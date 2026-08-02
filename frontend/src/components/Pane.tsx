import React, { useState } from 'react';
import { CornerLeftUp, File, Folder, FolderPlus, Minus, Plus, RefreshCw } from 'lucide-react';
import { formatBytes } from '../format';
import type { PaneState } from '../usePane';
import type { RcloneFile } from '../types';

export interface DragPayload {
  sourceRemote: string;
  sourcePath: string;
  fileName: string;
  isDir: boolean;
}

export interface DropTarget {
  destRemote: string;
  destPath: string;
}

interface PaneProps {
  pane: PaneState;
  remotes: string[];
  onDropFile: (source: DragPayload, dest: DropTarget) => void;
  onNewFolder: () => void;
}

const joinPath = (base: string, name: string) => {
  if (base === '' || base === '/') return base === '/' ? `/${name}` : name;
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
};

export const Pane: React.FC<PaneProps> = ({ pane, remotes, onDropFile, onNewFolder }) => {
  const [pathInput, setPathInput] = useState(pane.path);
  const [syncedPath, setSyncedPath] = useState(pane.path);
  const [isDragOver, setIsDragOver] = useState(false);

  // Reset the draft during render (not in an effect) when navigation changes
  // the pane's path, so the box never paints a stale value for a frame.
  if (syncedPath !== pane.path) {
    setSyncedPath(pane.path);
    setPathInput(pane.path);
  }

  const navigate = (file: RcloneFile) => {
    // Ignore clicks while a listing is in flight: the row belongs to the
    // folder we are leaving, so joining its name would build a path under a
    // directory we have already navigated past.
    if (pane.loading) return;
    if (file.IsDir) pane.setPath(joinPath(pane.path, file.Name));
  };

  const goUp = () => {
    if (pane.path === '' || pane.path === '/') return;
    const parts = pane.path.split('/');
    parts.pop();
    const next = parts.join('/');
    pane.setPath(pane.remote === 'Local Filesystem' && next === '' ? '/' : next);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const raw = e.dataTransfer.getData('application/json');
    if (!raw) return;
    try {
      const data: DragPayload = JSON.parse(raw);
      if (data.sourceRemote === pane.remote && data.sourcePath === pane.path) return;
      onDropFile(data, { destRemote: pane.remote, destPath: pane.path });
    } catch {
      /* not one of our drags */
    }
  };

  const atRoot = pane.path === '' || pane.path === '/';
  const allSelected = pane.files.length > 0 && pane.files.every(f => pane.selected.has(f.Name));

  return (
    <section
      className={`pane${isDragOver ? ' is-drop-target' : ''}`}
      onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="pane-header">
        <select
          className="select"
          aria-label="Remote"
          value={pane.remote}
          onChange={e => pane.setRemote(e.target.value)}
        >
          {remotes.map(remote => (
            <option key={remote} value={remote}>{remote}</option>
          ))}
        </select>
        <input
          className="input"
          aria-label="Path"
          value={pathInput}
          placeholder="Path…"
          onChange={e => setPathInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') pane.setPath(pathInput); }}
        />
      </div>

      <div className="pane-toolbar">
        <div className="pane-toolbar-actions">
          <button className="btn-link" onClick={() => pane.refresh(true)}>
            <RefreshCw size={13} /> Refresh
          </button>
          <button className="btn-link is-accent" onClick={onNewFolder}>
            <FolderPlus size={13} /> New Folder
          </button>
        </div>
        <div className="stepper-label">
          <label htmlFor={`auto-${pane.remote}`}>Auto-refresh (s)</label>
          <div className="stepper">
            <button aria-label="Decrease" onClick={() => pane.setAutoRefresh(Math.max(0, pane.autoRefresh - 1))}>
              <Minus size={12} />
            </button>
            <input
              id={`auto-${pane.remote}`}
              type="number"
              min="0"
              value={pane.autoRefresh}
              onChange={e => pane.setAutoRefresh(Math.max(0, parseInt(e.target.value) || 0))}
            />
            <button aria-label="Increase" onClick={() => pane.setAutoRefresh(pane.autoRefresh + 1)}>
              <Plus size={12} />
            </button>
          </div>
        </div>
      </div>

      <div className="file-list">
        {pane.loading && pane.files.length === 0 ? (
          <div className="pane-empty">Loading…</div>
        ) : (
          <>
            <div className="file-row is-header">
              <input
                type="checkbox"
                className="checkbox"
                aria-label="Select all"
                checked={allSelected}
                onChange={e => pane.toggleAll(pane.files.map(f => f.Name), e.target.checked)}
              />
              <span className="file-name">
                Select all · {pane.files.length} item{pane.files.length === 1 ? '' : 's'}
              </span>
            </div>

            {!atRoot && (
              <div className="file-row is-dir" onClick={goUp} onDrop={handleDrop}>
                <span className="checkbox" style={{ visibility: 'hidden' }} />
                <span className="file-icon"><CornerLeftUp size={16} /></span>
                <span className="file-name">..</span>
              </div>
            )}

            {pane.files.map(file => (
              <div
                key={file.Name}
                className={`file-row${file.IsDir ? ' is-dir' : ''}${pane.selected.has(file.Name) ? ' is-selected' : ''}`}
                draggable
                onDragStart={e => e.dataTransfer.setData('application/json', JSON.stringify({
                  sourceRemote: pane.remote,
                  sourcePath: pane.path,
                  fileName: file.Name,
                  isDir: file.IsDir,
                }))}
                onClick={e => {
                  if ((e.target as HTMLElement).tagName === 'INPUT') return;
                  if (file.IsDir) navigate(file);
                  else pane.toggleFile(file.Name);
                }}
              >
                <input
                  type="checkbox"
                  className="checkbox"
                  aria-label={`Select ${file.Name}`}
                  checked={pane.selected.has(file.Name)}
                  onChange={() => pane.toggleFile(file.Name)}
                />
                <span className="file-icon">
                  {file.IsDir ? <Folder size={16} /> : <File size={16} />}
                </span>
                <span className="file-name" title={file.Name}>{file.Name}</span>
                {!file.IsDir && <span className="file-size">{formatBytes(file.Size)}</span>}
              </div>
            ))}

            {pane.files.length === 0 && (
              pane.error
                ? <div className="pane-empty is-error">{pane.error}</div>
                : <div className="pane-empty">This folder is empty.</div>
            )}
          </>
        )}
      </div>
    </section>
  );
};
