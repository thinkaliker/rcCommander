import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowLeftRight, ArrowRight, Monitor, Moon, RotateCcw,
  Settings2, Square, Sun, X,
} from 'lucide-react';
import './App.css';
import { Pane } from './components/Pane';
import type { DragItem, DragPayload, DropTarget } from './components/Pane';
import { API_BASE, apiGet, apiPost, remotePath } from './api';
import {
  fileName, formatDuration, formatSpeed, parseDuration, parseSpeed, progressPercent,
} from './format';
import { usePane } from './usePane';
import { useTheme } from './useTheme';
import type { ThemeChoice } from './useTheme';
import { clampAutoRefresh, clampAutoRemove, clampThreads, useSettings } from './useSettings';
import type { CopyJob } from './types';

const LOCAL = 'Local Filesystem';

/** One pane-to-pane transfer, before the thread/auto-remove numbers are applied. */
interface CopyRequest {
  sourceRemote: string;
  sourcePath: string;
  destRemote: string;
  destPath: string;
  items: DragItem[];
}

const THEMES: { id: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { id: 'light', label: 'Light theme', Icon: Sun },
  { id: 'dark', label: 'Dark theme', Icon: Moon },
  { id: 'auto', label: 'Match system theme', Icon: Monitor },
];

function App() {
  const [remotes, setRemotes] = useState<string[]>([LOCAL]);
  // Panes hold off on their first listing until the remote list has arrived,
  // so the right pane never shows Local Filesystem and then jump to a remote.
  const [remotesReady, setRemotesReady] = useState(false);

  const [settings, setSettings] = useSettings();

  const left = usePane(remotesReady, settings.autoRefresh, settings.perPaneRefresh);
  const right = usePane(remotesReady, settings.autoRefresh, settings.perPaneRefresh);

  const [activeJobs, setActiveJobs] = useState<Record<string, CopyJob>>({});
  const [isConnected, setIsConnected] = useState(true);
  const [theme, setTheme] = useTheme();

  // The transfer waiting on the confirm dialog, and the numbers that dialog is
  // editing — a draft, so an override here does not rewrite the saved defaults.
  const [pendingCopy, setPendingCopy] = useState<CopyRequest | null>(null);
  const [draftThreads, setDraftThreads] = useState(settings.threads);
  const [draftAutoRemove, setDraftAutoRemove] = useState(settings.autoRemove);
  const [configDetails, setConfigDetails] = useState<{ path: string; dump: string; error?: string } | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [mkdirTarget, setMkdirTarget] = useState<{ remote: string; path: string; side: 'left' | 'right' } | null>(null);
  const [mkdirName, setMkdirName] = useState('');
  const [mkdirError, setMkdirError] = useState('');

  const setRightRemote = right.setRemote;

  // Forward browser-side errors to the server log.
  useEffect(() => {
    const post = (level: string, message: string, data?: unknown) => {
      fetch(`${API_BASE}/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level, message, data }),
        keepalive: true,
      }).catch(() => {});
    };

    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = (...args) => { post('error', args.map(String).join(' ')); originalError(...args); };
    console.warn = (...args) => { post('warn', args.map(String).join(' ')); originalWarn(...args); };

    const onError = (e: ErrorEvent) =>
      post('error', `Uncaught Error: ${e.message}`, { filename: e.filename, lineno: e.lineno });
    window.addEventListener('error', onError);

    return () => {
      console.error = originalError;
      console.warn = originalWarn;
      window.removeEventListener('error', onError);
    };
  }, []);

  // Load remotes once, pick the right pane's default, then release both panes
  // in the same render so each fetches exactly once with its final target.
  useEffect(() => {
    let cancelled = false;
    apiGet<{ remotes?: string[] }>('/remotes')
      .then(data => {
        if (cancelled) return;
        // All three updates in one callback so React batches them into a
        // single render: the panes are released already pointing at their
        // final remote, so neither lists a directory it is about to leave.
        const list = data.remotes?.length ? data.remotes : [LOCAL];
        setRemotes(list);
        if (list.length > 1) setRightRemote(list[1]);
        setRemotesReady(true);
      })
      .catch(err => {
        if (cancelled) return;
        console.error(err);
        setRemotesReady(true);
      });
    return () => { cancelled = true; };
  }, [setRightRemote]);

  // Jobs the user dismissed locally, held back until the server drops them
  // too — otherwise an already in-flight poll resurrects the removed row.
  const dismissed = useRef<Set<string>>(new Set());

  useEffect(() => {
    let stopped = false;
    let inFlight = false;

    const poll = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        const data = await apiGet<{ jobs?: Record<string, CopyJob> }>('/copy/status');
        if (stopped) return;
        setIsConnected(true);
        const jobs = { ...(data.jobs ?? {}) };
        for (const id of dismissed.current) {
          if (id in jobs) delete jobs[id];
          else dismissed.current.delete(id);
        }
        setActiveJobs(jobs);
      } catch {
        // Deliberately not logged: while the server is down this fires once a
        // second and would flood the very log endpoint that is unreachable.
        if (!stopped) setIsConnected(false);
      } finally {
        inFlight = false;
      }
    };

    poll();
    const timer = setInterval(poll, 1000);
    document.addEventListener('visibilitychange', poll);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, []);

  const startCopy = useCallback(async (
    source: string, destination: string, threads: number, autoRemoveSeconds: number,
  ) => {
    try {
      await apiPost('/copy', { source, destination, threads, autoRemoveSeconds });
    } catch (e) {
      console.error(e);
    }
  }, []);

  const runCopy = async (request: CopyRequest, threads: number, autoRemove: number) => {
    await Promise.all(request.items.map(item => startCopy(
      remotePath(request.sourceRemote, request.sourcePath, item.name),
      // A folder keeps its own name at the destination; a file is copied into
      // the destination directory itself.
      remotePath(request.destRemote, request.destPath, item.isDir ? item.name : ''),
      threads,
      autoRemove,
    )));

    // Only the pane the items actually came from loses its ticks — the other
    // pane may be showing an unrelated selection of its own.
    for (const pane of [left, right]) {
      if (pane.remote === request.sourceRemote && pane.path === request.sourcePath) pane.clearSelection();
    }
  };

  // Every transfer funnels through here, so the saved defaults and the
  // "ask every time" choice apply to the arrow buttons and to drag and drop alike.
  const requestCopy = (request: CopyRequest) => {
    if (request.items.length === 0) return;
    if (settings.askEveryTime) {
      setDraftThreads(settings.threads);
      setDraftAutoRemove(settings.autoRemove);
      setPendingCopy(request);
      return;
    }
    runCopy(request, settings.threads, settings.autoRemove);
  };

  const handlePaneCopy = (direction: 'L2R' | 'R2L') => {
    const src = direction === 'L2R' ? left : right;
    const dest = direction === 'L2R' ? right : left;
    requestCopy({
      sourceRemote: src.remote,
      sourcePath: src.path,
      destRemote: dest.remote,
      destPath: dest.path,
      items: Array.from(src.selected).map(name => ({
        name,
        isDir: src.files.find(f => f.Name === name)?.IsDir ?? false,
      })),
    });
  };

  const handleCopyConfirm = () => {
    const request = pendingCopy;
    setPendingCopy(null);
    if (request) runCopy(request, draftThreads, draftAutoRemove);
  };

  const handleDragAndDrop = (source: DragPayload, dest: DropTarget) => {
    requestCopy({
      sourceRemote: source.sourceRemote,
      sourcePath: source.sourcePath,
      destRemote: dest.destRemote,
      destPath: dest.destPath,
      items: source.items,
    });
  };

  const openSettings = async () => {
    setIsSettingsOpen(true);
    setConfigDetails(null);
    try {
      const data = await apiGet<{ path: string; dump: string; error?: string }>('/config');
      setConfigDetails(data.error
        ? { path: 'Error executing rclone config', dump: '', error: data.error }
        : { path: data.path, dump: data.dump });
    } catch (e) {
      setConfigDetails({ path: 'Network/server error', dump: '', error: (e as Error).message });
    }
  };

  const jobAction = async (endpoint: string, jobId: string) => {
    try {
      await apiPost(endpoint, { jobId });
    } catch (e) {
      console.error(e);
    }
  };

  const handleDismissJob = (jobId: string) => {
    dismissed.current.add(jobId);
    setActiveJobs(prev => {
      const next = { ...prev };
      delete next[jobId];
      return next;
    });
    jobAction('/copy/remove', jobId);
  };

  const handleMkdir = async () => {
    if (!mkdirTarget || !mkdirName.trim()) return;
    try {
      await apiPost('/mkdir', {
        remote: mkdirTarget.remote,
        pathParam: mkdirTarget.path,
        folderName: mkdirName.trim(),
      });
      const pane = mkdirTarget.side === 'left' ? left : right;
      setMkdirTarget(null);
      setMkdirName('');
      setMkdirError('');
      // Only refresh if the pane still shows the folder we created in.
      if (pane.remote === mkdirTarget.remote && pane.path === mkdirTarget.path) pane.refresh(true);
    } catch (e) {
      setMkdirError((e as Error).message);
    }
  };

  const jobs = Object.values(activeJobs);
  const running = jobs.filter(job => job.status === 'running');

  let totalSpeed = 0;
  let maxElapsed = 0;
  let totalRemaining = 0;
  let hasETA = false;
  for (const job of running) {
    totalSpeed += parseSpeed(job.speed);
    maxElapsed = Math.max(maxElapsed, parseDuration(job.elapsedTime) ?? 0);
    const eta = parseDuration(job.eta);
    if (eta !== null) {
      hasETA = true;
      totalRemaining += eta;
    }
  }
  const avgSpeed = running.length > 0 ? totalSpeed / running.length : 0;

  const pendingCount = pendingCopy?.items.length ?? 0;

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><ArrowLeftRight size={19} /></span>
          <h1>rclone<span>Commander</span></h1>
          <span className={`status-pill${isConnected ? '' : ' is-offline'}`}>
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        <div className="header-actions">
          <div className="theme-switch" role="group" aria-label="Colour theme">
            {THEMES.map(({ id, label, Icon }) => (
              <button
                key={id}
                className={`theme-switch-btn${theme === id ? ' is-active' : ''}`}
                title={label}
                aria-label={label}
                aria-pressed={theme === id}
                onClick={() => setTheme(id)}
              >
                <Icon size={14} />
              </button>
            ))}
          </div>
          <button className="btn btn-sm btn-ghost" onClick={openSettings}>
            <Settings2 size={14} /> Settings
          </button>
        </div>
      </header>

      <main className="workspace">
        <Pane
          pane={left}
          remotes={remotes}
          onDropFile={handleDragAndDrop}
          showAutoRefresh={settings.perPaneRefresh}
          onNewFolder={() => {
            setMkdirTarget({ remote: left.remote, path: left.path, side: 'left' });
            setMkdirName('');
            setMkdirError('');
          }}
        />

        <div className="transfer-controls">
          <button
            className="btn-round"
            title="Copy left pane selection to the right"
            aria-label="Copy left pane selection to the right"
            disabled={left.selected.size === 0}
            onClick={() => handlePaneCopy('L2R')}
          >
            <ArrowRight size={20} />
          </button>
          <button
            className="btn-round"
            title="Copy right pane selection to the left"
            aria-label="Copy right pane selection to the left"
            disabled={right.selected.size === 0}
            onClick={() => handlePaneCopy('R2L')}
          >
            <ArrowLeft size={20} />
          </button>
        </div>

        <Pane
          pane={right}
          remotes={remotes}
          onDropFile={handleDragAndDrop}
          showAutoRefresh={settings.perPaneRefresh}
          onNewFolder={() => {
            setMkdirTarget({ remote: right.remote, path: right.path, side: 'right' });
            setMkdirName('');
            setMkdirError('');
          }}
        />
      </main>

      {jobs.length > 0 && (
        <section className="jobs-panel">
          <div className="jobs-panel-header">
            <h2>Copy Jobs</h2>
          </div>

          {running.length > 1 && (
            <div className="jobs-summary">
              <span className="jobs-summary-title">
                <span className="pulse-dot" />
                {running.length} running
              </span>
              <span className="jobs-summary-stats">
                <span>Avg speed <strong>{formatSpeed(avgSpeed)}</strong></span>
                <span>Max elapsed <strong>{formatDuration(maxElapsed)}</strong></span>
                <span>Total remaining <strong>{hasETA ? formatDuration(totalRemaining) : '—'}</strong></span>
              </span>
            </div>
          )}

          <div className="jobs-list">
            {jobs.map(job => (
              <article key={job.id} className={`job is-${job.status}`}>
                <div className="job-info">
                  <div className="job-title">
                    <span className="job-route" title={`${job.source} → ${job.destination}`}>
                      {fileName(job.source)} → {fileName(job.destination)}
                    </span>
                    <span className="job-progress-text" title={job.progress}>{job.progress}</span>
                  </div>

                  <div className="progress-track">
                    <div
                      className="progress-fill"
                      style={{ width: `${progressPercent(job.progress, job.status)}%` }}
                    />
                  </div>

                  <div className="job-stats">
                    {job.elapsedTime && <span>Elapsed <strong>{job.elapsedTime}</strong></span>}
                    {job.status === 'running' && job.speed && <span>Speed <strong>{job.speed}</strong></span>}
                    {job.status === 'running' && job.eta && <span>Remaining <strong>{job.eta}</strong></span>}
                  </div>

                  {job.status === 'error' && job.error && (
                    <div className="job-error">{job.error}</div>
                  )}
                </div>

                <div className="job-actions">
                  {job.status === 'running' && (
                    <button className="btn btn-sm btn-danger" onClick={() => jobAction('/copy/stop', job.id)}>
                      <Square size={12} /> Stop
                    </button>
                  )}
                  {job.status === 'error' && (
                    <button className="btn btn-sm" onClick={() => jobAction('/copy/restart', job.id)}>
                      <RotateCcw size={12} /> Restart
                    </button>
                  )}
                  {job.status !== 'running' && (
                    <button className="btn btn-sm btn-ghost" onClick={() => handleDismissJob(job.id)}>
                      <X size={12} /> Dismiss
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {pendingCopy && (
        <div className="overlay" onClick={() => setPendingCopy(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Confirm Copy</h2>
            <p>
              Copy {pendingCount} item{pendingCount === 1 ? '' : 's'} from{' '}
              <strong>{remotePath(pendingCopy.sourceRemote, pendingCopy.sourcePath)}</strong> to{' '}
              <strong>{remotePath(pendingCopy.destRemote, pendingCopy.destPath)}</strong>?
            </p>

            <div className="field">
              <label htmlFor="threads">Parallel transfers</label>
              <input
                id="threads" className="input" type="number" min="1" max="16"
                value={draftThreads}
                onChange={e => setDraftThreads(clampThreads(parseInt(e.target.value)))}
              />
            </div>

            <div className="field">
              <label htmlFor="auto-remove">Auto-remove completed after (seconds, 0 to keep)</label>
              <input
                id="auto-remove" className="input" type="number" min="0" max="3600"
                value={draftAutoRemove}
                onChange={e => setDraftAutoRemove(clampAutoRemove(parseInt(e.target.value)))}
              />
            </div>

            <p className="modal-note">
              These apply to this transfer only. Change the defaults under Settings.
            </p>

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setPendingCopy(null)}>Cancel</button>
              <button className="btn" onClick={handleCopyConfirm}>Start Copy</button>
            </div>
          </div>
        </div>
      )}

      {isSettingsOpen && (
        <div className="overlay" onClick={() => setIsSettingsOpen(false)}>
          <div className="modal is-wide" onClick={e => e.stopPropagation()}>
            <h2>Settings</h2>

            <h3 className="modal-section">Transfer defaults</h3>

            <div className="field">
              <label htmlFor="default-threads">Parallel transfers</label>
              <input
                id="default-threads" className="input" type="number" min="1" max="16"
                value={settings.threads}
                onChange={e => setSettings(prev => ({ ...prev, threads: clampThreads(parseInt(e.target.value)) }))}
              />
            </div>

            <div className="field">
              <label htmlFor="default-auto-remove">Auto-remove completed after (seconds, 0 to keep)</label>
              <input
                id="default-auto-remove" className="input" type="number" min="0" max="3600"
                value={settings.autoRemove}
                onChange={e => setSettings(prev => ({ ...prev, autoRemove: clampAutoRemove(parseInt(e.target.value)) }))}
              />
            </div>

            <label className="field-check" htmlFor="ask-every-time">
              <input
                id="ask-every-time"
                type="checkbox"
                className="checkbox"
                checked={settings.askEveryTime}
                onChange={e => setSettings(prev => ({ ...prev, askEveryTime: e.target.checked }))}
              />
              <span>
                Ask every time
                <small>Confirm each transfer and let these numbers be changed for that one copy.</small>
              </span>
            </label>

            <h3 className="modal-section">Folder listings</h3>

            <div className="field">
              <label htmlFor="auto-refresh">Auto-refresh both panes every (seconds, 0 to disable)</label>
              <input
                id="auto-refresh" className="input" type="number" min="0" max="3600"
                value={settings.autoRefresh}
                onChange={e => setSettings(prev => ({ ...prev, autoRefresh: clampAutoRefresh(parseInt(e.target.value)) }))}
              />
            </div>

            <label className="field-check" htmlFor="per-pane-refresh">
              <input
                id="per-pane-refresh"
                type="checkbox"
                className="checkbox"
                checked={settings.perPaneRefresh}
                onChange={e => setSettings(prev => ({ ...prev, perPaneRefresh: e.target.checked }))}
              />
              <span>
                Set per pane
                <small>Show each pane its own auto-refresh control, starting from the interval above.</small>
              </span>
            </label>

            <h3 className="modal-section">Rclone configuration</h3>

            {!configDetails ? (
              <div className="pane-empty">Loading config from the server…</div>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="config-path">Config path</label>
                  <input id="config-path" className="input" readOnly value={configDetails.path} />
                </div>
                {configDetails.error ? (
                  <div className="alert-error">{configDetails.error}</div>
                ) : (
                  <div className="field">
                    <label htmlFor="config-dump">Config dump</label>
                    <textarea id="config-dump" className="input config-dump" readOnly value={configDetails.dump} />
                  </div>
                )}
              </>
            )}

            <div className="modal-actions">
              <button className="btn" onClick={() => setIsSettingsOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {mkdirTarget && (
        <div className="overlay" onClick={() => setMkdirTarget(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Create New Folder</h2>
            <div className="field">
              <label htmlFor="folder-name">Folder name</label>
              <input
                id="folder-name" className="input" autoFocus
                value={mkdirName}
                placeholder="New folder"
                onChange={e => { setMkdirName(e.target.value); setMkdirError(''); }}
                onKeyDown={e => { if (e.key === 'Enter') handleMkdir(); }}
              />
            </div>
            {mkdirError && <div className="alert-error">{mkdirError}</div>}
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => { setMkdirTarget(null); setMkdirName(''); setMkdirError(''); }}>Cancel</button>
              <button className="btn" disabled={!mkdirName.trim()} onClick={handleMkdir}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
