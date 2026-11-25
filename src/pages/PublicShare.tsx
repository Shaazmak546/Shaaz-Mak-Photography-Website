import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Camera, ChevronLeft, ChevronRight, Clock, Link2Off, X } from "lucide-react";
import { RowsPhotoAlbum } from "react-photo-album";
import "react-photo-album/rows.css";
import { Button } from "@/components/ui/button";
import { renderAlbumImage } from "@/components/album/renderAlbumImage";
import { cdn } from "@/lib/cdn";
import ZipDownload from "@/components/album/ZipDownload";
import { SavePhotoButton } from "@/components/album/SavePhotoButton";
import { measureSrc, toGridPhoto } from "@/lib/photoUrls";
import { SharedAlbumResult, SharedPhoto, fetchSharedAlbum, formatShareDate } from "@/lib/shares";

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "unavailable"; reason: "not_found" | "expired" | "revoked" }
  | { kind: "ok"; data: Extract<SharedAlbumResult, { status: "ok" }> };

const UNAVAILABLE_COPY = {
  expired: {
    icon: Clock,
    title: "This link has expired",
    body: "The person who shared these photos set this link to expire. Ask them to send you a new one.",
  },
  revoked: {
    icon: Link2Off,
    title: "This link is no longer active",
    body: "The person who shared these photos has turned this link off. Ask them for a new link if you'd like to see them.",
  },
  not_found: {
    icon: Camera,
    title: "We couldn't find these photos",
    body: "The link may be incomplete — please check that you copied the whole address.",
  },
} as const;

/** Best on-screen URL for the lightbox; null when the photo has no viewable variant. */
function viewSrc(p: SharedPhoto): string | null {
  const u = p.preview_url || p.thumbnail_url || p.url;
  return u ? cdn(u) : null;
}

/** Keep shared links out of search engines while this page is open. */
function useNoIndex(title: string) {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.appendChild(meta);
    const prevTitle = document.title;
    document.title = title;
    return () => {
      document.head.removeChild(meta);
      document.title = prevTitle;
    };
  }, [title]);
}

export default function PublicShare() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [measuredDims, setMeasuredDims] = useState<Record<string, { w: number; h: number }>>({});

  const albumTitle = state.kind === "ok" ? state.data.album_title : "Shared photos";
  useNoIndex(`${albumTitle} · Shaaz Mak Photography`);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    if (!token) {
      setState({ kind: "unavailable", reason: "not_found" });
      return;
    }
    fetchSharedAlbum(token)
      .then((result) => {
        if (cancelled) return;
        if (result.status === "ok") setState({ kind: "ok", data: result });
        else setState({ kind: "unavailable", reason: result.status });
      })
      .catch((err) => {
        console.error("Failed to load shared album:", err);
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const photos = useMemo(() => (state.kind === "ok" ? state.data.photos : []), [state]);
  const allowDownload = state.kind === "ok" && state.data.allow_download;

  // Measure only from a real variant when stored dimensions are missing.
  useEffect(() => {
    photos
      .filter((p) => !p.width || !p.height)
      .forEach((p) => {
        const src = measureSrc({ ...p, url: p.url ?? "" });
        if (!src) return;
        const el = new Image();
        el.onload = () =>
          setMeasuredDims((prev) => ({ ...prev, [p.id]: { w: el.naturalWidth, h: el.naturalHeight } }));
        el.src = cdn(src);
      });
  }, [photos]);

  const gridPhotos = useMemo(
    () => photos.map((p) => toGridPhoto({ ...p, url: p.url ?? "" }, measuredDims[p.id])),
    [photos, measuredDims],
  );

  const goPrev = useCallback(() => setLightboxIndex((i) => (i !== null && i > 0 ? i - 1 : i)), []);
  const goNext = useCallback(
    () => setLightboxIndex((i) => (i !== null && i < photos.length - 1 ? i + 1 : i)),
    [photos.length],
  );

  useEffect(() => {
    if (lightboxIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") goPrev();
      if (e.key === "ArrowRight") goNext();
      if (e.key === "Escape") setLightboxIndex(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxIndex, goPrev, goNext]);

  const fileBase = albumTitle.replace(/[^a-zA-Z0-9-_]+/g, "_");

  const header = (
    <header className="py-8 border-b border-border/60">
      <div className="container mx-auto px-6 text-center">
        <Link to="/" className="inline-block">
          <span className="text-2xl font-serif text-foreground hover:text-primary transition-colors">
            Shaaz Mak Photography
          </span>
        </Link>
      </div>
    </header>
  );

  if (state.kind === "loading") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">Loading photos...</p>
        </div>
      </div>
    );
  }

  if (state.kind !== "ok") {
    const copy =
      state.kind === "error"
        ? {
            icon: Camera,
            title: "We're having trouble loading these photos",
            body: "Please check your connection and try again in a few minutes.",
          }
        : UNAVAILABLE_COPY[state.reason];
    const Icon = copy.icon;
    return (
      <div className="min-h-screen bg-background flex flex-col">
        {header}
        <div className="flex-1 flex items-center justify-center px-6 py-20">
          <div className="text-center max-w-md">
            <div className="w-20 h-20 mx-auto mb-6 bg-secondary rounded-full flex items-center justify-center">
              <Icon className="w-9 h-9 text-muted-foreground" />
            </div>
            <h1 className="text-3xl font-serif mb-4">{copy.title}</h1>
            <p className="text-muted-foreground mb-8">{copy.body}</p>
            <Link to="/" className="text-primary hover:text-accent transition-colors font-medium">
              Visit Shaaz Mak Photography
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const { data } = state;
  const current = lightboxIndex !== null ? photos[lightboxIndex] : null;
  const currentSrc = current ? viewSrc(current) : null;

  return (
    <div className="min-h-screen bg-background">
      {header}

      <section className="pt-14 pb-10">
        <div className="container mx-auto px-6 text-center">
          <p className="text-primary font-medium tracking-[0.3em] uppercase text-xs mb-4">Shared with you</p>
          <h1 className="text-4xl md:text-5xl font-serif mb-4">{data.album_title}</h1>
          <p className="text-muted-foreground">
            {photos.length} photo{photos.length === 1 ? "" : "s"}
            {data.mode === "album" ? "" : " selected for you"}
            {data.expires_at && <> · available until {formatShareDate(data.expires_at)}</>}
          </p>
          {allowDownload && photos.length > 0 && (
            <div className="mt-6 flex justify-center">
              <ZipDownload
                photos={photos.filter((p) => p.url).map((p) => ({ url: cdn(p.url as string), title: null }))}
                albumTitle={albumTitle}
                label="Download all (ZIP)"
              />
            </div>
          )}
        </div>
      </section>

      <section className="pb-20">
        <div className="container mx-auto px-6">
          {photos.length === 0 ? (
            <p className="text-center text-muted-foreground py-12">There are no photos in this link yet.</p>
          ) : (
            <RowsPhotoAlbum
              photos={gridPhotos}
              targetRowHeight={300}
              rowConstraints={{ minPhotos: 1, maxPhotos: 4 }}
              spacing={8}
              onClick={({ index }) => setLightboxIndex(index)}
              render={{ image: renderAlbumImage }}
              componentsProps={{ container: { className: "cursor-pointer" } }}
              sizes={{
                size: "1100px",
                sizes: [{ viewport: "(max-width: 1024px)", size: "calc(100vw - 48px)" }],
              }}
            />
          )}
        </div>
      </section>

      <footer className="py-10 border-t border-border/60 bg-secondary/30">
        <div className="container mx-auto px-6 text-center">
          <p className="text-muted-foreground text-sm">
            Photographed by{" "}
            <Link to="/" className="text-primary hover:text-accent transition-colors">
              Shaaz Mak Photography
            </Link>
          </p>
        </div>
      </footer>

      {current && lightboxIndex !== null && (
        <div
          className="fixed inset-0 z-50 bg-background/95 backdrop-blur-md flex items-center justify-center p-4"
          onClick={() => setLightboxIndex(null)}
        >
          <button
            className="absolute top-6 right-6 text-foreground hover:text-primary transition-colors z-10"
            onClick={() => setLightboxIndex(null)}
            aria-label="Close"
          >
            <X className="w-8 h-8" />
          </button>
          {allowDownload && current.url && (
            <SavePhotoButton
              className="absolute top-6 right-20"
              photo={{
                id: current.id,
                url: cdn(current.url),
                original_filename: current.original_filename,
              }}
              fallbackFileName={`${fileBase}_${String(lightboxIndex + 1).padStart(3, "0")}.${current.url.split(".").pop()?.split("?")[0] || "jpg"}`}
            />
          )}
          {lightboxIndex > 0 && (
            <button
              className="absolute left-4 md:left-8 top-1/2 -translate-y-1/2 text-foreground hover:text-primary transition-colors z-10 p-2"
              onClick={(e) => {
                e.stopPropagation();
                goPrev();
              }}
              aria-label="Previous photo"
            >
              <ChevronLeft className="w-10 h-10" />
            </button>
          )}
          {lightboxIndex < photos.length - 1 && (
            <button
              className="absolute right-4 md:right-8 top-1/2 -translate-y-1/2 text-foreground hover:text-primary transition-colors z-10 p-2"
              onClick={(e) => {
                e.stopPropagation();
                goNext();
              }}
              aria-label="Next photo"
            >
              <ChevronRight className="w-10 h-10" />
            </button>
          )}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-foreground/70 text-sm z-10">
            {lightboxIndex + 1} / {photos.length}
          </div>
          {currentSrc ? (
            <img
              key={current.id}
              src={currentSrc}
              alt={`${data.album_title} photo ${lightboxIndex + 1}`}
              className="max-w-full max-h-[90vh] object-contain shadow-elevated animate-scale-in"
              onClick={(e) => e.stopPropagation()}
              onContextMenu={allowDownload ? undefined : (e) => e.preventDefault()}
            />
          ) : (
            <p className="text-muted-foreground">This photo is still being prepared.</p>
          )}
        </div>
      )}
    </div>
  );
}
