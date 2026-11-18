import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Download, LogOut, Loader2, X, Heart, Share2 } from "lucide-react";
import { RowsPhotoAlbum } from "react-photo-album";
import "react-photo-album/rows.css";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Layout } from "@/components/layout/Layout";
import { Lightbox } from "@/components/portfolio/Lightbox";
import { downloadAlbumAsZip, DownloadProgress } from "@/lib/downloadHelper";
import { lightboxSrc, measureSrc, toGridPhoto } from "@/lib/photoUrls";
import { renderAlbumImage } from "@/components/album/renderAlbumImage";
import { makePhotoOverlay } from "@/components/album/photoOverlay";
import { ShareDialog } from "@/components/album/ShareDialog";
import { addFavorite, fetchAlbumFavorites, removeFavorite } from "@/lib/favorites";
import { AlbumShare, ShareMode, listShares } from "@/lib/shares";
import { cn } from "@/lib/utils";

interface Photo {
  id: string;
  url: string;
  thumbnail_url: string | null;
  preview_url?: string | null;
  title: string | null;
  sort_order: number | null;
  width: number | null;
  height: number | null;
}

interface Album {
  id: string;
  title: string;
  description: string | null;
  event_date: string | null;
  cover_photo_url: string | null;
}

export default function MyAlbum() {
  const { user, isLoading: authLoading, signOut } = useAuth();
  const [albums, setAlbums] = useState<Album[]>([]);
  const [selectedAlbum, setSelectedAlbum] = useState<Album | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<string>("");
  const [downloadingPhotoId, setDownloadingPhotoId] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Favorites (hearts) for the selected album, and the "Favorites only" filter.
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  // Share links: dialog + "Choose photos" selection mode.
  const [shareOpen, setShareOpen] = useState(false);
  const [shareInitialMode, setShareInitialMode] = useState<ShareMode | null>(null);
  const [shares, setShares] = useState<AlbumShare[]>([]);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedForShare, setSelectedForShare] = useState<Set<string>>(new Set());

  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/login");
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user) {
      fetchAlbums();
    }
  }, [user]);

  const fetchAlbums = async () => {
    try {
      const { data, error } = await supabase
        .from('albums')
        .select('*')
        .eq('client_id', user?.id)
        .order('event_date', { ascending: false });

      if (error) throw error;

      setAlbums(data || []);
      if (data && data.length > 0) {
        setSelectedAlbum(data[0]);
        fetchPhotos(data[0].id);
      }
    } catch (error) {
      console.error('Error fetching albums:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchPhotos = async (albumId: string) => {
    try {
      const { data, error } = await supabase
        .from('photos')
        .select('*')
        .eq('album_id', albumId)
        .order('sort_order', { ascending: true });

      if (error) throw error;
      setPhotos(data || []);
    } catch (error) {
      console.error('Error fetching photos:', error);
    }
  };

  const handleAlbumSelect = (album: Album) => {
    setSelectedAlbum(album);
    fetchPhotos(album.id);
  };

  const selectedAlbumId = selectedAlbum?.id;

  const loadShares = useCallback(async () => {
    if (!selectedAlbumId) return;
    try {
      setShares(await listShares(selectedAlbumId));
    } catch (error) {
      // Feature not available yet (e.g. database not migrated) — keep the album usable.
      console.error("Error loading share links:", error);
      setShares([]);
    }
  }, [selectedAlbumId]);

  // Reset per-album UI state and load this album's hearts + share links.
  useEffect(() => {
    setFavoriteIds(new Set());
    setShowFavoritesOnly(false);
    setSelectMode(false);
    setSelectedForShare(new Set());
    setShares([]);
    if (!selectedAlbumId || !user) return;
    let cancelled = false;
    fetchAlbumFavorites(selectedAlbumId, user.id)
      .then((rows) => {
        if (!cancelled) setFavoriteIds(new Set(rows.map((r) => r.photo_id)));
      })
      .catch((error) => console.error("Error loading favorites:", error));
    loadShares();
    return () => {
      cancelled = true;
    };
  }, [selectedAlbumId, user, loadShares]);

  const toggleFavorite = useCallback(
    async (photoId: string) => {
      if (!user || !selectedAlbumId) return;
      const wasFavorite = favoriteIds.has(photoId);
      const apply = (fav: boolean) =>
        setFavoriteIds((prev) => {
          const next = new Set(prev);
          if (fav) next.add(photoId);
          else next.delete(photoId);
          return next;
        });
      apply(!wasFavorite); // optimistic
      try {
        if (wasFavorite) await removeFavorite(user.id, photoId);
        else await addFavorite(user.id, selectedAlbumId, photoId);
      } catch (error) {
        console.error("Error updating favorite:", error);
        apply(wasFavorite);
        toast({ title: "Couldn't save your favorite", description: "Please try again.", variant: "destructive" });
      }
    },
    [user, selectedAlbumId, favoriteIds, toast],
  );

  const toggleSelected = useCallback((photoId: string) => {
    setSelectedForShare((prev) => {
      const next = new Set(prev);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  }, []);

  // "Choose photos": start from the current pick, or from their favorites.
  const startChoosingPhotos = () => {
    setShareOpen(false);
    setSelectedIndex(null);
    if (selectedForShare.size === 0 && favoriteIds.size > 0) {
      setSelectedForShare(new Set(favoriteIds));
    }
    setSelectMode(true);
  };

  const finishChoosingPhotos = () => {
    setShareInitialMode("selection");
    setShareOpen(true);
  };

  const cancelChoosingPhotos = () => {
    setSelectMode(false);
    setSelectedForShare(new Set());
  };

  const openShareDialog = () => {
    setShareInitialMode(null);
    setShareOpen(true);
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const handleDownloadPhoto = async (photo: Photo) => {
    setDownloadingPhotoId(photo.id);
    try {
      const response = await fetch(photo.url);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const extension = photo.url.split('.').pop()?.split('?')[0] || 'jpg';
      a.download = photo.title ? `${photo.title}.${extension}` : `photo.${extension}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      toast({ title: "Download started" });
    } catch (error) {
      console.error('Download error:', error);
      toast({ title: "Download failed", variant: "destructive" });
    } finally {
      setDownloadingPhotoId(null);
    }
  };

  const handleDownloadAll = async () => {
    if (!selectedAlbum || photos.length === 0) return;
    
    setIsDownloading(true);
    setDownloadProgress("Preparing download...");
    abortControllerRef.current = new AbortController();

    try {
      const downloadPhotos = photos.map(p => ({
        url: p.url,
        title: p.title
      }));

      await downloadAlbumAsZip(
        downloadPhotos,
        selectedAlbum.title,
        (progress: DownloadProgress) => {
          if (progress.phase === 'downloading') {
            const percent = Math.round((progress.current / progress.total) * 100);
            setDownloadProgress(`Downloading ${progress.current} of ${progress.total} photos (${percent}%)`);
          } else if (progress.phase === 'creating') {
            setDownloadProgress("Creating ZIP file...");
          }
        },
        abortControllerRef.current.signal
      );

      toast({ title: "Download complete", description: "Your ZIP file has been downloaded." });
    } catch (error) {
      if (error.message === 'Download cancelled') {
        toast({ title: "Download cancelled" });
      } else {
        console.error('ZIP download error:', error);
        toast({ 
          title: "Download failed", 
          description: error.message || "Failed to download album", 
          variant: "destructive" 
        });
      }
    } finally {
      setIsDownloading(false);
      setDownloadProgress("");
      abortControllerRef.current = null;
    }
  };

  const handleCancelDownload = () => {
    abortControllerRef.current?.abort();
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return "";
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  // Measure dimensions only from a real variant — never pull a full-res original
  // just to learn aspect ratio (stored width/height cover most rows).
  const [measuredDims, setMeasuredDims] = useState<Record<string, { w: number; h: number }>>({});
  useEffect(() => {
    const missing = photos.filter((p) => !p.width || !p.height);
    if (missing.length === 0) return;
    missing.forEach((p) => {
      const src = measureSrc(p);
      if (!src) return;
      const el = new Image();
      el.onload = () =>
        setMeasuredDims((prev) => ({ ...prev, [p.id]: { w: el.naturalWidth, h: el.naturalHeight } }));
      el.src = src;
    });
  }, [photos]);

  // What the grid + lightbox show: everything, or just the client's hearts.
  const displayedPhotos = useMemo(
    () => (showFavoritesOnly ? photos.filter((p) => favoriteIds.has(p.id)) : photos),
    [photos, showFavoritesOnly, favoriteIds],
  );

  // Un-hearting the last photo while filtered can shrink the list under the lightbox.
  useEffect(() => {
    if (selectedIndex !== null && selectedIndex >= displayedPhotos.length) {
      setSelectedIndex(displayedPhotos.length > 0 ? displayedPhotos.length - 1 : null);
    }
  }, [selectedIndex, displayedPhotos.length]);

  const favoriteCount = useMemo(
    () => photos.reduce((n, p) => n + (favoriteIds.has(p.id) ? 1 : 0), 0),
    [photos, favoriteIds],
  );

  // Grid: real thumbnails (+ srcSet) only. Never load the download original here.
  const albumPhotos = displayedPhotos.map((img) => toGridPhoto(img, measuredDims[img.id]));

  const photoOverlay = makePhotoOverlay({
    favorites: favoriteIds,
    onToggleFavorite: toggleFavorite,
    selectMode,
    selected: selectedForShare,
    onToggleSelect: toggleSelected,
    onOpen: (index) => setSelectedIndex(index),
  });

  // Lightbox: preview → thumb → original (last resort when opened). Downloads still use `url`.
  const lightboxImages = displayedPhotos.map((p) => ({
    src: lightboxSrc(p),
    alt: p.title || "Photo",
  }));

  if (authLoading || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <Layout>
      <section className="pt-32 pb-20 px-6">
        <div className="container mx-auto">
          {/* Header */}
          <div className="flex items-center justify-between mb-12">
            <div>
              <h1 className="text-3xl md:text-4xl font-serif font-medium text-foreground mb-2">
                Your Albums
              </h1>
              <p className="text-muted-foreground">
                Browse and download your photos
              </p>
            </div>
            <Button
              variant="outline"
              onClick={handleSignOut}
              className="border-border/50"
            >
              <LogOut className="w-4 h-4 mr-2" />
              Sign Out
            </Button>
          </div>

          {albums.length === 0 ? (
            <div className="text-center py-20 bg-muted/30 border border-border/50">
              <p className="text-muted-foreground text-lg">
                No albums available yet.
              </p>
              <p className="text-muted-foreground mt-2">
                Your photographer will add your photos soon!
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
              {/* Album Sidebar */}
              {albums.length > 1 && (
                <div className="lg:col-span-1">
                  <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">
                    Albums
                  </h3>
                  <div className="space-y-2">
                    {albums.map((album) => (
                      <button
                        key={album.id}
                        onClick={() => handleAlbumSelect(album)}
                        className={`w-full text-left p-4 border transition-all ${
                          selectedAlbum?.id === album.id
                            ? 'border-primary bg-primary/5'
                            : 'border-border/50 hover:border-primary/50'
                        }`}
                      >
                        <p className="font-medium">{album.title}</p>
                        {album.event_date && (
                          <p className="text-sm text-muted-foreground">
                            {formatDate(album.event_date)}
                          </p>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Photos Grid */}
              <div className={albums.length > 1 ? 'lg:col-span-3' : 'lg:col-span-4'}>
                {selectedAlbum && (
                  <>
                    <div className="mb-6 flex flex-col gap-4">
                      <div>
                        <h2 className="text-2xl font-serif font-medium">
                          {selectedAlbum.title}
                        </h2>
                        {selectedAlbum.description && (
                          <p className="text-muted-foreground mt-1">
                            {selectedAlbum.description}
                          </p>
                        )}
                        {selectedAlbum.event_date && (
                          <p className="text-sm text-muted-foreground mt-1">
                            {formatDate(selectedAlbum.event_date)}
                          </p>
                        )}
                      </div>
                      {photos.length > 0 && (
                        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                          <div className="flex items-center gap-2">
                            <Button
                              onClick={handleDownloadAll}
                              disabled={isDownloading}
                              className="bg-primary text-primary-foreground hover:bg-primary/90 w-full sm:w-auto"
                            >
                              {isDownloading ? (
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                              ) : (
                                <Download className="w-4 h-4 mr-2" />
                              )}
                              {isDownloading ? "Downloading..." : "Download All (ZIP)"}
                            </Button>
                            {isDownloading && (
                              <Button
                                variant="outline"
                                size="icon"
                                onClick={handleCancelDownload}
                                className="border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground"
                              >
                                <X className="w-4 h-4" />
                              </Button>
                            )}
                          </div>
                          <Button
                            variant="outline"
                            onClick={openShareDialog}
                            className="border-primary/40 w-full sm:w-auto"
                          >
                            <Share2 className="w-4 h-4 mr-2" />
                            Share
                          </Button>
                          {downloadProgress && (
                            <p className="text-sm text-muted-foreground animate-pulse">
                              {downloadProgress}
                            </p>
                          )}
                        </div>
                      )}
                      {photos.length > 0 && (
                        <div className="flex items-center gap-1 text-sm" role="tablist" aria-label="Filter photos">
                          <button
                            type="button"
                            role="tab"
                            aria-selected={!showFavoritesOnly}
                            onClick={() => setShowFavoritesOnly(false)}
                            className={cn(
                              "px-3 py-1.5 border-b-2 transition-colors",
                              !showFavoritesOnly
                                ? "border-primary text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground",
                            )}
                          >
                            All photos ({photos.length})
                          </button>
                          <button
                            type="button"
                            role="tab"
                            aria-selected={showFavoritesOnly}
                            onClick={() => setShowFavoritesOnly(true)}
                            className={cn(
                              "px-3 py-1.5 border-b-2 transition-colors inline-flex items-center gap-1.5",
                              showFavoritesOnly
                                ? "border-primary text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground",
                            )}
                          >
                            <Heart
                              className="w-3.5 h-3.5 text-primary"
                              fill={favoriteCount > 0 ? "currentColor" : "none"}
                            />
                            Favorites ({favoriteCount})
                          </button>
                        </div>
                      )}
                    </div>

                    {selectMode && (
                      <div className="sticky top-20 z-30 mb-4 flex flex-wrap items-center gap-2 border border-primary/30 bg-background/95 backdrop-blur-sm px-4 py-3 shadow-sm">
                        <div className="mr-auto">
                          <p className="font-medium">
                            {selectedForShare.size} photo{selectedForShare.size === 1 ? "" : "s"} selected
                          </p>
                          <p className="text-xs text-muted-foreground">Tap photos to add or remove them from your link.</p>
                        </div>
                        {favoriteCount > 0 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setSelectedForShare((prev) => new Set([...prev, ...favoriteIds]))
                            }
                          >
                            <Heart className="w-4 h-4 mr-1.5 text-primary" fill="currentColor" />
                            Select my favorites
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelectedForShare(new Set(displayedPhotos.map((p) => p.id)))}
                        >
                          Select all
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelectedForShare(new Set())}
                          disabled={selectedForShare.size === 0}
                        >
                          Clear
                        </Button>
                        <Button variant="outline" size="sm" onClick={cancelChoosingPhotos}>
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={finishChoosingPhotos}
                          disabled={selectedForShare.size === 0}
                          className="bg-primary text-primary-foreground hover:bg-primary/90"
                        >
                          Continue
                        </Button>
                      </div>
                    )}

                    {photos.length === 0 ? (
                      <div className="text-center py-12 bg-muted/30 border border-border/50">
                        <p className="text-muted-foreground">
                          {photos.length > 0 
                            ? "Please wait for photos to load..." 
                            : "Photos coming soon!"}
                        </p>
                      </div>
                    ) : displayedPhotos.length === 0 ? (
                      <div className="text-center py-16 bg-muted/30 border border-border/50">
                        <Heart className="w-8 h-8 text-primary/60 mx-auto mb-3" />
                        <p className="font-serif text-xl mb-1">No favorites yet</p>
                        <p className="text-muted-foreground text-sm">
                          Tap the heart on any photo to save it here.
                        </p>
                        <Button variant="link" className="mt-2 text-primary" onClick={() => setShowFavoritesOnly(false)}>
                          View all photos
                        </Button>
                      </div>
                    ) : (
                      <RowsPhotoAlbum
                        photos={albumPhotos}
                        targetRowHeight={300}
                        rowConstraints={{ minPhotos: 1, maxPhotos: 4 }}
                        spacing={8}
                        render={{ image: renderAlbumImage, extras: photoOverlay }}
                        componentsProps={{
                          container: { className: "cursor-pointer" },
                          wrapper: { className: "group" },
                        }}
                        sizes={{
                          size: "900px",
                          sizes: [
                            { viewport: "(max-width: 1024px)", size: "calc(100vw - 48px)" },
                          ],
                        }}
                      />
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Lightbox with Download */}
      {selectedIndex !== null && (
        <div
          className="fixed inset-0 z-50 bg-background/95 backdrop-blur-md flex items-center justify-center"
          onClick={() => setSelectedIndex(null)}
        >
          {/* Close button */}
          <button
            className="absolute top-6 right-6 text-foreground hover:text-primary transition-colors z-10"
            onClick={() => setSelectedIndex(null)}
          >
            <span className="sr-only">Close</span>
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          {/* Download button */}
          <button
            className="absolute top-6 right-20 text-foreground hover:text-primary transition-colors z-10 p-2"
            onClick={(e) => {
              e.stopPropagation();
              handleDownloadPhoto(displayedPhotos[selectedIndex]);
            }}
            disabled={downloadingPhotoId === displayedPhotos[selectedIndex]?.id}
          >
            {downloadingPhotoId === displayedPhotos[selectedIndex]?.id ? (
              <Loader2 className="w-6 h-6 animate-spin" />
            ) : (
              <Download className="w-6 h-6" />
            )}
          </button>

          {/* Favorite (heart) button */}
          {displayedPhotos[selectedIndex] && (
            <button
              className={cn(
                "absolute top-6 right-32 transition-colors z-10 p-2",
                favoriteIds.has(displayedPhotos[selectedIndex].id)
                  ? "text-primary hover:text-accent"
                  : "text-foreground hover:text-primary",
              )}
              aria-label={
                favoriteIds.has(displayedPhotos[selectedIndex].id) ? "Remove from favorites" : "Add to favorites"
              }
              aria-pressed={favoriteIds.has(displayedPhotos[selectedIndex].id)}
              onClick={(e) => {
                e.stopPropagation();
                toggleFavorite(displayedPhotos[selectedIndex].id);
              }}
            >
              <Heart
                className="w-6 h-6"
                fill={favoriteIds.has(displayedPhotos[selectedIndex].id) ? "currentColor" : "none"}
              />
            </button>
          )}

          {/* Image counter */}
          <div className="absolute top-6 left-6 text-foreground/70 text-sm font-medium">
            {selectedIndex + 1} / {displayedPhotos.length}
          </div>

          {/* Previous button */}
          {selectedIndex > 0 && (
            <button
              className="absolute left-4 top-1/2 -translate-y-1/2 p-2 text-foreground/70 hover:text-foreground bg-background/50 hover:bg-background/80 rounded-full transition-all z-10"
              onClick={(e) => {
                e.stopPropagation();
                setSelectedIndex(selectedIndex - 1);
              }}
            >
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}

          {/* Next button */}
          {selectedIndex < displayedPhotos.length - 1 && (
            <button
              className="absolute right-4 top-1/2 -translate-y-1/2 p-2 text-foreground/70 hover:text-foreground bg-background/50 hover:bg-background/80 rounded-full transition-all z-10"
              onClick={(e) => {
                e.stopPropagation();
                setSelectedIndex(selectedIndex + 1);
              }}
            >
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}

          {/* Image */}
          <img
            src={lightboxImages[selectedIndex]?.src}
            alt={lightboxImages[selectedIndex]?.alt || "Photo"}
            className="max-h-[90vh] max-w-[90vw] w-auto h-auto object-contain shadow-elevated animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {selectedAlbum && (
        <ShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          albumId={selectedAlbum.id}
          albumTitle={selectedAlbum.title}
          totalPhotos={photos.length}
          favoriteCount={favoriteCount}
          selectedIds={[...selectedForShare]}
          initialMode={shareInitialMode}
          onChooseSelection={startChoosingPhotos}
          shares={shares}
          onSharesChanged={loadShares}
          onCreated={() => {
            setSelectMode(false);
            setSelectedForShare(new Set());
          }}
        />
      )}
    </Layout>
  );
}
