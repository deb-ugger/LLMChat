import fs from "node:fs";
import path from "node:path";

export const runtimeAssetDirectories = ["ocr", "ort", "manga-ort", "wtp"];

/** Keep large inference resources outside Tauri's embedded frontend. */
export function copyPublicAssets(frontendRoot, outDir) {
  const publicDir = path.join(frontendRoot, "public");
  const resourceDir = path.join(frontendRoot, "src-tauri/resources/web-assets");
  for (const name of runtimeAssetDirectories) {
    if (!fs.statSync(path.join(publicDir, name)).isDirectory()) {
      throw new Error(`Missing runtime asset directory: ${name}`);
    }
  }
  // Only this generated resource tree is replaced; user model caches are separate.
  fs.rmSync(resourceDir, { recursive: true, force: true });
  fs.mkdirSync(resourceDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const entry of fs.readdirSync(publicDir, { withFileTypes: true })) {
    const target = runtimeAssetDirectories.includes(entry.name) ? resourceDir : outDir;
    fs.cpSync(path.join(publicDir, entry.name), path.join(target, entry.name), {
      recursive: true, preserveTimestamps: true,
    });
  }
}
