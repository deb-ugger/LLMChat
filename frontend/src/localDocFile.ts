import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { redactRuntimeMessage } from "./runtimeLog";

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
  if (extOf(path) !== "onnx") return invoke<ArrayBuffer>("read_file_bytes", { path });

  const { size, lastModified } = await fileStat(path);
  const modelName = baseName(path);
  const started = performance.now();
  let offset = 0;
  const record = (phase: string, error = "") => invoke<void>("write_runtime_log", {
    kind: "onnx-transfer", message: redactRuntimeMessage(
      `phase=${phase}; model=${modelName}; bytes=${size}; transferred_bytes=${offset}; elapsed_ms=${Math.round(performance.now() - started)}${error}`,
    ),
  }).catch(cause => console.warn("ONNX 诊断日志写入失败", cause));

  await record("begin");
  try {
    const chunkSize = 16 * 1024 * 1024;
    // Large responses can require a single, much larger allocation in WebView2 IPC.
    const output = new Uint8Array(size);
    if (size === 0) await invoke<ArrayBuffer>("read_file_bytes", { path });
    while (offset < size) {
      const length = Math.min(chunkSize, size - offset);
      const part = new Uint8Array(await invoke<ArrayBuffer>("read_file_bytes", { path, range: { offset, length } }));
      if (part.byteLength !== length) throw new Error(`模型文件分块长度不符（偏移 ${offset}）`);
      output.set(part, offset);
      offset += length;
    }
    const current = await fileStat(path);
    if (current.size !== size || current.lastModified !== lastModified) throw new Error("读取过程中模型文件已变动");
    await record("ready");
    return output.buffer;
  } catch (cause) {
    await record("failed", `; error=${cause instanceof Error ? cause.message : String(cause)}`);
    throw cause;
  }
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
