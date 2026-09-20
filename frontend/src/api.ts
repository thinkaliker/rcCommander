import type { RcloneFile } from './types';

// Route relatively in production so reverse proxies work; in dev the Vite
// server and the API live on different ports.
export const API_BASE = import.meta.env.DEV
  ? `http://${window.location.hostname}:3001/api`
  : '/api';

export async function apiGet<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

// Build the rclone-style path for a remote + path pair, optionally joining a
// child entry onto it.
export function remotePath(remote: string, path: string, file = ''): string {
  const base = remote === 'Local Filesystem'
    ? `Local Filesystem:${path || '/'}`
    : `${remote}${path}`;
  if (!file) return base;
  return base.endsWith('/') ? `${base}${file}` : `${base}/${file}`;
}

/** One file queued for upload, with the path it should take under the drop target. */
export interface UploadTask {
  file: File;
  /** Relative to the destination folder; a dropped folder keeps its structure. */
  relPath: string;
}

/** Thrown when an upload ended because the user stopped it, not because it broke. */
export class UploadCancelled extends Error {}

/**
 * Send one file to the destination folder. The body is the File itself, so the
 * browser streams it and the server pipes it straight into rclone — nothing is
 * buffered at either end. The server registers the transfer as a job, which is
 * what makes it appear in the progress panel.
 */
export async function uploadFile(
  task: UploadTask, dest: string, autoRemoveSeconds: number,
): Promise<void> {
  const query = new URLSearchParams({
    dest,
    name: task.relPath,
    autoRemove: String(autoRemoveSeconds),
  });
  const res = await fetch(`${API_BASE}/upload?${query}`, {
    method: 'POST',
    // Explicit, so the body is never mistaken for JSON the server would parse.
    headers: { 'Content-Type': 'application/octet-stream' },
    body: task.file,
  });
  const data = await res.json().catch(() => ({})) as { error?: string; cancelled?: boolean };
  if (!res.ok) {
    if (data.cancelled) throw new UploadCancelled(data.error || 'Upload stopped');
    throw new Error(data.error || `Upload failed (${res.status})`);
  }
}

/**
 * List a folder. With `recursive`, the server returns the whole subtree in one
 * call (rclone lsjson -R), so packing a folder does not mean walking it a
 * directory at a time from the browser.
 */
export async function listFolder(spec: string, recursive = false): Promise<RcloneFile[]> {
  const query = new URLSearchParams({ path: spec });
  if (recursive) query.set('recursive', '1');
  const data = await apiGet<{ files?: RcloneFile[] }>(`/files?${query}`);
  return data.files ?? [];
}

/** Direct link the browser can download a single file from. */
export function downloadUrl(spec: string): string {
  return `${API_BASE}/download?path=${encodeURIComponent(spec)}`;
}

/**
 * Run `worker` over every item, `limit` at a time. Uploads are one request per
 * file, so a few in flight keeps a folder of small files moving without opening
 * a connection per file.
 */
export async function runPool<T>(
  items: T[], limit: number, worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      await worker(items[next++]);
    }
  });
  await Promise.all(runners);
}
