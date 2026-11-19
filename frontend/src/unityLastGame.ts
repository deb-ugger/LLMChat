/** Last Unity game directory selected in the Unity translate page. */
export const LAST_UNITY_GAME_DIR_KEY = "llmchat-unity-last-game-dir";
export const RECENT_UNITY_GAMES_KEY = "llmchat-unity-recent-games";

const RECENT_MAX = 12;

export type RecentUnityGame = {
  gameDir: string;
  /** Display name (folder or exe stem). */
  name: string;
  openedAt: number;
  engine?: string;
};

type GameFailureKind = "text" | "images" | "patch";
const failureSummaryKey = (path: string) =>
  "llmchat-game-failures:" + path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export function recentGameFailureCount(path: string) {
  try {
    const counts: Partial<Record<GameFailureKind, number>> =
      JSON.parse(localStorage.getItem(failureSummaryKey(path)) || "{}");
    return (counts.text || 0) + (counts.images || 0) + (counts.patch || 0);
  } catch { return 0; }
}

export function rememberRecentGameFailures(path: string, kind: GameFailureKind, count: number) {
  if (!path) return;
  try {
    const key = failureSummaryKey(path);
    const counts: Partial<Record<GameFailureKind, number>> = JSON.parse(localStorage.getItem(key) || "{}");
    if ((counts[kind] || 0) === count) return;
    if (count) counts[kind] = count;
    else delete counts[kind];
    if (Object.keys(counts).length) localStorage.setItem(key, JSON.stringify(counts));
    else localStorage.removeItem(key);
  } catch { /* Storage can be unavailable. */ }
}

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
        engine: typeof x.engine === "string" ? x.engine : "Unity",
      }));
  } catch {
    return [];
  }
}

export function rememberRecentUnityGame(entry: {
  gameDir: string;
  name?: string;
  engine?: string;
}): RecentUnityGame[] {
  const gameDir = entry.gameDir.trim().replace(/[\\/]+$/, "");
  if (!gameDir) return loadRecentUnityGames();
  const name = (entry.name || "").trim() || folderNameFromPath(gameDir);
  const next: RecentUnityGame[] = [
    { gameDir, name, engine: entry.engine || "Unity", openedAt: Date.now() },
    ...loadRecentUnityGames().filter(
      (g) => g.gameDir.toLowerCase() !== gameDir.toLowerCase(),
    ),
  ].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_UNITY_GAMES_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  if (!entry.engine || entry.engine === "Unity") rememberLastUnityGameDir(gameDir);
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

const GAME_WORKSPACE_KEY = "llmchat-game-workspace";
export type GameWorkspaceState = { view: "list" } | { view: "detail"; game: RecentUnityGame; mode: "offline" | "runtime" };
export function rememberGameWorkspace(game: { gameDir: string; name?: string; engine?: string } | null, mode: "offline" | "runtime" = "offline") {
  const state: GameWorkspaceState = game ? { view: "detail", game: { gameDir: game.gameDir, name: game.name || folderNameFromPath(game.gameDir), engine: game.engine || "Unity", openedAt: Date.now() }, mode } : { view: "list" };
  try { localStorage.setItem(GAME_WORKSPACE_KEY, JSON.stringify(state)); } catch { /* Storage can be unavailable. */ }
}
export function loadGameWorkspace(): GameWorkspaceState {
  try {
    const raw = localStorage.getItem(GAME_WORKSPACE_KEY);
    if (raw) {
      const value = JSON.parse(raw);
      if (value.view === "list") return { view: "list" };
      if (value.view === "detail" && typeof value.game?.gameDir === "string" && value.game.gameDir.trim()) return { view: "detail", game: value.game, mode: value.mode === "runtime" ? "runtime" : "offline" };
    }
  } catch { /* Use the existing recent history when no workspace was saved. */ }
  // Older versions recorded non-Unity games in history, but only restored the Unity key.
  const recent = loadRecentUnityGames()[0];
  if (recent) return { view: "detail", game: recent, mode: "offline" };
  const gameDir = lastUnityGameDir();
  return gameDir ? { view: "detail", game: { gameDir, name: folderNameFromPath(gameDir), engine: "Unity", openedAt: 0 }, mode: "offline" } : { view: "list" };
}
const gameStageKey = (path: string) => `llmchat-game-stage:${path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()}`;
export function loadGameStage(path: string, supportsImages: boolean) {
  try {
    const value = JSON.parse(localStorage.getItem(gameStageKey(path)) || "null");
    if (value && [1,2,3,4].includes(value.step)) return { step: value.step as number, part: supportsImages && [2,4].includes(value.step) && value.part === "images" ? "images" as const : "text" as const };
  } catch { /* New or invalid view state starts at scanning. */ }
  return { step: 1, part: "text" as const };
}
export function rememberGameStage(path: string, step: number, part: "text" | "images") {
  try { localStorage.setItem(gameStageKey(path), JSON.stringify({step,part})); } catch { /* Storage can be unavailable. */ }
}
