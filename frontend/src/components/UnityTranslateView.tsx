import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, type UnityGameInfo, type UnityIniSection } from "../api";
import { toFriendlyError } from "../friendlyError";
import { usePersistedHeight } from "../hooks/usePersistedHeight";
import { usePersistedWidth } from "../hooks/usePersistedWidth";
import { fieldMeta, sectionMeta } from "../unityConfigMeta";

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
};

type SelfCheckTab = {
  id: string;
  title: string;
  result: SelfCheck;
};

type HelpDialog = "wont-launch" | "startup-flow" | null;

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

function setIniValue(
  sections: UnityIniSection[],
  section: string,
  key: string,
  value: string,
): UnityIniSection[] {
  const next = sections.map((sec) => ({
    ...sec,
    keys: sec.keys.map((k) => ({ ...k })),
  }));
  let sec = next.find((s) => s.name.toLowerCase() === section.toLowerCase());
  if (!sec) {
    sec = { name: section, keys: [] };
    next.push(sec);
  }
  const row = sec.keys.find((k) => k.key.toLowerCase() === key.toLowerCase());
  if (row) row.value = value;
  else sec.keys.push({ key, value });
  return next;
}

function isBoolIniValue(v: string) {
  const t = v.trim().toLowerCase();
  return t === "true" || t === "false";
}

function formatClock(d = new Date()) {
  return d.toLocaleTimeString("zh-CN", { hour12: false });
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

export function UnityTranslateView({ active = true }: { active?: boolean }) {
  const [pathInput, setPathInput] = useState("");
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [endpoint, setEndpoint] = useState("GoogleTranslate");
  const [fallbackEndpoint, setFallbackEndpoint] = useState("");
  const [targetLang, setTargetLang] = useState("zh-CN");
  const [fromLang, setFromLang] = useState("ja");
  const [configSections, setConfigSections] = useState<UnityIniSection[]>([]);
  const [configPath, setConfigPath] = useState("");
  const [configExists, setConfigExists] = useState(false);
  const [configOpenSections, setConfigOpenSections] = useState<
    Record<string, boolean>
  >({ Service: true, General: true });
  const [scanState, setScanState] = useState<ScanState | null>(null);
  const [selectedGameDir, setSelectedGameDir] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "detail">("list");
  const [searchQuery, setSearchQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outputLines, setOutputLines] = useState<OutputLine[]>([]);
  const [outputLogPath, setOutputLogPath] = useState("");
  const [selfCheckTab, setSelfCheckTab] = useState<SelfCheckTab | null>(null);
  const [activeBottomTab, setActiveBottomTab] = useState<"output" | "selfcheck">(
    "output",
  );
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpMenuPos, setHelpMenuPos] = useState<{
    top: number;
    right: number;
  } | null>(null);
  const [helpDialog, setHelpDialog] = useState<HelpDialog>(null);
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
    width: sideWidth,
    setWidth: setSideWidth,
  } = usePersistedWidth("llmchat-unity-side-width", 400, 300, 720);

  const beginSideResize = useCallback(
    (e: React.MouseEvent) => {
      const workspaceW = workspaceRef.current?.clientWidth ?? 1200;
      const max = Math.max(320, workspaceW - 300);
      const startX = e.clientX;
      const startW = Math.min(sideWidth, max);
      e.preventDefault();
      e.stopPropagation();
      const onMove = (ev: MouseEvent) => {
        const next = Math.min(
          max,
          Math.max(300, startW - (ev.clientX - startX)),
        );
        setSideWidth(next);
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
    [setSideWidth, sideWidth],
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

  const closeSelfCheckTab = useCallback(() => {
    setSelfCheckTab((prev) => {
      if (prev) {
        for (const line of formatSelfCheckForLog(prev)) {
          appendLogOnly(line, "info");
        }
      }
      return null;
    });
    setActiveBottomTab("output");
  }, [appendLogOnly, formatSelfCheckForLog]);

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
    setBusy(true);
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
      reportSuccess(`配置已保存：${res.path || configPath}`);
    } catch (e) {
      reportError(toFriendlyError(e, "保存配置失败"));
    } finally {
      setBusy(false);
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
    setBusy(false);
    setScanning(false);
    setPathInput("");
    setScanState(null);
    setSelectedGameDir(null);
    setViewMode("list");
    setSearchQuery("");
    setError(null);
    setActiveBottomTab("output");
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
    setBusy(true);
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
        setBusy(false);
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
    if (
      !window.confirm(
        `将安装 XUnity.AutoTranslator 到：\n${gameDir}\n\n仅下载一次 GitHub 安装包到本地，不会调用翻译引擎 API。是否继续？`,
      )
    ) {
      return;
    }
    setBusy(true);
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
      setBusy(false);
    }
  };

  const onUninstall = async () => {
    const gameDir = selected?.gameDir;
    if (!gameDir) {
      reportError(
        games.length > 1 ? "请先在列表中点选一个游戏" : "请先检测并选择游戏",
      );
      return;
    }
    if (!selected?.hasAutoTranslator) {
      reportError("该游戏未检测到已安装的翻译插件");
      return;
    }
    if (
      !window.confirm(
        `将从以下目录卸载翻译插件：\n${gameDir}\n\n会删除本模块安装的翻译插件，以及插件生成的缓存/配置文件。是否继续？`,
      )
    ) {
      return;
    }
    setBusy(true);
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
      setBusy(false);
    }
  };

  const onInstallLoader = async () => {
    const gameDir = selected?.gameDir;
    if (!gameDir) {
      reportError(
        games.length > 1 ? "请先在列表中点选一个游戏" : "请先检测并选择游戏",
      );
      return;
    }
    if (!selected?.isIl2Cpp) {
      reportError("仅 IL2CPP 游戏需要安装加载器");
      return;
    }
    if (selected.hasBepInEx) {
      reportError("该游戏已安装 BepInEx 加载器");
      return;
    }
    if (
      !window.confirm(
        `将为 IL2CPP 游戏安装 BepInEx 6 加载器到：\n${gameDir}\n\n若本地 resources/bepinex 已有缓存则直接使用；否则会下载一次并保存，供下次复用。是否继续？`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    reportSteps(["准备安装加载器"]);
    try {
      const res = await api.unityInstallLoader(gameDir);
      reportSteps(res.steps || []);
      if (!res.ok) {
        reportError(res.error || "安装加载器失败");
        return;
      }
      reportSuccess(
        `加载器安装完成（BepInEx ${res.version}）。建议先启动一次游戏完成初始化，再安装翻译插件。`,
      );
      await refreshGame(gameDir);
      setSelectedGameDir(gameDir);
    } catch (e) {
      reportError(toFriendlyError(e, "安装加载器失败"));
    } finally {
      setBusy(false);
    }
  };

  const onUninstallLoader = async () => {
    const gameDir = selected?.gameDir;
    if (!gameDir) {
      reportError(
        games.length > 1 ? "请先在列表中点选一个游戏" : "请先检测并选择游戏",
      );
      return;
    }
    if (!selected?.isIl2Cpp) {
      reportError("仅 IL2CPP 游戏使用加载器卸载");
      return;
    }
    if (!selected.hasBepInEx) {
      reportError("未检测到 BepInEx 加载器");
      return;
    }
    if (
      !window.confirm(
        `将卸载 BepInEx 加载器：\n${gameDir}\n\n会删除整个 BepInEx 目录及其下全部内容（包括已装的翻译插件与缓存），以及注入文件。是否继续？`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    reportSteps(["准备卸载加载器"]);
    try {
      const res = await api.unityUninstallLoader(gameDir);
      reportSteps(res.steps || []);
      if (!res.ok) {
        reportError(res.error || "卸载加载器失败");
        return;
      }
      const n = res.removed?.length ?? 0;
      reportSuccess(`加载器卸载完成，已移除 ${n} 项。`);
      await refreshGame(gameDir);
      setSelectedGameDir(gameDir);
    } catch (e) {
      reportError(toFriendlyError(e, "卸载加载器失败"));
    } finally {
      setBusy(false);
    }
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

  const onLaunch = async () => {
    const gameDir = selected?.gameDir;
    if (!gameDir) {
      reportError("请先选择一个游戏");
      return;
    }
    setBusy(true);
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
      setBusy(false);
    }
  };

  const onLaunchPatch = async () => {
    const gameDir = selected?.gameDir;
    if (!gameDir) {
      reportError("请先选择一个游戏");
      return;
    }
    if (!selected?.hasAutoTranslator) {
      reportError("请先安装翻译插件后再使用 Patch and Run");
      return;
    }
    setBusy(true);
    setError(null);
    focusOutputTab();
    try {
      const res = await api.unityLaunchPatch(gameDir);
      if (!res.ok) {
        reportError(res.error || "Patch and Run 启动失败");
        return;
      }
      reportSuccess(
        "已通过 Patch and Run 启动（首次会注入补丁；进游戏后 Alt+0 可打开翻译面板）。",
      );
    } catch (e) {
      reportError(toFriendlyError(e, "Patch and Run 启动失败"));
    } finally {
      setBusy(false);
    }
  };

  const openGameDetail = (gameDir: string) => {
    setSelectedGameDir(gameDir);
    setViewMode("detail");
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
    setBusy(true);
    setError(null);
    try {
      const res = await api.unitySelfCheck(gameDir);
      if (!res.ok) {
        reportError(res.error || "自检失败");
        return;
      }
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
      };
      const tab: SelfCheckTab = {
        id: "selfcheck",
        title: "自检结果",
        result,
      };
      // Previous result leaves the UI → archive to log only (not 输出 tab)
      if (selfCheckTab) {
        for (const line of formatSelfCheckForLog(selfCheckTab)) {
          appendLogOnly(line, "info");
        }
      }
      setSelfCheckTab(tab);
      setActiveBottomTab("selfcheck");
    } catch (e) {
      reportError(toFriendlyError(e, "自检失败"));
    } finally {
      setBusy(false);
    }
  };

  const showDetail = viewMode === "detail" && !!selected;
  const awaitingPath = !showDetail && !pathInput.trim();

  const installBtnLabel = busy
    ? "处理中"
    : selected?.hasAutoTranslator
      ? "已安装插件"
      : "安装翻译插件";

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

  return (
    <div className="unity-shell" aria-hidden={!active}>
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
          </div>,
          document.body,
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
                <li>直接安装翻译插件</li>
                <li>启动游戏</li>
                <li>
                  游戏内按 <strong>Alt+0</strong> 打开翻译面板
                </li>
              </ol>
              <h3>IL2CPP 游戏</h3>
              <ol>
                <li>检测游戏（选目录或拖入文件夹 / .exe）</li>
                <li>先安装 BepInEx 加载器</li>
                <li>启动一次游戏（完成 BepInEx 初始化）</li>
                <li>再安装翻译插件</li>
                <li>启动游戏</li>
                <li>
                  游戏内按 <strong>Alt+0</strong> 打开翻译面板
                </li>
              </ol>
              <p>
                <strong>说明：</strong>
                本模块只负责安装翻译插件与（IL2CPP 所需的）BepInEx
                加载器；游戏内翻译请求由 XUnity 自行发起，不经本软件翻译接口。若本地已有
                GitHub 缓存则不会重复下载。
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
              ? { flex: "1 1 0%", minWidth: 280, width: "auto" }
              : undefined
          }
        >
          {showDetail && selected ? (
            <section className="unity-games">
              <div className="unity-section-head">
                <h2>详细信息</h2>
              </div>
              <div className="unity-games-body">
                <div className="unity-game-detail">
                  <h3 className="unity-game-detail-title">
                    {gameTitle(selected)}
                  </h3>
                    {(() => {
                      const exe = selected.gameExe || "未知";
                      const pluginLabel = selected.hasAutoTranslator
                        ? `XUnity.AutoTranslator${
                            selected.autoTranslatorVersion
                              ? ` ${selected.autoTranslatorVersion}`
                              : ""
                          }`
                        : "未安装";
                      const loaderLabel = selected.loaderName
                        ? `${selected.loaderName}${
                            selected.loaderVersion
                              ? ` ${selected.loaderVersion}`
                              : ""
                          }`
                        : selected.hasBepInEx
                          ? "BepInEx"
                          : "未安装";
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
                            <dt>推荐安装方式</dt>
                            <dd>
                              <strong>
                                {selected.installMethod || "未知"}
                              </strong>
                            </dd>
                          </div>
                          <div className="unity-fact">
                            <dt>翻译插件</dt>
                            <dd>
                              <strong>{pluginLabel}</strong>
                            </dd>
                          </div>
                          <div className="unity-fact">
                            <dt>插件框架</dt>
                            <dd>
                              <strong>{loaderLabel}</strong>
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
                              <strong className="unity-fact-path">
                                {selected.gameDir}
                              </strong>
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
                        {busy ? "处理中" : "启动游戏"}
                      </button>
                      <button
                        type="button"
                        className="unity-btn unity-btn-primary"
                        disabled={busy || !selected.hasAutoTranslator}
                        title={
                          selected.hasAutoTranslator
                            ? "通过 ReiPatcher 补丁并启动（推荐首次使用）"
                            : "请先安装翻译插件"
                        }
                        onClick={() => void onLaunchPatch()}
                      >
                        {busy ? "处理中" : "Patch and Run"}
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
                              onClick={() => openGameDetail(g.gameDir)}
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
                                <span title="推荐安装方式">
                                  {g.installMethod}
                                </span>
                                <span
                                  title={
                                    g.plugins && g.plugins.length > 0
                                      ? `已检测：${g.plugins.join("、")}`
                                      : g.hasAutoTranslator
                                        ? "已装翻译插件"
                                        : "未装翻译插件"
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
              aria-label="调整配置栏宽度"
              onMouseDown={beginSideResize}
            />
            <aside
              className="unity-col-side"
              style={{
                flex: `0 0 ${sideWidth}px`,
                width: sideWidth,
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
                下列选项对应游戏内 Config.ini / AutoTranslatorConfig.ini。常见只需改「翻译服务」与「语言」；其余保持默认即可。说明依据
                XUnity.AutoTranslator 官方文档。
              </p>
              {configPath ? (
                <p className="unity-target">
                  配置文件：<code>{configPath}</code>
                </p>
              ) : (
                <p className="unity-warn">
                  未检测到配置文件时使用完整默认项；安装或保存后写入游戏目录。
                </p>
              )}
              <div className="unity-ini-sections">
                {configSections.map((sec) => {
                  const open = configOpenSections[sec.name] === true;
                  const secInfo = sectionMeta(sec.name);
                  return (
                    <div
                      key={sec.name}
                      className={
                        "unity-ini-section" + (open ? " is-open" : "")
                      }
                    >
                      <button
                        type="button"
                        className="unity-ini-section-head"
                        onClick={() =>
                          setConfigOpenSections((prev) => ({
                            ...prev,
                            [sec.name]: !open,
                          }))
                        }
                      >
                        <span className="unity-ini-section-titles">
                          <span className="unity-ini-section-label">
                            {secInfo.label}
                          </span>
                          <span className="unity-ini-section-key">
                            [{sec.name}]
                          </span>
                          <span className="unity-ini-section-help">
                            {secInfo.help}
                          </span>
                        </span>
                        <span className="unity-ini-section-chevron" aria-hidden="true">
                          {open ? "▾" : "▸"}
                        </span>
                      </button>
                      {open ? (
                        <div className="unity-ini-keys">
                          {sec.keys.map((row) => {
                            const id = `${sec.name}.${row.key}`;
                            const meta = fieldMeta(row.key);
                            const boolish = isBoolIniValue(row.value);
                            const isEndpoint =
                              sec.name === "Service" &&
                              (row.key === "Endpoint" ||
                                row.key === "FallbackEndpoint");
                            const isLang =
                              sec.name === "General" &&
                              (row.key === "Language" ||
                                row.key === "FromLanguage");
                            return (
                              <div key={id} className="unity-ini-key">
                                <div className="unity-ini-key-meta">
                                  <div className="unity-ini-key-title">
                                    <span className="unity-ini-key-label">
                                      {meta.label}
                                    </span>
                                    <code className="unity-ini-key-code">
                                      {row.key}
                                    </code>
                                  </div>
                                  <p className="unity-ini-key-help">
                                    {meta.help}
                                  </p>
                                </div>
                                <div className="unity-ini-key-control">
                                  {boolish ? (
                                    <label className="unity-ini-switch">
                                      <input
                                        type="checkbox"
                                        checked={
                                          row.value.trim().toLowerCase() ===
                                          "true"
                                        }
                                        onChange={(ev) =>
                                          updateConfigKey(
                                            sec.name,
                                            row.key,
                                            ev.target.checked
                                              ? "True"
                                              : "False",
                                          )
                                        }
                                      />
                                      <span>
                                        {row.value.trim().toLowerCase() ===
                                        "true"
                                          ? "开"
                                          : "关"}
                                      </span>
                                    </label>
                                  ) : isEndpoint ? (
                                    <select
                                      value={row.value}
                                      onChange={(ev) =>
                                        updateConfigKey(
                                          sec.name,
                                          row.key,
                                          ev.target.value,
                                        )
                                      }
                                    >
                                      {row.key === "FallbackEndpoint" ? (
                                        <option value="">无</option>
                                      ) : null}
                                      {endpoints.map((o) => (
                                        <option
                                          key={o.id || "__empty"}
                                          value={o.id}
                                        >
                                          {o.label}
                                        </option>
                                      ))}
                                    </select>
                                  ) : isLang ? (
                                    <select
                                      value={row.value}
                                      onChange={(ev) =>
                                        updateConfigKey(
                                          sec.name,
                                          row.key,
                                          ev.target.value,
                                        )
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
                                      {!TARGET_LANG_OPTIONS.some(
                                        (o) => o.id === row.value,
                                      ) &&
                                      !FROM_LANG_OPTIONS.some(
                                        (o) => o.id === row.value,
                                      ) ? (
                                        <option value={row.value}>
                                          {row.value}
                                        </option>
                                      ) : null}
                                    </select>
                                  ) : (
                                    <input
                                      type="text"
                                      value={row.value}
                                      spellCheck={false}
                                      onChange={(ev) =>
                                        updateConfigKey(
                                          sec.name,
                                          row.key,
                                          ev.target.value,
                                        )
                                      }
                                    />
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {selected?.isIl2Cpp && !selected.hasBepInEx ? (
                <p className="unity-warn">
                  该游戏为 IL2CPP，请先安装加载器（BepInEx 6），再安装翻译插件。
                </p>
              ) : null}
              {selected?.isIl2Cpp && selected.hasBepInEx ? (
                <p className="unity-ok">
                  已检测到 BepInEx 加载器，可直接安装翻译插件。
                </p>
              ) : null}
              {selected ? (
                <p className="unity-target">
                  目标（{archLabel(selected.arch)} ·{" "}
                  {runtimeLabel(selected.runtime, selected.isIl2Cpp)}）：
                  <code>{selected.gameDir}</code>
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
                {busy ? "处理中" : "保存配置"}
              </button>
              <button
                type="button"
                className="unity-btn unity-btn-wide"
                disabled={busy || !selected}
                onClick={() => void runSelfCheck()}
                title="装完打不开时：核对位数与 BepInEx 日志（本地，不出网）"
              >
                {busy ? "处理中" : "打不开？自检"}
              </button>
              {selected?.isIl2Cpp ? (
                <>
                  <button
                    type="button"
                    className="unity-btn unity-btn-primary unity-btn-wide"
                    disabled={busy || !selected || selected.hasBepInEx}
                    onClick={() => void onInstallLoader()}
                    title={
                      selected.hasBepInEx
                        ? "已安装 BepInEx"
                        : "为 IL2CPP 游戏安装 BepInEx 6"
                    }
                  >
                    {busy ? "处理中" : "安装加载器"}
                  </button>
                  <button
                    type="button"
                    className="unity-btn unity-btn-danger unity-btn-wide"
                    disabled={busy || !selected.hasBepInEx}
                    onClick={() => void onUninstallLoader()}
                    title={
                      selected.hasBepInEx
                        ? "卸载 BepInEx 及其下全部内容"
                        : "未安装加载器"
                    }
                  >
                    {busy ? "处理中" : "卸载加载器"}
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="unity-btn unity-btn-primary unity-btn-wide"
                disabled={
                  busy ||
                  !selected ||
                  selected.hasAutoTranslator ||
                  (selected.isIl2Cpp && !selected.hasBepInEx)
                }
                onClick={() => void onInstall()}
                title={
                  selected?.hasAutoTranslator
                    ? "已安装翻译插件"
                    : selected?.isIl2Cpp && !selected.hasBepInEx
                      ? "请先安装加载器"
                      : undefined
                }
              >
                {installBtnLabel}
              </button>
              <button
                type="button"
                className="unity-btn unity-btn-danger unity-btn-wide"
                disabled={busy || !selected?.hasAutoTranslator}
                onClick={() => void onUninstall()}
                title={
                  selected?.hasAutoTranslator
                    ? "卸载所选游戏中的翻译插件"
                    : "所选游戏未安装插件"
                }
              >
                {busy ? "处理中" : "卸载翻译插件"}
              </button>
            </div>
          </section>

          <section className="unity-footnote">
            <h3>流量说明</h3>
            <ul>
              <li>
                <strong>检测 / 自检</strong>：只扫本地，不出网。
              </li>
              <li>
                <strong>打不开？自检</strong>
                ：对比游戏与加载器位数，并查看 BepInEx
                日志迹象，区分「装错 x86/x64」与「可能需要更新的 BepInEx BE」。
              </li>
              <li>
                <strong>安装加载器</strong>
                ：优先用本地 resources/bepinex 缓存；没有则下载一次并保存。
              </li>
              <li>
                <strong>安装插件</strong>：从 GitHub 下载一次翻译插件包。
              </li>
              <li>
                <strong>游戏内翻译</strong>
                ：由 XUnity 自行请求，不经本软件翻译接口。
              </li>
            </ul>
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
              {selfCheckTab ? (
                <div
                  className={
                    "unity-bottom-tab-wrap" +
                    (activeBottomTab === "selfcheck" ? " is-active" : "")
                  }
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeBottomTab === "selfcheck"}
                    className={
                      "unity-bottom-tab" +
                      (activeBottomTab === "selfcheck" ? " is-active" : "")
                    }
                    title={selfCheckTab.title}
                    onClick={() => setActiveBottomTab("selfcheck")}
                  >
                    {selfCheckTab.title}
                  </button>
                  <button
                    type="button"
                    className="unity-bottom-tab-close"
                    aria-label={`关闭 ${selfCheckTab.title}`}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      closeSelfCheckTab();
                    }}
                  >
                    ×
                  </button>
                </div>
              ) : null}
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
            ) : selfCheckTab ? (
              renderSelfCheckPanel(selfCheckTab.result)
            ) : null}
          </div>
      </div>
    </div>
  );
}
