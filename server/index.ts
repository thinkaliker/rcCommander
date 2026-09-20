import express from 'express';
import cors from 'cors';
import { execFile, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
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
// Uploads and downloads are one request per file, so dropping a folder of a few
// hundred files is normal traffic rather than abuse. They are still bounded,
// just on a separate, roomier budget than the polling endpoints.
const TRANSFER_MAX = 2000;
const isTransfer = (p: string) => p === '/upload' || p === '/download';
const rateHits = new Map<string, { count: number; reset: number }>();
// Evict expired buckets periodically so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateHits) {
    if (now > entry.reset) rateHits.delete(key);
  }
}, RATE_WINDOW_MS).unref();
app.use('/api', (req, res, next) => {
  const transfer = isTransfer(req.path);
  const key = `${transfer ? 'transfer' : 'api'}:${req.ip || 'unknown'}`;
  const now = Date.now();
  const entry = rateHits.get(key);
  if (!entry || now > entry.reset) {
    rateHits.set(key, { count: 1, reset: now + RATE_WINDOW_MS });
    return next();
  }
  if (entry.count >= (transfer ? TRANSFER_MAX : RATE_MAX)) {
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
  // 'copy' is a server-side rclone copy; 'upload' is a browser stream being
  // rcat'd into place. They differ in what actions make sense on them.
  kind: 'copy' | 'upload';
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
  // Incremented every time the job is (re)started. A spawned rclone process
  // carries the runId it was started under; its stdout/close handlers are
  // ignored once the job has moved on to a newer run. Without this a restart
  // races the SIGTERM'd old process, whose late `close` would flip the fresh
  // run straight back to 'error'.
  runId: number;
}
const activeJobs: Record<string, CopyJob> = {};
const activeProcesses: Record<string, { child: ChildProcess; runId: number }> = {};
const removeTimers: Record<string, NodeJS.Timeout> = {};

// Tear down any process/timer belonging to a job so a new run starts clean.
function cancelRun(jobId: string) {
  const timer = removeTimers[jobId];
  if (timer) {
    clearTimeout(timer);
    delete removeTimers[jobId];
  }
  const entry = activeProcesses[jobId];
  if (entry) {
    delete activeProcesses[jobId];
    entry.child.kill('SIGTERM');
  }
  return !!entry;
}

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

// A whole tree's listing is far larger than execFile's 1 MB default, which
// would otherwise fail a recursive listing with ENOBUFS partway through.
const LSJSON_MAX_BUFFER = 64 * 1024 * 1024;

app.get('/api/files', async (req, res) => {
  const targetPath = req.query.path as string;
  if (!targetPath) {
    return res.status(400).json({ error: 'path query parameter is required' });
  }
  // Used when a folder is being packed into an archive: one call returns the
  // entire subtree, rather than the client walking it a directory at a time.
  const recursive = req.query.recursive === '1';

  try {
    // Local paths are confined to LOCAL_ROOT; remotes pass through unchanged.
    const rclonePath = toRclonePath(targetPath);
    const args = recursive ? ['lsjson', '-R', rclonePath] : ['lsjson', rclonePath];
    const { stdout } = await execFileAsync('rclone', args, { maxBuffer: LSJSON_MAX_BUFFER });
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
      // `rclone listremotes` already returns names with their trailing colon,
      // so adding another one built paths like `jellyfin::media/new`. Append
      // one only if the caller sent a bare name.
      const spec = remote.endsWith(':') ? remote : `${remote}:`;
      const prefix = pathParam ? `${pathParam.replace(/\/+$/, '')}/` : '';
      targetPath = `${spec}${prefix}${folderName}`;
    }
    await execFileAsync('rclone', ['mkdir', targetPath]);
    res.json({ success: true, message: 'Folder created successfully' });
  } catch (error: any) {
    console.error('Error creating folder:', error);
    res.status(500).json({ error: error.message });
  }
});

function startRcloneJob(jobId: string, srcPath: string, destPath: string, numThreads: number) {
  const job = activeJobs[jobId];
  if (!job) return;
  const runId = job.runId;

  const child = spawn('rclone', [
    'copy',
    srcPath,
    destPath,
    '--progress',
    '--stats=1s',
    `--transfers=${numThreads}`
  ]);

  activeProcesses[jobId] = { child, runId };

  // Returns the job only while this process is still the job's current run.
  const currentJob = () => {
    const j = activeJobs[jobId];
    return j && j.runId === runId ? j : null;
  };

  let lastError = '';
  const handleProgress = (data: any) => {
    if (!currentJob()) return;
    const output = data.toString();

    const j = currentJob();
    if (!j) return;

    // Capture potential error messages
    const lines = output.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.includes('ERROR :') || trimmed.includes('Failed to')) {
        lastError = trimmed;
      }

      // Parse main stats line: Transferred: size / size, pct%, speed, ETA eta
      const transMatch = trimmed.match(/Transferred:\s+([^,]+),\s*([^,]+),\s*([^,]+),\s*ETA\s+(.*)/);
      if (transMatch) {
        const pct = transMatch[2].trim();
        j.progress = pct.endsWith('%') ? pct : (pct === '-' ? '-' : `${pct}%`);
        j.speed = transMatch[3].trim();
        j.eta = transMatch[4].trim();
      }

      // Parse elapsed time: Elapsed time: time
      const elapsedMatch = trimmed.match(/Elapsed time:\s+(.*)/);
      if (elapsedMatch) {
        j.elapsedTime = elapsedMatch[1].trim();
      }
    }

    // Fallback logic for progress if speed was not parsed yet (e.g. very early stage)
    if (!j.speed) {
      const match = output.match(/([0-9.]+)%/);
      if (match) {
        j.progress = `${parseFloat(match[1])}%`;
      } else {
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (line.length > 0 && line.includes('Transferred:')) {
            j.progress = line;
            break;
          }
        }
      }
    }
  };

  child.stdout.on('data', handleProgress);
  child.stderr.on('data', handleProgress);

  child.on('close', (code) => {
    // Drop this run's process handle, but only if it is still the registered
    // one — a restart may already have installed a newer child.
    if (activeProcesses[jobId]?.runId === runId) delete activeProcesses[jobId];

    const j = currentJob();
    if (!j) return;

    j.status = code === 0 ? 'completed' : 'error';
    j.speed = '0 B/s';
    j.eta = '-';
    if (code === 0) {
      j.progress = '100%';
      // Only auto-remove if completed successfully, not if error!
      const delay = j.autoRemoveSeconds;
      if (delay && delay > 0) {
        removeTimers[jobId] = setTimeout(() => {
          delete removeTimers[jobId];
          // Re-check: the job may have been restarted while the timer ran.
          if (activeJobs[jobId]?.runId === runId) delete activeJobs[jobId];
        }, delay * 1000);
      }
    } else {
      j.error = lastError || `Exited with code ${code}`;
    }
  });
}

app.post('/api/copy', (req, res) => {
  const { source, destination, threads, autoRemoveSeconds } = req.body;

  if (!source || !destination) {
    return res.status(400).json({ error: 'source and destination are required' });
  }

  const numThreads = threads || 4;
  const jobId = randomUUID();

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
    kind: 'copy',
    source: srcPath,
    destination: destPath,
    progress: 'Starting...',
    status: 'running',
    threads: numThreads,
    autoRemoveSeconds: autoRemoveSeconds !== undefined ? autoRemoveSeconds : 5,
    elapsedTime: '0s',
    speed: '0 B/s',
    eta: '-',
    runId: 1,
  };

  startRcloneJob(jobId, srcPath, destPath, numThreads);

  res.json({ jobId, message: 'Copy job started' });
});

app.get('/api/copy/status', (req, res) => {
  res.json({ jobs: activeJobs });
});

app.post('/api/copy/stop', (req, res) => {
  const { jobId } = req.body;
  const job = activeJobs[jobId];
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  // The client polls once a second, so its "running" view can be stale. Only
  // a genuinely running job may be stopped — otherwise a late click would
  // flip an already-finished job to 'error'.
  if (job.status !== 'running') {
    return res.json({ message: `Job already ${job.status}` });
  }

  // Retire this run before killing, so the dying process's `close` cannot
  // overwrite the "Stopped by user" state we set below.
  job.runId++;
  cancelRun(jobId);
  job.status = 'error';
  job.progress = 'Stopped by user';
  job.speed = '0 B/s';
  job.eta = '-';
  res.json({ message: 'Job stopped' });
});

app.post('/api/copy/remove', (req, res) => {
  const { jobId } = req.body;
  if (activeJobs[jobId]) {
    activeJobs[jobId].runId++;
    cancelRun(jobId);
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
  // An upload's bytes came from the browser and are gone once the request
  // ended, so there is nothing to replay.
  if (job.kind === 'upload') {
    return res.status(400).json({ error: 'Uploads cannot be restarted' });
  }

  // Retire the previous run first: SIGTERM is asynchronous, so the old child
  // is still alive and emitting when the new one spawns.
  job.runId++;
  cancelRun(jobId);

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

// ---------------------------------------------------------------------------
// Transfers between the browser and a remote
// ---------------------------------------------------------------------------

// rclone's own wording, so the numbers a job reports read the same whether the
// job is an rclone copy or a browser upload the server is metering itself.
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let val = bytes;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function formatSpeed(bytesPerSec: number): string {
  return bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : '0 B/s';
}

function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  let out = '';
  if (h > 0) out += `${h}h`;
  if (m > 0) out += `${m}m`;
  out += h === 0 && m === 0 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
  return out;
}

// A dropped folder arrives as one request per file carrying its path relative
// to the drop target, so every segment has to be checked, not just the name.
function relPathSegments(rel: unknown): string[] {
  const segments = String(rel ?? '').split('/').filter(s => s.length > 0);
  if (segments.length === 0) throw new Error('name is required');
  if (segments.length > 32) throw new Error('Path is nested too deeply');
  for (const seg of segments) {
    // eslint-disable-next-line no-control-regex
    if (seg === '.' || seg === '..' || /[\\\u0000-\u001f]/.test(seg) || seg.length > 255) {
      throw new Error(`Invalid path segment: ${seg}`);
    }
  }
  return segments;
}

// Join a validated relative path onto a pane's location. Local destinations go
// back through resolveLocalPath so they stay confined to LOCAL_ROOT.
function resolveUploadTarget(dest: string, segments: string[]): string {
  const rel = segments.join('/');
  if (isLocal(dest)) {
    const sub = dest.startsWith('Local Filesystem:')
      ? dest.slice('Local Filesystem:'.length).replace(/\/+$/, '')
      : '';
    return resolveLocalPath(`Local Filesystem:${sub}/${rel}`);
  }
  // As in /api/mkdir: `rclone listremotes` already returns the trailing colon,
  // so only a bare remote name needs one added.
  const clean = dest.replace(/\/+$/, '');
  const spec = clean.includes(':') ? clean : `${clean}:`;
  return spec.endsWith(':') ? `${spec}${rel}` : `${spec}/${rel}`;
}

// Stream one file from the browser straight into `rclone rcat`, so nothing is
// buffered in the server and arbitrarily large files are fine. The transfer is
// registered as a job, which is what puts it in the same progress panel as an
// rclone copy.
app.post('/api/upload', (req, res) => {
  const dest = req.query.dest as string;
  const name = req.query.name as string;
  if (!dest || !name) {
    return res.status(400).json({ error: 'dest and name query parameters are required' });
  }

  let target: string;
  let segments: string[];
  try {
    segments = relPathSegments(name);
    target = resolveUploadTarget(dest, segments);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }

  const autoRemoveSeconds = Math.min(3600, Math.max(0, parseInt(req.query.autoRemove as string) || 0));
  const total = Number(req.headers['content-length']) || 0;
  const jobId = randomUUID();
  const runId = 1;
  const startedAt = Date.now();

  const job: CopyJob = {
    id: jobId,
    kind: 'upload',
    source: segments[segments.length - 1],
    destination: target,
    progress: total > 0 ? '0%' : 'Uploading…',
    status: 'running',
    threads: 1,
    autoRemoveSeconds,
    elapsedTime: '0s',
    speed: '0 B/s',
    eta: '-',
    runId,
  };
  activeJobs[jobId] = job;

  // Null while this run has been superseded — stopped or dismissed by the user
  // — exactly as startRcloneJob does.
  const currentJob = () => {
    const j = activeJobs[jobId];
    return j && j.runId === runId ? j : null;
  };

  let received = 0;
  let lastTick = 0;
  const tick = (force = false) => {
    const now = Date.now();
    if (!force && now - lastTick < 250) return;
    lastTick = now;
    const j = currentJob();
    if (!j) return;
    const elapsed = (now - startedAt) / 1000;
    const bps = elapsed > 0 ? received / elapsed : 0;
    j.elapsedTime = formatDuration(elapsed);
    j.speed = formatSpeed(bps);
    if (total > 0) {
      j.progress = `${Math.min(100, (received / total) * 100).toFixed(1)}%`;
      j.eta = bps > 0 ? formatDuration(Math.max(0, total - received) / bps) : '-';
    } else {
      // No Content-Length (a chunked upload): report bytes instead of a
      // percentage rather than inventing one.
      j.progress = `${formatBytes(received)} sent`;
    }
  };

  const child = spawn('rclone', ['rcat', target]);
  activeProcesses[jobId] = { child, runId };

  let stderr = '';
  child.stderr.on('data', data => {
    stderr = (stderr + data.toString()).slice(-2000);
  });
  // A killed or failed rcat leaves the pipe broken; without this the EPIPE
  // would surface as an unhandled error and take the process down.
  child.stdin.on('error', () => {});

  req.on('data', chunk => {
    received += chunk.length;
    tick();
  });
  req.on('aborted', () => {
    const j = currentJob();
    if (j) {
      j.runId++;
      j.status = 'error';
      j.progress = 'Upload cancelled';
      j.speed = '0 B/s';
      j.eta = '-';
    }
    cancelRun(jobId);
  });

  req.pipe(child.stdin);

  child.on('close', (code, signal) => {
    if (activeProcesses[jobId]?.runId === runId) delete activeProcesses[jobId];
    req.unpipe(child.stdin);

    const failure = stderr.trim().split('\n').pop()
      || (signal ? `rclone rcat was terminated (${signal})` : `rclone rcat exited with code ${code}`);

    const j = currentJob();
    if (j) {
      tick(true);
      j.speed = '0 B/s';
      j.eta = '-';
      if (code === 0) {
        j.status = 'completed';
        j.progress = '100%';
        if (autoRemoveSeconds > 0) {
          removeTimers[jobId] = setTimeout(() => {
            delete removeTimers[jobId];
            if (activeJobs[jobId]?.runId === runId) delete activeJobs[jobId];
          }, autoRemoveSeconds * 1000);
        }
      } else {
        j.status = 'error';
        j.error = failure;
      }
    }

    if (res.headersSent) return;
    if (code === 0) {
      res.json({ jobId, message: 'Upload complete' });
    } else if (!j) {
      // currentJob() went null: the run was retired by /copy/stop or
      // /copy/remove, i.e. the user cancelled it on purpose.
      res.status(409).json({ jobId, cancelled: true, error: 'Upload stopped' });
    } else {
      res.status(500).json({ jobId, error: failure });
    }
  });

  child.on('error', error => {
    const j = currentJob();
    if (j) {
      j.status = 'error';
      j.error = error.message;
      j.speed = '0 B/s';
      j.eta = '-';
    }
    if (!res.headersSent) res.status(500).json({ jobId, error: error.message });
  });
});

// Build a Content-Disposition that survives non-ASCII names and cannot inject
// a header of its own.
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// Last segment of a pane path: after the final slash, or after the remote's
// colon when the file sits at a remote's root.
function baseName(spec: string): string {
  const afterSlash = spec.slice(spec.lastIndexOf('/') + 1);
  const colon = afterSlash.lastIndexOf(':');
  return colon >= 0 ? afterSlash.slice(colon + 1) : afterSlash;
}

// Stream a single file back to the browser. Folders are refused: the client
// downloads a selection as one request per file, so nothing here has to build
// an archive or hold a file in memory.
app.get('/api/download', async (req, res) => {
  const targetPath = req.query.path as string;
  if (!targetPath) {
    return res.status(400).json({ error: 'path query parameter is required' });
  }

  const name = baseName(targetPath);
  if (!name) {
    return res.status(400).json({ error: 'path does not name a file' });
  }

  let rclonePath: string;
  try {
    rclonePath = toRclonePath(targetPath);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }

  // Local files go out through res.download, which adds range support and the
  // right length without another rclone process in the way.
  if (isLocal(targetPath)) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(rclonePath);
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Folders cannot be downloaded' });
    }
    return res.download(rclonePath, name);
  }

  // Stat first so a missing file or a folder becomes a clean JSON error
  // instead of a truncated download.
  let size: number | null = null;
  try {
    const { stdout } = await execFileAsync('rclone', ['lsjson', '--stat', rclonePath]);
    const info = JSON.parse(stdout);
    if (info?.IsDir) {
      return res.status(400).json({ error: 'Folders cannot be downloaded' });
    }
    if (typeof info?.Size === 'number' && info.Size >= 0) size = info.Size;
  } catch (error: any) {
    console.error(`Error stating ${targetPath}:`, error);
    return res.status(404).json({ error: 'File not found' });
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition(name));
  if (size !== null) res.setHeader('Content-Length', String(size));

  const child = spawn('rclone', ['cat', rclonePath]);
  child.stdout.pipe(res);
  child.stderr.on('data', data => console.error(`rclone cat: ${data.toString().trim()}`));
  child.on('error', error => {
    console.error('Error starting rclone cat:', error);
    res.destroy();
  });
  // The browser cancelling mid-download must not leave an rclone behind.
  res.on('close', () => child.kill('SIGTERM'));
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
