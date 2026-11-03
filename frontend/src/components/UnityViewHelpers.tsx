import { type UnityGameInfo,type UnityIniSection } from "../api";
type OutputLevel = "step" | "ok" | "error" | "info";

type OutputLine = {
  id: string;
  time: string;
  level: OutputLevel;
  text: string;
};

type ScanState = {
  ok: boolean;
  error: string;
  scanRoot: string;
  isUnity: boolean;
  isIl2Cpp: boolean;
  hasAutoTranslator: boolean;
  hasBepInEx: boolean;
  gameDir: string;
  gameExe: string;
  arch: string;
  runtime: string;
  installMethod: string;
  games: UnityGameInfo[];
};

function serializeIniSections(sections: UnityIniSection[]): string {
  const parts: string[] = [];
  for (const sec of sections) {
    parts.push(`[${sec.name}]`);
    for (const k of sec.keys) {
      parts.push(`${k.key}=${k.value}`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

function getIniValue(
  sections: UnityIniSection[],
  section: string,
  key: string,
): string | undefined {
  const sec = sections.find(
    (s) => s.name.toLowerCase() === section.toLowerCase(),
  );
  const row = sec?.keys.find((k) => k.key.toLowerCase() === key.toLowerCase());
  return row?.value;
}

function joinGameExePath(gameDir: string, gameExe?: string | null): string {
  const dir = gameDir.trim().replace(/[\\/]+$/, "");
  const exe = (gameExe || "").trim();
  if (!dir) return exe;
  if (!exe) return dir;
  const sep = dir.includes("/") && !dir.includes("\\") ? "/" : "\\";
  return `${dir}${sep}${exe}`;
}

function parseLogLine(raw: string, id: string): OutputLine {
  const m = raw.match(
    /^\[([^\]]+)\]\s*\[(step|ok|error|info)\]\s*(.*)$/i,
  );
  if (m) {
    return {
      id,
      time: m[1],
      level: m[2].toLowerCase() as OutputLevel,
      text: m[3],
    };
  }
  return { id, time: "", level: "step", text: raw };
}

function emptyScanState(scanRoot = ""): ScanState {
  return {
    ok: true,
    error: "",
    scanRoot,
    isUnity: false,
    isIl2Cpp: false,
    hasAutoTranslator: false,
    hasBepInEx: false,
    gameDir: "",
    gameExe: "",
    arch: "",
    runtime: "",
    installMethod: "",
    games: [],
  };
}

function gameTitle(n: UnityGameInfo) {
  if (n.gameExe) return n.gameExe.replace(/\.exe$/i, "");
  const e = n.gameDir.replace(/[\\/]+$/, "").split(/[\\/]/);
  return e[e.length - 1] || n.gameDir;
}

function archLabel(n?: string) {
  switch ((n || "").toLowerCase()) {
    case "x86":
      return "32位";
    case "x64":
      return "64位";
    case "arm64":
      return "ARM64";
    default:
      return "位数未知";
  }
}

function runtimeLabel(n: string, e?: boolean) {
  return n === "il2cpp" || e ? "IL2CPP" : n === "mono" ? "Mono" : "运行时未知";
}
export { archLabel,emptyScanState,gameTitle,getIniValue,joinGameExePath,parseLogLine,runtimeLabel,serializeIniSections };
export type { OutputLevel,OutputLine,ScanState };
