/**
 * Single-photo save / download.
 *
 * On iPhone and iPad (and any other touch browser that can share files),
 * we call navigator.share({ files }) so the share sheet offers "Save Image"
 * into the Photos app. iOS only allows share() while the user's tap is still
 * "active", so awaiting a fetch() before share() usually fails. We prefetch
 * the original when the lightbox photo opens and only call share() when the
 * File is already in memory. If the user taps before that, the button shows
 * "Preparing…" and then "Save to Photos" for a second tap.
 *
 * Desktop and Android keep the familiar browser download (Files / Downloads).
 */

export interface SaveablePhoto {
  id: string;
  url: string;
  original_filename?: string | null;
  title?: string | null;
}

const CACHE_LIMIT = 3;

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  tif: "image/tiff",
  tiff: "image/tiff",
  bmp: "image/bmp",
  avif: "image/avif",
};

function extensionOf(nameOrUrl: string): string {
  const last = nameOrUrl.split("?")[0].split("#")[0].split("/").pop() ?? "";
  const ext = last.includes(".") ? last.split(".").pop() ?? "" : "";
  return /^[a-zA-Z0-9]{2,5}$/.test(ext) ? ext.toLowerCase() : "";
}

function sanitizeFileName(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, "_").replace(/\0/g, "").trim() || "photo";
}

export function fileNameForPhoto(photo: SaveablePhoto, fallbackFileName?: string): string {
  const extFromUrl = extensionOf(photo.url) || "jpg";
  const original = photo.original_filename?.trim();
  if (original) {
    const cleaned = sanitizeFileName(original);
    return extensionOf(cleaned) ? cleaned : `${cleaned}.${extFromUrl}`;
  }
  if (fallbackFileName?.trim()) return fallbackFileName.trim();
  const title = photo.title?.trim();
  if (title) return `${sanitizeFileName(title)}.${extFromUrl}`;
  return `photo.${extFromUrl}`;
}

export function mimeForPhoto(fileName: string, blobType?: string): string {
  if (blobType && blobType.startsWith("image/")) return blobType;
  const ext = extensionOf(fileName) || "jpg";
  return MIME_BY_EXT[ext] || "image/jpeg";
}

function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

function isAppleTouchDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPhone|iPod|iPad/.test(ua)) return true;
  // iPadOS 13+ can report itself as a Macintosh with a touch screen.
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

function isTouchMobileDevice(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  if (isAndroid()) return false;
  if (isAppleTouchDevice()) return true;
  const ua = navigator.userAgent || "";
  const coarse = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
  const noHover = window.matchMedia?.("(hover: none)")?.matches ?? false;
  return coarse && noHover && /Mobile|Tablet|Mobi/i.test(ua);
}

function canShareFiles(): boolean {
  if (typeof navigator === "undefined" || typeof File === "undefined") return false;
  if (typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
  try {
    const probe = new File([new Uint8Array([0xff, 0xd8, 0xff])], "probe.jpg", { type: "image/jpeg" });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/** True when a tap should open the iOS / iPadOS (or similar) share sheet. */
export function shouldUseShareSheet(): boolean {
  return isTouchMobileDevice() && canShareFiles();
}

class LruCache<V> {
  private map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

const fileCache = new LruCache<File>(CACHE_LIMIT);
const inflight = new Map<string, Promise<File>>();

export function peekPhotoFile(photoId: string): File | undefined {
  return fileCache.get(photoId);
}

async function fetchPhotoFile(photo: SaveablePhoto, fallbackFileName?: string): Promise<File> {
  if (!photo.url) throw new Error("This photo has no downloadable original");
  const res = await fetch(photo.url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (!blob.size) throw new Error("Empty download");
  const name = fileNameForPhoto(photo, fallbackFileName);
  const type = mimeForPhoto(name, blob.type);
  return new File([blob], name, { type, lastModified: Date.now() });
}

export function getPhotoFile(photo: SaveablePhoto, fallbackFileName?: string): Promise<File> {
  const cached = fileCache.get(photo.id);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(photo.id);
  if (pending) return pending;
  const promise = fetchPhotoFile(photo, fallbackFileName)
    .then((file) => {
      fileCache.set(photo.id, file);
      return file;
    })
    .finally(() => {
      inflight.delete(photo.id);
    });
  inflight.set(photo.id, promise);
  return promise;
}

export function prefetchPhotoFile(photo: SaveablePhoto, fallbackFileName?: string): void {
  if (!photo?.id || !photo.url) return;
  void getPhotoFile(photo, fallbackFileName).catch(() => {
    /* leave uncached so the next tap can retry */
  });
}

export function triggerBrowserDownload(file: Blob & { name?: string }, fileName?: string): void {
  const href = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = href;
  a.download = fileName || file.name || "photo.jpg";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

export function isShareCancel(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { name?: string }).name === "AbortError";
}

/**
 * Opens the share sheet. Must be called directly from a user tap.
 * Returns 'shared', 'cancelled', or 'downloaded' (fallback to a normal save).
 */
export async function sharePhotoFile(file: File): Promise<"shared" | "cancelled" | "downloaded"> {
  try {
    if (typeof navigator.canShare === "function" && !navigator.canShare({ files: [file] })) {
      triggerBrowserDownload(file);
      return "downloaded";
    }
    await navigator.share({ files: [file] });
    return "shared";
  } catch (error) {
    if (isShareCancel(error)) return "cancelled";
    triggerBrowserDownload(file);
    return "downloaded";
  }
}
