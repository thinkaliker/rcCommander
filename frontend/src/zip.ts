// Building the archive in the browser, streaming, so a multi-file download
// arrives as one .zip instead of a burst of separate downloads.
//
// Nothing is compressed: everything here is already-stored bytes coming off a
// remote, and deflating media on the main thread would cost time for no size
// saving. Entries are added with ZipPassThrough, which is store-only.
import { Zip, ZipPassThrough } from 'fflate';

/**
 * fflate's zip *writer* emits 32-bit sizes and offsets with no zip64 record, so
 * anything at or past 4 GiB would produce an archive that unpacks wrongly.
 * Above this the caller falls back to downloading the files individually.
 */
export const ZIP_MAX_TOTAL_BYTES = 4 * 1024 ** 3 - 1;

/**
 * Without a save-file handle the archive has to be held in memory until it is
 * complete, so the ceiling is far lower on browsers that lack the API.
 */
export const MEMORY_ZIP_MAX_BYTES = 1024 ** 3;

export interface ZipEntrySource {
  /** Path inside the archive. */
  name: string;
  /** Where the bytes come from. */
  url: string;
}

export interface ZipProgress {
  /** Bytes written into the archive so far. */
  bytes: number;
  /** Index of the entry being read, 0-based. */
  index: number;
  name: string;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}

interface FileSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
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

/** True when the archive can be streamed to disk instead of held in memory. */
export function canStreamToDisk(): boolean {
  return typeof (window as PickerWindow).showSaveFilePicker === 'function';
}

/** Raised when the user dismisses the save dialog — not an error worth reporting. */
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
 * in memory. The picker must be reached without awaiting anything first, or the
 * click's user activation will have expired by the time it is called.
 */
async function openSink(archiveName: string): Promise<FileSink> {
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

/**
 * Stream every entry into one archive and hand it to the user.
 *
 * Each file is fetched and pushed through the zip writer chunk by chunk, and
 * the loop waits on the sink between reads, so memory stays bounded by roughly
 * one chunk rather than by the size of the selection.
 */
export async function downloadZip(
  entries: ZipEntrySource[],
  archiveName: string,
  onProgress: (progress: ZipProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const sink = await openSink(archiveName);

  let queue: Promise<void> = Promise.resolve();
  let settle!: () => void;
  let fail!: (reason: unknown) => void;
  const flushed = new Promise<void>((resolve, reject) => { settle = resolve; fail = reject; });

  const zip = new Zip((err, chunk, final) => {
    if (err) {
      fail(err);
      return;
    }
    queue = queue.then(() => sink.write(chunk));
    // `final` accompanies the last bytes of the central directory.
    if (final) queue.then(settle, fail);
  });

  let bytes = 0;
  try {
    for (const [index, entry] of entries.entries()) {
      signal.throwIfAborted();
      onProgress({ bytes, index, name: entry.name });

      const file = new ZipPassThrough(entry.name);
      zip.add(file);

      const res = await fetch(entry.url, { signal });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(`${entry.name} — ${data.error || `download failed (${res.status})`}`);
      }

      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        file.push(value, false);
        bytes += value.length;
        onProgress({ bytes, index, name: entry.name });
        // Backpressure: never read faster than the archive is being written.
        await queue;
      }
      file.push(new Uint8Array(0), true);
    }

    zip.end();
    await flushed;
    await sink.close();
  } catch (e) {
    zip.terminate();
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
