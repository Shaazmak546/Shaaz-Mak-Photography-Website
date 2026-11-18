import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Users, ImageIcon, LogOut, Camera, Home, RefreshCw, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  formatReprocessSummary,
  reprocessMissingVariants,
  type ReprocessProgress,
} from "@/lib/reprocessVariants";
import { Clients } from "./admin/Clients";
import { AlbumManager } from "./admin/AlbumManager";
import { PortfolioManager } from "./admin/PortfolioManager";
import { HomepageManager } from "./admin/HomepageManager";

interface AdminStats {
  albums: number;
  clients: number;
  photos: number;
}

interface AlbumOption {
  id: string;
  title: string;
}

export default function Admin() {
  const { user, isAdmin, isLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [isReprocessing, setIsReprocessing] = useState(false);
  const [reprocessProgress, setReprocessProgress] = useState<ReprocessProgress | null>(null);
  const [reprocessDialogOpen, setReprocessDialogOpen] = useState(false);
  const [reprocessScope, setReprocessScope] = useState<string>("all");
  const [albumOptions, setAlbumOptions] = useState<AlbumOption[]>([]);
  const [myUsername, setMyUsername] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !user) {
      navigate("/login");
    } else if (!isLoading && user && !isAdmin) {
      navigate("/my-album");
    }
  }, [user, isAdmin, isLoading, navigate]);

  useEffect(() => {
    if (user && isAdmin) {
      loadStats();
      // Pull the admin's own username from profiles so it's visible on screen.
      // Useful for remembering what to log in with.
      supabase
        .from("profiles")
        .select("username")
        .eq("user_id", user.id)
        .maybeSingle()
        .then(({ data }) => setMyUsername(data?.username ?? null));
    }
  }, [user, isAdmin]);

  // Warn if the tab is closed mid-run — leaving would abandon in-progress photos.
  useEffect(() => {
    if (!isReprocessing) return;
    const onLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [isReprocessing]);

  const loadStats = async () => {
    // RPC may not be in generated types yet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.rpc as any)("get_admin_stats");
    if (error) {
      console.error("Failed to load admin stats:", error);
      return;
    }
    setStats(data as unknown as AdminStats);
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const openReprocessDialog = async () => {
    setReprocessScope("all");
    setReprocessDialogOpen(true);
    const { data, error } = await supabase
      .from("albums")
      .select("id, title")
      .order("created_at", { ascending: false });
    if (error) {
      console.warn("Could not load albums for reprocess filter:", error.message);
      return;
    }
    setAlbumOptions((data ?? []) as AlbumOption[]);
  };

  // Build thumb/preview in this browser for rows still missing variants.
  // The old backfill-variants Edge Function runs out of memory on large JPEGs.
  const handleReprocess = async () => {
    setReprocessDialogOpen(false);
    setIsReprocessing(true);
    setReprocessProgress({ completed: 0, total: 0, succeeded: 0, failed: 0 });
    try {
      const result = await reprocessMissingVariants({
        albumId: reprocessScope === "all" ? undefined : reprocessScope,
        onProgress: setReprocessProgress,
      });

      toast({
        title: result.failed > 0 ? "Reprocessing finished with errors" : "Reprocessing complete",
        description: formatReprocessSummary(result),
        variant: result.failed > 0 ? "destructive" : undefined,
      });
    } catch (err: unknown) {
      toast({
        title: "Reprocess failed",
        description: err instanceof Error ? err.message : "Could not run image reprocessing.",
        variant: "destructive",
      });
    } finally {
      setIsReprocessing(false);
      setReprocessProgress(null);
    }
  };

  const reprocessButtonLabel = (() => {
    if (!isReprocessing) return "Reprocess images";
    if (reprocessProgress && reprocessProgress.total > 0) {
      return `Reprocessing ${reprocessProgress.completed} of ${reprocessProgress.total}`;
    }
    return "Looking up photos...";
  })();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!user || !isAdmin) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Admin Header */}
      <header className="border-b border-border/50 bg-card">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-serif font-medium">Admin Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Shaaz Mak Photography
              {user?.email && (
                <>
                  {" · "}
                  Logged in as <span className="font-medium">{user.email}</span>
                  {myUsername && (
                    <> (username: <span className="font-medium">{myUsername}</span>)</>
                  )}
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={openReprocessDialog}
              disabled={isReprocessing}
              className="border-border/50"
              title="Generate WebP thumbnails in this browser for photos that don't have them yet"
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${isReprocessing ? "animate-spin" : ""}`} />
              {reprocessButtonLabel}
            </Button>
            <Button
              variant="outline"
              onClick={handleSignOut}
              disabled={isReprocessing}
              className="border-border/50"
            >
              <LogOut className="w-4 h-4 mr-2" />
              Sign Out
            </Button>
          </div>
        </div>
      </header>

      <Dialog open={reprocessDialogOpen} onOpenChange={setReprocessDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reprocess images</DialogTitle>
            <DialogDescription>
              Creates thumbnails and previews in this browser for photos that
              don&apos;t have them yet. Keep this tab open until it finishes.
              Photos that already have thumbnails are skipped.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm font-medium">Which photos?</p>
            <Select value={reprocessScope} onValueChange={setReprocessScope}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All photos (albums, portfolio, and homepage)</SelectItem>
                {albumOptions.map((album) => (
                  <SelectItem key={album.id} value={album.id}>
                    {album.title || "Untitled album"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReprocessDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleReprocess}>Start</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Main Content */}
      <main className="container mx-auto px-6 py-8">
        {/* Stats cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          <StatCard label="Albums" value={stats?.albums} icon={<FolderOpen className="w-5 h-5" />} />
          <StatCard label="Clients" value={stats?.clients} icon={<Users className="w-5 h-5" />} />
          <StatCard label="Photos" value={stats?.photos} icon={<ImageIcon className="w-5 h-5" />} />
        </div>

        <Tabs defaultValue="albums" className="space-y-6">
          <TabsList className="bg-muted/50">
            <TabsTrigger value="albums" className="data-[state=active]:bg-background">
              <ImageIcon className="w-4 h-4 mr-2" />
              Albums
            </TabsTrigger>
            <TabsTrigger value="homepage" className="data-[state=active]:bg-background">
              <Home className="w-4 h-4 mr-2" />
              Homepage
            </TabsTrigger>
            <TabsTrigger value="portfolio" className="data-[state=active]:bg-background">
              <Camera className="w-4 h-4 mr-2" />
              Portfolio
            </TabsTrigger>
            <TabsTrigger value="clients" className="data-[state=active]:bg-background">
              <Users className="w-4 h-4 mr-2" />
              Clients
            </TabsTrigger>
          </TabsList>

          <TabsContent value="albums">
            <AlbumManager onChange={loadStats} />
          </TabsContent>

          <TabsContent value="homepage">
            <HomepageManager />
          </TabsContent>

          <TabsContent value="portfolio">
            <PortfolioManager />
          </TabsContent>

          <TabsContent value="clients">
            <Clients onChange={loadStats} />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: number | undefined;
  icon: React.ReactNode;
}) {
  return (
    <div className="bg-card border border-border/50 rounded-lg p-5 flex items-center justify-between">
      <div>
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="text-3xl font-serif font-medium mt-1">
          {value === undefined ? "—" : value}
        </p>
      </div>
      <div className="text-muted-foreground">{icon}</div>
    </div>
  );
}
