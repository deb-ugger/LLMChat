export function gameSelectionDropPath(files: readonly { path?: string; name?: string }[], uriList: string) {
  if (files.length > 1) throw new Error("一次请拖入一个游戏程序或目录");
  if (files[0]?.path) return files[0].path;
  const uri = uriList.split(/\r?\n/).find(line => line.trim() && !line.startsWith("#"))?.trim();
  if (uri?.startsWith("file:")) {
    const url = new URL(uri), path = decodeURIComponent(url.pathname);
    return url.hostname && url.hostname !== "localhost" ? `\\\\${url.hostname}${path.replace(/\//g, "\\")}` : path.replace(/^\/(?=[A-Za-z]:)/, "");
  }
  if (uri && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(uri)) return uri;
  throw new Error("无法取得本地路径，请从文件管理器拖入游戏程序或目录");
}

export const openDroppedGameDirectly = (path: string) => /\.exe$/i.test(path.trim());
