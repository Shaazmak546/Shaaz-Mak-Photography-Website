// Generates the WebP display variants for a new upload *in the admin's
// browser*, before anything touches the server.
//
// Why the browser: the Supabase Edge Functions (process-upload /
// backfill-variants) run out of memory ("Memory limit exceeded", HTTP 546)
// on full-size wedding JPEGs (~5 MB, 3648x5472). The browser has plenty of
// memory and a native image decoder, so we decode once here, resize, and
// upload the small files alongside the original.
//
// Spec (matches the existing library-wide variants):
//   thumb   – 640px long edge, WebP q82  -> photos/derived/thumb/<section>/<uuid>.webp
//   preview – 2048px long edge, WebP q90 -> photos/derived/preview/<section>/<uuid>.webp
//
// Color: createImageBitmap converts the photo's embedded profile (e.g.
// ProPhoto RGB / Adobe RGB from Lightroom) into the canvas's sRGB space, so
// the WebP pixels are sRGB, which is what browsers assume for untagged WebP.

export const VARIANT_SPECS = [
  { name: "thumb", maxEdge: 640, quality: 0.82 },
  { name: "preview", maxEdge: 2048, quality: 0.9 },
] as const;

export type VariantName = (typeof VARIANT_SPECS)[number]["name"];

export interface EncodedVariant {
  name: VariantName;
  blob: Blob;
  contentType: string;   // "image/webp", or "image/jpeg" if the browser can't encode WebP
  extension: "webp" | "jpg";
}

export interface BrowserVariantsResult {
  width: number;   // natural (EXIF-oriented) dimensions of the original
  height: number;
  variants: EncodedVariant[];
}

/** Scale (w,h) so the long edge is at most maxEdge. Never upscales. */
export function fitWithin(w: number, h: number, maxEdge: number): { width: number; height: number } {
  const long = Math.max(w, h);
  if (long <= maxEdge) return { width: w, height: h };
  const s = maxEdge / long;
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/**
 * "originals/<section>/<uuid>.jpg" -> "derived/<variant>/<section>/<uuid>.<ext>"
 * Same layout process-upload uses, so both paths produce identical keys.
 */
export function deriveVariantKey(sourcePath: string, variant: string, ext = "webp"): string {
  const stripped = sourcePath.replace(/^originals\//, "");
  const noExt = stripped.replace(/\.[^./]+$/, "");
  return `derived/${variant}/${noExt}.${ext}`;
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function ctx2d(c: AnyCanvas): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const ctx = (c as HTMLCanvasElement).getContext("2d", { alpha: false }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error("Canvas 2D not available");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return ctx;
}

/**
 * Downscale with repeated halving so big reductions (5472 -> 640) stay sharp
 * and don't alias, even in browsers whose single-step "high" filter is weak.
 */
function resizeTo(src: CanvasImageSource & { width: number; height: number }, w: number, h: number): AnyCanvas {
  let cur: CanvasImageSource & { width: number; height: number } = src;
  let cw = src.width;
  let ch = src.height;
  while (cw / 2 >= w && ch / 2 >= h) {
    const nw = Math.round(cw / 2);
    const nh = Math.round(ch / 2);
    const step = makeCanvas(nw, nh);
    ctx2d(step).drawImage(cur, 0, 0, nw, nh);
    cur = step;
    cw = nw;
    ch = nh;
  }
  const out = makeCanvas(w, h);
  ctx2d(out).drawImage(cur, 0, 0, w, h);
  return out;
}

async function encode(c: AnyCanvas, type: string, quality: number): Promise<Blob | null> {
  if ("convertToBlob" in c) {
    try {
      return await (c as OffscreenCanvas).convertToBlob({ type, quality });
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => (c as HTMLCanvasElement).toBlob((b) => resolve(b), type, quality));
}

async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image", colorSpaceConversion: "default" });
    } catch {
      /* fall through to <img> (e.g. older Safari) */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Decode `file` once and produce the thumb + preview variants.
 * Throws if the browser cannot decode the file (e.g. HEIC on Chrome); callers
 * should fall back to the server path in that case.
 */
export async function generateBrowserVariants(file: Blob): Promise<BrowserVariantsResult> {
  const img = await decode(file);
  const width = "naturalWidth" in img ? img.naturalWidth : img.width;
  const height = "naturalHeight" in img ? img.naturalHeight : img.height;
  if (!width || !height) throw new Error("Could not decode image");

  // Normalise to a canvas source with width/height so resizeTo can step down.
  const base = img as CanvasImageSource & { width: number; height: number };
  if (!("width" in base) || !base.width) {
    (base as HTMLImageElement).width = width;
    (base as HTMLImageElement).height = height;
  }

  const variants: EncodedVariant[] = [];
  try {
    // Largest first; the thumb is resized from the preview canvas (cheaper,
    // and avoids holding a second full-size buffer).
    let previous: (CanvasImageSource & { width: number; height: number }) = base;
    const ordered = [...VARIANT_SPECS].sort((a, b) => b.maxEdge - a.maxEdge);
    for (const spec of ordered) {
      const t = fitWithin(width, height, spec.maxEdge);
      const canvas = resizeTo(previous, t.width, t.height);
      let blob = await encode(canvas, "image/webp", spec.quality);
      let contentType = "image/webp";
      let extension: "webp" | "jpg" = "webp";
      // Browsers that can't encode WebP silently return PNG; use JPEG instead.
      if (!blob || blob.type !== "image/webp") {
        blob = await encode(canvas, "image/jpeg", spec.quality);
        contentType = "image/jpeg";
        extension = "jpg";
      }
      if (!blob || blob.size === 0) throw new Error(`Could not encode ${spec.name}`);
      variants.push({ name: spec.name, blob, contentType, extension });
      previous = canvas as unknown as CanvasImageSource & { width: number; height: number };
    }
  } finally {
    if ("close" in img && typeof img.close === "function") img.close();
  }
  return { width, height, variants };
}
