import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { copyPublicAssets, syncDirectory } from "./build/runtimeAssets.mjs";

const host = process.env.TAURI_DEV_HOST;
const require = createRequire(import.meta.url);
const pdfjsDistPath = path.dirname(require.resolve("pdfjs-dist/package.json"));

/** Serve pdf.js support files directly in dev. */
function servePdfjsAssets(): Plugin {
  const cmapsSrc = path.join(pdfjsDistPath, "cmaps");
  const fontsSrc = path.join(pdfjsDistPath, "standard_fonts");

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
    name: "serve-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/cmaps", mountStatic("/cmaps", cmapsSrc));
      server.middlewares.use(
        "/standard_fonts",
        mountStatic("/standard_fonts", fontsSrc),
      );
    },
  };
}

export default defineConfig(async () => ({
  worker: { format: "es" },
  build: { copyPublicDir: false, outDir: "dist-staging" },
  plugins: [react(), servePdfjsAssets(), {
    name: "external-runtime-assets",
    apply: "build",
    writeBundle(options) {
      const staging = path.resolve(options.dir ?? "dist-staging");
      copyPublicAssets(path.resolve("."), staging);
      for (const name of ["cmaps", "standard_fonts"]) {
        syncDirectory(path.join(pdfjsDistPath, name), path.join(staging, name));
      }
      // Tauri watches dist. Do not invalidate Rust for identical frontend output.
      syncDirectory(staging, path.resolve("dist"));
    },
  }],
  clearScreen: false,
  resolve: {
    // PaddleOCR is configured for the portable WASM backend. Avoid bundling
    // the full WebGPU runtime and use the explicitly shipped JSEP-capable
    // WASM file instead of emitting a duplicate copy.
    conditions: [
      "module",
      "browser",
      "development|production",
      "onnxruntime-web-use-extern-wasm",
    ],
    alias: [
      {
        find: /^onnxruntime-web$/,
        replacement: "onnxruntime-web/wasm",
      },
    ],
  },
  // Relative base so cmaps/fonts resolve under Tauri asset protocol
  base: "./",
  optimizeDeps: {
    include: [
      "pdfjs-dist",
      "clipper-lib",
      "js-yaml",
      "@techstark/opencv-js",
      "onnxruntime-web/wasm",
    ],
    // The SDK resolves its module Worker relative to its own package output;
    // dependency pre-bundling moves the entry without moving that Worker.
    exclude: ["@paddleocr/paddleocr-js"],
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
      ignored: ["**/src-tauri/**", "**/public/ocr/**", "**/public/ort/**"],
    },
  },
}));
