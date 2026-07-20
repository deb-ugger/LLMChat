import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;
const require = createRequire(import.meta.url);
const pdfjsDistPath = path.dirname(require.resolve("pdfjs-dist/package.json"));

/** Copy pdf.js cmaps/fonts into dist (and serve them in dev). */
function copyPdfjsAssets(): Plugin {
  const cmapsSrc = path.join(pdfjsDistPath, "cmaps");
  const fontsSrc = path.join(pdfjsDistPath, "standard_fonts");
  const outDir = path.resolve("dist");

  const mountStatic = (prefix: string, root: string) => {
    return (
      req: { url?: string },
      res: NodeJS.WritableStream & {
        statusCode?: number;
        setHeader?: (k: string, v: string) => void;
      },
      next: () => void,
    ) => {
      const rel = decodeURIComponent((req.url ?? "").split("?")[0] ?? "").replace(
        /^\//,
        "",
      );
      if (!rel) return next();
      const filePath = path.resolve(root, rel);
      if (!filePath.startsWith(path.resolve(root))) return next();
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        return next();
      }
      res.setHeader?.("Content-Type", "application/octet-stream");
      fs.createReadStream(filePath).pipe(res);
    };
  };

  return {
    name: "copy-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/cmaps", mountStatic("/cmaps", cmapsSrc));
      server.middlewares.use(
        "/standard_fonts",
        mountStatic("/standard_fonts", fontsSrc),
      );
    },
    closeBundle() {
      for (const [src, name] of [
        [cmapsSrc, "cmaps"],
        [fontsSrc, "standard_fonts"],
      ] as const) {
        const dest = path.join(outDir, name);
        fs.rmSync(dest, { recursive: true, force: true });
        fs.cpSync(src, dest, { recursive: true });
      }
    },
  };
}

export default defineConfig(async () => ({
  plugins: [react(), copyPdfjsAssets()],
  clearScreen: false,
  // Relative base so cmaps/fonts resolve under Tauri asset protocol
  base: "./",
  optimizeDeps: {
    include: ["pdfjs-dist"],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
