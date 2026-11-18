import { useEffect, useState } from "react";
import { Check, Copy, Heart, Images, Loader2, MousePointerClick, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  AlbumShare,
  CreatedShare,
  ShareExpiry,
  ShareMode,
  createShare,
  formatShareDate,
  shareStatus,
  shareUrl,
} from "@/lib/shares";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { ShareLinksList } from "./ShareLinksList";

interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  albumId: string;
  albumTitle: string;
  totalPhotos: number;
  favoriteCount: number;
  /** Photos picked in "Choose photos" mode (empty until the client picks). */
  selectedIds: string[];
  /** Mode to preselect when the dialog opens (e.g. "selection" after picking). */
  initialMode?: ShareMode | null;
  /** Close the dialog and let the client pick photos in the grid. */
  onChooseSelection: () => void;
  shares: AlbumShare[];
  onSharesChanged: () => void;
  /** Called after a link is created (e.g. to leave selection mode). */
  onCreated?: () => void;
}

const EXPIRY_OPTIONS: Array<{ value: ShareExpiry; label: string }> = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "never", label: "Never" },
];

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function ShareDialog({
  open,
  onOpenChange,
  albumId,
  albumTitle,
  totalPhotos,
  favoriteCount,
  selectedIds,
  initialMode,
  onChooseSelection,
  shares,
  onSharesChanged,
  onCreated,
}: ShareDialogProps) {
  const { toast } = useToast();
  const [tab, setTab] = useState<"new" | "links">("new");
  const [mode, setMode] = useState<ShareMode>("album");
  const [expiry, setExpiry] = useState<ShareExpiry>("30");
  const [allowDownload, setAllowDownload] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<(CreatedShare & { mode: ShareMode; allowDownload: boolean }) | null>(null);
  const [copied, setCopied] = useState(false);

  // Fresh state every time the dialog opens. Favorites are the default when the
  // client has any, so sharing them is a single tap on "Create link".
  useEffect(() => {
    if (!open) return;
    setTab("new");
    setCreated(null);
    setCopied(false);
    if (initialMode === "selection" && selectedIds.length > 0) setMode("selection");
    else if (initialMode && initialMode !== "selection") setMode(initialMode);
    else setMode(favoriteCount > 0 ? "favorites" : "album");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // If the last heart is removed while "My favorites" is chosen, fall back.
  useEffect(() => {
    if (mode === "favorites" && favoriteCount === 0) setMode("album");
  }, [mode, favoriteCount]);

  const activeCount = shares.filter((s) => shareStatus(s) === "active").length;

  const photoCountFor = (m: ShareMode) =>
    m === "album" ? totalPhotos : m === "favorites" ? favoriteCount : selectedIds.length;

  const canCreate =
    !creating &&
    (mode === "album" ? totalPhotos > 0 : mode === "favorites" ? favoriteCount > 0 : selectedIds.length > 0);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const result = await createShare({
        albumId,
        mode,
        photoIds: mode === "selection" ? selectedIds : undefined,
        expiry,
        allowDownload,
      });
      setCreated({ ...result, mode, allowDownload });
      onSharesChanged();
      onCreated?.();
    } catch (err) {
      console.error("Create share failed:", err);
      toast({
        title: "Couldn't create the link",
        description: err instanceof Error && err.message ? err.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!created) return;
    if (await copyText(shareUrl(created.token))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const handleNativeShare = async () => {
    if (!created) return;
    try {
      await navigator.share({ title: albumTitle, text: `Photos from ${albumTitle}`, url: shareUrl(created.token) });
    } catch {
      // User cancelled the share sheet — nothing to do.
    }
  };

  const options: Array<{
    value: ShareMode;
    title: string;
    detail: string;
    icon: typeof Images;
    disabled?: boolean;
  }> = [
    {
      value: "album",
      title: "Whole album",
      detail: `All ${plural(totalPhotos, "photo")}, including any added later`,
      icon: Images,
    },
    {
      value: "favorites",
      title: favoriteCount > 0 ? `My favorites (${favoriteCount})` : "My favorites",
      detail:
        favoriteCount > 0
          ? `Just the ${plural(favoriteCount, "photo")} you've hearted`
          : "Heart photos in your album to share just those",
      icon: Heart,
      disabled: favoriteCount === 0,
    },
    {
      value: "selection",
      title: "Choose photos",
      detail:
        selectedIds.length > 0
          ? `${plural(selectedIds.length, "photo")} selected`
          : favoriteCount > 0
            ? "Starts with your favorites — add or remove a few"
            : "Tap the photos you want to share",
      icon: MousePointerClick,
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl font-medium">Share {albumTitle}</DialogTitle>
          <DialogDescription>
            Send family and friends a private link — no login needed. Only the photos you choose are visible.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 border-b border-border/60">
          {(["new", "links"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "px-3 py-2 text-sm -mb-px border-b-2 transition-colors",
                tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t === "new" ? "New link" : `Your links${activeCount ? ` (${activeCount})` : ""}`}
            </button>
          ))}
        </div>

        {tab === "links" ? (
          <ShareLinksList
            shares={shares}
            onChanged={onSharesChanged}
            emptyText="You haven't shared this album yet."
          />
        ) : created ? (
          <div className="space-y-5 py-2">
            <div className="text-center">
              <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-primary/15 flex items-center justify-center">
                <Check className="w-6 h-6 text-primary" />
              </div>
              <p className="font-serif text-xl">Your link is ready</p>
              <p className="text-sm text-muted-foreground mt-1">
                {plural(created.photo_count, "photo")}
                {" · "}
                {created.expires_at ? `expires ${formatShareDate(created.expires_at)}` : "never expires"}
                {" · "}
                {created.allowDownload ? "downloads allowed" : "view only"}
              </p>
            </div>
            <div className="flex gap-2">
              <input
                readOnly
                value={shareUrl(created.token)}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 min-w-0 rounded-md border border-input bg-muted/40 px-3 py-2 text-sm text-foreground"
                aria-label="Share link"
              />
              <Button onClick={handleCopy} className="bg-primary text-primary-foreground hover:bg-primary/90 shrink-0">
                {copied ? <Check className="w-4 h-4 mr-2" /> : <Copy className="w-4 h-4 mr-2" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            {canNativeShare && (
              <Button variant="outline" className="w-full border-primary/30" onClick={handleNativeShare}>
                <Share2 className="w-4 h-4 mr-2" />
                Send with Messages, WhatsApp…
              </Button>
            )}
            <div className="flex justify-between gap-2">
              <Button variant="ghost" onClick={() => setCreated(null)}>
                Create another link
              </Button>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-6 py-1">
            <div className="space-y-2" role="radiogroup" aria-label="What to share">
              {options.map((opt) => {
                const Icon = opt.icon;
                const checked = mode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    disabled={opt.disabled}
                    onClick={() => {
                      if (opt.value === "selection" && selectedIds.length === 0) {
                        onChooseSelection();
                        return;
                      }
                      setMode(opt.value);
                    }}
                    className={cn(
                      "w-full flex items-center gap-4 p-4 text-left border rounded-md transition-all",
                      checked ? "border-primary bg-primary/5 shadow-sm" : "border-border/60 hover:border-primary/50",
                      opt.disabled && "opacity-50 cursor-not-allowed hover:border-border/60",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                        checked ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground/70",
                      )}
                    >
                      <Icon className="w-5 h-5" fill={opt.value === "favorites" && checked ? "currentColor" : "none"} />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block font-medium">{opt.title}</span>
                      <span className="block text-sm text-muted-foreground">{opt.detail}</span>
                    </span>
                    {opt.value === "selection" && selectedIds.length > 0 && (
                      <span
                        role="link"
                        tabIndex={0}
                        className="text-sm text-primary hover:text-accent underline-offset-4 hover:underline shrink-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          onChooseSelection();
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.stopPropagation();
                            onChooseSelection();
                          }
                        }}
                      >
                        Edit
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="space-y-2">
              <Label className="text-sm text-muted-foreground uppercase tracking-wider">Link expires after</Label>
              <div className="grid grid-cols-3 gap-2">
                {EXPIRY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setExpiry(opt.value)}
                    aria-pressed={expiry === opt.value}
                    className={cn(
                      "py-2 text-sm border rounded-md transition-colors",
                      expiry === opt.value
                        ? "border-primary bg-primary/5 text-foreground"
                        : "border-border/60 text-muted-foreground hover:border-primary/50",
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="share-allow-download" className="font-medium">
                  Allow downloads
                </Label>
                <p className="text-sm text-muted-foreground">
                  {allowDownload ? "Guests can save full-size photos." : "Guests can view but not download."}
                </p>
              </div>
              <Switch id="share-allow-download" checked={allowDownload} onCheckedChange={setAllowDownload} />
            </div>

            <Button
              onClick={handleCreate}
              disabled={!canCreate}
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {creating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Share2 className="w-4 h-4 mr-2" />}
              {creating ? "Creating link..." : `Create link · ${plural(photoCountFor(mode), "photo")}`}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
