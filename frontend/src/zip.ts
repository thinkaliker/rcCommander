// Assembling a multi-file (or whole-folder) download into one archive in the
// browser. The bytes are streamed through the zip writer and out to disk, so
// this costs no more transfer than downloading the files separately, and — on a
// browser with a save-file API — no more memory either.
import { ZipWriter } from './zipwriter';
import type { ZipSink } from './zipwriter';

/**
 * Ceiling for the in-memory fallback. There is no format limit any more (the
 * writer emits zip64 records), but a browser without a streaming save API has
 * to hold the whole archive in memory until it is complete.
 */
export const MEMORY_ZIP_MAX_BYTES = 1024 ** 3;

/** How often progress is reported while a large entry streams past. */
const PROGRESS_INTERVAL_MS = 100;

export interface ZipEntry {
  /** Path inside the archive. */
  name: string;
  /** Size as listed, used to choose zip64 up front; negative means unknown. */
  size: number;
  url: string;
  /** The file's own mtime, so the archive preserves it. */
  modified?: string;
}

export interface ZipPlan {
  files: ZipEntry[];
  /** Folders with nothing beneath them, which would otherwise vanish. */
  emptyDirs: string[];
  totalBytes: number;
  /** How many of the selected items were folders. */
  folders: number;
}

export interface ZipProgress {
  bytes: number;
  index: number;
  name: string;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}

type PickerWindow = Window & {
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<{
    createWritable(): Promise<{
      write(chunk: Uint8Array): Promise<void>;
      close(): Promise<void>;
      abort(): Promise<void>;
    }>;
  }>;
};

/** True when the archive can be streamed to disk rather than held in memory. */
export function canStreamToDisk(): boolean {
  return typeof (window as PickerWindow).showSaveFilePicker === 'function';
}

/** Raised when the user backs out — not an error worth reporting. */
export class ZipCancelled extends Error {}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a moment to start reading before the URL is revoked.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Ask for a file on disk to stream into, falling back to collecting the archive
 * in memory. The picker needs transient user activation, so this must be
 * reached from a click without awaiting anything first.
 */
async function openSink(archiveName: string): Promise<ZipSink> {
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: archiveName,
        types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
      });
      const writable = await handle.createWritable();
      return {
        write: chunk => writable.write(chunk),
        close: () => writable.close(),
        abort: () => writable.abort().catch(() => {}),
      };
    } catch (e) {
      // A dismissed dialog means the user changed their mind; anything else
      // (an insecure context, a sandboxed frame) just means falling back.
      if ((e as Error).name === 'AbortError') throw new ZipCancelled('Save cancelled');
    }
  }

  const chunks: Uint8Array[] = [];
  return {
    write: async chunk => { chunks.push(chunk); },
    close: async () => {
      saveBlob(new Blob(chunks as BlobPart[], { type: 'application/zip' }), archiveName);
      chunks.length = 0;
    },
    abort: async () => { chunks.length = 0; },
  };
}

/** Stream every entry into one archive and hand it to the user. */
export async function downloadZip(
  plan: ZipPlan,
  archiveName: string,
  onProgress: (progress: ZipProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const sink = await openSink(archiveName);
  const writer = new ZipWriter(sink);

  let bytes = 0;
  let lastReport = 0;
  const report = (index: number, name: string, force = false) => {
    const now = Date.now();
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return;
    lastReport = now;
    onProgress({ bytes, index, name });
  };

  try {
    for (const dir of plan.emptyDirs) {
      signal.throwIfAborted();
      await writer.addDirectory(dir);
    }

    for (const [index, entry] of plan.files.entries()) {
      signal.throwIfAborted();
      report(index, entry.name, true);

      const res = await fetch(entry.url, { signal });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(`${entry.name} — ${data.error || `download failed (${res.status})`}`);
      }

      await writer.add(entry.name, entry.size, res.body, chunk => {
        bytes += chunk;
        report(index, entry.name);
      }, entry.modified ? new Date(entry.modified) : undefined);
    }

    // finish() writes the central directory and closes the sink.
    await writer.finish();
  } catch (e) {
    await sink.abort();
    throw signal.aborted ? new ZipCancelled('Download cancelled') : e;
  }
}

/** A filename the OS will accept, derived from the folder being downloaded. */
export function archiveNameFor(remote: string, path: string): string {
  const segments = path.split('/').filter(Boolean);
  const base = segments.length > 0 ? segments[segments.length - 1] : remote.replace(/:$/, '');
  const safe = base.replace(/[/\\?%*:|"<>]/g, '-').trim() || 'download';
  return `${safe}.zip`;
}
