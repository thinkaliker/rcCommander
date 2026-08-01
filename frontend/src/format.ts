// Formatting + parsing of the human-readable strings rclone prints.

const DURATION_RE = /^(?:([\d.]+)h)?(?:([\d.]+)m)?(?:([\d.]+)s)?$/;

/** Last non-empty path segment, tolerating both slash styles. */
export function fileName(pathStr: string): string {
  if (!pathStr) return '';
  const parts = pathStr.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '/';
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${parseFloat((bytes / 1024 ** i).toFixed(1))} ${units[i]}`;
}

/** "5.102 MiB/s" -> bytes per second. */
export function parseSpeed(speed: string | undefined): number {
  const match = speed?.trim().toLowerCase().match(/^([\d.]+)\s*([a-z/]+)$/);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = match[2];
  if (unit.startsWith('t')) return val * 1024 ** 4;
  if (unit.startsWith('g')) return val * 1024 ** 3;
  if (unit.startsWith('m')) return val * 1024 ** 2;
  if (unit.startsWith('k')) return val * 1024;
  return val;
}

export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '0 B/s';
  const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s'];
  let idx = 0;
  let val = bytesPerSec;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(2)} ${units[idx]}`;
}

/** "1m2.3s" -> seconds. Returns null when the value is absent or "-". */
export function parseDuration(time: string | undefined): number | null {
  const cleaned = time?.trim().toLowerCase().replace(/\s+/g, '');
  if (!cleaned || cleaned === '-') return null;
  const match = cleaned.match(DURATION_RE);
  if (match) {
    const [, h, m, s] = match;
    return (h ? parseFloat(h) : 0) * 3600 + (m ? parseFloat(m) : 0) * 60 + (s ? parseFloat(s) : 0);
  }
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  let out = '';
  if (h > 0) out += `${h}h`;
  if (m > 0) out += `${m}m`;
  out += h === 0 && m === 0
    ? `${s.toFixed(1).replace(/\.0$/, '')}s`
    : `${Math.round(s)}s`;
  return out;
}

/** Percentage for the progress bar, clamped so it can never overflow. */
export function progressPercent(progress: string, status: string): number {
  const match = progress.match(/([\d.]+)%/);
  if (match) return Math.min(100, Math.max(0, parseFloat(match[1])));
  return status === 'completed' ? 100 : 0;
}
