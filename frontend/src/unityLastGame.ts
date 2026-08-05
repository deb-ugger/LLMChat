/** Last Unity game directory selected in the Unity translate page. */
export const LAST_UNITY_GAME_DIR_KEY = "llmchat-unity-last-game-dir";
export const RECENT_UNITY_GAMES_KEY = "llmchat-unity-recent-games";

const RECENT_MAX = 12;

export type RecentUnityGame = {
  gameDir: string;
  /** Display name (folder or exe stem). */
  name: string;
  openedAt: number;
};

export function rememberLastUnityGameDir(path: string) {
  const dir = path.trim().replace(/[\\/]+$/, "");
  if (!dir) return;
  try {
    localStorage.setItem(LAST_UNITY_GAME_DIR_KEY, dir);
  } catch {
    /* ignore quota / private mode */
  }
}

export function lastUnityGameDir(): string {
  try {
    return localStorage.getItem(LAST_UNITY_GAME_DIR_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

export function loadRecentUnityGames(): RecentUnityGame[] {
  try {
    const raw = localStorage.getItem(RECENT_UNITY_GAMES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (x): x is RecentUnityGame =>
          !!x &&
          typeof x === "object" &&
          typeof (x as RecentUnityGame).gameDir === "string" &&
          !!(x as RecentUnityGame).gameDir.trim(),
      )
      .map((x) => ({
        gameDir: x.gameDir.trim().replace(/[\\/]+$/, ""),
        name: (x.name || "").trim() || folderNameFromPath(x.gameDir),
        openedAt: typeof x.openedAt === "number" ? x.openedAt : 0,
      }));
  } catch {
    return [];
  }
}

export function rememberRecentUnityGame(entry: {
  gameDir: string;
  name?: string;
}): RecentUnityGame[] {
  const gameDir = entry.gameDir.trim().replace(/[\\/]+$/, "");
  if (!gameDir) return loadRecentUnityGames();
  const name = (entry.name || "").trim() || folderNameFromPath(gameDir);
  const next: RecentUnityGame[] = [
    { gameDir, name, openedAt: Date.now() },
    ...loadRecentUnityGames().filter(
      (g) => g.gameDir.toLowerCase() !== gameDir.toLowerCase(),
    ),
  ].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_UNITY_GAMES_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  rememberLastUnityGameDir(gameDir);
  return next;
}

export function removeRecentUnityGame(gameDir: string): RecentUnityGame[] {
  const key = gameDir.trim().replace(/[\\/]+$/, "").toLowerCase();
  const next = loadRecentUnityGames().filter(
    (g) => g.gameDir.toLowerCase() !== key,
  );
  try {
    localStorage.setItem(RECENT_UNITY_GAMES_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

function folderNameFromPath(path: string): string {
  const raw = path.trim().replace(/[\\/]+$/, "");
  const parts = raw.split(/[\\/]/);
  return parts[parts.length - 1] || raw;
}
