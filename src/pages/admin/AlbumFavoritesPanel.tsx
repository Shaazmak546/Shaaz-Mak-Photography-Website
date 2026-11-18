import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Heart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { useToast } from "@/hooks/use-toast";
import { cdn } from "@/lib/cdn";
import { FavoriteRow, storageFileName } from "@/lib/favorites";
import { gridSrc } from "@/lib/photoUrls";

export interface FavoritePanelPhoto {
  id: string;
  url: string;
  thumbnail_url: string | null;
  preview_url?: string | null;
  original_filename?: string | null;
}

interface AlbumFavoritesPanelProps {
  albumTitle: string;
  /** Album photos in album order (position = index + 1). */
  photos: FavoritePanelPhoto[];
  favorites: FavoriteRow[];
  clientNames: Record<string, string>;
}

function photoLabel(photo: FavoritePanelPhoto): string {
  return photo.original_filename || storageFileName(photo.url);
}

/**
 * Admin view of a client's hearted photos: one section per client with a
 * copyable list ("#12  DSC_1234.jpg") for print / edit picks.
 */
export function AlbumFavoritesPanel({ albumTitle, photos, favorites, clientNames }: AlbumFavoritesPanelProps) {
  const { toast } = useToast();
  const [copiedFor, setCopiedFor] = useState<string | null>(null);

  useEffect(() => {
    if (!copiedFor) return;
    const t = setTimeout(() => setCopiedFor(null), 2000);
    return () => clearTimeout(t);
  }, [copiedFor]);

  const position = useMemo(() => new Map(photos.map((p, i) => [p.id, i + 1])), [photos]);
  const byId = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);

  // Group by client, keep album order inside each group.
  const groups = useMemo(() => {
    const map = new Map<string, FavoritePanelPhoto[]>();
    for (const f of favorites) {
      const photo = byId.get(f.photo_id);
      if (!photo) continue;
      const list = map.get(f.user_id) ?? [];
      list.push(photo);
      map.set(f.user_id, list);
    }
    return [...map.entries()].map(([userId, list]) => ({
      userId,
      name: clientNames[userId] || "Client",
      photos: list.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0)),
    }));
  }, [favorites, byId, clientNames, position]);

  if (groups.length === 0) {
    return (
      <div className="text-center py-16 bg-muted/30 rounded-lg border border-dashed border-border">
        <Heart className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
        <p className="text-muted-foreground">No favorites yet.</p>
        <p className="text-sm text-muted-foreground mt-1">
          When your client hearts photos in their album, their picks show up here.
        </p>
      </div>
    );
  }

  const handleCopy = async (group: (typeof groups)[number]) => {
    const lines = group.photos.map((p) => `#${position.get(p.id)}\t${photoLabel(p)}`);
    const text = `${albumTitle} — ${group.name}'s favorites (${group.photos.length})\n${lines.join("\n")}`;
    if (await copyText(text)) {
      setCopiedFor(group.userId);
      toast({ title: "List copied", description: `${group.photos.length} photos copied to your clipboard.` });
    } else {
      toast({ title: "Couldn't copy the list", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-10">
      {groups.map((group) => (
        <section key={group.userId} className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-serif text-xl font-medium flex items-center gap-2">
                <Heart className="w-4 h-4 text-primary" fill="currentColor" />
                {group.name}'s favorites
              </h3>
              <p className="text-sm text-muted-foreground">
                {group.photos.length} photo{group.photos.length === 1 ? "" : "s"} · # is the photo's position in the
                album
              </p>
            </div>
            <Button variant="outline" size="sm" className="border-primary/30" onClick={() => handleCopy(group)}>
              {copiedFor === group.userId ? <Check className="w-4 h-4 mr-2" /> : <Copy className="w-4 h-4 mr-2" />}
              Copy list
            </Button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {group.photos.map((p) => {
              const thumb = gridSrc(p);
              return (
                <figure key={p.id} className="space-y-1">
                  <div className="aspect-square bg-muted/50 overflow-hidden rounded">
                    {thumb ? (
                      <img src={thumb} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
                    ) : (
                      <img src={cdn(p.url)} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
                    )}
                  </div>
                  <figcaption className="text-xs text-muted-foreground truncate" title={photoLabel(p)}>
                    <span className="text-foreground font-medium">#{position.get(p.id)}</span> {photoLabel(p)}
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
