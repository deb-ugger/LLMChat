import { invoke } from "@tauri-apps/api/core";
import { join, resourceDir } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { addDownload, downloadFileName, trackDownload } from "./appDownloads";

export type OutputModule = "literature" | "text" | "redraw";
const moduleLabels: Record<OutputModule, string> = {
  literature: "文献翻译",
  text: "文本译文",
  redraw: "AI 风格重绘",
};

export async function getOutputDirectory(module: OutputModule): Promise<string> {
  return localStorage.getItem(`llmchat-output-directory-${module}`) || await resourceDir();
}

export function setOutputDirectory(module: OutputModule, path: string) {
  localStorage.setItem(`llmchat-output-directory-${module}`, path);
}

export async function saveOutputFile(fileName: string, contents: Uint8Array, extensions: string[], label: string, module: OutputModule, initialDirectory?: string): Promise<string | null> {
  const path = await save({
    defaultPath: await join(initialDirectory ?? await getOutputDirectory(module), fileName),
    filters: [{ name: label, extensions }],
  });
  if (!path) return null;
  await writeDownloadedFile(path, contents, moduleLabels[module]);
  return path;
}

export function writeDownloadedFile(path: string, contents: Uint8Array, source: string) {
  return trackDownload({ path, name: downloadFileName(path), source }, () => {
    // This command resolves after the atomic replacement succeeds.
    return invoke("write_file_bytes", { path, contents: Array.from(contents) });
  });
}

export function downloadBrowserFile(blob: Blob, name: string, source: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  addDownload({ name, source, status: "handed-off" });
}
