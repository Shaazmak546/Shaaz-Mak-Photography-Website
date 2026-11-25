import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const photoFile = path.join(dir, "photo.jpg");

function photoFixtures(): Plugin {
  const send = (res: import("node:http").ServerResponse, delayMs = 0) => {
    const start = async () => {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "no-store");
      fs.createReadStream(photoFile).pipe(res);
    };
    void start();
  };
  return {
    name: "photo-fixtures",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0];
        if (url === "/photos/slow.jpg") {
          send(res, 2000);
          return;
        }
        if (url === "/photos/photo.jpg") {
          send(res);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  root: dir,
  plugins: [react(), photoFixtures()],
  resolve: {
    alias: { "@": path.resolve(dir, "../../src") },
  },
  server: { host: "127.0.0.1", port: 4177, strictPort: true },
});
