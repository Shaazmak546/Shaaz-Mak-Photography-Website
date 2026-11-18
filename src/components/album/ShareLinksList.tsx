import { useState } from "react";
import { Check, Copy, Download, ExternalLink, Link2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  AlbumShare,
  SHARE_MODE_LABEL,
  formatShareDate,
  revokeShare,
  shareStatus,
  shareUrl,
} from "@/lib/shares";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";

interface ShareLinksListProps {
  shares: AlbumShare[];
  onChanged: () => void;
  /** Admin view: label each link with the client who created it. */
  creatorNames?: Record<string, string>;
  emptyText?: string;
}

export function ShareLinksList({ shares, onChanged, creatorNames, emptyText }: ShareLinksListProps) {
  const { toast } = useToast();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [toRevoke, setToRevoke] = useState<AlbumShare | null>(null);
  const [revoking, setRevoking] = useState(false);

  if (shares.length === 0) {
    return (
      <div className="text-center py-8 text-sm text-muted-foreground">
        <Link2 className="w-6 h-6 mx-auto mb-2 opacity-50" />
        {emptyText ?? "No share links yet."}
      </div>
    );
  }

  const handleCopy = async (share: AlbumShare) => {
    if (await copyText(shareUrl(share.token))) {
      setCopiedId(share.id);
      setTimeout(() => setCopiedId((c) => (c === share.id ? null : c)), 2000);
    } else {
      toast({ title: "Couldn't copy", description: shareUrl(share.token) });
    }
  };

  const handleRevoke = async () => {
    if (!toRevoke) return;
    setRevoking(true);
    try {
      await revokeShare(toRevoke.id);
      toast({ title: "Link turned off", description: "Anyone opening it will see that it's no longer available." });
      setToRevoke(null);
      onChanged();
    } catch (err) {
      console.error("Revoke failed:", err);
      toast({ title: "Couldn't turn off the link", description: "Please try again.", variant: "destructive" });
    } finally {
      setRevoking(false);
    }
  };

  return (
    <>
      <ul className="divide-y divide-border/60">
        {shares.map((share) => {
          const status = shareStatus(share);
          const active = status === "active";
          return (
            <li key={share.id} className={cn("py-3 flex items-start gap-3", !active && "opacity-60")}>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-sm">{SHARE_MODE_LABEL[share.mode]}</span>
                  {share.photo_count !== null && (
                    <span className="text-xs text-muted-foreground">
                      {share.photo_count} photo{share.photo_count === 1 ? "" : "s"}
                    </span>
                  )}
                  <span
                    className={cn(
                      "text-[11px] uppercase tracking-wider px-1.5 py-0.5 rounded",
                      active ? "bg-primary/15 text-accent" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {status === "active" ? "Active" : status === "expired" ? "Expired" : "Turned off"}
                  </span>
                  {share.allow_download && (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Download className="w-3 h-3" /> Downloads on
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {creatorNames && <>{creatorNames[share.created_by] ?? "Client"} · </>}
                  Created {formatShareDate(share.created_at)}
                  {share.revoked_at
                    ? ` · Turned off ${formatShareDate(share.revoked_at)}`
                    : share.expires_at
                      ? ` · ${status === "expired" ? "Expired" : "Expires"} ${formatShareDate(share.expires_at)}`
                      : " · Never expires"}
                </p>
              </div>
              {active && (
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="sm" onClick={() => handleCopy(share)} title="Copy link">
                    {copiedId === share.id ? <Check className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4" />}
                  </Button>
                  <Button variant="ghost" size="sm" asChild title="Open link">
                    <a href={shareUrl(share.token)} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-destructive/30 text-destructive hover:bg-destructive hover:text-destructive-foreground"
                    onClick={() => setToRevoke(share)}
                  >
                    Turn off
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <AlertDialog open={!!toRevoke} onOpenChange={(open) => !open && setToRevoke(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off this link?</AlertDialogTitle>
            <AlertDialogDescription>
              Anyone who has this link won't be able to see the photos anymore. This can't be undone, but you can
              always create a new link.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleRevoke();
              }}
              disabled={revoking}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {revoking && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Turn off link
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
