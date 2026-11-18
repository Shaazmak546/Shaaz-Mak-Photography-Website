// Client-side "Reprocess images" for the admin dashboard.
//
// The backfill-variants Edge Function runs out of memory (HTTP 546) on
// full-size wedding JPEGs. This module walks the same tables that function
// covered (photos, portfolio_photos, homepage_photos), downloads each
// original, builds thumb + preview in the admin's browser with
// generateBrowserVariants, uploads them, and writes the URLs back.
//
// Idempotent: only rows whose thumbnail_url / preview_url are missing,
// equal to the original, or not under /derived/ are touched. Per-photo
// errors are skipped so one bad file cannot stop the rest.
//
// Do not call this from a script or agent — the admin clicks the button.

import { supabase } from "@/integrations/supabase/client";
import { deriveVariantKey, generateBrowserVariants } from "@/lib/browserVariants";

/** How many originals to decode at once. Easy to change if a machine struggles. */
export const REPROCESS_CONCURRENCY = 3;

const BUCKET = "photos";
const PAGE_SIZE = 1000;

export const PHOTO_TABLES = ["photos", "portfolio_photos", "homepage_photos"] as const;
export type PhotoTable = (typeof PHOTO_TABLES)[number];

export interface ReprocessOptions {
  /** When set, only `photos` rows in this album are processed (portfolio/homepage skipped). */
  albumId?: string;
  onProgress?: (progress: ReprocessProgress) => void;
  concurrency?: number;
}

export interface ReprocessProgress {
  completed: number;
  total: number;
  succeeded: number;
  failed: number;
}

export interface TableSummary {
  processed: number;
  failed: number;
  errors: string[];
}

export interface ReprocessResult {
  total: number;
  processed: number;
  failed: number;
  scopedToAlbum: boolean;
  tables: Record<PhotoTable, TableSummary>;
}

type PhotoRow = {
  id: string;
  url: string;
  thumbnail_url?: string | null;
  preview_url?: string | null;
  album_id?: string;
};

function isDerivedVariant(candidate: string | null | undefined, original: string): boolean {
  if (!candidate) return false;
  if (candidate.split("?")[0] === original.split("?")[0]) return false;
  return candidate.includes("/derived/");
}

/** A row needs work when thumb or preview is missing / is the original / isn't a derived file. */
export function needsVariants(row: PhotoRow): boolean {
  return !isDerivedVariant(row.thumbnail_url, row.url) || !isDerivedVariant(row.preview_url, row.url);
}

/** Extract the photos-bucket key from a public (or signed) Storage URL. */
export function urlToStorageKey(url: string): string | null {
  const stripped = url.split("?")[0];
  const markers = ["/object/public/photos/", "/object/sign/photos/"];
  for (const marker of markers) {
    const i = stripped.indexOf(marker);
    if (i !== -1) {
      try {
        return decodeURIComponent(stripped.slice(i + marker.length));
      } catch {
        return stripped.slice(i + marker.length);
      }
    }
  }
  return null;
}

function isAlreadyExistsError(error: { message?: string; statusCode?: string | number }): boolean {
  const status = String(error.statusCode ?? "");
  if (status === "409") return true;
  return /already exists|Duplicate|409/i.test(error.message ?? "");
}

async function uploadVariant(key: string, blob: Blob, contentType: string): Promise<void> {
  const opts = { contentType, upsert: false, cacheControl: "31536000" };
  const first = await supabase.storage.from(BUCKET).upload(key, blob, opts);
  if (!first.error) return;

  // No storage UPDATE policy, so upsert:true would fail. Delete + re-upload
  // works with the existing admin insert/delete policies and refreshes stale files.
  if (!isAlreadyExistsError(first.error)) {
    throw new Error(`upload failed: ${first.error.message}`);
  }
  const { error: delErr } = await supabase.storage.from(BUCKET).remove([key]);
  if (delErr) throw new Error(`replace failed: ${delErr.message}`);
  const retry = await supabase.storage.from(BUCKET).upload(key, blob, opts);
  if (retry.error) throw new Error(`re-upload failed: ${retry.error.message}`);
}

async function downloadOriginal(row: PhotoRow): Promise<Blob> {
  const key = urlToStorageKey(row.url);
  if (key) {
    const { data, error } = await supabase.storage.from(BUCKET).download(key);
    if (!error && data) return data;
    if (error) console.warn("[reprocess] storage download failed, trying public URL:", error.message);
  }
  const res = await fetch(row.url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  return await res.blob();
}

async function processRow(table: PhotoTable, row: PhotoRow): Promise<void> {
  const srcKey = urlToStorageKey(row.url);
  if (!srcKey) throw new Error(`cannot parse storage key from url: ${row.url}`);

  const original = await downloadOriginal(row);
  const result = await generateBrowserVariants(original);

  const urls: Record<string, string> = {};
  for (const v of result.variants) {
    const key = deriveVariantKey(srcKey, v.name, v.extension);
    await uploadVariant(key, v.blob, v.contentType);
    urls[v.name] = supabase.storage.from(BUCKET).getPublicUrl(key).data.publicUrl;
  }
  if (!urls.thumb || !urls.preview) throw new Error("variants did not include thumb and preview");

  const { error: updErr } = await supabase
    .from(table)
    .update({
      thumbnail_url: urls.thumb,
      preview_url: urls.preview,
      width: result.width,
      height: result.height,
    })
    .eq("id", row.id);
  if (updErr) throw new Error(`db update failed: ${updErr.message}`);
}

async function fetchPage(
  table: PhotoTable,
  from: number,
  albumId?: string,
): Promise<PhotoRow[]> {
  const to = from + PAGE_SIZE - 1;
  if (table === "photos") {
    let q = supabase
      .from("photos")
      .select("id, url, thumbnail_url, preview_url, album_id")
      .order("id", { ascending: true })
      .range(from, to);
    if (albumId) q = q.eq("album_id", albumId);
    const { data, error } = await q;
    if (error) throw new Error(`select ${table} failed: ${error.message}`);
    return (data ?? []) as PhotoRow[];
  }
  const { data, error } = await supabase
    .from(table)
    .select("id, url, thumbnail_url, preview_url")
    .order("id", { ascending: true })
    .range(from, to);
  if (error) throw new Error(`select ${table} failed: ${error.message}`);
  return (data ?? []) as PhotoRow[];
}

async function fetchCandidates(table: PhotoTable, albumId?: string): Promise<PhotoRow[]> {
  const rows: PhotoRow[] = [];
  let from = 0;
  for (;;) {
    const page = await fetchPage(table, from, albumId);
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows.filter(needsVariants);
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

/**
 * Find every photo missing derived variants and build them in this browser.
 * Safe to click more than once — already-processed rows are skipped.
 */
export async function reprocessMissingVariants(options: ReprocessOptions = {}): Promise<ReprocessResult> {
  const concurrency = options.concurrency ?? REPROCESS_CONCURRENCY;
  const tables: PhotoTable[] = options.albumId ? ["photos"] : [...PHOTO_TABLES];

  const empty = (): TableSummary => ({ processed: 0, failed: 0, errors: [] });
  const tablesSummary = {
    photos: empty(),
    portfolio_photos: empty(),
    homepage_photos: empty(),
  } as Record<PhotoTable, TableSummary>;

  const work: Array<{ table: PhotoTable; row: PhotoRow }> = [];
  for (const table of tables) {
    const candidates = await fetchCandidates(table, options.albumId);
    for (const row of candidates) work.push({ table, row });
  }

  const total = work.length;
  let completed = 0;
  let succeeded = 0;
  let failed = 0;

  const emit = () =>
    options.onProgress?.({ completed, total, succeeded, failed });
  emit();

  if (total === 0) {
    return { total: 0, processed: 0, failed: 0, scopedToAlbum: Boolean(options.albumId), tables: tablesSummary };
  }

  await runPool(work, concurrency, async ({ table, row }) => {
    try {
      await processRow(table, row);
      tablesSummary[table].processed++;
      succeeded++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tablesSummary[table].failed++;
      tablesSummary[table].errors.push(`${row.id}: ${message}`);
      failed++;
      console.warn(`[reprocess] ${table} ${row.id} failed:`, message);
    } finally {
      completed++;
      emit();
    }
  });

  return { total, processed: succeeded, failed, scopedToAlbum: Boolean(options.albumId), tables: tablesSummary };
}

export function formatReprocessSummary(result: ReprocessResult): string {
  if (result.total === 0) {
    return result.scopedToAlbum
      ? "Every photo in this album already has thumbnails."
      : "All images already have thumbnails.";
  }
  const parts = PHOTO_TABLES.map((t) => {
    const r = result.tables[t];
    if (r.processed === 0 && r.failed === 0) return null;
    const label = t === "photos" ? "Photos" : t === "portfolio_photos" ? "Portfolio" : "Homepage";
    const bit = `${label}: ${r.processed} done`;
    return r.failed ? `${bit}, ${r.failed} failed` : bit;
  }).filter(Boolean);
  const body = parts.join(" · ") || `${result.processed} of ${result.total} done`;
  if (result.failed > 0) {
    return `${body}. ${result.failed} failed — click Reprocess again to retry those.`;
  }
  return body;
}
