import { createRoot } from "react-dom/client";
import { SavePhotoButton } from "@/components/album/SavePhotoButton";

const params = new URLSearchParams(window.location.search);
const slow = params.get("slow") === "1";
const noName = params.get("noName") === "1";
const title = params.get("title") || null;
const fallback = params.get("fallback") || undefined;
const name = params.get("name") || "DSC_1234.jpg";

const photo = {
  id: params.get("id") || "photo-1",
  url: slow ? "/photos/slow.jpg" : "/photos/photo.jpg",
  original_filename: noName ? null : name,
  title,
};

createRoot(document.getElementById("root")!).render(
  <div style={{ padding: 24 }}>
    <SavePhotoButton photo={photo} fallbackFileName={fallback} announceDownload />
  </div>,
);
