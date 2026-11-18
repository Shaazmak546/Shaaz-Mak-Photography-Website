// Shared upload helper used by all admin upload UIs (album photos, portfolio,
// homepage). Pipeline:
//
//   1. Upload the original to `photos/originals/<section>/<uuid>.<ext>`.
//   2. In the admin's browser, build the thumb (640px) + preview (2048px) WebP
//      variants and upload them to `photos/derived/{thumb,preview}/...`.
//      (See src/lib/browserVariants.ts — the Edge Functions run out of memory
//      on full-size wedding JPEGs, the browser does not.)
//   3. Only if the browser can't decode the file (e.g. HEIC on Chrome), try the
//      `process-upload` Edge Function as a fallback.
//   4. Return the URLs + natural dimensions ready for a DB insert.
//
// All callers should treat the original `url` as the full-resolution download
// asset and use `thumbnail_url` / `preview_url` for on-screen rendering.
//
// If no variants could be made we still succeed the upload, but leave
// thumbnail_url / preview_url null (NOT equal to the original). Client grids
// must not treat the original as a thumbnail — see src/lib/photoUrls.ts.

import { supabase } from "@/integrations/supabase/client";
import { deriveVariantKey, generateBrowserVariants } from "@/lib/browserVariants";

export interface ProcessedUpload {
  url: string;                       // original, full-res — for downloads
  thumbnail_url: string | null;      // small WebP for grid thumbnails (null if variants unavailable)
  preview_url: string | null;        // medium WebP for gallery viewing (null if variants unavailable)
  width: number;
  height: number;
  /** False when no variants could be produced — admin can use Reprocess later. */
  variantsReady: boolean;
}

function makeKey(section: string, file: File): string {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  // crypto.randomUUID is in every modern browser; collisions are not a concern.
  const id = (crypto as Crypto).randomUUID();
  return `originals/${section}/${id}.${ext}`;
}

// Measure image dimensions client-side from a File. Used as a fallback when
// variants can't be produced and we still need dimensions for the layout.
async function measureDimensions(file: File): Promise<{ width: number; height: number }> {
  // Prefer createImageBitmap — fast, off-main-thread on most browsers.
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file);
      const dims = { width: bmp.width, height: bmp.height };
      bmp.close?.();
      return dims;
    } catch {
      // fall through to <img> path
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const dims = { width: img.naturalWidth, height: img.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(dims);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image dimensions"));
    };
    img.src = url;
  });
}

/**
 * Build + upload thumb/preview in the browser. Returns null (never throws) if
 * the browser can't do it, so the caller can fall back.
 */
async function makeVariantsInBrowser(
  file: File,
  sourcePath: string,
): Promise<{ thumbnail_url: string; preview_url: string; width: number; height: number } | null> {
  try {
    const result = await generateBrowserVariants(file);
    const urls: Record<string, string> = {};
    for (const v of result.variants) {
      const key = deriveVariantKey(sourcePath, v.name, v.extension);
      const { error } = await supabase.storage.from("photos").upload(key, v.blob, {
        contentType: v.contentType,
        upsert: false,
        cacheControl: "31536000",
      });
      if (error) throw new Error(`upload ${v.name} failed: ${error.message}`);
      urls[v.name] = supabase.storage.from("photos").getPublicUrl(key).data.publicUrl;
    }
    if (!urls.thumb || !urls.preview) return null;
    return {
      thumbnail_url: urls.thumb,
      preview_url: urls.preview,
      width: result.width,
      height: result.height,
    };
  } catch (err) {
    console.warn("[uploadAndProcessPhoto] browser variants failed, trying process-upload:", err);
    return null;
  }
}

export async function uploadAndProcessPhoto(
  file: File,
  section: string,
): Promise<ProcessedUpload> {
  const sourcePath = makeKey(section, file);

  // 1. Upload original.
  const { error: upErr } = await supabase.storage
    .from("photos")
    .upload(sourcePath, file, { contentType: file.type, upsert: false });
  if (upErr) throw new Error(`Upload failed: ${upErr.message}`);

  const { data: pub } = supabase.storage.from("photos").getPublicUrl(sourcePath);
  const publicUrl = pub.publicUrl;

  // 2. Preferred: build the variants right here in the browser.
  const local = await makeVariantsInBrowser(file, sourcePath);
  if (local) {
    return {
      url: publicUrl,
      thumbnail_url: local.thumbnail_url,
      preview_url: local.preview_url,
      width: local.width,
      height: local.height,
      variantsReady: true,
    };
  }

  // 3. Fallback: the process-upload Edge Function (may run out of memory on
  //    very large files, in which case we store the original only).
  try {
    const { data, error: fnErr } = await supabase.functions.invoke("process-upload", {
      body: { sourcePath },
    });
    if (!fnErr && data && !data.error && data.url) {
      const thumb = data.thumbnail_url || null;
      const preview = data.preview_url || null;
      // Guard against a buggy function returning the original as "thumb".
      const thumbOk = thumb && thumb !== data.url;
      const previewOk = preview && preview !== data.url;
      return {
        url: data.url,
        thumbnail_url: thumbOk ? thumb : null,
        preview_url: previewOk ? preview : null,
        width: data.width,
        height: data.height,
        variantsReady: Boolean(thumbOk),
      };
    }
    console.warn(
      "[uploadAndProcessPhoto] process-upload unavailable — uploaded original only. Reason:",
      fnErr?.message || data?.error || "no data",
    );
  } catch (err) {
    console.warn("[uploadAndProcessPhoto] process-upload threw — uploaded original only. Error:", err);
  }

  // 4. Last resort: keep the original for downloads, leave variants null so the
  //    frontend shows a placeholder in grids instead of silently loading full-res.
  const dims = await measureDimensions(file).catch(() => ({ width: 1500, height: 1000 }));
  return {
    url: publicUrl,
    thumbnail_url: null,
    preview_url: null,
    width: dims.width,
    height: dims.height,
    variantsReady: false,
  };
}
