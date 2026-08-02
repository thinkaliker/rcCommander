import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, remotePath } from './api';
import type { RcloneFile } from './types';

export interface PaneState {
  remote: string;
  path: string;
  files: RcloneFile[];
  selected: Set<string>;
  loading: boolean;
  error: string | null;
  autoRefresh: number;
  setRemote: (remote: string) => void;
  setPath: (path: string) => void;
  setAutoRefresh: (seconds: number) => void;
  toggleFile: (name: string) => void;
  toggleAll: (names: string[], select: boolean) => void;
  clearSelection: () => void;
  refresh: (silent?: boolean) => void;
}

const sortFiles = (files: RcloneFile[]) =>
  [...files].sort((a, b) =>
    a.IsDir === b.IsDir ? a.Name.localeCompare(b.Name) : a.IsDir ? -1 : 1
  );

/**
 * State for one file browser pane.
 *
 * `ready` gates the first listing until the remote list has loaded, so the
 * pane never renders one remote's contents and then swaps to another a beat
 * later. Listings are guarded by a monotonic request id: navigating away or
 * an overlapping auto-refresh means only the newest response is allowed to
 * write state, so a slow earlier reply can't clobber the current directory.
 */
export function usePane(ready: boolean): PaneState {
  const [remote, setRemote] = useState('Local Filesystem');
  const [path, setPath] = useState('');
  const [files, setFiles] = useState<RcloneFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(0);

  const requestId = useRef(0);

  const load = useCallback(async (silent = false) => {
    const id = ++requestId.current;
    if (!silent) {
      setLoading(true);
      // Drop the previous folder's rows the moment we navigate. Leaving them
      // up while the new listing is in flight lets a click land on a stale
      // entry, which appends that name onto the path we already moved to —
      // most obvious on a slow remote, or a folder that turns out to be empty
      // and so never replaces the rows with anything of its own.
      setFiles([]);
      setError(null);
    }
    try {
      const data = await apiGet<{ files?: RcloneFile[] }>(
        `/files?path=${encodeURIComponent(remotePath(remote, path))}`
      );
      if (id !== requestId.current) return;
      setFiles(sortFiles(data.files ?? []));
      setError(null);
    } catch (err) {
      if (id !== requestId.current) return;
      console.error(err);
      // A failed background refresh keeps the last good listing; a failed
      // navigation has nothing valid left to show.
      if (!silent) setFiles([]);
      setError((err as Error).message || 'Could not list this folder.');
    } finally {
      // Only the newest request may clear the spinner; a superseded response
      // landing late must not make an in-flight navigation look finished.
      if (id === requestId.current) setLoading(false);
    }
  }, [remote, path]);

  useEffect(() => {
    if (!ready) return;
    setSelected(new Set());
    load();
  }, [ready, load]);

  useEffect(() => {
    if (!ready || autoRefresh <= 0) return;
    const timer = setInterval(() => load(true), autoRefresh * 1000);
    return () => clearInterval(timer);
  }, [ready, autoRefresh, load]);

  const toggleFile = useCallback((name: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }, []);

  const toggleAll = useCallback((names: string[], select: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      names.forEach(name => (select ? next.add(name) : next.delete(name)));
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  return {
    remote, path, files, selected, loading, error, autoRefresh,
    setRemote, setPath, setAutoRefresh,
    toggleFile, toggleAll, clearSelection,
    refresh: load,
  };
}
