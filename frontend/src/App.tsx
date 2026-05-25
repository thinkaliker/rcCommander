import { useState, useEffect } from 'react';
import './App.css';
import { Pane } from './components/Pane';
import type { RcloneFile, CopyJob } from './types';

// Fix for Reverse Proxies: Route relatively in Production, fallback to strict port in Dev
const API_BASE = import.meta.env.DEV
  ? `http://${window.location.hostname}:3001/api`
  : '/api';

// Helper to extract the last non-empty path segment, handling both Unix and Windows slashes, and trailing slashes
const getFileName = (pathStr: string) => {
  if (!pathStr) return '';
  const parts = pathStr.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '/';
};

// Parse speed string (e.g. "5.102 MiB/s") to raw bytes per second
const parseSpeed = (speedStr: string | undefined): number => {
  if (!speedStr) return 0;
  const cleaned = speedStr.trim().toLowerCase();
  const match = cleaned.match(/^([\d.]+)\s*([a-z/]+)$/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = match[2];
  if (unit.startsWith('t')) return val * 1024 * 1024 * 1024 * 1024;
  if (unit.startsWith('g')) return val * 1024 * 1024 * 1024;
  if (unit.startsWith('m')) return val * 1024 * 1024;
  if (unit.startsWith('k')) return val * 1024;
  return val;
};

// Format speed from raw bytes per second
const formatSpeed = (bytesPerSec: number): string => {
  if (bytesPerSec === 0) return '0 B/s';
  const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s'];
  let idx = 0;
  let val = bytesPerSec;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(2)} ${units[idx]}`;
};

// Parse elapsed time string (e.g. "12.3s", "1m2.3s") to raw seconds
const parseElapsedTime = (timeStr: string | undefined): number => {
  if (!timeStr) return 0;
  const cleaned = timeStr.trim().toLowerCase();
  const match = cleaned.replace(/\s+/g, '').match(/^(?:([\d.]+)h)?(?:([\d.]+)m)?(?:([\d.]+)s)?$/);
  if (match) {
    const h = match[1] ? parseFloat(match[1]) : 0;
    const m = match[2] ? parseFloat(match[2]) : 0;
    const s = match[3] ? parseFloat(match[3]) : 0;
    return h * 3600 + m * 60 + s;
  }
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
};

// Format elapsed time from raw seconds
const formatElapsedTime = (seconds: number): string => {
  if (seconds < 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  
  let res = '';
  if (h > 0) res += `${h}h`;
  if (m > 0) res += `${m}m`;
  if (h === 0 && m === 0) {
    res += `${s.toFixed(1).replace(/\.0$/, '')}s`;
  } else {
    res += `${Math.round(s)}s`;
  }
  return res;
};

// Parse remaining time string (e.g. "3m56s") to seconds
const parseETA = (etaStr: string | undefined): number | null => {
  if (!etaStr || etaStr.trim() === '-') return null;
  const cleaned = etaStr.trim().toLowerCase();
  const match = cleaned.replace(/\s+/g, '').match(/^(?:([\d.]+)h)?(?:([\d.]+)m)?(?:([\d.]+)s)?$/);
  if (match) {
    const h = match[1] ? parseFloat(match[1]) : 0;
    const m = match[2] ? parseFloat(match[2]) : 0;
    const s = match[3] ? parseFloat(match[3]) : 0;
    return h * 3600 + m * 60 + s;
  }
  return null;
};

function App() {
  const [remotes, setRemotes] = useState<string[]>([]);

  // Left Pane State
  const [leftRemote, setLeftRemote] = useState<string>('Local Filesystem');
  const [leftPath, setLeftPath] = useState<string>('');
  const [leftFiles, setLeftFiles] = useState<RcloneFile[]>([]);
  const [leftSelected, setLeftSelected] = useState<Set<string>>(new Set());
  const [leftLoading, setLeftLoading] = useState(false);

  // Right Pane State
  const [rightRemote, setRightRemote] = useState<string>('Local Filesystem');
  const [rightPath, setRightPath] = useState<string>('');
  const [rightFiles, setRightFiles] = useState<RcloneFile[]>([]);
  const [rightSelected, setRightSelected] = useState<Set<string>>(new Set());
  const [rightLoading, setRightLoading] = useState(false);

  const [leftAutoRefresh, setLeftAutoRefresh] = useState(0);
  const [rightAutoRefresh, setRightAutoRefresh] = useState(0);

  // Job State
  const [activeJobs, setActiveJobs] = useState<Record<string, CopyJob>>({});
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [copyDirection, setCopyDirection] = useState<'L2R' | 'R2L'>('L2R');
  const [threads, setThreads] = useState(4);
  const [autoRemove, setAutoRemove] = useState(5);
  const [configDetails, setConfigDetails] = useState<{ path: string, dump: string, error?: string } | null>(null);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [mkdirState, setMkdirState] = useState<{ remote: string, path: string } | null>(null);
  const [mkdirFolderName, setMkdirFolderName] = useState('');
  const [isConnected, setIsConnected] = useState(true);

  // Utility to send logs to the server
  const logToServer = (level: string, message: string, data?: any) => {
    fetch(`${API_BASE}/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, message, data }),
      keepalive: true // Ensure log completes even if page unloads
    }).catch(() => {}); // Silent fail
  };

  useEffect(() => {
    const originalError = console.error;
    const originalWarn = console.warn;

    console.error = (...args) => {
      logToServer('error', args.map(String).join(' '));
      originalError.apply(console, args);
    };

    console.warn = (...args) => {
      logToServer('warn', args.map(String).join(' '));
      originalWarn.apply(console, args);
    };

    const handleGlobalError = (event: ErrorEvent) => {
      logToServer('error', `Uncaught Error: ${event.message}`, { filename: event.filename, lineno: event.lineno });
    };

    window.addEventListener('error', handleGlobalError);

    return () => {
      console.error = originalError;
      console.warn = originalWarn;
      window.removeEventListener('error', handleGlobalError);
    };
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/remotes`)
      .then(res => res.json())
      .then(data => {
        if (data.remotes) {
          setRemotes(data.remotes);
          if (data.remotes.length > 1) {
            setRightRemote(data.remotes[1]);
          }
        }
      })
      .catch(console.error);
  }, []);

  const fetchFiles = async (remote: string, path: string, setFiles: (f: RcloneFile[]) => void, setLoading: (l: boolean) => void, silent = false) => {
    if (!silent) setLoading(true);
    try {
      let fullPath = '';
      if (remote === 'Local Filesystem') {
        fullPath = 'Local Filesystem:' + (path || '/');
      } else {
        fullPath = `${remote}${path}`;
      }
      const res = await fetch(`${API_BASE}/files?path=${encodeURIComponent(fullPath)}`);
      const data = await res.json();
      if (data.files) {
        const sorted = data.files.sort((a: RcloneFile, b: RcloneFile) => {
          if (a.IsDir && !b.IsDir) return -1;
          if (!a.IsDir && b.IsDir) return 1;
          return a.Name.localeCompare(b.Name);
        });
        setFiles(sorted);
      } else {
        setFiles([]);
      }
    } catch (err) {
      console.error(err);
      setFiles([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchFiles(leftRemote, leftPath, setLeftFiles, setLeftLoading);
    setLeftSelected(new Set());
  }, [leftRemote, leftPath]);

  useEffect(() => {
    fetchFiles(rightRemote, rightPath, setRightFiles, setRightLoading);
    setRightSelected(new Set());
  }, [rightRemote, rightPath]);

  useEffect(() => {
    if (leftAutoRefresh <= 0) return;
    const interval = setInterval(() => {
      fetchFiles(leftRemote, leftPath, setLeftFiles, setLeftLoading, true);
    }, leftAutoRefresh * 1000);
    return () => clearInterval(interval);
  }, [leftAutoRefresh, leftRemote, leftPath]);

  useEffect(() => {
    if (rightAutoRefresh <= 0) return;
    const interval = setInterval(() => {
      fetchFiles(rightRemote, rightPath, setRightFiles, setRightLoading, true);
    }, rightAutoRefresh * 1000);
    return () => clearInterval(interval);
  }, [rightAutoRefresh, rightRemote, rightPath]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetch(`${API_BASE}/copy/status`)
        .then(res => {
          if (!res.ok) throw new Error('Bad response');
          setIsConnected(true);
          return res.json();
        })
        .then(data => {
          if (data && data.jobs) setActiveJobs(data.jobs);
        })
        .catch(err => {
          console.error(err);
          setIsConnected(false);
        });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const toggleSelection = (fileName: string, selected: Set<string>, setSelected: (s: Set<string>) => void) => {
    const newSelected = new Set(selected);
    if (newSelected.has(fileName)) {
      newSelected.delete(fileName);
    } else {
      newSelected.add(fileName);
    }
    setSelected(newSelected);
  };

  const toggleAll = (fileNames: string[], selectAll: boolean, selected: Set<string>, setSelected: (s: Set<string>) => void) => {
    const newSelected = new Set(selected);
    fileNames.forEach(f => selectAll ? newSelected.add(f) : newSelected.delete(f));
    setSelected(newSelected);
  };

  const getFullPath = (remote: string, pathParam: string, file: string) => {
    if (remote === 'Local Filesystem') {
      let p = pathParam || '/';
      if (!p.endsWith('/')) p += '/';
      return 'Local Filesystem:' + p + file;
    } else {
      let base = remote + pathParam;
      if (!base.endsWith('/')) base += '/';
      return base + file;
    }
  };

  const handleCopyConfirm = async () => {
    setIsModalOpen(false);

    let sourceRemote = copyDirection === 'L2R' ? leftRemote : rightRemote;
    let sourcePath = copyDirection === 'L2R' ? leftPath : rightPath;
    let selectedSet = copyDirection === 'L2R' ? leftSelected : rightSelected;

    let destRemote = copyDirection === 'L2R' ? rightRemote : leftRemote;
    let destPath = copyDirection === 'L2R' ? rightPath : leftPath;

    for (const fileName of Array.from(selectedSet)) {
      const sourceFile = getFullPath(sourceRemote, sourcePath, fileName);

      const fileList = copyDirection === 'L2R' ? leftFiles : rightFiles;
      const fileObj = fileList.find(f => f.Name === fileName);

      let destStr = getFullPath(destRemote, destPath, '');
      if (fileObj?.IsDir) {
        destStr = getFullPath(destRemote, destPath, fileObj.Name);
      }

      try {
        await fetch(`${API_BASE}/copy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: sourceFile,
            destination: destStr,
            threads: threads,
            autoRemoveSeconds: autoRemove
          })
        });
      } catch (e) {
        console.error(e);
      }
    }

    setLeftSelected(new Set());
    setRightSelected(new Set());
  };

  const handleDragAndDrop = async (source: any, dest: any) => {
    const sourceFile = getFullPath(source.sourceRemote, source.sourcePath, source.fileName);
    let destStr = getFullPath(dest.destRemote, dest.destPath, '');
    if (source.isDir) {
      destStr = getFullPath(dest.destRemote, dest.destPath, source.fileName);
    }

    try {
      await fetch(`${API_BASE}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: sourceFile,
          destination: destStr,
          threads: threads,
          autoRemoveSeconds: autoRemove
        })
      });
    } catch (e) {
      console.error(e);
    }
  };

  const showConfig = async () => {
    setIsConfigModalOpen(true);
    setConfigDetails(null);
    try {
      const res = await fetch(`${API_BASE}/config`);
      const data = await res.json();
      if (data.error) {
        setConfigDetails({ path: 'Error Executing Rclone Config', dump: '', error: data.error });
      } else {
        setConfigDetails({ path: data.path, dump: data.dump });
      }
    } catch (e: any) {
      setConfigDetails({ path: 'Network/Server Error', dump: '', error: e.message });
    }
  };

  const handleStopJob = async (jobId: string) => {
    try {
      await fetch(`${API_BASE}/copy/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId })
      });
    } catch (e) {
      console.error(e);
    }
  };

  const handleRestartJob = async (jobId: string) => {
    try {
      await fetch(`${API_BASE}/copy/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId })
      });
    } catch (e) {
      console.error(e);
    }
  };

  const handleDismissJob = async (jobId: string) => {
    try {
      await fetch(`${API_BASE}/copy/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId })
      });
      setActiveJobs(prev => {
        const next = { ...prev };
        delete next[jobId];
        return next;
      });
    } catch (e) {
      console.error(e);
    }
  };

  const handleMkdir = async () => {
    if (!mkdirState || !mkdirFolderName) return;
    try {
      const response = await fetch(`${API_BASE}/mkdir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remote: mkdirState.remote, pathParam: mkdirState.path, folderName: mkdirFolderName })
      });
      if (response.ok) {
        setMkdirState(null);
        setMkdirFolderName('');
        if (mkdirState.remote === leftRemote && mkdirState.path === leftPath) fetchFiles(leftRemote, leftPath, setLeftFiles, setLeftLoading, true);
        if (mkdirState.remote === rightRemote && mkdirState.path === rightPath) fetchFiles(rightRemote, rightPath, setRightFiles, setRightLoading, true);
      } else {
        const err = await response.json();
        alert(err.error || 'Failed to create folder');
      }
    } catch (e) {
      console.error(e);
      alert('Error creating directory');
    }
  };

  // Summed/aggregate stats calculation for active running jobs
  const runningJobs = Object.values(activeJobs).filter(job => job.status === 'running');
  
  let totalSpeedBytes = 0;
  let maxElapsedSeconds = 0;
  let totalRemainingSeconds = 0;
  let hasValidETA = false;
  
  runningJobs.forEach(job => {
    totalSpeedBytes += parseSpeed(job.speed);
    
    const elapsedSec = parseElapsedTime(job.elapsedTime);
    if (elapsedSec > maxElapsedSeconds) {
      maxElapsedSeconds = elapsedSec;
    }
    
    const etaSec = parseETA(job.eta);
    if (etaSec !== null) {
      hasValidETA = true;
      totalRemainingSeconds += etaSec;
    }
  });
  
  const avgSpeedBytes = runningJobs.length > 0 ? totalSpeedBytes / runningJobs.length : 0;
  const avgSpeedFormatted = formatSpeed(avgSpeedBytes);
  const maxElapsedFormatted = formatElapsedTime(maxElapsedSeconds);
  const totalRemainingFormatted = hasValidETA ? formatElapsedTime(totalRemainingSeconds) : '-';

  return (
    <div className="app-container">
      <div className="header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <h1>rclone<span>Commander</span></h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', color: isConnected ? 'var(--accent)' : 'var(--danger)', padding: '6px 12px', background: 'rgba(0,0,0,0.3)', borderRadius: '20px', border: `1px solid ${isConnected ? 'var(--accent)' : 'var(--danger)'}` }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: isConnected ? 'var(--accent)' : 'var(--danger)', boxShadow: `0 0 8px ${isConnected ? 'var(--accent)' : 'var(--danger)'}` }}></div>
            {isConnected ? 'Server Connected' : 'Server Disconnected'}
          </div>
        </div>
        <button className="btn-primary" style={{ padding: '8px 16px', fontSize: '0.9rem' }} onClick={showConfig}>Rclone Config</button>
      </div>

      <div className="main-content">
        <Pane
          remotes={remotes}
          activeRemote={leftRemote}
          activePath={leftPath}
          setActiveRemote={setLeftRemote}
          setActivePath={setLeftPath}
          files={leftFiles}
          selectedFiles={leftSelected}
          toggleFile={(file) => toggleSelection(file, leftSelected, setLeftSelected)}
          toggleAll={(names, select) => toggleAll(names, select, leftSelected, setLeftSelected)}
          isLoading={leftLoading}
          onDropFile={handleDragAndDrop}
          onRefresh={() => fetchFiles(leftRemote, leftPath, setLeftFiles, setLeftLoading, true)}
          onNewFolder={() => { setMkdirState({ remote: leftRemote, path: leftPath }); setMkdirFolderName(''); }}
          autoRefreshVal={leftAutoRefresh}
          setAutoRefreshVal={setLeftAutoRefresh}
        />

        <div className="controls-bar" style={{ flexDirection: 'column', justifyContent: 'center' }}>
          <button
            className="btn-primary"
            disabled={leftSelected.size === 0}
            onClick={() => { setCopyDirection('L2R'); setIsModalOpen(true); }}
          >
            Copy ➡️
          </button>

          <button
            className="btn-primary"
            disabled={rightSelected.size === 0}
            onClick={() => { setCopyDirection('R2L'); setIsModalOpen(true); }}
          >
            ⬅️ Copy
          </button>
        </div>

        <Pane
          remotes={remotes}
          activeRemote={rightRemote}
          activePath={rightPath}
          setActiveRemote={setRightRemote}
          setActivePath={setRightPath}
          files={rightFiles}
          selectedFiles={rightSelected}
          toggleFile={(file) => toggleSelection(file, rightSelected, setRightSelected)}
          toggleAll={(names, select) => toggleAll(names, select, rightSelected, setRightSelected)}
          isLoading={rightLoading}
          onDropFile={handleDragAndDrop}
          onRefresh={() => fetchFiles(rightRemote, rightPath, setRightFiles, setRightLoading, true)}
          onNewFolder={() => { setMkdirState({ remote: rightRemote, path: rightPath }); setMkdirFolderName(''); }}
          autoRefreshVal={rightAutoRefresh}
          setAutoRefreshVal={setRightAutoRefresh}
        />
      </div>

      {isModalOpen && (
        <div className="overlay">
          <div className="modal">
            <h2>Confirm Copy</h2>
            <p>Copy {copyDirection === 'L2R' ? leftSelected.size : rightSelected.size} items from {copyDirection === 'L2R' ? 'Left' : 'Right'} to {copyDirection === 'L2R' ? 'Right' : 'Left'}?</p>

            <div className="modal-input">
              <label>Threads (Multi-threading)</label>
              <input type="number" min="1" max="16" value={threads} onChange={(e) => setThreads(parseInt(e.target.value) || 4)} className="path-input" />
            </div>

            <div className="modal-input">
              <label>Auto-remove completed (seconds, 0 to keep forever)</label>
              <input type="number" min="0" max="3600" value={autoRemove} onChange={(e) => setAutoRemove(parseInt(e.target.value) || 0)} className="path-input" />
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '10px' }}>
              <button className="btn-primary" style={{ background: '#555', boxShadow: 'none' }} onClick={() => setIsModalOpen(false)}>Cancel</button>
              <button className="btn-primary" onClick={handleCopyConfirm}>Start Copy</button>
            </div>
          </div>
        </div>
      )}

      {isConfigModalOpen && (
        <div className="overlay">
          <div className="modal" style={{ width: '600px' }}>
            <h2>Rclone Configuration</h2>
            {!configDetails ? (
              <div style={{ padding: '20px', textAlign: 'center', color: '#888' }}>Loading config details natively from the server...</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div className="modal-input">
                  <label>Config Path</label>
                  <input className="path-input" readOnly value={configDetails.path} />
                </div>
                {configDetails.error ? (
                  <div style={{ color: 'var(--danger)', padding: '10px', background: 'rgba(255,0,0,0.1)', borderRadius: '8px' }}>
                    {configDetails.error}
                  </div>
                ) : (
                  <div className="modal-input">
                    <label>Config Dump</label>
                    <textarea className="path-input" readOnly value={configDetails.dump} style={{ height: '200px', resize: 'vertical', fontFamily: 'monospace' }} />
                  </div>
                )}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px' }}>
              <button className="btn-primary" onClick={() => setIsConfigModalOpen(false)}>Close Debugger</button>
            </div>
          </div>
        </div>
      )}

      {mkdirState && (
        <div className="overlay">
          <div className="modal">
            <h2>Create New Folder</h2>
            <div className="modal-input">
              <label>Folder Name</label>
              <input
                type="text"
                value={mkdirFolderName}
                onChange={(e) => setMkdirFolderName(e.target.value)}
                className="path-input"
                placeholder="New folder name..."
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleMkdir(); }}
              />
            </div>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '10px' }}>
              <button className="btn-primary" style={{ background: '#555', boxShadow: 'none' }} onClick={() => { setMkdirState(null); setMkdirFolderName(''); }}>Cancel</button>
              <button className="btn-primary" onClick={handleMkdir}>Create</button>
            </div>
          </div>
        </div>
      )}

      {Object.keys(activeJobs).length > 0 && (
        <div className="bottom-panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <h3 style={{ color: '#fff', margin: 0 }}>Copy Jobs</h3>
            <button className="btn-primary" style={{ padding: '6px 12px', fontSize: '0.8rem' }} onClick={() => {
              fetchFiles(leftRemote, leftPath, setLeftFiles, setLeftLoading);
              fetchFiles(rightRemote, rightPath, setRightFiles, setRightLoading);
            }}>Refresh Folders</button>
          </div>

          {runningJobs.length > 1 && (
            <div className="jobs-summary-card" style={{
              background: 'rgba(102, 252, 241, 0.03)',
              border: '1px solid rgba(102, 252, 241, 0.15)',
              borderRadius: '8px',
              padding: '10px 14px',
              marginBottom: '10px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontSize: '0.8rem',
            }}>
              <div style={{ fontWeight: 600, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span className="pulse-dot" style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--accent)', display: 'inline-block' }}></span>
                Aggregate Summary ({runningJobs.length} running)
              </div>
              <div style={{ display: 'flex', gap: '16px', color: '#aaa' }}>
                <div>Avg Speed: <strong style={{ color: '#fff' }}>{avgSpeedFormatted}</strong></div>
                <div>Max Elapsed: <strong style={{ color: '#fff' }}>{maxElapsedFormatted}</strong></div>
                <div>Total Remaining: <strong style={{ color: '#fff' }}>{totalRemainingFormatted}</strong></div>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {Object.values(activeJobs).map(job => (
              <div key={job.id} className="job-item" style={{ flexDirection: 'column', alignItems: 'stretch', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', minWidth: 0 }}>
                  <div className="job-item-info" style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.85rem', color: '#ccc', marginBottom: '6px', minWidth: 0 }}>
                      <span style={{ maxWidth: '70%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${job.source} ➡️ ${job.destination}`}>
                        {getFileName(job.source)} ➡️ {getFileName(job.destination)}
                      </span>
                      <span style={{ color: job.status === 'error' ? 'var(--danger)' : '#aaa', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '30%', marginLeft: '10px' }} title={job.progress}>
                        {job.progress}
                      </span>
                    </div>
                    <div className="progress-bar-container">
                      <div className="progress-bar-fill" style={{ width: `${job.progress.match(/([0-9.]+)%/)?.[1] || (job.status === 'completed' ? 100 : 0)}%`, background: job.status === 'error' ? 'var(--danger)' : 'var(--accent)' }}></div>
                    </div>
                    {(job.elapsedTime || job.speed || job.eta) && (
                      <div style={{ display: 'flex', gap: '15px', fontSize: '0.75rem', color: '#8892b0', marginTop: '6px' }}>
                        {job.elapsedTime && (
                          <span>Elapsed: <span style={{ color: '#ccc' }}>{job.elapsedTime}</span></span>
                        )}
                        {job.status === 'running' && job.speed && (
                          <span>Speed: <span style={{ color: '#ccc' }}>{job.speed}</span></span>
                        )}
                        {job.status === 'running' && job.eta && (
                          <span>Remaining: <span style={{ color: '#ccc' }}>{job.eta}</span></span>
                        )}
                      </div>
                    )}
                    {job.status === 'error' && job.error && (
                      <div style={{ fontSize: '0.75rem', color: 'var(--danger)', marginTop: '6px', padding: '4px 8px', background: 'rgba(255,0,0,0.1)', borderRadius: '4px', borderLeft: '2px solid var(--danger)', wordBreak: 'break-all' }}>
                        {job.error}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                    {job.status === 'running' && (
                      <button className="btn-primary" style={{ background: 'var(--danger)', padding: '6px 12px', fontSize: '0.8rem', boxShadow: 'none' }} onClick={() => handleStopJob(job.id)}>Stop</button>
                    )}
                    {job.status === 'error' && (
                      <>
                        <button className="btn-primary" style={{ background: 'var(--accent)', color: 'var(--bg-primary)', padding: '6px 12px', fontSize: '0.8rem', boxShadow: 'none' }} onClick={() => handleRestartJob(job.id)}>Restart</button>
                        <button className="btn-primary" style={{ background: '#555', color: '#fff', padding: '6px 12px', fontSize: '0.8rem', boxShadow: 'none' }} onClick={() => handleDismissJob(job.id)}>Dismiss</button>
                      </>
                    )}
                    {job.status === 'completed' && (
                      <button className="btn-primary" style={{ background: '#555', color: '#fff', padding: '6px 12px', fontSize: '0.8rem', boxShadow: 'none' }} onClick={() => handleDismissJob(job.id)}>Dismiss</button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
