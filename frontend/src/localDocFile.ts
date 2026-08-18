import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

export type DocKind = "pdf" | "epub";

export type LocalDocFile = {
  filePath: string;
  fileName: string;
  fileSize: number;
  lastModified: number;
  bytes: ArrayBuffer;
};

function baseName(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

function extOf(path: string): string {
  const name = baseName(path).toLowerCase();
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1) : "";
}

export function detectDocKind(path: string): DocKind | null {
  const ext = extOf(path);
  if (ext === "pdf") return "pdf";
  if (ext === "epub") return "epub";
  return null;
}

/** Pick a local document via Tauri open dialog; returns absolute path or null. */
export async function pickDocumentPath(
  kinds: DocKind[],
): Promise<string | null> {
  const filters: { name: string; extensions: string[] }[] = [];
  if (kinds.includes("pdf")) {
    filters.push({ name: "PDF", extensions: ["pdf"] });
  }
  if (kinds.includes("epub")) {
    filters.push({ name: "EPUB", extensions: ["epub"] });
  }
  if (kinds.includes("pdf") && kinds.includes("epub")) {
    filters.unshift({ name: "文档", extensions: ["pdf", "epub"] });
  }
  const selected = await openDialog({
    multiple: false,
    directory: false,
    title: "打开文献",
    filters,
  });
  if (typeof selected !== "string" || !selected.trim()) return null;
  return selected;
}

export async function readFileBytes(path: string): Promise<ArrayBuffer> {
  const bytes = await invoke<number[]>("read_file_bytes", { path });
  return new Uint8Array(bytes).buffer;
}

export async function fileStat(
  path: string,
): Promise<{ size: number; lastModified: number }> {
  const [size, lastModified] = await invoke<[number, number]>("file_stat", {
    path,
  });
  return { size, lastModified };
}

/** Read path + stat into a LocalDocFile for in-memory open. */
export async function loadLocalDoc(path: string): Promise<LocalDocFile> {
  const [bytes, stat] = await Promise.all([
    readFileBytes(path),
    fileStat(path),
  ]);
  return {
    filePath: path,
    fileName: baseName(path),
    fileSize: stat.size,
    lastModified: stat.lastModified,
    bytes,
  };
}

export async function pickAndLoadDocument(
  kinds: DocKind[],
): Promise<LocalDocFile | null> {
  const path = await pickDocumentPath(kinds);
  if (!path) return null;
  const kind = detectDocKind(path);
  if (!kind || !kinds.includes(kind)) {
    throw new Error("不支持的文件类型");
  }
  return loadLocalDoc(path);
}
