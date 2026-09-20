import React, { useRef, useState } from 'react';
import {
  CornerLeftUp, Download, File, Folder, FolderPlus, Minus, Plus, RefreshCw, Upload,
} from 'lucide-react';
import { formatBytes } from '../format';
import type { UploadTask } from '../api';
import type { PaneState } from '../usePane';
import type { RcloneFile } from '../types';

export interface DragItem {
  name: string;
  isDir: boolean;
}

export interface DragPayload {
  sourceRemote: string;
  sourcePath: string;
  items: DragItem[];
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
  /** Files picked from the desktop — dropped onto the pane or chosen in the file dialog. */
  onUploadFiles: (tasks: UploadTask[], dest: DropTarget) => void;
  onDownload: () => void;
  /** Off by default: the auto-refresh interval is a global setting unless the
      user opts into setting it per pane. */
  showAutoRefresh: boolean;
}

const joinPath = (base: string, name: string) => {
  if (base === '' || base === '/') return base === '/' ? `/${name}` : name;
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
};

/** readEntries hands back at most a batch at a time; keep asking until it is empty. */
const readAllEntries = (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> =>
  new Promise((resolve, reject) => reader.readEntries(resolve, reject));

/**
 * Flatten a desktop drop into upload tasks, walking into any dropped folders so
 * their structure survives the transfer.
 *
 * The DataTransfer is emptied as soon as the drop handler returns, so every
 * entry has to be taken off it before the first `await` — which is exactly what
 * the synchronous prelude below does.
 */
async function collectDropFiles(dt: DataTransfer): Promise<UploadTask[]> {
  const roots: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  // No entry API (or a drag that carries plain files only): the flat list of
  // files is still enough for everything but folders.
  if (roots.length === 0) {
    return Array.from(dt.files).map(file => ({ file, relPath: file.name }));
  }

  const tasks: UploadTask[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject)
      );
      tasks.push({ file, relPath: `${prefix}${entry.name}` });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await readAllEntries(reader);
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
    }
  };

  for (const entry of roots) await walk(entry, '');
  return tasks;
}

export const Pane: React.FC<PaneProps> = ({
  pane, remotes, onDropFile, onNewFolder, onUploadFiles, onDownload, showAutoRefresh,
}) => {
  const [pathInput, setPathInput] = useState(pane.path);
  const [syncedPath, setSyncedPath] = useState(pane.path);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

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
    const dt = e.dataTransfer;

    // A drag from the other pane carries our own payload; anything else that
    // brings files along came from the desktop and is an upload.
    const raw = dt.getData('application/json');
    if (raw) {
      try {
        const data: DragPayload = JSON.parse(raw);
        if (!Array.isArray(data.items) || data.items.length === 0) return;
        if (data.sourceRemote === pane.remote && data.sourcePath === pane.path) return;
        onDropFile(data, { destRemote: pane.remote, destPath: pane.path });
      } catch {
        /* not one of our drags */
      }
      return;
    }

    if (!Array.from(dt.types).includes('Files')) return;
    const dest = { destRemote: pane.remote, destPath: pane.path };
    collectDropFiles(dt)
      .then(tasks => { if (tasks.length > 0) onUploadFiles(tasks, dest); })
      .catch(err => console.error(`Could not read the dropped files: ${(err as Error).message}`));
  };

  const handlePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    // Clear it first, so picking the same file twice in a row still fires.
    e.target.value = '';
    if (picked.length === 0) return;
    onUploadFiles(
      picked.map(file => ({ file, relPath: file.name })),
      { destRemote: pane.remote, destPath: pane.path },
    );
  };

  // Dragging a row that is part of the selection moves the whole selection;
  // dragging an unselected row moves just that row and leaves the selection
  // alone, which is how desktop file managers behave.
  const handleDragStart = (e: React.DragEvent, file: RcloneFile) => {
    const items: DragItem[] = pane.selected.has(file.Name)
      ? pane.files.filter(f => pane.selected.has(f.Name)).map(f => ({ name: f.Name, isDir: f.IsDir }))
      : [{ name: file.Name, isDir: file.IsDir }];
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('application/json', JSON.stringify({
      sourceRemote: pane.remote,
      sourcePath: pane.path,
      items,
    }));
  };

  const atRoot = pane.path === '' || pane.path === '/';
  const allSelected = pane.files.length > 0 && pane.files.every(f => pane.selected.has(f.Name));
  // Folders count too: a selection of more than one item is packed into an
  // archive, and a folder contributes its whole tree.
  const picked = pane.files.filter(f => pane.selected.has(f.Name));
  const pickedFolders = picked.filter(f => f.IsDir).length;

  return (
    <section
      className={`pane${isDragOver ? ' is-drop-target' : ''}`}
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setIsDragOver(true); }}
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
          <button
            className="btn-link is-accent"
            title="Upload files from this computer into the current folder"
            onClick={() => fileInput.current?.click()}
          >
            <Upload size={13} /> Upload
          </button>
          <button
            className="btn-link"
            disabled={picked.length === 0}
            title={picked.length === 0
              ? 'Select files or folders to download'
              : picked.length === 1 && pickedFolders === 0
                ? 'Download the selected file'
                : `Download ${picked.length} selected item${picked.length === 1 ? '' : 's'} as a .zip${
                    pickedFolders > 0 ? ' (folders included, with their contents)' : ''}`}
            onClick={onDownload}
          >
            <Download size={13} /> Download
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            aria-hidden="true"
            onChange={handlePicked}
          />
        </div>
        {showAutoRefresh && (
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
        )}
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
              <div className="file-row is-dir" onClick={goUp}>
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
                onDragStart={e => handleDragStart(e, file)}
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
