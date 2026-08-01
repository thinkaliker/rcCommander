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
