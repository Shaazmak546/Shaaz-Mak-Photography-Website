import { useMemo, useRef, useState } from "react";
import { Check, Download, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  CANCELLED_MESSAGE,
  DownloadPhoto,
  DownloadResult,
  PART_SIZE,
  canStreamToDisk,
  downloadAlbumPart,
  downloadAlbumToDisk,
  partCount,
  partRange,
} from "@/lib/downloadHelper";

interface ZipDownloadProps {
  photos: DownloadPhoto[];
  albumTitle: string;
  /** Visible label on the main button. */
  label?: string;
}

type Busy = { kind: "whole" } | { kind: "part"; index: number } | null;

/**
 * "Download all (ZIP)" for an album or shared link.
 *  - Chrome / Edge desktop: one ZIP streamed to disk with a live "x of N" counter.
 *  - Safari / Firefox / phones: the album is split into parts of {PART_SIZE} photos,
 *    each downloaded with its own button, so no single ZIP gets too big for the browser.
 */
export default function ZipDownload({ photos, albumTitle, label = "Download All (ZIP)" }: ZipDownloadProps) {
  const { toast } = useToast();
  const streaming = useMemo(() => canStreamToDisk(), []);
  const parts = partCount(photos.length);
  const needsParts = parts > 1;

  const [forceParts, setForceParts] = useState(false);
  const [showParts, setShowParts] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [progress, setProgress] = useState("");
  const [donePartIndexes, setDonePartIndexes] = useState<Set<number>>(new Set());
  const [partsWithMissing, setPartsWithMissing] = useState<Set<number>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  const useWholeFile = streaming && !forceParts && needsParts;
  const partsMode = needsParts && !useWholeFile;

  const reportFailures = (result: DownloadResult) => {
    if (result.failed.length > 0) {
      toast({
        title: `${result.failed.length} photo${result.failed.length === 1 ? "" : "s"} couldn't be downloaded`,
        description: "They're listed in _missing_photos.txt inside the ZIP. Please try again in a few minutes.",
        variant: "destructive",
      });
    }
  };

  const handleError = (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    if (message === CANCELLED_MESSAGE) {
      toast({ title: "Download cancelled" });
      return;
    }
    console.error("ZIP download error:", error);
    toast({
      title: "Download failed",
      description: message || "Something went wrong. Please try again.",
      variant: "destructive",
    });
  };

  const run = async (b: Exclude<Busy, null>, job: (signal: AbortSignal) => Promise<DownloadResult>) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(b);
    setProgress("Preparing...");
    try {
      const result = await job(controller.signal);
      reportFailures(result);
      return result;
    } catch (error) {
      handleError(error);
      return null;
    } finally {
      setBusy(null);
      setProgress("");
      abortRef.current = null;
    }
  };

  const onProgress = (p: { current: number; total: number; phase: string }) => {
    setProgress(
      p.phase === "finishing" || p.phase === "complete"
        ? "Finishing your ZIP..."
        : `Downloading photo ${Math.min(p.current + 1, p.total)} of ${p.total}...`,
    );
  };

  const startWhole = async () => {
    // Must be the first async step so the browser still treats this as a click.
    const result = await run({ kind: "whole" }, (signal) => downloadAlbumToDisk(photos, albumTitle, onProgress, signal));
    if (result) toast({ title: "Download complete", description: "Your ZIP file has been saved." });
  };

  const startPart = async (index: number) => {
    const result = await run({ kind: "part", index }, (signal) =>
      downloadAlbumPart(photos, albumTitle, index, onProgress, signal),
    );
    if (result) {
      setDonePartIndexes((prev) => new Set(prev).add(index));
      if (result.failed.length > 0) setPartsWithMissing((prev) => new Set(prev).add(index));
      else setPartsWithMissing((prev) => {
        const n = new Set(prev);
        n.delete(index);
        return n;
      });
    }
  };

  const onMainClick = () => {
    if (useWholeFile) void startWhole();
    else if (partsMode) setShowParts((v) => !v);
    else void startPart(0);
  };

  const mainBusy = busy?.kind === "whole" || (busy?.kind === "part" && !partsMode);

  return (
    <div className="flex flex-col gap-2 items-start">
      <div className="flex items-center gap-2">
        <Button
          onClick={onMainClick}
          disabled={busy !== null}
          className="bg-primary text-primary-foreground hover:bg-primary/90 w-full sm:w-auto"
        >
          {mainBusy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
          {mainBusy ? "Downloading..." : label}
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

      {busy && <p className="text-sm text-muted-foreground animate-pulse">{progress}</p>}
      {useWholeFile && !busy && (
        <p className="text-xs text-muted-foreground max-w-md">
          Choose where to save the ZIP. Keep this tab open until it finishes.{" "}
          <button type="button" className="underline" onClick={() => {
              setForceParts(true);
              setShowParts(true);
            }}>
            Trouble downloading? Get it in smaller parts.
          </button>
        </p>
      )}

      {partsMode && showParts && (
        <div className="w-full max-w-xl rounded-md border border-border/60 p-3 space-y-3">
          <p className="text-sm text-muted-foreground">
            This album has {photos.length} photos, so it's split into {parts} ZIP files of up to {PART_SIZE} photos each
            (full quality). Download each part below and keep this tab open while one is downloading.
            {streaming ? "" : " For a single ZIP file of the whole album, use Chrome or Edge on a computer."}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {Array.from({ length: parts }, (_, i) => {
              const { start, end } = partRange(photos.length, i);
              const done = donePartIndexes.has(i);
              const thisBusy = busy?.kind === "part" && busy.index === i;
              return (
                <Button
                  key={i}
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void startPart(i)}
                  className="justify-start h-auto py-2 text-left"
                >
                  {thisBusy ? (
                    <Loader2 className="w-4 h-4 mr-2 shrink-0 animate-spin" />
                  ) : done ? (
                    <Check className="w-4 h-4 mr-2 shrink-0 text-primary" />
                  ) : (
                    <Download className="w-4 h-4 mr-2 shrink-0" />
                  )}
                  <span>
                    Part {i + 1} of {parts}
                    <span className="block text-xs font-normal text-muted-foreground">
                      Photos {start + 1}–{end}
                      {partsWithMissing.has(i) ? " · some missing, tap to retry" : done ? " · downloaded" : ""}
                    </span>
                  </span>
                </Button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
