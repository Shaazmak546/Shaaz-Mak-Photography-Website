import { useEffect, useState, type MouseEvent } from "react";
import { Download, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  SaveablePhoto,
  getPhotoFile,
  peekPhotoFile,
  sharePhotoFile,
  shouldUseShareSheet,
  triggerBrowserDownload,
} from "@/lib/savePhoto";
import { cn } from "@/lib/utils";

type Status = "idle" | "preparing" | "ready" | "downloading";

interface SavePhotoButtonProps {
  photo: SaveablePhoto;
  /** Used when the photo has no original_filename (e.g. "Mendhi_001.jpg"). */
  fallbackFileName?: string;
  className?: string;
  /** Show a short toast after a classic browser download starts. */
  announceDownload?: boolean;
}

export function SavePhotoButton({
  photo,
  fallbackFileName,
  className,
  announceDownload,
}: SavePhotoButtonProps) {
  const { toast } = useToast();
  const useShare = shouldUseShareSheet();
  const [status, setStatus] = useState<Status>("idle");
  const [prefetched, setPrefetched] = useState(() => !!peekPhotoFile(photo.id));

  useEffect(() => {
    let cancelled = false;
    setStatus("idle");
    const already = peekPhotoFile(photo.id);
    setPrefetched(!!already);
    if (already) return;
    void getPhotoFile(photo, fallbackFileName)
      .then(() => {
        if (!cancelled) setPrefetched(true);
      })
      .catch(() => {
        /* the tap handler retries and shows an error if it still fails */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- parent passes a fresh photo literal each render
  }, [photo.id, photo.url, photo.original_filename, photo.title, fallbackFileName]);

  const fail = () =>
    toast({ title: "Download failed", description: "Please try again.", variant: "destructive" });

  const onClick = async (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    if (status === "preparing" || status === "downloading") return;

    if (useShare) {
      // Only share when the File is already in memory — a fetch here would
      // spend the iOS user-activation and the share sheet would not appear.
      const ready = peekPhotoFile(photo.id);
      if (ready) {
        await sharePhotoFile(ready);
        setStatus("idle");
        return;
      }
      setStatus("preparing");
      try {
        await getPhotoFile(photo, fallbackFileName);
        setPrefetched(true);
        setStatus("ready");
      } catch {
        setStatus("idle");
        fail();
      }
      return;
    }

    setStatus("downloading");
    try {
      const file = await getPhotoFile(photo, fallbackFileName);
      triggerBrowserDownload(file);
      if (announceDownload) toast({ title: "Download started" });
    } catch {
      fail();
    } finally {
      setStatus("idle");
    }
  };

  const busy = status === "preparing" || status === "downloading";
  const showSaveLabel = useShare && status === "ready";
  const label =
    status === "preparing"
      ? "Preparing…"
      : status === "downloading"
        ? "Downloading…"
        : useShare
          ? "Save to Photos"
          : "Download photo";

  return (
    <button
      type="button"
      className={cn(
        "text-foreground hover:text-primary transition-colors z-10 p-2",
        className,
      )}
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      aria-busy={busy}
      data-testid="save-photo-button"
      data-prefetch={prefetched ? "ready" : "loading"}
      data-mode={useShare ? "share" : "download"}
    >
      {busy ? (
        <span className="inline-flex flex-col items-center gap-1">
          <Loader2 className="w-6 h-6 animate-spin" />
          {status === "preparing" && (
            <span className="text-xs font-medium whitespace-nowrap">Preparing…</span>
          )}
        </span>
      ) : showSaveLabel ? (
        <span className="inline-flex flex-col items-center gap-1">
          <Download className="w-6 h-6" />
          <span className="text-xs font-medium whitespace-nowrap">Save to Photos</span>
        </span>
      ) : (
        <Download className="w-6 h-6" />
      )}
    </button>
  );
}
