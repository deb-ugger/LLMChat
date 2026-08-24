import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, API_BASE, type UnityGameInfo, type UnityIniSection } from "../api";
import { toFriendlyError } from "../friendlyError";
import { isBoolIniValue, setIniValue } from "../unityIni";
import { usePersistedHeight } from "../hooks/usePersistedHeight";
import { usePersistedWidth } from "../hooks/usePersistedWidth";
import {
  CONFIG_HELP_CATALOG,
  CONFIG_README_URL,
  essentialConfigSections,
  fieldMeta,
  sectionMeta,
} from "../unityConfigMeta";
import {
  lastUnityGameDir,
  loadRecentUnityGames,
  rememberLastUnityGameDir,
  rememberRecentUnityGame,
  removeRecentUnityGame,
  type RecentUnityGame,
} from "../unityLastGame";

const OUTPUT_UI_MAX = 200;
const LAST_PICK_DIR_KEY = "llmchat-unity-last-pick-dir";

/** Directory to open in the native picker (parent if path is a .exe). */
function browseDirFromPath(path: string): string {
  const raw = path.trim().replace(/\//g, "\\").replace(/\\+$/, "");
  if (!raw) return "";
  if (/\.exe$/i.test(raw)) {
    const idx = raw.lastIndexOf("\\");
    return idx > 0 ? raw.slice(0, idx) : "";
  }
  return raw;
}

function rememberLastPickDir(path: string) {
  const dir = browseDirFromPath(path);
  if (!dir) return;
  try {
    localStorage.setItem(LAST_PICK_DIR_KEY, dir);
  } catch {
    /* ignore quota / private mode */
  }
}

function lastPickDir(): string {
  try {
    return localStorage.getItem(LAST_PICK_DIR_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

/** Match backend pathContainsChinese — CJK in path breaks Doorstop/BepInEx. */
function pathContainsChinese(path: string): boolean {
  for (const ch of path) {
    const u = ch.codePointAt(0) ?? 0;
    if (
      (u >= 0x4e00 && u <= 0x9fff) || // CJK Unified Ideographs
      (u >= 0x3400 && u <= 0x4dbf) || // Extension A
      (u >= 0xf900 && u <= 0xfaff) || // Compatibility Ideographs
      (u >= 0x3000 && u <= 0x303f) // CJK Symbols and Punctuation
    ) {
      return true;
    }
  }
  return false;
}

/** Mono → ReiPatcher；IL2CPP → BepInEx */
function expectedFrameworkName(isIl2Cpp: boolean): string {
  return isIl2Cpp ? "BepInEx" : "ReiPatcher";
}

function hasPluginFramework(g: {
  isIl2Cpp: boolean;
  hasBepInEx: boolean;
  loaderName?: string;
}): boolean {
  if (g.isIl2Cpp) return !!g.hasBepInEx;
  return g.loaderName === "ReiPatcher";
}

type OutputLevel = "step" | "ok" | "error" | "info";

type OutputLine = {
  id: string;
  time: string;
  level: OutputLevel;
  text: string;
};

const TARGET_LANG_OPTIONS = [
  { id: "zh-CN", label: "简体中文" },
  { id: "zh-TW", label: "繁体中文" },
  { id: "en", label: "英语" },
  { id: "ja", label: "日语" },
  { id: "ko", label: "韩语" },
];

const FROM_LANG_OPTIONS = [
  { id: "ja", label: "日语" },
  { id: "en", label: "英语" },
  { id: "ko", label: "韩语" },
  { id: "zh-CN", label: "简体中文" },
  { id: "auto", label: "自动检测" },
];

type Endpoint = { id: string; label: string; needsKey: boolean };

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

type SelfCheckCheck = {
  id: string;
  level: string;
  title: string;
  detail: string;
};

type SelfCheck = {
  verdict: string;
  verdictLabel: string;
  summary: string;
  gameArch: string;
  loaderArch: string;
  runtime: string;
  checks: SelfCheckCheck[];
  suggestions: string[];
  hasLog: boolean;
  logPath: string;
  logSnippet: string;
  checkedAt: string;
  gameExePath: string;
};

type SelfCheckTab = {
  id: string;
  title: string;
  result: SelfCheck;
};

type HelpDialog = "wont-launch" | "startup-flow" | "config-keys" | null;

type UninstallConfirm = {
  kind: "plugin" | "framework";
  gameDir: string;
  frameworkName: string;
  isIl2Cpp: boolean;
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

function formatClock(d = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
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

export function UnityTranslateView({
  active = true,
  onOpenUnitySettings,
}: {
  active?: boolean;
  onOpenUnitySettings?: () => void;
}) {
  const [pathInput, setPathInput] = useState("");
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [endpoint, setEndpoint] = useState("GoogleTranslate");
  const [fallbackEndpoint, setFallbackEndpoint] = useState("");
  const [targetLang, setTargetLang] = useState("zh-CN");
  const [fromLang, setFromLang] = useState("ja");
  const [configSections, setConfigSections] = useState<UnityIniSection[]>([]);
  const [configPath, setConfigPath] = useState("");
  const [configExists, setConfigExists] = useState(false);
  const [scanState, setScanState] = useState<ScanState | null>(null);
  const [selectedGameDir, setSelectedGameDir] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "detail">("list");

  useEffect(() => {
    if (selectedGameDir) rememberLastUnityGameDir(selectedGameDir);
  }, [selectedGameDir]);

  const [recentGames, setRecentGames] = useState<RecentUnityGame[]>(() => {
    const list = loadRecentUnityGames();
    if (list.length > 0) return list;
    const dir = lastUnityGameDir();
    return dir ? rememberRecentUnityGame({ gameDir: dir }) : [];
  });

  const [searchQuery, setSearchQuery] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busy = busyAction !== null;
  const actionLabel = (id: string, idle: string) =>
    busyAction === id ? "处理中" : idle;
  const [scanning, setScanning] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outputLines, setOutputLines] = useState<OutputLine[]>([]);
  const [outputLogPath, setOutputLogPath] = useState("");
  const [selfCheckTabs, setSelfCheckTabs] = useState<SelfCheckTab[]>([]);
  const [activeBottomTab, setActiveBottomTab] = useState<string>("output");
  const [selfCheckTabMenu, setSelfCheckTabMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
  } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpMenuPos, setHelpMenuPos] = useState<{
    top: number;
    right: number;
  } | null>(null);
  const [helpDialog, setHelpDialog] = useState<HelpDialog>(null);
  const [uninstallConfirm, setUninstallConfirm] =
    useState<UninstallConfirm | null>(null);
  const [configToast, setConfigToast] = useState<{
    message: string;
    ok: boolean;
  } | null>(null);
  const configToastTimerRef = useRef<number | null>(null);
  const detectAbortRef = useRef<AbortController | null>(null);
  const helpBtnRef = useRef<HTMLButtonElement>(null);
  const dropzoneRef = useRef<HTMLDivElement | null>(null);
  const outputEndRef = useRef<HTMLLIElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const detectGamesAccRef = useRef<UnityGameInfo[]>([]);
  const {
    height: statusHeight,
    beginResize: beginStatusResize,
    collapsed: statusCollapsed,
  } = usePersistedHeight("llmchat-unity-status-height", 220, 120, 520, {
    collapseBelow: 72,
  });
  const {
    width: detailWidth,
    setWidth: setDetailWidth,
  } = usePersistedWidth("llmchat-unity-detail-width", 340, 280, 480);

  const beginDetailResize = useCallback(
    (e: React.MouseEvent) => {
      const workspaceW = workspaceRef.current?.clientWidth ?? 1200;
      const max = Math.min(480, Math.max(280, workspaceW - 360));
      const startX = e.clientX;
      const startW = Math.min(detailWidth, max);
      e.preventDefault();
      e.stopPropagation();
      const onMove = (ev: MouseEvent) => {
        const next = Math.min(
          max,
          Math.max(280, startW + (ev.clientX - startX)),
        );
        setDetailWidth(next);
      };
      const onUp = () => {
        document.body.classList.remove("col-resizing");
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      document.body.classList.add("col-resizing");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [detailWidth, setDetailWidth],
  );

  useEffect(() => {
    api
      .unityEndpoints()
      .then((res) => setEndpoints(res.endpoints || []))
      .catch(() => {
        setEndpoints([
          {
            id: "GoogleTranslate",
            label: "Google 翻译（免 Key）",
            needsKey: false,
          },
          { id: "BingTranslate", label: "Bing 翻译（免 Key）", needsKey: false },
        ]);
      });
  }, []);

  useEffect(() => {
    void api
      .unityReadOutputLog(OUTPUT_UI_MAX)
      .then((res) => {
        if (!res.ok) return;
        if (res.logPath) setOutputLogPath(res.logPath);
        const text = (res.text || "").trim();
        if (!text) return;
        const rows = text
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0)
          .slice(-OUTPUT_UI_MAX);
        setOutputLines(rows.map((raw, i) => parseLogLine(raw, `hist-${i}`)));
      })
      .catch(() => {
        // ignore history load failures
      });
  }, []);

  useEffect(() => {
    if (activeBottomTab !== "output") return;
    outputEndRef.current?.scrollIntoView({ block: "end" });
  }, [outputLines, activeBottomTab]);

  const pushOutput = useCallback((text: string, level: OutputLevel = "step") => {
    const line: OutputLine = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      time: formatClock(),
      level,
      text,
    };
    setOutputLines((prev) => {
      const next = [...prev, line];
      return next.length > OUTPUT_UI_MAX
        ? next.slice(next.length - OUTPUT_UI_MAX)
        : next;
    });
    void api
      .unityAppendOutputLog(`[${line.time}] [${level}] ${text}`)
      .then((res) => {
        if (res.logPath) setOutputLogPath(res.logPath);
      })
      .catch(() => {
        // keep UI history even if disk log write fails
      });
  }, []);

  /** Write to unity-output.log only; do not show in the 输出 tab. */
  const appendLogOnly = useCallback((text: string, level: OutputLevel = "info") => {
    const time = formatClock();
    void api
      .unityAppendOutputLog(`[${time}] [${level}] ${text}`)
      .then((res) => {
        if (res.logPath) setOutputLogPath(res.logPath);
      })
      .catch(() => {
        // ignore
      });
  }, []);

  const formatSelfCheckForLog = useCallback((tab: SelfCheckTab) => {
    const r = tab.result;
    const lines = [
      `=== ${tab.title} ===`,
      `时间：${r.checkedAt}`,
      `游戏路径：${r.gameExePath}`,
      `${r.verdictLabel} — ${r.summary}`,
      `游戏 ${archLabel(r.gameArch)} · 加载器 ${archLabel(r.loaderArch)} · ${runtimeLabel(r.runtime)}`,
    ];
    for (const c of r.checks) {
      lines.push(`[${c.level}] ${c.title}：${c.detail}`);
    }
    for (const s of r.suggestions) {
      lines.push(`建议：${s}`);
    }
    if (r.hasLog && r.logPath) {
      lines.push(`插件日志：${r.logPath}`);
    }
    return lines;
  }, []);

  const focusOutputTab = useCallback(() => {
    setActiveBottomTab("output");
  }, []);

  const archiveSelfCheckTab = useCallback(
    (tab: SelfCheckTab) => {
      for (const line of formatSelfCheckForLog(tab)) {
        appendLogOnly(line, "info");
      }
    },
    [appendLogOnly, formatSelfCheckForLog],
  );

  const closeSelfCheckTab = useCallback(
    (tabId: string) => {
      setSelfCheckTabs((prev) => {
        const closing = prev.find((t) => t.id === tabId);
        if (closing) archiveSelfCheckTab(closing);
        const next = prev.filter((t) => t.id !== tabId);
        setActiveBottomTab((cur) => {
          if (cur !== tabId) return cur;
          return next.length > 0 ? next[next.length - 1].id : "output";
        });
        return next;
      });
      setSelfCheckTabMenu(null);
    },
    [archiveSelfCheckTab],
  );

  const closeAllSelfCheckTabs = useCallback(() => {
    setSelfCheckTabs((prev) => {
      for (const tab of prev) archiveSelfCheckTab(tab);
      return [];
    });
    setActiveBottomTab("output");
    setSelfCheckTabMenu(null);
  }, [archiveSelfCheckTab]);

  const reportError = useCallback(
    (message: string) => {
      setError(message);
      pushOutput(message, "error");
      focusOutputTab();
    },
    [focusOutputTab, pushOutput],
  );

  const applyConfigSections = useCallback((sections: UnityIniSection[]) => {
    setConfigSections(sections);
    const ep = getIniValue(sections, "Service", "Endpoint");
    const fb = getIniValue(sections, "Service", "FallbackEndpoint");
    const lang = getIniValue(sections, "General", "Language");
    const from = getIniValue(sections, "General", "FromLanguage");
    if (ep != null) setEndpoint(ep);
    if (fb != null) setFallbackEndpoint(fb);
    if (lang != null) setTargetLang(lang);
    if (from != null) setFromLang(from);
  }, []);

  const loadConfigForGame = useCallback(
    async (gameDir: string) => {
      try {
        const res = await api.unityGetConfig(gameDir);
        if (!res.ok) {
          reportError(res.error || "读取配置失败");
          return;
        }
        setConfigPath(res.path || "");
        setConfigExists(!!res.exists);
        applyConfigSections(res.sections || []);
      } catch (e) {
        reportError(toFriendlyError(e, "读取配置失败"));
      }
    },
    [applyConfigSections, reportError],
  );

  const updateConfigKey = useCallback(
    (section: string, key: string, value: string) => {
      setConfigSections((prev) => setIniValue(prev, section, key, value));
      if (section === "Service" && key === "Endpoint") setEndpoint(value);
      if (section === "Service" && key === "FallbackEndpoint")
        setFallbackEndpoint(value);
      if (section === "General" && key === "Language") setTargetLang(value);
      if (section === "General" && key === "FromLanguage") setFromLang(value);
    },
    [],
  );

  const reportSuccess = useCallback(
    (message: string) => {
      setError(null);
      pushOutput(message, "ok");
      focusOutputTab();
    },
    [focusOutputTab, pushOutput],
  );

  const showConfigToast = useCallback((message: string, ok: boolean) => {
    setConfigToast({ message, ok });
    if (configToastTimerRef.current) {
      window.clearTimeout(configToastTimerRef.current);
    }
    configToastTimerRef.current = window.setTimeout(() => {
      setConfigToast(null);
      configToastTimerRef.current = null;
    }, 2600);
  }, []);

  useEffect(() => {
    return () => {
      if (configToastTimerRef.current) {
        window.clearTimeout(configToastTimerRef.current);
      }
    };
  }, []);

  const reportSteps = useCallback(
    (steps: string[]) => {
      for (const step of steps) pushOutput(step, "step");
      focusOutputTab();
    },
    [focusOutputTab, pushOutput],
  );

  useEffect(() => {
    if (!helpOpen) return;
    const onMouseDown = (ev: MouseEvent) => {
      const target = ev.target as Element | null;
      if (
        target?.closest?.(".unity-help-wrap") ||
        target?.closest?.(".unity-help-menu")
      ) {
        return;
      }
      setHelpOpen(false);
      setHelpMenuPos(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [helpOpen]);

  useEffect(() => {
    if (!selfCheckTabMenu) return;
    const onMouseDown = (ev: MouseEvent) => {
      const target = ev.target as Element | null;
      if (target?.closest?.(".unity-tab-context-menu")) return;
      setSelfCheckTabMenu(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setSelfCheckTabMenu(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [selfCheckTabMenu]);

  const games = scanState?.games ?? [];

  const filteredGames = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return games;
    return games.filter((g) => {
      const title = gameTitle(g).toLowerCase();
      const exe = (g.gameExe || "").toLowerCase();
      const dir = g.gameDir.toLowerCase();
      return title.includes(q) || exe.includes(q) || dir.includes(q);
    });
  }, [games, searchQuery]);

  const selected = useMemo(() => {
    if (!games.length) return null;
    if (selectedGameDir) {
      return games.find((g) => g.gameDir === selectedGameDir) ?? null;
    }
    if (games.length === 1) return games[0];
    return null;
  }, [games, selectedGameDir]);

  useEffect(() => {
    if (!selected?.gameDir) {
      void api
        .unityGetConfig("")
        .then((res) => {
          if (res.ok && res.sections) applyConfigSections(res.sections);
          setConfigPath(res.path || "");
          setConfigExists(!!res.exists);
        })
        .catch(() => {
          // ignore
        });
      return;
    }
    void loadConfigForGame(selected.gameDir);
  }, [selected?.gameDir, loadConfigForGame, applyConfigSections]);

  const onSaveConfig = async () => {
    const gameDir = selected?.gameDir;
    if (!gameDir) {
      reportError("请先选择一个游戏");
      return;
    }
    setBusyAction("save-config");
    setError(null);
    try {
      const res = await api.unitySaveConfig({
        path: gameDir,
        sections: configSections,
      });
      if (!res.ok) {
        reportError(res.error || "保存配置失败");
        return;
      }
      setConfigPath(res.path || configPath);
      setConfigExists(true);
      const savedPath = res.path || configPath;
      reportSuccess(`配置已保存：${savedPath}`);
      showConfigToast("配置已保存", true);
    } catch (e) {
      reportError(toFriendlyError(e, "保存配置失败"));
    } finally {
      setBusyAction(null);
    }
  };

  const resetPath = useCallback((path: string) => {
    setPathInput(path);
    rememberLastPickDir(path);
    setScanState(null);
    setSelectedGameDir(null);
    setViewMode("list");
    setSearchQuery("");
    setError(null);
  }, []);

  const clearPath = useCallback(() => {
    detectAbortRef.current?.abort();
    detectAbortRef.current = null;
    detectGamesAccRef.current = [];
    setBusyAction(null);
    setScanning(false);
    setPathInput("");
    setScanState(null);
    setSelectedGameDir(null);
    setViewMode("list");
    setSearchQuery("");
    setError(null);
    setActiveBottomTab("output");
    setSelfCheckTabs([]);
    setSelfCheckTabMenu(null);
  }, []);

  const refreshGame = useCallback(async (gameDir: string) => {
    const res = await api.unityDetect(gameDir);
    const game = res.games?.[0];
    if (game) {
      setScanState((prev) => {
        const base = prev ?? emptyScanState(res.scanRoot || gameDir);
        const nextGames = [...base.games];
        const idx = nextGames.findIndex((g) => g.gameDir === game.gameDir);
        if (idx >= 0) nextGames[idx] = game;
        else nextGames.push(game);
        return { ...base, games: nextGames, isUnity: true, ok: true };
      });
    }
  }, []);

  const runDetect = useCallback(async (path: string) => {
    const trimmed = path.trim();
    if (!trimmed) {
      reportError("请先选择或拖入游戏目录 / 主程序");
      return;
    }
    detectAbortRef.current?.abort();
    const ac = new AbortController();
    detectAbortRef.current = ac;
    setBusyAction("detect");
    setScanning(true);
    setError(null);
    setViewMode("list");
    setSelectedGameDir(null);
    setScanState(emptyScanState(trimmed));
    detectGamesAccRef.current = [];
    pushOutput(`开始检测：${trimmed}`, "info");
    focusOutputTab();
    try {
      await api.unityDetectStream(
        trimmed,
        {
          onGame: (game) => {
            if (ac.signal.aborted) return;
            if (
              !detectGamesAccRef.current.some((g) => g.gameDir === game.gameDir)
            ) {
              detectGamesAccRef.current = [...detectGamesAccRef.current, game];
            }
            setScanState((prev) => {
              const base = prev ?? emptyScanState(trimmed);
              if (base.games.some((g) => g.gameDir === game.gameDir)) {
                return base;
              }
              return {
                ...base,
                ok: true,
                isUnity: true,
                games: [...base.games, game],
              };
            });
          },
          onDone: (result) => {
            if (ac.signal.aborted) return;
            const found =
              typeof result.count === "number" && result.count >= 0
                ? result.count
                : detectGamesAccRef.current.length;
            setScanState((prev) => {
              const base = prev ?? emptyScanState(trimmed);
              const list =
                base.games.length > 0 ? base.games : detectGamesAccRef.current;
              return {
                ...base,
                games: list,
                ok: result.ok && list.length > 0,
                error: result.error || "",
                scanRoot: result.scanRoot || base.scanRoot || trimmed,
                isUnity: list.length > 0,
              };
            });
            if (!result.ok || found === 0) {
              reportError(result.error || "未找到 Unity 游戏");
            } else {
              pushOutput(`检测完成，找到 ${found} 个游戏`, "ok");
            }
          },
        },
        ac.signal,
      );
    } catch (e) {
      if (ac.signal.aborted) return;
      setScanState(null);
      setSelectedGameDir(null);
      reportError(toFriendlyError(e, "检测失败"));
    } finally {
      if (detectAbortRef.current === ac) {
        detectAbortRef.current = null;
        setBusyAction(null);
        setScanning(false);
      }
    }
  }, [focusOutputTab, pushOutput, reportError]);

  useEffect(() => {
    return () => {
      detectAbortRef.current?.abort();
    };
  }, []);

  const browsePath = async () => {
    try {
      const defaultPath =
        browseDirFromPath(pathInput) || lastPickDir();
      const res = await api.unityPickPath(defaultPath || undefined);
      if (res.cancelled || !res.path) return;
      resetPath(res.path);
      await runDetect(res.path);
    } catch (e) {
      setError(toFriendlyError(e, "无法打开选择对话框"));
    }
  };

  const pointInDropzone = useCallback(
    (physical: { x: number; y: number }, scaleFactor: number) => {
      const el = dropzoneRef.current;
      if (!el) return false;
      const x = physical.x / scaleFactor;
      const y = physical.y / scaleFactor;
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    },
    [],
  );

  useEffect(() => {
    if (!active) {
      setDragOver(false);
      return;
    }
    const unsubs: Array<() => void> = [];
    let cancelled = false;
    void (async () => {
      try {
        const win = getCurrentWindow();
        let scale = await win.scaleFactor();
        const u1 = await win.onScaleChanged(({ payload }) => {
          scale = payload.scaleFactor;
        });
        if (cancelled) {
          u1();
          return;
        }
        unsubs.push(u1);
        const u2 = await win.onDragDropEvent((event) => {
          if (cancelled) return;
          const payload = event.payload;
          if (payload.type === "leave") {
            setDragOver(false);
            return;
          }
          const over =
            "position" in payload &&
            pointInDropzone(payload.position, scale);
          if (payload.type === "enter" || payload.type === "over") {
            setDragOver(over);
            return;
          }
          if (payload.type === "drop") {
            setDragOver(false);
            if (!over) return;
            const p = payload.paths?.[0];
            if (!p) return;
            resetPath(p);
            void runDetect(p);
          }
        });
        if (cancelled) {
          u2();
          return;
        }
        unsubs.push(u2);
      } catch {
        /* Tauri drag-drop unavailable */
      }
    })();
    return () => {
      cancelled = true;
      setDragOver(false);
      for (const u of unsubs) u();
    };
  }, [active, pointInDropzone, resetPath, runDetect]);

  const openHelpMenu = () => {
    if (helpOpen) {
      setHelpOpen(false);
      setHelpMenuPos(null);
      return;
    }
    const rect = helpBtnRef.current?.getBoundingClientRect();
    if (rect) {
      setHelpMenuPos({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    }
    setHelpOpen(true);
  };

  const closeHelpMenu = () => {
    setHelpOpen(false);
    setHelpMenuPos(null);
  };

  const onInstall = async () => {
    const gameDir = selected?.gameDir;
    if (!gameDir) {
      reportError(
        games.length > 1 ? "请先在列表中点选一个游戏" : "请先检测并选择游戏",
      );
      return;
    }
    if (selected?.hasAutoTranslator) {
      reportError("该游戏已安装翻译插件，无需重复安装");
      return;
    }
    if (selected && !hasPluginFramework(selected)) {
      reportError(
        `请先安装插件框架（${expectedFrameworkName(selected.isIl2Cpp)}）`,
      );
      return;
    }
    if (
      !window.confirm(
        `将安装 XUnity.AutoTranslator 到：\n${gameDir}\n\n仅下载一次 GitHub 安装包到本地，不会调用翻译引擎 API。是否继续？`,
      )
    ) {
      return;
    }
    setBusyAction("install-plugin");
    setError(null);
    // Keep Service/General in sync with quick fields before install
    let sections = configSections;
    sections = setIniValue(sections, "Service", "Endpoint", endpoint);
    sections = setIniValue(
      sections,
      "Service",
      "FallbackEndpoint",
      fallbackEndpoint,
    );
    sections = setIniValue(sections, "General", "Language", targetLang);
    sections = setIniValue(sections, "General", "FromLanguage", fromLang);
    setConfigSections(sections);
    reportSteps(["准备安装"]);
    try {
      const res = await api.unityInstall({
        path: gameDir,
        language: targetLang,
        fromLanguage: fromLang,
        endpoint,
        fallbackEndpoint,
        runSetup: true,
        configIni: serializeIniSections(sections),
      });
      reportSteps(res.steps || []);
      if (!res.ok) {
        reportError(res.error || "安装失败");
        return;
      }
      reportSuccess(
        `安装完成（${res.installMethod} / v${res.version}）。配置已写入：${res.configPath}`,
      );
      await refreshGame(gameDir);
      setSelectedGameDir(gameDir);
      await loadConfigForGame(gameDir);
    } catch (e) {
      reportError(toFriendlyError(e, "安装失败"));
    } finally {
      setBusyAction(null);
    }
  };

  const onUninstall = () => {
    const gameDir = selected?.gameDir;
    if (!gameDir || !selected) {
      reportError(
        games.length > 1 ? "请先在列表中点选一个游戏" : "请先检测并选择游戏",
      );
      return;
    }
    if (!selected.hasAutoTranslator) {
      reportError("该游戏未检测到已安装的翻译插件");
      return;
    }
    setUninstallConfirm({
      kind: "plugin",
      gameDir,
      frameworkName: expectedFrameworkName(selected.isIl2Cpp),
      isIl2Cpp: selected.isIl2Cpp,
    });
  };

  const doUninstallPlugin = async (gameDir: string) => {
    setBusyAction("uninstall-plugin");
    setError(null);
    reportSteps(["准备卸载"]);
    try {
      const res = await api.unityUninstall(gameDir);
      reportSteps(res.steps || []);
      if (!res.ok) {
        reportError(res.error || "卸载失败");
        return;
      }
      const n = res.removed?.length ?? 0;
      reportSuccess(`卸载完成，已移除 ${n} 项。`);
      await refreshGame(gameDir);
      setSelectedGameDir(gameDir);
    } catch (e) {
      reportError(toFriendlyError(e, "卸载失败"));
    } finally {
      setBusyAction(null);
    }
  };

  const onInstallLoader = async () => {
    const gameDir = selected?.gameDir;
    if (!gameDir || !selected) {
      reportError(
        games.length > 1 ? "请先在列表中点选一个游戏" : "请先检测并选择游戏",
      );
      return;
    }
    const fw = expectedFrameworkName(selected.isIl2Cpp);
    if (hasPluginFramework(selected)) {
      reportError(`该游戏已安装插件框架（${fw}），无需重复安装`);
      return;
    }
    if (
      !window.confirm(
        selected.isIl2Cpp
          ? `将为 IL2CPP 游戏安装插件框架 BepInEx 到：\n${gameDir}\n\n若本地 resources/bepinex 已有缓存则直接使用；否则会下载一次并保存。是否继续？`
          : `将为 Mono 游戏安装插件框架 ReiPatcher 到：\n${gameDir}\n\n仅安装框架；官方 Setup 顺带装上的翻译插件会自动剥离。是否继续？`,
      )
    ) {
      return;
    }
    setBusyAction("install-framework");
    setError(null);
    reportSteps(["准备安装插件框架"]);
    try {
      const res = await api.unityInstallLoader(gameDir);
      reportSteps(res.steps || []);
      if (!res.ok) {
        reportError(res.error || "安装插件框架失败");
        return;
      }
      reportSuccess(
        selected.isIl2Cpp
          ? `插件框架安装完成（BepInEx ${res.version}）。建议先启动一次游戏完成初始化，再安装翻译插件。`
          : `插件框架安装完成（ReiPatcher）。请再点「安装翻译插件」。`,
      );
      await refreshGame(gameDir);
      setSelectedGameDir(gameDir);
    } catch (e) {
      reportError(toFriendlyError(e, "安装插件框架失败"));
    } finally {
      setBusyAction(null);
    }
  };

  const onUninstallLoader = () => {
    const gameDir = selected?.gameDir;
    if (!gameDir || !selected) {
      reportError(
        games.length > 1 ? "请先在列表中点选一个游戏" : "请先检测并选择游戏",
      );
      return;
    }
    const fw = expectedFrameworkName(selected.isIl2Cpp);
    if (!hasPluginFramework(selected)) {
      reportError(`该游戏未检测到插件框架（${fw}）`);
      return;
    }
    if (selected.hasAutoTranslator) {
      reportError("请先卸载翻译插件，再卸载插件框架");
      return;
    }
    setUninstallConfirm({
      kind: "framework",
      gameDir,
      frameworkName: fw,
      isIl2Cpp: selected.isIl2Cpp,
    });
  };

  const doUninstallFramework = async (gameDir: string) => {
    setBusyAction("uninstall-framework");
    setError(null);
    reportSteps(["准备卸载插件框架"]);
    try {
      const res = await api.unityUninstallLoader(gameDir);
      reportSteps(res.steps || []);
      if (!res.ok) {
        reportError(res.error || "卸载插件框架失败");
        return;
      }
      const n = res.removed?.length ?? 0;
      reportSuccess(`插件框架卸载完成，已移除 ${n} 项。`);
      await refreshGame(gameDir);
      setSelectedGameDir(gameDir);
    } catch (e) {
      reportError(toFriendlyError(e, "卸载插件框架失败"));
    } finally {
      setBusyAction(null);
    }
  };

  const confirmUninstall = async () => {
    if (!uninstallConfirm) return;
    const { kind, gameDir } = uninstallConfirm;
    setUninstallConfirm(null);
    if (kind === "plugin") await doUninstallPlugin(gameDir);
    else await doUninstallFramework(gameDir);
  };

  const openCurrentDir = async () => {
    const dir =
      selected?.gameDir || scanState?.scanRoot || pathInput.trim();
    if (!dir) return;
    try {
      await api.revealPath(dir);
    } catch (e) {
      reportError(toFriendlyError(e, "无法打开目录"));
    }
  };

  const openConfigFile = async () => {
    if (!configPath.trim() && !selected?.gameDir) return;
    try {
      let pathToOpen = configPath.trim();
      // getConfig 在未安装插件时也会返回「预计路径」，但文件尚不存在。
      // 先按当前编辑内容写入，再走与「打开游戏目录」相同的 UTF-8 路径打开逻辑。
      if (!configExists) {
        const gameDir = selected?.gameDir;
        if (!gameDir) {
          reportError("请先选择一个游戏");
          return;
        }
        const res = await api.unitySaveConfig({
          path: gameDir,
          sections: configSections,
        });
        if (!res.ok) {
          reportError(res.error || "无法创建配置文件");
          return;
        }
        pathToOpen = (res.path || pathToOpen).trim();
        setConfigPath(pathToOpen);
        setConfigExists(true);
        reportSuccess(`已写入配置：${pathToOpen}`);
      }
      if (!pathToOpen) {
        reportError("无法确定配置文件路径");
        return;
      }
      await api.openPath(pathToOpen);
    } catch (e) {
      reportError(toFriendlyError(e, "无法打开配置文件"));
    }
  };

  const openConfigReadme = async () => {
    try {
      await api.openPath(CONFIG_README_URL);
    } catch (e) {
      reportError(toFriendlyError(e, "无法打开官方说明"));
    }
  };

  const onLaunch = async () => {
    const gameDir = selected?.gameDir;
    if (!gameDir) {
      reportError("请先选择一个游戏");
      return;
    }
    setBusyAction("launch");
    setError(null);
    focusOutputTab();
    try {
      const res = await api.unityLaunch(gameDir);
      if (!res.ok) {
        reportError(res.error || "启动失败");
        return;
      }
      reportSuccess("已请求启动游戏。");
    } catch (e) {
      reportError(toFriendlyError(e, "启动失败"));
    } finally {
      setBusyAction(null);
    }
  };

  const onLaunchPatch = async () => {
    const gameDir = selected?.gameDir;
    if (!gameDir) {
      reportError("请先选择一个游戏");
      return;
    }
    if (!selected?.hasAutoTranslator) {
      reportError("请先安装翻译插件后再使用「补丁并启动」");
      return;
    }
    setBusyAction("launch-patch");
    setError(null);
    focusOutputTab();
    try {
      const res = await api.unityLaunchPatch(gameDir);
      if (!res.ok) {
        reportError(res.error || "补丁并启动失败");
        return;
      }
      reportSuccess(
        "已通过「补丁并启动」启动（首次会注入补丁；进游戏后 Alt+0 可打开翻译面板）。",
      );
    } catch (e) {
      reportError(toFriendlyError(e, "补丁并启动失败"));
    } finally {
      setBusyAction(null);
    }
  };

  const openGameDetail = (gameDir: string, displayName?: string) => {
    setSelectedGameDir(gameDir);
    setViewMode("detail");
    setRecentGames(
      rememberRecentUnityGame({
        gameDir,
        name: displayName,
      }),
    );
  };

  const openRecentGame = async (entry: RecentUnityGame) => {
    const gameDir = entry.gameDir;
    setPathInput(gameDir);
    rememberLastPickDir(gameDir);
    setBusyAction("detect");
    setError(null);
    try {
      const res = await api.unityDetect(gameDir);
      const list = res.games || [];
      const game = list[0];
      if (!res.ok || !game) {
        reportError(res.error || "未找到该游戏，可从列表移除后重新选择");
        return;
      }
      setScanState({
        ...emptyScanState(res.scanRoot || gameDir),
        ok: true,
        error: "",
        isUnity: true,
        games: list,
        gameDir: game.gameDir,
        gameExe: game.gameExe || "",
        arch: game.arch || "",
        runtime: game.runtime || "",
        installMethod: game.installMethod || "",
        hasAutoTranslator: !!game.hasAutoTranslator,
        hasBepInEx: !!game.hasBepInEx,
        isIl2Cpp: !!game.isIl2Cpp,
      });
      openGameDetail(game.gameDir, gameTitle(game));
    } catch (e) {
      reportError(toFriendlyError(e, "打开最近游戏失败"));
    } finally {
      setBusyAction(null);
    }
  };

  const backToList = () => {
    setViewMode("list");
  };

  const runSelfCheck = async () => {
    const gameDir = selected?.gameDir;
    if (!gameDir) {
      reportError(
        games.length > 1 ? "请先在列表中点选一个游戏" : "请先检测并选择游戏",
      );
      return;
    }
    setBusyAction("self-check");
    setError(null);
    try {
      const res = await api.unitySelfCheck(gameDir);
      if (!res.ok) {
        reportError(res.error || "自检失败");
        return;
      }
      const checkedAt = formatClock();
      const gameExePath = joinGameExePath(gameDir, selected?.gameExe);
      const result: SelfCheck = {
        verdict: res.verdict || "looks_ok",
        verdictLabel: res.verdictLabel || "自检完成",
        summary: res.summary || "",
        gameArch: res.gameArch || selected?.arch || "",
        loaderArch: res.loaderArch || "",
        runtime: res.runtime || selected?.runtime || "",
        checks: res.checks || [],
        suggestions: res.suggestions || [],
        hasLog: !!res.hasLog,
        logPath: res.logPath || "",
        logSnippet: res.logSnippet || "",
        checkedAt,
        gameExePath,
      };
      const tabId = `selfcheck-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tab: SelfCheckTab = {
        id: tabId,
        title: `自检 ${checkedAt}`,
        result,
      };
      setSelfCheckTabs((prev) => [...prev, tab]);
      setActiveBottomTab(tabId);
    } catch (e) {
      reportError(toFriendlyError(e, "自检失败"));
    } finally {
      setBusyAction(null);
    }
  };

  const showDetail = viewMode === "detail" && !!selected;
  const awaitingPath = !showDetail && !pathInput.trim();

  const installBtnLabel = actionLabel(
    "install-plugin",
    selected?.hasAutoTranslator ? "已安装插件" : "安装翻译插件",
  );

  const helpButton = (
    <div className="unity-help-wrap">
      <button
        ref={helpBtnRef}
        type="button"
        className="unity-btn unity-help-trigger"
        aria-expanded={helpOpen}
        aria-haspopup="menu"
        onClick={openHelpMenu}
      >
        帮助
      </button>
    </div>
  );

  const renderSelfCheckPanel = (check: SelfCheck) => (
    <section
      className={
        "unity-selfcheck" +
        (check.verdict === "arch_mismatch"
          ? " is-error"
          : check.verdict === "log_suggests_outdated"
            ? " is-warn"
            : "")
      }
    >
      <p className="unity-selfcheck-verdict">{check.verdictLabel}</p>
      <p className="unity-selfcheck-summary">{check.summary}</p>
      <p className="unity-selfcheck-meta">
        时间 {check.checkedAt} · 游戏路径{" "}
        <code className="unity-selfcheck-path">{check.gameExePath}</code>
      </p>
      <p className="unity-selfcheck-meta">
        游戏 {archLabel(check.gameArch)} · 加载器 {archLabel(check.loaderArch)}{" "}
        · {runtimeLabel(check.runtime)}
      </p>
      <ul className="unity-selfcheck-list">
        {check.checks.map((c) => (
          <li key={c.id} className={"level-" + c.level}>
            <strong>{c.title}</strong>
            <span>{c.detail}</span>
          </li>
        ))}
      </ul>
      {check.suggestions.length > 0 ? (
        <>
          <h3 className="unity-selfcheck-h">建议步骤</h3>
          <ol className="unity-selfcheck-steps">
            {check.suggestions.map((s, i) => (
              <li key={`${i}-${s.slice(0, 24)}`}>{s}</li>
            ))}
          </ol>
        </>
      ) : null}
      {check.hasLog && check.logPath ? (
        <p className="unity-selfcheck-logpath">
          日志：<code>{check.logPath}</code>
        </p>
      ) : null}
      {check.logSnippet ? (
        <pre className="unity-selfcheck-snippet">{check.logSnippet}</pre>
      ) : null}
    </section>
  );

  const essentialSections = useMemo(
    () => essentialConfigSections(configSections),
    [configSections],
  );

  const [llmBridgeUrl, setLlmBridgeUrl] = useState(
    () => `${API_BASE.replace(/\/$/, "")}/api/unity/llm-translate`,
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await api.getSettings();
        const port = typeof s.port === "number" && s.port > 0 ? s.port : 17800;
        const url = `http://127.0.0.1:${port}/api/unity/llm-translate`;
        if (!cancelled) setLlmBridgeUrl(url);
      } catch {
        /* keep API_BASE fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  const applyLlmEndpoint = async () => {
    const gameDir = selected?.gameDir;
    if (!gameDir) {
      reportError("请先选择一个游戏");
      return;
    }
    setBusyAction("apply-llm");
    try {
      let bridgeUrl = llmBridgeUrl;
      try {
        const s = await api.getSettings();
        const port = typeof s.port === "number" && s.port > 0 ? s.port : 17800;
        bridgeUrl = `http://127.0.0.1:${port}/api/unity/llm-translate`;
        setLlmBridgeUrl(bridgeUrl);
      } catch {
        /* use cached llmBridgeUrl */
      }
      let sections = setIniValue(
        configSections,
        "Service",
        "Endpoint",
        "CustomTranslate",
      );
      sections = setIniValue(sections, "Custom", "Url", bridgeUrl);
      applyConfigSections(sections);
      const res = await api.unitySaveConfig({ path: gameDir, sections });
      if (!res.ok) {
        reportError(res.error || "写入大模型端点失败");
        return;
      }
      setConfigPath(res.path || configPath);
      setConfigExists(true);
      showConfigToast("已切换为 LLMChat 大模型翻译（需保持本软件运行）", true);
      reportSuccess(
        `已设置 Endpoint=CustomTranslate，Url=${bridgeUrl}；模型请在「设置」页配置`,
      );
    } catch (e) {
      reportError(toFriendlyError(e, "写入大模型端点失败"));
    } finally {
      setBusyAction(null);
    }
  };

  const testLlmTranslate = async () => {
    setBusyAction("test-llm");
    try {
      const from =
        getIniValue(configSections, "General", "FromLanguage") || fromLang;
      const to =
        getIniValue(configSections, "General", "Language") || targetLang;
      const res = await api.unityLlmTranslate({
        text: "こんにちは",
        from,
        to,
      });
      showConfigToast(`测试译文：${res.translation}`, true);
      reportSuccess(`大模型桥接测试成功：${res.translation}`);
    } catch (e) {
      const msg = toFriendlyError(e, "大模型桥接测试失败");
      showConfigToast(msg, false);
      reportError(msg);
    } finally {
      setBusyAction(null);
    }
  };

  const renderIniKeyControl = (
    secName: string,
    row: { key: string; value: string },
  ) => {
    const boolish = isBoolIniValue(row.value);
    const isEndpoint =
      secName === "Service" &&
      (row.key === "Endpoint" || row.key === "FallbackEndpoint");
    const isLang =
      secName === "General" &&
      (row.key === "Language" || row.key === "FromLanguage");
    if (boolish) {
      return (
        <label className="unity-ini-switch">
          <input
            type="checkbox"
            checked={row.value.trim().toLowerCase() === "true"}
            onChange={(ev) =>
              updateConfigKey(
                secName,
                row.key,
                ev.target.checked ? "True" : "False",
              )
            }
          />
          <span>
            {row.value.trim().toLowerCase() === "true" ? "开" : "关"}
          </span>
        </label>
      );
    }
    if (isEndpoint) {
      return (
        <select
          value={row.value}
          onChange={(ev) =>
            updateConfigKey(secName, row.key, ev.target.value)
          }
        >
          {row.key === "FallbackEndpoint" ? (
            <option value="">无</option>
          ) : null}
          {endpoints.map((o) => (
            <option key={o.id || "__empty"} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    if (isLang) {
      return (
        <select
          value={row.value}
          onChange={(ev) =>
            updateConfigKey(secName, row.key, ev.target.value)
          }
        >
          {(row.key === "FromLanguage"
            ? FROM_LANG_OPTIONS
            : TARGET_LANG_OPTIONS
          ).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
          {!TARGET_LANG_OPTIONS.some((o) => o.id === row.value) &&
          !FROM_LANG_OPTIONS.some((o) => o.id === row.value) ? (
            <option value={row.value}>{row.value}</option>
          ) : null}
        </select>
      );
    }
    return (
      <input
        type="text"
        value={row.value}
        spellCheck={false}
        onChange={(ev) =>
          updateConfigKey(secName, row.key, ev.target.value)
        }
      />
    );
  };

  const renderIniSection = (sec: UnityIniSection) => {
    const open = true;
    const secInfo = sectionMeta(sec.name);
    const pairKeys =
      sec.name === "Service"
        ? (["Endpoint", "FallbackEndpoint"] as const)
        : sec.name === "General"
          ? (["Language", "FromLanguage"] as const)
          : null;
    const pairRows = pairKeys
      ? pairKeys
          .map((key) => sec.keys.find((k) => k.key === key))
          .filter((k): k is NonNullable<typeof k> => k != null)
      : [];
    const pairKeySet = new Set(pairRows.map((k) => k.key));
    const otherKeys = sec.keys.filter((k) => !pairKeySet.has(k.key));

    const headInner = (
      <span className="unity-ini-section-titles">
        <span className="unity-ini-section-label">{secInfo.label}</span>
        <span className="unity-ini-section-key">[{sec.name}]</span>
        <span className="unity-ini-section-help">{secInfo.help}</span>
      </span>
    );

    const keysBody = open ? (
      <div className="unity-ini-keys">
        {pairRows.length > 0 ? (
          <div className="unity-ini-pair">
            {pairRows.map((row) => {
              const meta = fieldMeta(row.key);
              return (
                <div
                  key={`${sec.name}.${row.key}`}
                  className="unity-ini-pair-item"
                >
                  <div className="unity-ini-key-title">
                    <span className="unity-ini-key-label">{meta.label}</span>
                    <code className="unity-ini-key-code">{row.key}</code>
                  </div>
                  <div className="unity-ini-key-control">
                    {renderIniKeyControl(sec.name, row)}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
        {otherKeys.map((row) => {
          const id = `${sec.name}.${row.key}`;
          const meta = fieldMeta(row.key);
          return (
            <div key={id} className="unity-ini-key">
              <div className="unity-ini-key-meta">
                <div className="unity-ini-key-title">
                  <span className="unity-ini-key-label">{meta.label}</span>
                  <code className="unity-ini-key-code">{row.key}</code>
                </div>
                <p className="unity-ini-key-help">{meta.help}</p>
              </div>
              <div className="unity-ini-key-control">
                {renderIniKeyControl(sec.name, row)}
              </div>
            </div>
          );
        })}
      </div>
    ) : null;

    return (
      <div key={sec.name} className="unity-ini-section is-open is-plain">
        <div className="unity-ini-section-head is-static">{headInner}</div>
        {keysBody}
      </div>
    );
  };

  return (
    <div className="unity-shell" aria-hidden={!active}>
      {configToast
        ? createPortal(
            <div
              className={
                "unity-config-toast" + (configToast.ok ? " is-ok" : " is-fail")
              }
              role="status"
              aria-live="polite"
            >
              {configToast.message}
            </div>,
            document.body,
          )
        : null}
      {showDetail ? (
        <header className="unity-top unity-top-detail">
          <div className="unity-top-brand">
            <button
              type="button"
              className="unity-btn unity-back"
              onClick={backToList}
            >
              ← 返回游戏列表
            </button>
            {helpButton}
          </div>
          {onOpenUnitySettings ? (
            <div className="unity-top-actions">
              <button
                type="button"
                className="unity-btn"
                onClick={onOpenUnitySettings}
                title="打开设置中的 Unity 版块（引擎 Key 与低频选项）"
              >
                Unity 设置
              </button>
            </div>
          ) : null}
        </header>
      ) : null}

      {helpOpen &&
        helpMenuPos &&
        createPortal(
          <div
            className="unity-help-menu"
            role="menu"
            style={{
              position: "fixed",
              top: helpMenuPos.top,
              right: helpMenuPos.right,
              zIndex: 10000,
            }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeHelpMenu();
                setHelpDialog("startup-flow");
              }}
            >
              翻译插件启动流程
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeHelpMenu();
                setHelpDialog("wont-launch");
              }}
            >
              游戏打不开
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeHelpMenu();
                setHelpDialog("config-keys");
              }}
            >
              配置文件全部条目含义
            </button>
          </div>,
          document.body,
        )}

      {uninstallConfirm && (
        <div
          className="unity-help-backdrop"
          onClick={() => setUninstallConfirm(null)}
          role="presentation"
        >
          <div
            className="unity-help-dialog unity-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="unity-uninstall-confirm-title"
            onClick={(ev) => ev.stopPropagation()}
          >
            <header className="unity-help-dialog-head">
              <h2 id="unity-uninstall-confirm-title">
                {uninstallConfirm.kind === "plugin"
                  ? "确认卸载翻译插件"
                  : "确认卸载插件框架"}
              </h2>
              <button
                type="button"
                className="unity-btn"
                onClick={() => setUninstallConfirm(null)}
              >
                关闭
              </button>
            </header>
            <div className="unity-help-dialog-body">
              {uninstallConfirm.kind === "plugin" ? (
                <>
                  <p>
                    将卸载 <strong>XUnity.AutoTranslator</strong>
                    ，并删除插件生成的缓存/配置文件。插件框架（
                    {uninstallConfirm.frameworkName}）会保留。
                  </p>
                  <p className="unity-confirm-path">
                    <code>{uninstallConfirm.gameDir}</code>
                  </p>
                </>
              ) : (
                <>
                  <p>
                    将卸载插件框架{" "}
                    <strong>{uninstallConfirm.frameworkName}</strong>
                    {uninstallConfirm.isIl2Cpp
                      ? "（会删除整个 BepInEx 目录及其注入文件）。"
                      : "（会删除 ReiPatcher 目录及相关注入）。"}
                  </p>
                  <p className="unity-confirm-path">
                    <code>{uninstallConfirm.gameDir}</code>
                  </p>
                </>
              )}
              <div className="unity-confirm-actions">
                <button
                  type="button"
                  className="unity-btn"
                  onClick={() => setUninstallConfirm(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="unity-btn unity-btn-danger"
                  onClick={() => void confirmUninstall()}
                >
                  确认卸载
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {helpDialog === "startup-flow" && (
        <div
          className="unity-help-backdrop"
          onClick={() => setHelpDialog(null)}
          role="presentation"
        >
          <div
            className="unity-help-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="unity-help-startup-flow-title"
            onClick={(ev) => ev.stopPropagation()}
          >
            <header className="unity-help-dialog-head">
              <h2 id="unity-help-startup-flow-title">翻译插件启动流程</h2>
              <button
                type="button"
                className="unity-btn"
                onClick={() => setHelpDialog(null)}
              >
                关闭
              </button>
            </header>
            <div className="unity-help-dialog-body">
              <p>
                本模块负责检测游戏、安装 XUnity.AutoTranslator
                翻译插件，并在需要时为 IL2CPP 游戏安装 BepInEx
                加载器。安装插件时会从 GitHub 下载一次安装包并缓存到本地。
              </p>
              <h3>Mono 游戏</h3>
              <ol>
                <li>检测游戏（选目录或拖入文件夹 / .exe）</li>
                <li>先安装插件框架（ReiPatcher）</li>
                <li>再安装翻译插件</li>
                <li>启动游戏（可用「补丁并启动」）</li>
                <li>
                  游戏内按 <strong>Alt+0</strong> 打开翻译面板
                </li>
              </ol>
              <h3>IL2CPP 游戏</h3>
              <ol>
                <li>检测游戏（选目录或拖入文件夹 / .exe）</li>
                <li>先安装插件框架（BepInEx）</li>
                <li>启动一次游戏（完成 BepInEx 初始化）</li>
                <li>再安装翻译插件</li>
                <li>启动游戏</li>
                <li>
                  游戏内按 <strong>Alt+0</strong> 打开翻译面板
                </li>
              </ol>
              <p>
                <strong>说明：</strong>
                必须先装插件框架再装翻译插件；卸载时相反——先卸翻译插件，再卸插件框架。游戏内翻译请求由
                XUnity 自行发起，不经本软件翻译接口。
              </p>
            </div>
          </div>
        </div>
      )}

      {helpDialog === "wont-launch" && (
        <div
          className="unity-help-backdrop"
          onClick={() => setHelpDialog(null)}
          role="presentation"
        >
          <div
            className="unity-help-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="unity-help-wont-launch-title"
            onClick={(ev) => ev.stopPropagation()}
          >
            <header className="unity-help-dialog-head">
              <h2 id="unity-help-wont-launch-title">游戏打不开</h2>
              <button
                type="button"
                className="unity-btn"
                onClick={() => setHelpDialog(null)}
              >
                关闭
              </button>
            </header>
            <div className="unity-help-dialog-body">
              <p>
                装完加载器或翻译插件后无法启动时，先分清是「装错了 x86/x64」还是「BepInEx
                版本偏旧（可试 BE）」。本页右侧有「打不开？自检」，也可按下面流程手动判断。
              </p>
              <h3>推荐顺序</h3>
              <ol>
                <li>在左侧列表点进问题游戏的详情页。</li>
                <li>
                  点右侧 <strong>打不开？自检</strong>
                  （只读本地目录与日志，不出网）。
                </li>
                <li>按自检结论处理；结论不清时，再对照下方对照表。</li>
              </ol>
              <h3>1. 先排除 x86 / x64 装错</h3>
              <p>
                对照列表里的 <strong>32位 / 64位</strong>，与游戏目录中
                Doorstop（如 <code>winhttp.dll</code>）/ BepInEx
                是否同一位数。
              </p>
              <ul>
                <li>一点就闪退，几乎没有日志 → 常见于位数不对</li>
                <li>提示不是有效的 Win32 应用 / 无法启动 → 很典型</li>
                <li>
                  <code>BepInEx\LogOutput.log</code>{" "}
                  根本没生成，或 Doorstop 没起来 → 常见
                </li>
                <li>
                  游戏是 64 位却装了 32 位 BepInEx（或反过来）→ 可实锤为位数问题
                </li>
              </ul>
              <p>
                <strong>处理：</strong>
                用「卸载加载器」清掉后，按本工具识别的位数重新安装加载器。位数不一致时，不必先换
                BepInEx BE。
              </p>
              <h3>2. 位数一致时，再怀疑 BepInEx 偏旧（BE）</h3>
              <p>文件结构在、位数也对，但：</p>
              <ul>
                <li>游戏能闪一下或能进到很前面，然后挂掉</li>
                <li>
                  有 <code>BepInEx\LogOutput.log</code>
                  ，里面出现 IL2CPP / interop / preloader / unsupported /
                  failed 等
                </li>
                <li>偏新的 Unity / IL2CPP 游戏更容易遇到</li>
              </ul>
              <p>
                <strong>处理：</strong>
                在保持与游戏相同位数的前提下，尝试更新的 BepInEx Bleeding
                Edge（BE）；换包后删除旧日志再启动一次看新日志。
              </p>
              <h3>3. 快速验证「是不是注入层的问题」</h3>
              <p>
                临时移走或改名游戏目录下的 <code>winhttp.dll</code>（或{" "}
                <code>version.dll</code> / <code>winmm.dll</code>
                ）。若去掉注入后游戏能开，说明问题在
                Doorstop/BepInEx（位数或版本），不是游戏本体坏了。
              </p>
              <h3>自检结论怎么读</h3>
              <ul>
                <li>
                  <strong>优先怀疑：装错了 x86/x64</strong>
                  — 先纠正位数，不要急着换 BE
                </li>
                <li>
                  <strong>优先怀疑：BepInEx 版本偏旧</strong>
                  — 位数已一致且日志有版本/注入失败迹象，再试 BE
                </li>
                <li>
                  <strong>尚未生成日志</strong>
                  — 先再启动一次游戏；仍无日志则查杀软是否隔离了 Doorstop
                </li>
                <li>
                  <strong>缺少加载器</strong> — 先完成「安装加载器」
                </li>
              </ul>
              <div className="unity-help-actions">
                <button
                  type="button"
                  className="unity-btn unity-btn-primary"
                  disabled={busy || !selected}
                  onClick={() => {
                    setHelpDialog(null);
                    void runSelfCheck();
                  }}
                >
                  {selected
                    ? "对当前所选游戏运行自检"
                    : "请先在列表中选择游戏"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {helpDialog === "config-keys" && (
        <div
          className="unity-help-backdrop"
          onClick={() => setHelpDialog(null)}
          role="presentation"
        >
          <div
            className="unity-help-dialog unity-help-dialog-wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="unity-help-config-keys-title"
            onClick={(ev) => ev.stopPropagation()}
          >
            <header className="unity-help-dialog-head">
              <h2 id="unity-help-config-keys-title">
                配置文件全部条目含义
              </h2>
              <button
                type="button"
                className="unity-btn"
                onClick={() => setHelpDialog(null)}
              >
                关闭
              </button>
            </header>
            <div className="unity-help-dialog-body">
              <p>
                下列说明依据{" "}
                <strong>XUnity.AutoTranslator</strong> 官方 README 的
                Configuration 章节整理，对应游戏内{" "}
                <code>Config.ini</code> /{" "}
                <code>AutoTranslatorConfig.ini</code> 各分区与键。
              </p>
              <div className="unity-help-actions">
                <button
                  type="button"
                  className="unity-btn unity-btn-primary"
                  onClick={() => void openConfigReadme()}
                >
                  打开官方 README
                </button>
              </div>
              {CONFIG_HELP_CATALOG.map((group) => {
                const sec = sectionMeta(group.section);
                return (
                  <section
                    key={group.section}
                    className="unity-config-help-section"
                  >
                    <h3>
                      {sec.label}{" "}
                      <code>[{group.section}]</code>
                    </h3>
                    <p className="unity-config-help-sec-help">{sec.help}</p>
                    <dl className="unity-config-help-list">
                      {group.keys.map((key) => {
                        const meta = fieldMeta(key);
                        return (
                          <div key={key} className="unity-config-help-item">
                            <dt>
                              <span>{meta.label}</span>
                              <code>{key}</code>
                            </dt>
                            <dd>{meta.help}</dd>
                          </div>
                        );
                      })}
                    </dl>
                  </section>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div
        ref={workspaceRef}
        className={
          "unity-workspace" +
          (showDetail ? "" : " unity-workspace-list") +
          (awaitingPath ? " is-awaiting-path" : "")
        }
      >
        <div
          className="unity-col-main"
          style={
            showDetail
              ? {
                  flex: `0 0 ${detailWidth}px`,
                  width: detailWidth,
                  minWidth: 280,
                  maxWidth: 480,
                }
              : undefined
          }
        >
          {showDetail && selected ? (
            <section className="unity-games">
              <div className="unity-games-body">
                <div className="unity-game-detail">
                  <h3 className="unity-game-detail-title">
                    {gameTitle(selected)}
                  </h3>
                    {(() => {
                      const exe = selected.gameExe || "未知";
                      const frameworkInstalled = hasPluginFramework(selected);
                      const fwName = expectedFrameworkName(selected.isIl2Cpp);
                      const pluginLabel = selected.hasAutoTranslator
                        ? `XUnity.AutoTranslator${
                            selected.autoTranslatorVersion
                              ? ` ${selected.autoTranslatorVersion}`
                              : ""
                          }`
                        : "需要安装 XUnity.AutoTranslator";
                      const loaderLabel = frameworkInstalled
                        ? `${fwName}${
                            selected.loaderVersion
                              ? ` ${selected.loaderVersion}`
                              : ""
                          }`
                        : `需要安装 ${fwName}`;
                      const pathHasChinese = pathContainsChinese(
                        selected.gameDir,
                      );
                      return (
                        <dl className="unity-fact-list">
                          <div className="unity-fact">
                            <dt>程序架构</dt>
                            <dd>
                              <strong>{archLabel(selected.arch)}</strong>
                            </dd>
                          </div>
                          <div className="unity-fact">
                            <dt>脚本后端</dt>
                            <dd>
                              <strong>
                                {runtimeLabel(
                                  selected.runtime,
                                  selected.isIl2Cpp,
                                )}
                              </strong>
                            </dd>
                          </div>
                          <div className="unity-fact">
                            <dt>插件框架</dt>
                            <dd>
                              <strong
                                className={
                                  frameworkInstalled ? undefined : "is-missing"
                                }
                              >
                                {loaderLabel}
                              </strong>
                            </dd>
                          </div>
                          <div className="unity-fact">
                            <dt>翻译插件</dt>
                            <dd>
                              <strong
                                className={
                                  selected.hasAutoTranslator
                                    ? undefined
                                    : "is-missing"
                                }
                              >
                                {pluginLabel}
                              </strong>
                            </dd>
                          </div>
                          <div className="unity-fact">
                            <dt>主程序</dt>
                            <dd>
                              <strong className="unity-fact-path">{exe}</strong>
                            </dd>
                          </div>
                          <div className="unity-fact">
                            <dt>游戏目录</dt>
                            <dd>
                              <strong
                                className={
                                  "unity-fact-path" +
                                  (pathHasChinese ? " is-warn" : "")
                                }
                              >
                                {selected.gameDir}
                              </strong>
                              {pathHasChinese ? (
                                <p className="unity-fact-path-warn">
                                  路径包含中文（或 CJK）字符。BepInEx / Doorstop /
                                  ReiPatcher
                                  在含中文路径下常见闪退、无法注入或打不开；建议把游戏移到纯英文路径（例如
                                  D:\Games\GameName）。
                                </p>
                              ) : null}
                            </dd>
                          </div>
                        </dl>
                      );
                    })()}
                    <div className="unity-game-detail-actions">
                      <button
                        type="button"
                        className="unity-btn unity-btn-primary"
                        disabled={busy}
                        onClick={() => void onLaunch()}
                      >
                        {actionLabel("launch", "启动游戏")}
                      </button>
                      <button
                        type="button"
                        className="unity-btn unity-btn-primary"
                        disabled={busy || !selected.hasAutoTranslator}
                        title={
                          selected.hasAutoTranslator
                            ? "通过 ReiPatcher 注入补丁并启动（推荐首次使用）"
                            : "请先安装翻译插件"
                        }
                        onClick={() => void onLaunchPatch()}
                      >
                        {actionLabel("launch-patch", "补丁并启动")}
                      </button>
                      <button
                        type="button"
                        className="unity-btn"
                        disabled={busy}
                        onClick={() => void openCurrentDir()}
                      >
                        打开游戏目录
                      </button>
                    </div>
                  </div>
                </div>
            </section>
          ) : (
            <>
              <div className="unity-list-source">
              <section className="unity-drop">
                <div className="unity-drop-visual" aria-hidden={true}>
                  <svg viewBox="0 0 64 64" width="56" height="56">
                    <rect
                      x="6"
                      y="18"
                      width="52"
                      height="36"
                      rx="4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    />
                    <path
                      d="M6 26h52M22 18v-4h12l4 4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    />
                    <path
                      d="M32 34v14M25 41l7-7 7 7"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
                <div className="unity-drop-copy">
                  <div className="unity-drop-title-row">
                    <strong>游戏位置</strong>
                    {awaitingPath ? helpButton : null}
                  </div>
                  <span>
                    {scanning
                      ? "正在扫描，发现游戏后立即显示"
                      : "选择或拖入目录 / .exe，自动识别：程序则判断是否为游戏，目录则扫描其中的游戏"}
                  </span>
                  <div className="unity-path-row">
                    <button
                      type="button"
                      className="unity-btn unity-btn-primary"
                      disabled={busy}
                      onClick={() => void browsePath()}
                    >
                      选择目录/程序
                    </button>
                    <div className="unity-path-wrap">
                      <code
                        className={
                          "unity-path" + (pathInput ? "" : " is-empty")
                        }
                      >
                        {pathInput || "尚未选择路径"}
                      </code>
                      {pathInput.trim() ? (
                        <button
                          type="button"
                          className="unity-path-clear"
                          aria-label="清除当前路径"
                          title="清除路径"
                          onClick={() => clearPath()}
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="unity-btn"
                      disabled={busy || !pathInput.trim()}
                      onClick={() => void openCurrentDir()}
                    >
                      打开当前目录
                    </button>
                  </div>
                </div>
              </section>

              {awaitingPath ? (
                <div
                  ref={dropzoneRef}
                  role="button"
                  tabIndex={0}
                  className={
                    "unity-dropzone" + (dragOver ? " is-over" : "")
                  }
                  aria-label="点击或拖拽选择游戏目录或主程序"
                  onClick={() => {
                    if (!busy) void browsePath();
                  }}
                  onKeyDown={(ev) => {
                    if (busy) return;
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      void browsePath();
                    }
                  }}
                >
                  <span className="unity-dropzone-plus" aria-hidden="true">
                    ＋
                  </span>
                  <strong>
                    {scanning
                      ? "正在扫描…"
                      : "点击或拖拽游戏目录 / 程序"}
                  </strong>
                </div>
              ) : null}

              {recentGames.length > 0 ? (
                <section
                  className="unity-recent-games"
                  aria-label="最近打开的游戏"
                >
                  <div className="unity-recent-games-head">
                    <strong>最近打开</strong>
                    <span>点击直接进入详情</span>
                  </div>
                  <ul className="unity-recent-games-list">
                    {recentGames.map((r) => (
                      <li key={r.gameDir}>
                        <button
                          type="button"
                          className="unity-recent-game-btn"
                          disabled={busy}
                          onClick={() => void openRecentGame(r)}
                          title={r.gameDir}
                        >
                          <span className="unity-recent-game-name">
                            {r.name}
                          </span>
                          <span className="unity-recent-game-path">
                            {r.gameDir}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="unity-recent-game-remove"
                          title="从最近列表移除"
                          aria-label={`移除 ${r.name}`}
                          disabled={busy}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setRecentGames(removeRecentUnityGame(r.gameDir));
                          }}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              </div>

              {!awaitingPath ? (
              <section className="unity-games">
                <div className="unity-section-head">
                  <h2>检测到的游戏</h2>
                  <div className="unity-section-head-aside">
                    <span
                      className={
                        !scanning && games.length === 0
                          ? "unity-games-status is-empty"
                          : undefined
                      }
                    >
                      {scanning
                        ? `扫描中 · 已找到 ${games.length} 个`
                        : games.length === 0
                          ? "未找到游戏"
                          : searchQuery.trim()
                            ? `${filteredGames.length} / ${games.length} 个`
                            : `${games.length} 个`}
                      {games.length > 0 ? " · 点选查看详情" : ""}
                    </span>
                    {helpButton}
                  </div>
                </div>
                {games.length > 0 ? (
                  <div className="unity-game-search">
                    <input
                      type="search"
                      value={searchQuery}
                      onChange={(ev) => setSearchQuery(ev.target.value)}
                      placeholder="按游戏名称查找"
                      aria-label="按游戏名称查找"
                    />
                    {searchQuery.trim() ? (
                      <button
                        type="button"
                        className="unity-btn unity-btn-clear"
                        onClick={() => setSearchQuery("")}
                      >
                        清除
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <div className="unity-games-body">
                  {games.length === 0 ? (
                    <div
                      className={
                        "unity-game-empty" +
                        (scanning ? "" : " is-none-found")
                      }
                      role="status"
                    >
                      {scanning ? (
                        <p>正在扫描目录，发现游戏后会立即显示</p>
                      ) : (
                        <strong>未找到 Unity 游戏</strong>
                      )}
                    </div>
                  ) : filteredGames.length === 0 ? (
                    <p className="unity-game-empty">
                      没有匹配「{searchQuery.trim()}」的游戏
                    </p>
                  ) : (
                    <ul className="unity-game-list">
                      {filteredGames.map((g) => {
                        const isActive = selected?.gameDir === g.gameDir;
                        return (
                          <li key={g.gameDir}>
                            <button
                              type="button"
                              className={
                                "unity-game-card" +
                                (isActive ? " is-active" : "")
                              }
                              onClick={() =>
                                openGameDetail(g.gameDir, gameTitle(g))
                              }
                            >
                              <div className="unity-game-title">
                                {gameTitle(g)}
                              </div>
                              <div className="unity-game-meta">
                                <span title="程序架构（主程序位数）">
                                  {archLabel(g.arch)}
                                </span>
                                <span title="Unity 脚本后端">
                                  {runtimeLabel(g.runtime, g.isIl2Cpp)}
                                </span>
                                <span
                                  title={
                                    hasPluginFramework(g)
                                      ? `插件框架：${expectedFrameworkName(g.isIl2Cpp)}`
                                      : `未装插件框架（${expectedFrameworkName(g.isIl2Cpp)}）`
                                  }
                                  className={
                                    hasPluginFramework(g) ? undefined : "is-missing"
                                  }
                                >
                                  {hasPluginFramework(g)
                                    ? expectedFrameworkName(g.isIl2Cpp)
                                    : "无框架"}
                                </span>
                                <span
                                  title={
                                    g.plugins && g.plugins.length > 0
                                      ? `已检测：${g.plugins.join("、")}`
                                      : g.hasAutoTranslator
                                        ? "已装翻译插件"
                                        : "未装翻译插件"
                                  }
                                  className={
                                    g.hasAutoTranslator ? undefined : "is-missing"
                                  }
                                >
                                  {g.plugins && g.plugins.length > 0
                                    ? `插件 ${g.plugins.length}`
                                    : g.hasAutoTranslator
                                      ? "已装插件"
                                      : "未装插件"}
                                </span>
                              </div>
                              <div className="unity-game-path">{g.gameDir}</div>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </section>
              ) : null}

              {error ? (
                <p className="unity-error unity-list-error">{error}</p>
              ) : null}
            </>
          )}
        </div>

        {showDetail ? (
          <>
            <button
              type="button"
              className="unity-col-resizer"
              aria-label="调整详细信息栏宽度"
              onMouseDown={beginDetailResize}
            />
            <aside
              className="unity-col-side"
              style={{
                flex: "1 1 0%",
                width: "auto",
                minWidth: 320,
                maxWidth: "none",
              }}
            >
          <section className="unity-config">
            <div className="unity-section-head">
              <h2>AutoTranslator 配置</h2>
              <span>{configExists ? "已有配置" : "默认模板"}</span>
            </div>
            <div className="unity-config-body">
              <p className="unity-config-hint">
                翻译服务与语言对应游戏内 Config.ini。引擎 Key、文件路径等低频项请到「设置 →
                Unity」编辑。
              </p>
              {configPath ? (
                <button
                  type="button"
                  className="unity-config-path-link"
                  onClick={() => void openConfigFile()}
                  title={
                    configExists
                      ? "点击打开配置文件"
                      : "尚未生成，点击将写入并打开"
                  }
                >
                  <span className="unity-config-path-link-label">磁盘路径</span>
                  <code className="unity-config-path-link-value">
                    {configPath}
                  </code>
                </button>
              ) : (
                <p className="unity-warn">
                  未检测到配置文件时使用完整默认项；安装或保存后写入游戏目录。
                </p>
              )}
              <div className="unity-ini-sections unity-ini-sections-plain">
                {essentialSections.map((sec) => renderIniSection(sec))}
              </div>
              <div className="unity-llm-bridge">
                <p className="unity-llm-bridge-hint">
                  需保持 LLMChat 运行；大模型在「设置」页配置。一键写入后 Endpoint 为
                  CustomTranslate，Url 为：
                  <code>{llmBridgeUrl}</code>
                </p>
                <div className="unity-llm-bridge-actions">
                  <button
                    type="button"
                    className="unity-btn unity-btn-primary"
                    disabled={busy || !selected}
                    onClick={() => void applyLlmEndpoint()}
                  >
                    {actionLabel("apply-llm", "使用 LLMChat 大模型翻译")}
                  </button>
                  <button
                    type="button"
                    className="unity-btn"
                    disabled={busy}
                    onClick={() => void testLlmTranslate()}
                  >
                    {actionLabel("test-llm", "测试一条")}
                  </button>
                  {onOpenUnitySettings ? (
                    <button
                      type="button"
                      className="unity-btn"
                      onClick={onOpenUnitySettings}
                    >
                      更多设置…
                    </button>
                  ) : null}
                </div>
              </div>
              {selected && !hasPluginFramework(selected) ? (
                <p className="unity-warn">
                  请先安装插件框架（
                  {expectedFrameworkName(selected.isIl2Cpp)}
                  ），再安装翻译插件。
                </p>
              ) : null}
              {selected &&
              hasPluginFramework(selected) &&
              !selected.hasAutoTranslator ? (
                <p className="unity-ok">
                  已检测到插件框架（
                  {expectedFrameworkName(selected.isIl2Cpp)}
                  ），可安装翻译插件。
                </p>
              ) : null}
            </div>
            <div className="unity-config-foot">
              <button
                type="button"
                className="unity-btn unity-btn-wide"
                disabled={busy || !selected}
                onClick={() => void onSaveConfig()}
                title="将当前表单写入游戏目录 Config.ini"
              >
                {actionLabel("save-config", "保存配置")}
              </button>
              <button
                type="button"
                className="unity-btn unity-btn-wide"
                disabled={busy || !selected}
                onClick={() => void runSelfCheck()}
                title="装完打不开时：核对位数与日志（本地，不出网）"
              >
                {actionLabel("self-check", "打不开？自检")}
              </button>
              <button
                type="button"
                className="unity-btn unity-btn-primary unity-btn-wide"
                disabled={
                  busy || !selected || hasPluginFramework(selected)
                }
                onClick={() => void onInstallLoader()}
                title={
                  selected && hasPluginFramework(selected)
                    ? `已安装 ${expectedFrameworkName(selected.isIl2Cpp)}`
                    : selected
                      ? `安装 ${expectedFrameworkName(selected.isIl2Cpp)}`
                      : undefined
                }
              >
                {actionLabel(
                  "install-framework",
                  selected && hasPluginFramework(selected)
                    ? "已安装框架"
                    : "安装插件框架",
                )}
              </button>
              <button
                type="button"
                className="unity-btn unity-btn-danger unity-btn-wide"
                disabled={
                  busy ||
                  !selected ||
                  !hasPluginFramework(selected) ||
                  !!selected.hasAutoTranslator
                }
                onClick={() => onUninstallLoader()}
                title={
                  selected?.hasAutoTranslator
                    ? "请先卸载翻译插件"
                    : selected && hasPluginFramework(selected)
                      ? `卸载 ${expectedFrameworkName(selected.isIl2Cpp)}`
                      : "未安装插件框架"
                }
              >
                {actionLabel("uninstall-framework", "卸载插件框架")}
              </button>
              <button
                type="button"
                className="unity-btn unity-btn-primary unity-btn-wide"
                disabled={
                  busy ||
                  !selected ||
                  selected.hasAutoTranslator ||
                  !hasPluginFramework(selected)
                }
                onClick={() => void onInstall()}
                title={
                  selected?.hasAutoTranslator
                    ? "已安装翻译插件"
                    : selected && !hasPluginFramework(selected)
                      ? `请先安装插件框架（${expectedFrameworkName(selected.isIl2Cpp)}）`
                      : undefined
                }
              >
                {installBtnLabel}
              </button>
              <button
                type="button"
                className="unity-btn unity-btn-danger unity-btn-wide"
                disabled={busy || !selected?.hasAutoTranslator}
                onClick={() => onUninstall()}
                title={
                  selected?.hasAutoTranslator
                    ? "卸载所选游戏中的翻译插件（保留插件框架）"
                    : "所选游戏未安装插件"
                }
              >
                {actionLabel("uninstall-plugin", "卸载翻译插件")}
              </button>
            </div>
          </section>
            </aside>
          </>
        ) : null}
      </div>

      <div
        className={
          "unity-bottom-dock" + (statusCollapsed ? " is-collapsed" : "")
        }
      >
          <button
            type="button"
            className="unity-row-resizer unity-status-resizer"
            aria-label={
              statusCollapsed
                ? "向上拖动以展开输出区域"
                : "调整输出区域高度；拖到底可隐藏"
            }
            onMouseDown={(e) => beginStatusResize(e, "grow-up")}
          />

          <div
            className="unity-bottom"
            style={{ height: statusHeight }}
            aria-hidden={statusCollapsed}
          >
            <div
              className="unity-bottom-tabs"
              role="tablist"
              aria-label="输出与自检"
            >
              <div
                className={
                  "unity-bottom-tab-wrap" +
                  (activeBottomTab === "output" ? " is-active" : "")
                }
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeBottomTab === "output"}
                  className={
                    "unity-bottom-tab" +
                    (activeBottomTab === "output" ? " is-active" : "")
                  }
                  onClick={() => setActiveBottomTab("output")}
                >
                  输出
                </button>
              </div>
              {selfCheckTabs.map((tab) => {
                const isActive = activeBottomTab === tab.id;
                return (
                  <div
                    key={tab.id}
                    className={
                      "unity-bottom-tab-wrap" + (isActive ? " is-active" : "")
                    }
                    onContextMenu={(ev) => {
                      ev.preventDefault();
                      setSelfCheckTabMenu({
                        x: ev.clientX,
                        y: ev.clientY,
                        tabId: tab.id,
                      });
                    }}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      className={
                        "unity-bottom-tab" + (isActive ? " is-active" : "")
                      }
                      title={tab.title}
                      onClick={() => {
                        setActiveBottomTab(tab.id);
                        setSelfCheckTabMenu(null);
                      }}
                    >
                      {tab.title}
                    </button>
                    <button
                      type="button"
                      className="unity-bottom-tab-close"
                      aria-label={`关闭 ${tab.title}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        closeSelfCheckTab(tab.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>

            {activeBottomTab === "output" ? (
              <section className="unity-status" aria-label="输出历史">
                {outputLines.length === 0 ? (
                  <p className="unity-status-live">
                    暂无输出。操作结果会显示在这里。
                  </p>
                ) : (
                  <ul className="unity-output-log">
                    {outputLines.map((line, idx) => (
                      <li
                        key={line.id}
                        className={"level-" + line.level}
                        ref={
                          idx === outputLines.length - 1
                            ? outputEndRef
                            : undefined
                        }
                      >
                        <time>{line.time || "—"}</time>
                        <span>{line.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {outputLogPath ? (
                  <p className="unity-output-logpath">
                    界面最多保留 {OUTPUT_UI_MAX}{" "}
                    条；更早记录见完整日志：
                    <code>{outputLogPath}</code>
                  </p>
                ) : null}
              </section>
            ) : (
              (() => {
                const tab = selfCheckTabs.find((t) => t.id === activeBottomTab);
                return tab ? renderSelfCheckPanel(tab.result) : null;
              })()
            )}
          </div>
      </div>

      {selfCheckTabMenu &&
        createPortal(
          <div
            className="unity-tab-context-menu"
            role="menu"
            style={{
              position: "fixed",
              top: selfCheckTabMenu.y,
              left: selfCheckTabMenu.x,
              zIndex: 10000,
            }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => closeSelfCheckTab(selfCheckTabMenu.tabId)}
            >
              关闭
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => closeAllSelfCheckTabs()}
            >
              全部关闭
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
