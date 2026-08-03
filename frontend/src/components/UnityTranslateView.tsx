import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, type UnityGameInfo } from "../api";
import { toFriendlyError } from "../friendlyError";

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

type HelpDialog = "wont-launch" | "startup-flow" | null;

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

function archFact(n?: string) {
  switch ((n || "").toLowerCase()) {
    case "x86":
      return {
        value: "32位（x86）",
        hint: "游戏主程序为 32 位。安装 BepInEx / 插件时必须使用对应的 32 位包，否则容易闪退。",
      };
    case "x64":
      return {
        value: "64位（x64）",
        hint: "游戏主程序为 64 位。安装 BepInEx / 插件时必须使用对应的 64 位包，否则容易闪退。",
      };
    case "arm64":
      return {
        value: "ARM64",
        hint: "游戏主程序为 ARM64。当前工具主要面向 x86/x64 Windows 包。",
      };
    default:
      return {
        value: "位数未知",
        hint: "未能从主程序或 UnityPlayer.dll 读取 PE 架构，安装前请手动确认是 32 位还是 64 位。",
      };
  }
}

function runtimeFact(n: UnityGameInfo & { hasReiPatcher?: boolean }) {
  return n.runtime === "il2cpp" || n.isIl2Cpp
    ? {
        value: "IL2CPP",
        hint: "Unity IL2CPP 后端。需要先安装 BepInEx（IL2CPP）加载器，再安装翻译插件。",
      }
    : n.runtime === "mono"
      ? {
          value: "Mono",
          hint: "Unity Mono 后端。通常可用 ReiPatcher 方式直接安装 XUnity.AutoTranslator；若已有 BepInEx 则走 BepInEx 插件路径。",
        }
      : {
          value: "运行时未知",
          hint: "未能判断是 Mono 还是 IL2CPP，请查看目录中是否存在 GameAssembly.dll / Managed。",
        };
}

function installMethodFact(n: UnityGameInfo & { hasReiPatcher?: boolean }) {
  const e = n.installMethod || "";
  return e === "BepInEx-IL2CPP"
    ? {
        value: "BepInEx（IL2CPP）",
        hint: n.hasBepInEx
          ? "已检测到 BepInEx 目录；翻译插件将安装到 BepInEx/plugins。"
          : "推荐安装方式：先装 BepInEx IL2CPP 加载器，再装 XUnity.AutoTranslator。",
      }
    : e === "BepInEx"
      ? {
          value: "BepInEx（Mono）",
          hint: n.hasBepInEx
            ? "已检测到 BepInEx 目录；翻译插件将安装到 BepInEx/plugins。"
            : "推荐通过 BepInEx 安装翻译插件。",
        }
      : e === "ReiPatcher"
        ? {
            value: "ReiPatcher",
            hint: n.hasReiPatcher
              ? "已检测到 ReiPatcher 组件；Mono 游戏常用此方式注入 XUnity.AutoTranslator。"
              : "推荐安装方式：使用 ReiPatcher 包安装 XUnity.AutoTranslator（当前未检测到 BepInEx）。",
          }
        : { value: e || "未知", hint: "未能确定推荐安装方式。" };
}

function pluginsFact(n: UnityGameInfo) {
  const e = (n.plugins || []).filter(Boolean);
  return e.length > 0
    ? {
        value: `已检测到 ${e.length} 项`,
        hint: `已安装 / 检测到：${e.join("、")}`,
        plugins: e,
      }
    : n.hasAutoTranslator
      ? {
          value: "已装翻译插件",
          hint: "检测到 XUnity.AutoTranslator 相关痕迹，但未能枚举具体文件名。",
          plugins: ["XUnity.AutoTranslator"],
        }
      : {
          value: "未安装翻译插件",
          hint: "未检测到 XUnity.AutoTranslator / ReiPatcher 翻译组件。可在右侧安装。",
          plugins: [] as string[],
        };
}

export function UnityTranslateView({ active = true }: { active?: boolean }) {
  const [pathInput, setPathInput] = useState("");
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [endpoint, setEndpoint] = useState("GoogleTranslate");
  const [fallbackEndpoint, setFallbackEndpoint] = useState("");
  const [targetLang, setTargetLang] = useState("zh-CN");
  const [fromLang, setFromLang] = useState("ja");
  const [scanState, setScanState] = useState<ScanState | null>(null);
  const [selectedGameDir, setSelectedGameDir] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "detail">("list");
  const [searchQuery, setSearchQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [successNote, setSuccessNote] = useState<string | null>(null);
  const [selfCheck, setSelfCheck] = useState<SelfCheck | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpMenuPos, setHelpMenuPos] = useState<{
    top: number;
    right: number;
  } | null>(null);
  const [helpDialog, setHelpDialog] = useState<HelpDialog>(null);
  const detectAbortRef = useRef<AbortController | null>(null);
  const helpBtnRef = useRef<HTMLButtonElement>(null);

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

  const resetPath = useCallback((path: string) => {
    setPathInput(path);
    setScanState(null);
    setSelectedGameDir(null);
    setViewMode("list");
    setSearchQuery("");
    setSuccessNote(null);
    setSteps([]);
    setError(null);
    setSelfCheck(null);
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
      setError("请先选择或拖入游戏目录 / 主程序");
      return;
    }
    detectAbortRef.current?.abort();
    const ac = new AbortController();
    detectAbortRef.current = ac;
    setBusy(true);
    setScanning(true);
    setError(null);
    setSuccessNote(null);
    setSelfCheck(null);
    setViewMode("list");
    setSelectedGameDir(null);
    setScanState(emptyScanState(trimmed));
    try {
      await api.unityDetectStream(
        trimmed,
        {
          onGame: (game) => {
            if (ac.signal.aborted) return;
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
            setScanState((prev) => {
              const base = prev ?? emptyScanState(trimmed);
              const list = base.games;
              return {
                ...base,
                ok: result.ok && list.length > 0,
                error: result.error || "",
                scanRoot: result.scanRoot || base.scanRoot || trimmed,
                isUnity: list.length > 0,
              };
            });
            if (!result.ok) {
              setError(result.error || "未找到 Unity 游戏");
            }
          },
        },
        ac.signal,
      );
    } catch (e) {
      if (ac.signal.aborted) return;
      setScanState(null);
      setSelectedGameDir(null);
      setError(toFriendlyError(e, "检测失败"));
    } finally {
      if (detectAbortRef.current === ac) {
        detectAbortRef.current = null;
        setBusy(false);
        setScanning(false);
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      detectAbortRef.current?.abort();
    };
  }, []);

  const browseDir = async () => {
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: "选择游戏目录",
      });
      if (typeof picked !== "string" || !picked) return;
      resetPath(picked);
      await runDetect(picked);
    } catch (e) {
      setError(toFriendlyError(e, "无法打开选择对话框"));
    }
  };

  const onDrop = async (ev: React.DragEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    setDragOver(false);
    const plain =
      ev.dataTransfer.getData("text/plain")?.trim() || "";
    let dropped = "";
    if (/^[A-Za-z]:[\\/]/.test(plain) || plain.startsWith("\\\\")) {
      dropped = plain;
    } else {
      const file = ev.dataTransfer.files?.[0] as
        | (File & { path?: string })
        | undefined;
      if (file?.path) dropped = file.path;
    }
    if (dropped) {
      resetPath(dropped);
      await runDetect(dropped);
    }
  };

  useEffect(() => {
    if (!active) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        unlisten = await getCurrentWindow().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "over" || payload.type === "enter") {
            setDragOver(true);
            return;
          }
          if (payload.type === "leave") {
            setDragOver(false);
            return;
          }
          if (payload.type === "drop") {
            setDragOver(false);
            const p = payload.paths?.[0];
            if (!p) return;
            resetPath(p);
            void runDetect(p);
          }
        });
      } catch {
        /* Tauri drag-drop unavailable */
      }
    })();
    return () => {
      unlisten?.();
    };
  }, [active, resetPath, runDetect]);

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
      setError(
        games.length > 1 ? "请先在列表中点选一个游戏" : "请先检测并选择游戏",
      );
      return;
    }
    if (selected?.hasAutoTranslator) {
      setError("该游戏已安装翻译插件，无需重复安装");
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
    setSuccessNote(null);
    setSteps(["准备安装"]);
    try {
      const res = await api.unityInstall({
        path: gameDir,
        language: targetLang,
        fromLanguage: fromLang,
        endpoint,
        fallbackEndpoint,
        runSetup: true,
      });
      setSteps(res.steps || []);
      if (!res.ok) {
        setError(res.error || "安装失败");
        return;
      }
      setSuccessNote(
        `安装完成（${res.installMethod} / v${res.version}）。配置已写入：${res.configPath}`,
      );
      await refreshGame(gameDir);
      setSelectedGameDir(gameDir);
    } catch (e) {
      setError(toFriendlyError(e, "安装失败"));
    } finally {
      setBusy(false);
    }
  };

  const onUninstall = async () => {
    const gameDir = selected?.gameDir;
    if (!gameDir) {
      setError(
        games.length > 1 ? "请先在列表中点选一个游戏" : "请先检测并选择游戏",
      );
      return;
    }
    if (!selected?.hasAutoTranslator) {
      setError("该游戏未检测到已安装的翻译插件");
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
    setSuccessNote(null);
    setSteps(["准备卸载"]);
    try {
      const res = await api.unityUninstall(gameDir);
      setSteps(res.steps || []);
      if (!res.ok) {
        setError(res.error || "卸载失败");
        return;
      }
      const n = res.removed?.length ?? 0;
      setSuccessNote(`卸载完成，已移除 ${n} 项。`);
      await refreshGame(gameDir);
      setSelectedGameDir(gameDir);
    } catch (e) {
      setError(toFriendlyError(e, "卸载失败"));
    } finally {
      setBusy(false);
    }
  };

  const onInstallLoader = async () => {
    const gameDir = selected?.gameDir;
    if (!gameDir) {
      setError(
        games.length > 1 ? "请先在列表中点选一个游戏" : "请先检测并选择游戏",
      );
      return;
    }
    if (!selected?.isIl2Cpp) {
      setError("仅 IL2CPP 游戏需要安装加载器");
      return;
    }
    if (selected.hasBepInEx) {
      setError("该游戏已安装 BepInEx 加载器");
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
    setSuccessNote(null);
    setSteps(["准备安装加载器"]);
    try {
      const res = await api.unityInstallLoader(gameDir);
      setSteps(res.steps || []);
      if (!res.ok) {
        setError(res.error || "安装加载器失败");
        return;
      }
      setSuccessNote(
        `加载器安装完成（BepInEx ${res.version}）。建议先启动一次游戏完成初始化，再安装翻译插件。`,
      );
      await refreshGame(gameDir);
      setSelectedGameDir(gameDir);
    } catch (e) {
      setError(toFriendlyError(e, "安装加载器失败"));
    } finally {
      setBusy(false);
    }
  };

  const onUninstallLoader = async () => {
    const gameDir = selected?.gameDir;
    if (!gameDir) {
      setError(
        games.length > 1 ? "请先在列表中点选一个游戏" : "请先检测并选择游戏",
      );
      return;
    }
    if (!selected?.isIl2Cpp) {
      setError("仅 IL2CPP 游戏使用加载器卸载");
      return;
    }
    if (!selected.hasBepInEx) {
      setError("未检测到 BepInEx 加载器");
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
    setSuccessNote(null);
    setSteps(["准备卸载加载器"]);
    try {
      const res = await api.unityUninstallLoader(gameDir);
      setSteps(res.steps || []);
      if (!res.ok) {
        setError(res.error || "卸载加载器失败");
        return;
      }
      const n = res.removed?.length ?? 0;
      setSuccessNote(`加载器卸载完成，已移除 ${n} 项。`);
      await refreshGame(gameDir);
      setSelectedGameDir(gameDir);
    } catch (e) {
      setError(toFriendlyError(e, "卸载加载器失败"));
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
      setError(toFriendlyError(e, "无法打开目录"));
    }
  };

  const onLaunch = async () => {
    const gameDir = selected?.gameDir;
    if (!gameDir) {
      setError("请先选择一个游戏");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.unityLaunch(gameDir);
      if (!res.ok) {
        setError(res.error || "启动失败");
        return;
      }
      setSuccessNote("已请求启动游戏。");
    } catch (e) {
      setError(toFriendlyError(e, "启动失败"));
    } finally {
      setBusy(false);
    }
  };

  const onLaunchPatch = async () => {
    const gameDir = selected?.gameDir;
    if (!gameDir) {
      setError("请先选择一个游戏");
      return;
    }
    if (!selected?.hasAutoTranslator) {
      setError("请先安装翻译插件后再使用 Patch and Run");
      return;
    }
    setBusy(true);
    setError(null);
    setSuccessNote(null);
    try {
      const res = await api.unityLaunchPatch(gameDir);
      if (!res.ok) {
        setError(res.error || "Patch and Run 启动失败");
        return;
      }
      setSuccessNote(
        "已通过 Patch and Run 启动（首次会注入补丁；进游戏后 Alt+0 可打开翻译面板）。",
      );
    } catch (e) {
      setError(toFriendlyError(e, "Patch and Run 启动失败"));
    } finally {
      setBusy(false);
    }
  };

  const openGameDetail = (gameDir: string) => {
    setSelectedGameDir(gameDir);
    setViewMode("detail");
    setSelfCheck(null);
  };

  const backToList = () => {
    setViewMode("list");
  };

  const runSelfCheck = async () => {
    const gameDir = selected?.gameDir;
    if (!gameDir) {
      setError(
        games.length > 1 ? "请先在列表中点选一个游戏" : "请先检测并选择游戏",
      );
      return;
    }
    setBusy(true);
    setError(null);
    setSelfCheck(null);
    try {
      const res = await api.unitySelfCheck(gameDir);
      if (!res.ok) {
        setError(res.error || "自检失败");
        return;
      }
      setSelfCheck({
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
      });
    } catch (e) {
      setError(toFriendlyError(e, "自检失败"));
    } finally {
      setBusy(false);
    }
  };

  const installBtnLabel = busy
    ? "处理中"
    : selected?.hasAutoTranslator
      ? "已安装插件"
      : "安装翻译插件";

  return (
    <div className="unity-shell" aria-hidden={!active}>
      <header className="unity-top">
        <div className="unity-top-brand">
          <p className="unity-kicker">Unity · XUnity.AutoTranslator</p>
          <h1>Unity游戏解析</h1>
        </div>
        <div className="unity-top-aside">
          <p className="unity-lead">
            扫描本地游戏并写入 AutoTranslator 配置。检测不出网；仅安装时从 GitHub
            下载一次插件包。
          </p>
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
        </div>
      </header>

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

      <div className="unity-workspace">
        <div className="unity-col-main">
          <section
            className={"unity-drop" + (dragOver ? " is-over" : "")}
            onDragOver={(ev) => {
              ev.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(ev) => void onDrop(ev)}
          >
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
              <strong>游戏位置</strong>
              <span>
                {scanning
                  ? "正在扫描，发现游戏后立即显示"
                  : "选目录或拖入文件夹 / .exe；仅路径变化时重新检测"}
              </span>
              <div className="unity-path-row">
                <button
                  type="button"
                  className="unity-btn unity-btn-primary"
                  disabled={busy}
                  onClick={() => void browseDir()}
                >
                  选目录
                </button>
                <code className="unity-path">
                  {pathInput || "尚未选择路径"}
                </code>
                <button
                  type="button"
                  className="unity-btn"
                  disabled={busy || !(selected?.gameDir || pathInput.trim())}
                  onClick={() => void openCurrentDir()}
                >
                  打开当前目录
                </button>
              </div>
            </div>
          </section>

          <section className="unity-games">
            {viewMode === "detail" && selected ? (
              <>
                <div className="unity-section-head">
                  <button
                    type="button"
                    className="unity-btn unity-back"
                    onClick={backToList}
                  >
                    ← 返回游戏列表
                  </button>
                  <span>详细信息</span>
                </div>
                <div className="unity-games-body">
                  <div className="unity-game-detail">
                    <h3 className="unity-game-detail-title">
                      {gameTitle(selected)}
                    </h3>
                    {(() => {
                      const arch = archFact(selected.arch);
                      const runtime = runtimeFact(selected);
                      const install = installMethodFact(selected);
                      const plugins = pluginsFact(selected);
                      const exe = selected.gameExe || "未知";
                      return (
                        <dl className="unity-fact-list">
                          <div className="unity-fact">
                            <dt>程序架构</dt>
                            <dd>
                              <strong>{arch.value}</strong>
                              <p>{arch.hint}</p>
                            </dd>
                          </div>
                          <div className="unity-fact">
                            <dt>脚本后端</dt>
                            <dd>
                              <strong>{runtime.value}</strong>
                              <p>{runtime.hint}</p>
                            </dd>
                          </div>
                          <div className="unity-fact">
                            <dt>推荐安装方式</dt>
                            <dd>
                              <strong>{install.value}</strong>
                              <p>{install.hint}</p>
                            </dd>
                          </div>
                          <div className="unity-fact">
                            <dt>已装插件 / 组件</dt>
                            <dd>
                              <strong>{plugins.value}</strong>
                              <p>{plugins.hint}</p>
                              {plugins.plugins.length > 0 ? (
                                <ul className="unity-plugin-chips">
                                  {plugins.plugins.map((p) => (
                                    <li key={p}>{p}</li>
                                  ))}
                                </ul>
                              ) : null}
                            </dd>
                          </div>
                          <div className="unity-fact">
                            <dt>主程序</dt>
                            <dd>
                              <strong className="unity-fact-path">{exe}</strong>
                              <p>
                                {selected.gameExe
                                  ? "启动游戏时将运行该可执行文件；架构信息也主要从它读取。"
                                  : "未能在游戏目录中识别主程序 .exe。"}
                              </p>
                            </dd>
                          </div>
                          <div className="unity-fact">
                            <dt>游戏目录</dt>
                            <dd>
                              <strong className="unity-fact-path">
                                {selected.gameDir}
                              </strong>
                              <p>
                                插件、加载器与配置会写入此目录（或其下的 BepInEx /
                                ReiPatcher 子目录）。
                              </p>
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
              </>
            ) : (
              <>
                <div className="unity-section-head">
                  <h2>检测到的游戏</h2>
                  <span>
                    {scanning
                      ? `扫描中 · 已找到 ${games.length} 个`
                      : games.length === 0
                        ? "尚未检测"
                        : searchQuery.trim()
                          ? `${filteredGames.length} / ${games.length} 个`
                          : `${games.length} 个`}
                    {" · 点选查看详情"}
                  </span>
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
                    <p className="unity-game-empty">
                      {scanning
                        ? "正在扫描目录，发现游戏后会立即显示"
                        : "选择或拖入目录后，游戏列表会显示在这里"}
                    </p>
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
                                "unity-game-card" + (isActive ? " is-active" : "")
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
              </>
            )}
          </section>

          {(error || successNote || steps.length > 0) && (
            <section className="unity-status">
              {error ? <p className="unity-error">{error}</p> : null}
              {successNote ? <p className="unity-ok">{successNote}</p> : null}
              {steps.length > 0 ? (
                <ol>
                  {steps.map((s, i) => (
                    <li key={`${i}-${s}`}>{s}</li>
                  ))}
                </ol>
              ) : null}
            </section>
          )}
        </div>

        <aside className="unity-col-side">
          <section className="unity-config">
            <div className="unity-section-head">
              <h2>安装配置</h2>
              <span>写入游戏内配置</span>
            </div>
            <div className="unity-config-body">
              <div className="unity-config-grid">
                <label>
                  游戏原文语言
                  <select
                    value={fromLang}
                    onChange={(ev) => setFromLang(ev.target.value)}
                  >
                    {FROM_LANG_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  翻译目标语言
                  <select
                    value={targetLang}
                    onChange={(ev) => setTargetLang(ev.target.value)}
                  >
                    {TARGET_LANG_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="unity-span-2">
                  翻译引擎 Endpoint
                  <select
                    value={endpoint}
                    onChange={(ev) => setEndpoint(ev.target.value)}
                  >
                    {endpoints.map((o) => (
                      <option key={o.id || "__empty"} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="unity-span-2">
                  备用 Endpoint
                  <select
                    value={fallbackEndpoint}
                    onChange={(ev) => setFallbackEndpoint(ev.target.value)}
                  >
                    <option value="">无</option>
                    {endpoints
                      .filter((o) => o.id)
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                  </select>
                </label>
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

          {selfCheck ? (
            <section
              className={
                "unity-selfcheck" +
                (selfCheck.verdict === "arch_mismatch"
                  ? " is-error"
                  : selfCheck.verdict === "log_suggests_outdated"
                    ? " is-warn"
                    : "")
              }
            >
              <div className="unity-section-head">
                <h2>启动自检</h2>
                <button
                  type="button"
                  className="unity-btn unity-btn-clear"
                  onClick={() => setSelfCheck(null)}
                >
                  关闭
                </button>
              </div>
              <p className="unity-selfcheck-verdict">{selfCheck.verdictLabel}</p>
              <p className="unity-selfcheck-summary">{selfCheck.summary}</p>
              <p className="unity-selfcheck-meta">
                游戏 {archLabel(selfCheck.gameArch)} · 加载器{" "}
                {archLabel(selfCheck.loaderArch)} ·{" "}
                {runtimeLabel(selfCheck.runtime)}
              </p>
              <ul className="unity-selfcheck-list">
                {selfCheck.checks.map((c) => (
                  <li key={c.id} className={"level-" + c.level}>
                    <strong>{c.title}</strong>
                    <span>{c.detail}</span>
                  </li>
                ))}
              </ul>
              {selfCheck.suggestions.length > 0 ? (
                <>
                  <h3 className="unity-selfcheck-h">建议步骤</h3>
                  <ol className="unity-selfcheck-steps">
                    {selfCheck.suggestions.map((s, i) => (
                      <li key={`${i}-${s.slice(0, 24)}`}>{s}</li>
                    ))}
                  </ol>
                </>
              ) : null}
              {selfCheck.hasLog && selfCheck.logPath ? (
                <p className="unity-selfcheck-logpath">
                  日志：<code>{selfCheck.logPath}</code>
                </p>
              ) : null}
            </section>
          ) : null}

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
      </div>
    </div>
  );
}
