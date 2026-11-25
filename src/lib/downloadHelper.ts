import { ZipWriter } from "./zipWriter";

export interface DownloadPhoto {
  url: string;
  title?: string | null;
}

export interface DownloadProgress {
  /** Photos finished so far (downloaded or given up on). */
  current: number;
  total: number;
  phase: "downloading" | "finishing" | "complete";
}

export type ProgressCallback = (progress: DownloadProgress) => void;

export interface DownloadResult {
  saved: number;
  /** File names that still failed after retries (they are listed inside the ZIP too). */
  failed: string[];
}

export const CANCELLED_MESSAGE = "Download cancelled";

/** Photos per ZIP when the browser can't stream to disk (kept modest so memory stays low). */
export const PART_SIZE = 50;

const CONCURRENCY = 4; // photos fetched ahead while the previous one is written
const FETCH_ATTEMPTS = 4;
const FETCH_TIMEOUT_MS = 90_000;

type SaveFilePicker = (options?: {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}) => Promise<{
  createWritable: () => Promise<{
    write: (data: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
    abort: () => Promise<void>;
  }>;
}>;

function getSaveFilePicker(): SaveFilePicker | null {
  if (typeof window === "undefined") return null;
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  // The picker is blocked inside cross-origin frames.
  let topLevel = true;
  try {
    topLevel = window.self === window.top;
  } catch {
    topLevel = false;
  }
  return typeof picker === "function" && topLevel ? picker.bind(window) : null;
}

/** True on Chrome/Edge desktop, where the whole album can be streamed straight to one file on disk. */
export function canStreamToDisk(): boolean {
  return getSaveFilePicker() !== null;
}

export function partCount(totalPhotos: number): number {
  return Math.max(1, Math.ceil(totalPhotos / PART_SIZE));
}

export function partRange(totalPhotos: number, partIndex: number): { start: number; end: number } {
  const start = partIndex * PART_SIZE;
  return { start, end: Math.min(totalPhotos, start + PART_SIZE) };
}

function safeName(text: string): string {
  return text.replace(/[^a-zA-Z0-9-_]/g, "_") || "album";
}

function extensionOf(url: string): string {
  const ext = url.split("?")[0].split(".").pop() ?? "";
  return /^[a-zA-Z0-9]{2,5}$/.test(ext) ? ext.toLowerCase() : "jpg";
}

/**
 * One stable file name per photo, based on its position in the whole album, so a
 * part never renames photos and two photos never collide inside a ZIP.
 */
export function fileNamesFor(photos: DownloadPhoto[]): string[] {
  const used = new Set<string>();
  return photos.map((photo, index) => {
    const ext = extensionOf(photo.url);
    const base = photo.title ? safeName(photo.title) : `photo_${String(index + 1).padStart(3, "0")}`;
    let name = `${base}.${ext}`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}_${n}.${ext}`;
    used.add(name.toLowerCase());
    return name;
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        resolve();
      },
      { once: true },
    );
  });
}

/** Fetches one photo, retrying on network errors / 5xx / timeouts. Returns null if it never worked. */
async function fetchPhoto(url: string, signal?: AbortSignal): Promise<Uint8Array | null> {
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    throwIfAborted(signal);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      // 4xx (missing/forbidden file) won't fix itself, except timeouts and rate limits.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const expected = Number(res.headers.get("content-length"));
      if (expected && bytes.length !== expected) throw new Error("Incomplete download");
      return bytes;
    } catch (error) {
      throwIfAborted(signal);
      console.warn(`Photo download failed (attempt ${attempt}/${FETCH_ATTEMPTS})`, error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (attempt < FETCH_ATTEMPTS) await sleep(500 * 2 ** (attempt - 1), signal);
  }
  return null;
}

/**
 * Downloads photos a few at a time (in order) and writes them into the ZIP as they
 * arrive. Photos that cannot be fetched are skipped, noted in the ZIP, and returned.
 */
async function writeZip(
  photos: DownloadPhoto[],
  names: string[],
  writer: ZipWriter,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  const total = photos.length;
  const failed: string[] = [];
  let saved = 0;
  let done = 0;
  const inFlight: Promise<Uint8Array | null>[] = [];
  let next = 0;
  const launch = () => {
    while (next < total && inFlight.length < CONCURRENCY) {
      const p = fetchPhoto(photos[next].url, signal);
      p.catch(() => undefined); // surfaced when awaited below
      inFlight.push(p);
      next++;
    }
  };

  onProgress?.({ current: 0, total, phase: "downloading" });
  launch();
  for (let i = 0; i < total; i++) {
    const data = await inFlight.shift()!;
    launch();
    throwIfAborted(signal);
    if (data) {
      await writer.addFile(names[i], data);
      saved++;
    } else {
      failed.push(names[i]);
    }
    done++;
    onProgress?.({ current: done, total, phase: "downloading" });
  }

  if (saved === 0) throw new Error("None of the photos could be downloaded. Please check your connection and try again.");
  if (failed.length > 0) {
    const note =
      "These photos could not be downloaded and are not in this ZIP:\r\n\r\n" + failed.join("\r\n") + "\r\n";
    await writer.addFile("_missing_photos.txt", new TextEncoder().encode(note));
  }
  onProgress?.({ current: total, total, phase: "finishing" });
  await writer.finish();
  return { saved, failed };
}

function triggerBrowserDownload(blob: Blob, fileName: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser time to start reading the blob before releasing it.
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/**
 * Chrome / Edge desktop: the whole album goes into ONE ZIP that is written to disk
 * as it downloads, so memory use stays at a few photos no matter how big the album is.
 * Must be called straight from a click (it opens the "Save as" dialog first).
 */
export async function downloadAlbumToDisk(
  photos: DownloadPhoto[],
  albumTitle: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  const picker = getSaveFilePicker();
  if (!picker) throw new Error("Saving straight to disk isn't supported in this browser");

  let handle: Awaited<ReturnType<SaveFilePicker>>;
  try {
    handle = await picker({
      suggestedName: `${safeName(albumTitle)}.zip`,
      types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }],
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw new Error(CANCELLED_MESSAGE);
    throw error;
  }

  const file = await handle.createWritable();
  try {
    const writer = new ZipWriter((chunk) => file.write(chunk));
    const result = await writeZip(photos, fileNamesFor(photos), writer, onProgress, signal);
    await file.close();
    onProgress?.({ current: photos.length, total: photos.length, phase: "complete" });
    return result;
  } catch (error) {
    await file.abort().catch(() => undefined); // discard the half-written file
    throw error;
  }
}

/**
 * Any browser: one part of the album (PART_SIZE photos) as its own ZIP, e.g.
 * `Mendhi_part_03_of_11.zip`. Small enough to build in memory, including on Safari.
 */
export async function downloadAlbumPart(
  photos: DownloadPhoto[],
  albumTitle: string,
  partIndex: number,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  const parts = partCount(photos.length);
  const { start, end } = partRange(photos.length, partIndex);
  const names = fileNamesFor(photos).slice(start, end);
  const chunks: Uint8Array[] = [];
  const writer = new ZipWriter((chunk) => {
    chunks.push(chunk);
  });
  const result = await writeZip(photos.slice(start, end), names, writer, onProgress, signal);
  const suffix =
    parts === 1 ? "" : `_part_${String(partIndex + 1).padStart(2, "0")}_of_${String(parts).padStart(2, "0")}`;
  triggerBrowserDownload(new Blob(chunks as BlobPart[], { type: "application/zip" }), `${safeName(albumTitle)}${suffix}.zip`);
  onProgress?.({ current: end - start, total: end - start, phase: "complete" });
  return result;
}
