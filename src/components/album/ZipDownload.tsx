import { useEffect, useRef, useState } from "react";
import { Download, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { CANCELLED_MESSAGE, DownloadPhoto, DownloadProgress, downloadAlbum, prepareZipServiceWorker } from "@/lib/downloadHelper";

interface ZipDownloadProps {
  photos: DownloadPhoto[];
  albumTitle: string;
  /** Visible label on the button. */
  label?: string;
}

/**
 * One "Download all (ZIP)" button: the whole album, full quality, as a single ZIP,
 * saved straight to the browser's Downloads folder (Chrome, Edge, Firefox, Safari).
 */
export default function ZipDownload({ photos, albumTitle, label = "Download All (ZIP)" }: ZipDownloadProps) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // Get the download helper ready while the client looks at the album.
  useEffect(() => {
    prepareZipServiceWorker()?.catch(() => undefined);
  }, []);

  const onProgress = (p: DownloadProgress) => {
    setProgress(
      p.phase === "downloading"
        ? `Downloading photo ${Math.min(p.current + 1, p.total)} of ${p.total}...`
        : "Finishing your ZIP...",
    );
  };

  const start = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setProgress("Preparing your download...");
    try {
      const result = await downloadAlbum(photos, albumTitle, onProgress, controller.signal);
      if (result.failed.length > 0) {
        toast({
          title: `${result.failed.length} photo${result.failed.length === 1 ? "" : "s"} couldn't be downloaded`,
          description: "They're listed in _missing_photos.txt inside the ZIP. Please try again in a few minutes.",
          variant: "destructive",
        });
      } else {
        toast({ title: "Download complete", description: "Your ZIP file is in your Downloads folder." });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === CANCELLED_MESSAGE) {
        toast({ title: "Download cancelled" });
      } else {
        console.error("ZIP download error:", error);
        toast({
          title: "Download failed",
          description: message || "Something went wrong. Please try again.",
          variant: "destructive",
        });
      }
    } finally {
      setBusy(false);
      setProgress("");
      abortRef.current = null;
    }
  };

  return (
    <div className="flex flex-col gap-2 items-start">
      <div className="flex items-center gap-2">
        <Button
          onClick={() => void start()}
          disabled={busy}
          className="bg-primary text-primary-foreground hover:bg-primary/90 w-full sm:w-auto"
        >
          {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
          {busy ? "Downloading..." : label}
        </Button>
        {busy && (
          <Button
            variant="outline"
            size="icon"
            onClick={() => abortRef.current?.abort()}
            aria-label="Cancel download"
            className="border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground"
          >
            <X className="w-4 h-4" />
          </Button>
        )}
      </div>
      {busy && (
        <>
          <p className="text-sm text-muted-foreground animate-pulse">{progress}</p>
          <p className="text-xs text-muted-foreground">Keep this page open until the download finishes.</p>
        </>
      )}
    </div>
  );
}
