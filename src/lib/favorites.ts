// Client favorites ("hearts"). Rows live in public.photo_favorites; RLS only
// lets a client read/write their own rows for albums they own, and lets the
// admin read everything.

import { supabase } from "@/integrations/supabase/client";

const PAGE = 1000; // PostgREST caps a single response at 1000 rows.

export interface FavoriteRow {
  photo_id: string;
  user_id: string;
  created_at: string;
}

/** All favorite rows for an album (RLS scopes clients to their own rows). */
export async function fetchAlbumFavorites(albumId: string, userId?: string): Promise<FavoriteRow[]> {
  const rows: FavoriteRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = supabase
      .from("photo_favorites")
      .select("photo_id, user_id, created_at")
      .eq("album_id", albumId)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (userId) query = query.eq("user_id", userId);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

export async function addFavorite(userId: string, albumId: string, photoId: string): Promise<void> {
  const { error } = await supabase
    .from("photo_favorites")
    .insert({ user_id: userId, album_id: albumId, photo_id: photoId });
  // 23505 = already hearted (e.g. double tap / second tab) — treat as success.
  if (error && error.code !== "23505") throw error;
}

export async function removeFavorite(userId: string, photoId: string): Promise<void> {
  const { error } = await supabase
    .from("photo_favorites")
    .delete()
    .eq("user_id", userId)
    .eq("photo_id", photoId);
  if (error) throw error;
}

/** Number of favorite rows in an album (admin: all clients). */
export async function countAlbumFavorites(albumId: string): Promise<number> {
  const { count, error } = await supabase
    .from("photo_favorites")
    .select("id", { count: "exact", head: true })
    .eq("album_id", albumId);
  if (error) throw error;
  return count ?? 0;
}

/** File name from a storage URL, e.g. ".../originals/album/<uuid>.jpg" -> "<uuid>.jpg". */
export function storageFileName(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split("/").pop() || url);
  } catch {
    return url.split("?")[0].split("/").pop() || url;
  }
}
