import { invoke } from "@tauri-apps/api/core";
import { join, resourceDir } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";

export type OutputModule = "literature" | "text";

export async function getOutputDirectory(module: OutputModule): Promise<string> {
  return localStorage.getItem(`llmchat-output-directory-${module}`) || await resourceDir();
}

export function setOutputDirectory(module: OutputModule, path: string) {
  localStorage.setItem(`llmchat-output-directory-${module}`, path);
}

export async function saveOutputFile(fileName: string, contents: Uint8Array, extensions: string[], label: string, module: OutputModule): Promise<string | null> {
  const path = await save({
    defaultPath: await join(await getOutputDirectory(module), fileName),
    filters: [{ name: label, extensions }],
  });
  if (!path) return null;
  await invoke("write_file_bytes", { path, contents: Array.from(contents) });
  return path;
}
