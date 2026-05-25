import express from 'express';
import cors from 'cors';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const app = express();
const port = 3001;
const execAsync = promisify(exec);

app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Endpoint for frontend log forwarding
app.post('/api/log', (req, res) => {
  const { level, message, data } = req.body;
  console.log(`[${new Date().toISOString()}] [FRONTEND] [${level?.toUpperCase() || 'LOG'}] ${message}`, data ? JSON.stringify(data) : '');
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
}
const activeJobs: Record<string, CopyJob> = {};
const activeProcesses: Record<string, any> = {};

app.get('/api/remotes', async (req, res) => {
  try {
    const { stdout } = await execAsync('rclone listremotes');
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
    // Determine actual path for rclone
    // If it's "Local Filesystem", the root path will just be / (or drive letter on Windows)
    let rclonePath = targetPath;
    if (rclonePath === 'Local Filesystem' || rclonePath === 'Local Filesystem:') {
      // Special case to list root for local system. On Mac/Linux, this is '/'
      rclonePath = '/';
    } else if (rclonePath.startsWith('Local Filesystem:')) {
      rclonePath = rclonePath.replace('Local Filesystem:', '');
    }

    // Fallback default
    if (rclonePath === '') {
      rclonePath = '/';
    }

    const { stdout } = await execAsync(`rclone lsjson "${rclonePath}"`);
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

  let targetPath = '';
  if (remote === 'Local Filesystem') {
    targetPath = pathParam ? path.join(pathParam, folderName) : `/${folderName}`;
  } else {
    targetPath = `${remote}:${pathParam ? pathParam + '/' : ''}${folderName}`;
  }

  try {
    await execAsync(`rclone mkdir "${targetPath}"`);
    res.json({ success: true, message: 'Folder created successfully' });
  } catch (error: any) {
    console.error(`Error creating folder ${targetPath}:`, error);
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
    }

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
  };

  child.stdout.on('data', handleProgress);
  child.stderr.on('data', handleProgress);

  child.on('close', (code) => {
    if (!activeJobs[jobId]) return;
    activeJobs[jobId].status = code === 0 ? 'completed' : 'error';
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

  const formatPath = (p: string) => {
    if (p.startsWith('Local Filesystem:')) return p.replace('Local Filesystem:', '');
    if (p === 'Local Filesystem') return '/';
    return p;
  };

  const srcPath = formatPath(source);
  const destPath = formatPath(destination);

  activeJobs[jobId] = {
    id: jobId,
    source: srcPath,
    destination: destPath,
    progress: 'Starting...',
    status: 'running',
    threads: numThreads,
    autoRemoveSeconds: autoRemoveSeconds !== undefined ? autoRemoveSeconds : 5,
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
  delete job.error;

  startRcloneJob(jobId, job.source, job.destination, job.threads);

  res.json({ jobId, message: 'Job restarted' });
});

app.get('/api/config', async (req, res) => {
  try {
    const { stdout: configFile } = await execAsync('rclone config file');
    const { stdout: configDump } = await execAsync('rclone config dump || rclone config show');
    res.json({
      path: configFile.trim(),
      dump: configDump.trim()
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
