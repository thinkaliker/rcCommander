import express from 'express';
import cors from 'cors';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const app = express();
const port = 3001;
const execFileAsync = promisify(execFile);

// Local filesystem access is confined to this root to prevent path traversal.
const LOCAL_ROOT = path.resolve(process.env.LOCAL_ROOT || '/mnt');

function isLocal(p: string): boolean {
  return p === 'Local Filesystem' || p.startsWith('Local Filesystem:');
}

// Resolve a "Local Filesystem[:subpath]" spec to a host path confined to
// LOCAL_ROOT. Throws if the result escapes the root (../ traversal).
function resolveLocalPath(p: string): string {
  let rel = '';
  if (p.startsWith('Local Filesystem:')) rel = p.slice('Local Filesystem:'.length);
  rel = rel.replace(/^[/\\]+/, '');
  const resolved = path.resolve(LOCAL_ROOT, rel);
  if (resolved !== LOCAL_ROOT && !resolved.startsWith(LOCAL_ROOT + path.sep)) {
    throw new Error('Path is outside the allowed local root');
  }
  return resolved;
}

// Map a user-supplied source/dest into a value safe to hand to rclone:
// local specs are confined to LOCAL_ROOT, remotes pass through unchanged.
function toRclonePath(p: string): string {
  return isLocal(p) ? resolveLocalPath(p) : p;
}

app.use(cors());
app.use(express.json({ limit: '50kb' }));

// Simple in-memory rate limiter for the API (no external deps).
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 300;
const rateHits = new Map<string, { count: number; reset: number }>();
app.use('/api', (req, res, next) => {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const entry = rateHits.get(key);
  if (!entry || now > entry.reset) {
    rateHits.set(key, { count: 1, reset: now + RATE_WINDOW_MS });
    return next();
  }
  if (entry.count >= RATE_MAX) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  entry.count++;
  next();
});

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Endpoint for frontend log forwarding
app.post('/api/log', (req, res) => {
  const { level, message, data } = req.body;
  // Strip CR/LF and cap length to prevent log injection / forging.
  const clean = (v: any) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, 1000);
  console.log(`[${new Date().toISOString()}] [FRONTEND] [${clean(level).toUpperCase() || 'LOG'}] ${clean(message)}`, data ? clean(JSON.stringify(data)) : '');
  res.sendStatus(200);
});

// Data structures for tracking jobs
interface CopyJob {
  id: string;
  source: string;
  destination: string;
  progress: string; // latest percentage or text from stdout
  status: 'running' | 'completed' | 'error';
  error?: string;
  threads: number;
  autoRemoveSeconds?: number;
  elapsedTime?: string;
  speed?: string;
  eta?: string;
}
const activeJobs: Record<string, CopyJob> = {};
const activeProcesses: Record<string, any> = {};

app.get('/api/remotes', async (req, res) => {
  try {
    const { stdout } = await execFileAsync('rclone', ['listremotes']);
    const remotes = stdout.split('\n').map(r => r.trim()).filter(r => r.length > 0);
    // Include a local filesystem specifier
    res.json({ remotes: ['Local Filesystem', ...remotes] });
  } catch (error: any) {
    console.error('Error fetching remotes:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/files', async (req, res) => {
  const targetPath = req.query.path as string;
  if (!targetPath) {
    return res.status(400).json({ error: 'path query parameter is required' });
  }

  try {
    // Local paths are confined to LOCAL_ROOT; remotes pass through unchanged.
    const rclonePath = toRclonePath(targetPath);
    const { stdout } = await execFileAsync('rclone', ['lsjson', rclonePath]);
    const files = JSON.parse(stdout);
    res.json({ files });
  } catch (error: any) {
    console.error(`Error fetching files for path ${targetPath}:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/mkdir', async (req, res) => {
  const { remote, pathParam, folderName } = req.body;

  if (!remote || !folderName) {
    return res.status(400).json({ error: 'remote and folderName are required' });
  }

  // folderName must be a single path segment, no separators or traversal.
  if (/[\\/]/.test(folderName) || folderName === '..' || folderName === '.') {
    return res.status(400).json({ error: 'Invalid folderName' });
  }

  try {
    let targetPath: string;
    if (remote === 'Local Filesystem') {
      const sub = pathParam ? `${pathParam}/${folderName}` : folderName;
      targetPath = resolveLocalPath(`Local Filesystem:${sub}`);
    } else {
      targetPath = `${remote}:${pathParam ? pathParam + '/' : ''}${folderName}`;
    }
    await execFileAsync('rclone', ['mkdir', targetPath]);
    res.json({ success: true, message: 'Folder created successfully' });
  } catch (error: any) {
    console.error('Error creating folder:', error);
    res.status(500).json({ error: error.message });
  }
});

function startRcloneJob(jobId: string, srcPath: string, destPath: string, numThreads: number) {
  const child = spawn('rclone', [
    'copy',
    srcPath,
    destPath,
    '--progress',
    '--stats=1s',
    `--transfers=${numThreads}`
  ]);

  activeProcesses[jobId] = child;

  let lastError = '';
  const handleProgress = (data: any) => {
    if (!activeJobs[jobId]) return;
    const output = data.toString();

    // Capture potential error messages
    const lines = output.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.includes('ERROR :') || trimmed.includes('Failed to') || (trimmed.length > 0 && !trimmed.match(/[0-9.]%/))) {
        if (trimmed.includes('ERROR :') || trimmed.includes('Failed to')) {
            lastError = trimmed;
        }
      }

      // Parse main stats line: Transferred: size / size, pct%, speed, ETA eta
      const transMatch = trimmed.match(/Transferred:\s+([^,]+),\s*([^,]+),\s*([^,]+),\s*ETA\s+(.*)/);
      if (transMatch) {
        const pct = transMatch[2].trim();
        activeJobs[jobId].progress = pct.endsWith('%') ? pct : (pct === '-' ? '-' : `${pct}%`);
        activeJobs[jobId].speed = transMatch[3].trim();
        activeJobs[jobId].eta = transMatch[4].trim();
      }

      // Parse elapsed time: Elapsed time: time
      const elapsedMatch = trimmed.match(/Elapsed time:\s+(.*)/);
      if (elapsedMatch) {
        activeJobs[jobId].elapsedTime = elapsedMatch[1].trim();
      }
    }

    // Fallback logic for progress if speed was not parsed yet (e.g. very early stage)
    if (!activeJobs[jobId].speed) {
      const match = output.match(/([0-9.]+)%/);
      if (match) {
        activeJobs[jobId].progress = `${parseFloat(match[1])}%`;
      } else {
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (line.length > 0 && line.includes('Transferred:')) {
            activeJobs[jobId].progress = line;
            break;
          }
        }
      }
    }
  };

  child.stdout.on('data', handleProgress);
  child.stderr.on('data', handleProgress);

  child.on('close', (code) => {
    if (!activeJobs[jobId]) return;
    activeJobs[jobId].status = code === 0 ? 'completed' : 'error';
    activeJobs[jobId].speed = '0 B/s';
    activeJobs[jobId].eta = '-';
    if (code === 0) {
      activeJobs[jobId].progress = '100%';
    } else {
      activeJobs[jobId].error = lastError || `Exited with code ${code}`;
    }

    const delay = activeJobs[jobId].autoRemoveSeconds;
    // Only auto-remove if completed successfully, not if error!
    if (activeJobs[jobId].status === 'completed' && delay && delay > 0) {
      setTimeout(() => {
        delete activeJobs[jobId];
      }, delay * 1000);
    }
  });
}

app.post('/api/copy', (req, res) => {
  const { source, destination, threads, autoRemoveSeconds } = req.body;

  if (!source || !destination) {
    return res.status(400).json({ error: 'source and destination are required' });
  }

  const numThreads = threads || 4;
  const jobId = Date.now().toString(36) + '-' + Math.random().toString(36).substring(7);

  let srcPath: string;
  let destPath: string;
  try {
    srcPath = toRclonePath(source);
    destPath = toRclonePath(destination);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }

  activeJobs[jobId] = {
    id: jobId,
    source: srcPath,
    destination: destPath,
    progress: 'Starting...',
    status: 'running',
    threads: numThreads,
    autoRemoveSeconds: autoRemoveSeconds !== undefined ? autoRemoveSeconds : 5,
    elapsedTime: '0s',
    speed: '0 B/s',
    eta: '-',
  };

  startRcloneJob(jobId, srcPath, destPath, numThreads);

  res.json({ jobId, message: 'Copy job started' });
});

app.get('/api/copy/status', (req, res) => {
  res.json({ jobs: activeJobs });
});

app.post('/api/copy/stop', (req, res) => {
  const { jobId } = req.body;
  if (activeProcesses[jobId]) {
    activeProcesses[jobId].kill('SIGTERM');
    delete activeProcesses[jobId];
    if (activeJobs[jobId]) {
      activeJobs[jobId].status = 'error';
      activeJobs[jobId].progress = 'Stopped by user';
      activeJobs[jobId].speed = '0 B/s';
      activeJobs[jobId].eta = '-';
    }
    res.json({ message: 'Job stopped' });
  } else {
    res.status(404).json({ error: 'Job not found' });
  }
});

app.post('/api/copy/remove', (req, res) => {
  const { jobId } = req.body;
  if (activeJobs[jobId]) {
    if (activeProcesses[jobId]) {
      activeProcesses[jobId].kill('SIGTERM');
      delete activeProcesses[jobId];
    }
    delete activeJobs[jobId];
    res.json({ message: 'Job removed' });
  } else {
    res.status(404).json({ error: 'Job not found' });
  }
});

app.post('/api/copy/restart', (req, res) => {
  const { jobId } = req.body;
  const job = activeJobs[jobId];
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (activeProcesses[jobId]) {
    activeProcesses[jobId].kill('SIGTERM');
    delete activeProcesses[jobId];
  }

  job.status = 'running';
  job.progress = 'Starting...';
  job.elapsedTime = '0s';
  job.speed = '0 B/s';
  job.eta = '-';
  delete job.error;

  startRcloneJob(jobId, job.source, job.destination, job.threads);

  res.json({ jobId, message: 'Job restarted' });
});

app.get('/api/config', async (req, res) => {
  try {
    const { stdout: configFile } = await execFileAsync('rclone', ['config', 'file']);
    let dump = '';
    try {
      ({ stdout: dump } = await execFileAsync('rclone', ['config', 'dump']));
    } catch {
      ({ stdout: dump } = await execFileAsync('rclone', ['config', 'show']));
    }
    res.json({
      path: configFile.trim(),
      dump: dump.trim()
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Serve frontend static files securely strictly as a fallback behind exact API domains
const frontendDist = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
