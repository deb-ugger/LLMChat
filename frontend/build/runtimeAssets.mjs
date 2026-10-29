import fs from "node:fs";
import path from "node:path";

export const runtimeAssetDirectories = ["ocr", "ort", "manga-ort", "wtp"];

function syncEntry(source, destination) {
  const sourceStat = fs.statSync(source);
  const targetStat = fs.existsSync(destination) ? fs.statSync(destination) : null;
  if (targetStat && sourceStat.isDirectory() !== targetStat.isDirectory()) {
    fs.rmSync(destination, { recursive: true });
  }
  if (sourceStat.isDirectory()) {
    syncDirectory(source, destination);
  } else if (!targetStat || targetStat.isDirectory() || sourceStat.size !== targetStat.size
    || !fs.readFileSync(source).equals(fs.readFileSync(destination))) {
    fs.copyFileSync(source, destination);
    const now = new Date();
    fs.utimesSync(destination, now, now);
  }
}

/** Sync only owned build outputs, retaining timestamps when their bytes match. */
export function syncDirectory(source, destination, selectedNames) {
  fs.mkdirSync(destination, { recursive: true });
  const names = fs.readdirSync(source).filter(name => !selectedNames || selectedNames.includes(name));
  const retained = new Set(names);
  for (const name of fs.readdirSync(destination)) {
    if (!retained.has(name)) fs.rmSync(path.join(destination, name), { recursive: true });
  }
  for (const name of names) syncEntry(path.join(source, name), path.join(destination, name));
}

/** Keep large inference resources outside Tauri's embedded frontend. */
export function copyPublicAssets(frontendRoot, outDir) {
  const publicDir = path.join(frontendRoot, "public");
  const resourceDir = path.join(frontendRoot, "src-tauri/resources/web-assets");
  for (const name of runtimeAssetDirectories) {
    if (!fs.statSync(path.join(publicDir, name)).isDirectory()) {
      throw new Error(`Missing runtime asset directory: ${name}`);
    }
  }
  syncDirectory(publicDir, resourceDir, runtimeAssetDirectories);
  fs.mkdirSync(outDir, { recursive: true });
  for (const entry of fs.readdirSync(publicDir, { withFileTypes: true })) {
    if (!runtimeAssetDirectories.includes(entry.name)) {
      syncEntry(path.join(publicDir, entry.name), path.join(outDir, entry.name));
    }
  }
}
