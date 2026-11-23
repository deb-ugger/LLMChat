import { getLayoutRect, getLayoutViewport } from "./viewportLayout";
import { FeatureIcon } from "./components/FeatureIcon";
import { attachBenchmarkRunner } from "./benchmark/benchmarkRunner";
import { openProjectBenchmark } from "./gameBenchmarkWindow";
import { ApplicationHelpPage, isHelpModule, type HelpModule } from "./components/GameWorkflowHelp";
import { BuildSpeedTest } from "./components/BuildSpeedTest";
import { AppDownloadsButton } from "./components/AppDownloadsButton";
import { GlobalOutputView, OutputBadge } from "./components/GlobalOutputView";
import { initializeAppOutput, writeOutput } from "./appOutput";
import { lazy, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  api,
  type Conversation,
  type ConversationSummary,
  type Settings,
} from "./api";
import { DeferredPanel } from "./components/DeferredPanel";
import { isTauri } from "@tauri-apps/api/core";
import { lastUnityGameDir } from "./unityLastGame";
import { ChatView } from "./components/ChatView";
const StyleRedraw = lazy(() => import("./components/StyleRedraw"));
const ImageOcrView = lazy(() => import("./components/ImageOcrView").then(module => ({ default: module.ImageOcrView })));
const LiteratureView = lazy(async () => {
  await import("./pdfjsBootstrap");
  const module = await import("./components/LiteratureView");
  return { default: module.LiteratureView };
});
const SettingsView = lazy(() => import("./components/SettingsView").then(module => ({ default: module.SettingsView })));
import { Sidebar } from "./components/Sidebar";
import { showAppNotice } from "./components/AppNotice";
const StatsView = lazy(() => import("./components/StatsView").then(module => ({ default: module.StatsView })));
const TextTranslateView = lazy(() => import("./components/TextTranslateView").then(module => ({ default: module.TextTranslateView })));
const UnityTranslateView = lazy(() => import("./components/UnityTranslateView").then(module => ({ default: module.UnityTranslateView })));
const SpeechView = lazy(() => import("./components/SpeechView").then(module => ({ default: module.SpeechView })));
import { toFriendlyError } from "./friendlyError";
import { stringifyLiteraturePromptCatalog } from "./literaturePrompt";
import { defaultSettings, withDefaults } from "./settingsDefaults";
import { resolveFeatureLlm, setVendorModelsOverrideCache } from "./modelPresets";
import { THEMES, getTheme, onThemeChange, setTheme } from "./theme";

const pageLabels = {
  chat: "对话",
  literature: "文献翻译",
  image: "图片文字识别",
  redraw: "AI 风格重绘",
  speech: "语音转文字",
  text: "文本翻译工程",
  unity: "游戏翻译",
  output: "输出",
  downloads: "下载",
  stats: "统计",
  help: "帮助",
  benchmark: "测试队列",
  appearance: "外观",
  settings: "设置",
} as const;
type NavigationItem = keyof typeof pageLabels;
type Page = Exclude<NavigationItem, "output" | "downloads" | "appearance" | "benchmark"> | "buildSpeed";
const navigation: readonly NavigationItem[][] = [
  ["chat", "literature", "image", "redraw", "speech", "text", "unity"],
  ["output", "downloads", "stats", "benchmark", "help", "appearance", "settings"],
];
const isNarrowChat = () => window.matchMedia("(max-width: 720px)").matches;

function PagePanel({ feature, active, children }: { feature: Page; active: boolean; children: React.ReactNode }) {
  return <div className={active ? "literature-host" : "literature-host is-hidden"} aria-hidden={!active} inert={!active}>
    <DeferredPanel active={active} label={feature === "buildSpeed" ? "构建测速" : pageLabels[feature]}>{children}</DeferredPanel>
  </div>;
}

function AppearanceButton({ railHidden }: { railHidden: boolean }) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [theme, setSelectedTheme] = useState(getTheme);
  const [open, setOpen] = useState(false);

  useEffect(() => onThemeChange(setSelectedTheme), []);
  useEffect(() => {
    if (railHidden && panel.current?.matches(":popover-open")) panel.current.hidePopover();
  }, [railHidden]);

  return <>
    <button type="button" className={open ? "nav-item active" : "nav-item"} popoverTarget={id}
      aria-haspopup="dialog" aria-controls={id} aria-expanded={open} aria-label={pageLabels.appearance}
      data-tooltip={pageLabels.appearance} onClick={event => {
        const { scale, height } = getLayoutViewport();
        const bounds = getLayoutRect(event.currentTarget.getBoundingClientRect(), scale);
        panel.current?.style.setProperty("--appearance-left", `${bounds.right + 8}px`);
        panel.current?.style.setProperty("--appearance-bottom", `${height - bounds.bottom}px`);
      }}>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <circle cx="12" cy="12" r="8" />
        <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" />
      </svg>
      <span>{pageLabels.appearance}</span>
    </button>
    <div ref={panel} id={id} popover="auto" className="nav-appearance-popover" role="dialog" aria-label={pageLabels.appearance}
      onToggle={event => setOpen(event.currentTarget.matches(":popover-open"))}>
      {THEMES.map(option => <button key={option.id} type="button" className="nav-appearance-option"
        aria-pressed={theme === option.id} onClick={() => setTheme(option.id)}>
        <span className="nav-appearance-swatch" aria-hidden="true" style={{
          "--swatch-base": option.swatch[0],
          "--swatch-panel": option.swatch[1],
          "--swatch-accent": option.swatch[2],
        } as CSSProperties} />
        <span>{option.label}</span>
        {theme === option.id && <span aria-hidden="true">✓</span>}
      </button>)}
    </div>
  </>;
}

function TestQueueButton({ railHidden, onOpen, selected }: {
  railHidden: boolean; onOpen: () => void; selected: boolean;
}) {
  return <button type="button" className={selected ? "nav-item active" : "nav-item"}
    aria-label="运行记录" data-tooltip="运行记录" aria-current={selected ? "page" : undefined}
    onClick={() => { if (!railHidden) onOpen(); }}><FeatureIcon feature="benchmark" size={20} /><span>运行记录</span></button>;
}

export default function App() {
  useEffect(attachBenchmarkRunner, []);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("llmchat-run-records");
    const receive = (event: MessageEvent) => { if (event.data?.type === "open-build-speed") setPage("buildSpeed"); };
    channel.addEventListener("message", receive);
    return () => { channel.removeEventListener("message", receive); channel.close(); };
  }, []);
  const [page, setPage] = useState<Page>("chat");
  const [helpSection, setHelpSection] = useState<HelpModule>("chat");
  const [openGameQueue, setOpenGameQueue] = useState(false);
  useEffect(() => {
    if (!openGameQueue || page !== "unity") return;
    const frame = requestAnimationFrame(() => {
      setOpenGameQueue(false);
      if (!openProjectBenchmark()) showAppNotice("请先打开游戏翻译工程", "error");
    });
    return () => cancelAnimationFrame(frame);
  }, [openGameQueue, page]);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const startupInteracted = useRef(false);

  const [navRailHidden, setNavRailHidden] = useState(false);
  const [chatSidebarOpen, setChatSidebarOpen] = useState(() => !isNarrowChat());
  const [settingsInitialTab, setSettingsInitialTab] = useState<
    "unity" | "general" | "chat" | undefined
  >(undefined);
  const [backendReady, setBackendReady] = useState(false);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [{ current, displayOffset }, setChat] = useState<{ current: Conversation | null; displayOffset: number }>({ current: null, displayOffset: 0 });
  const conversationSelection = useRef(0);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => { if (backendReady) void initializeAppOutput(); }, [backendReady]);
  const settingsSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const [ocrIncoming, setOcrIncoming] = useState<{
    file: File;
    id: number;
  } | null>(null);
  useEffect(() => {
    if (!backendReady || !isTauri()) return;
    const root = lastUnityGameDir(); if (!root) return;
    let cancelled = false;
    void import("./unityOffline").then(module => module.unityRun<{ unfinished: boolean }>("resume-info", { root }))
      .then(info => { if (!cancelled && !startupInteracted.current && info.unfinished) setPage("unity"); })
      .catch(error => {
        if (cancelled) return;
        const detail = toFriendlyError(error, "读取上次 Unity 工程状态失败");
        setBackendError(detail); writeOutput(["游戏翻译", "Unity", "工程恢复"], detail, "error");
      });
    return () => { cancelled = true; };
  }, [backendReady]);
  const ocrIncomingSeq = useRef(0);
  useEffect(()=>{const text=()=>setPage("text"),image=()=>setPage("image");window.addEventListener("llmchat-open-game-text",text);window.addEventListener("llmchat-open-game-image",image);return()=>{window.removeEventListener("llmchat-open-game-text",text);window.removeEventListener("llmchat-open-game-image",image);};},[]);


  const openImageOcr = useCallback((file: File) => {
    ocrIncomingSeq.current += 1;
    setOcrIncoming({ file, id: ocrIncomingSeq.current });
    setPage("image");
  }, []);

  const refreshList = useCallback(async () => {
    const data = await api.listConversations();
    setConversations(data.items);
    return data;
  }, []);

  const refreshSidebar = useCallback(async () => {
    try {
      await refreshList();
    } catch (error) {
      const detail = toFriendlyError(error, "对话列表刷新失败");
      showAppNotice("对话列表刷新失败：" + detail, "error");
      writeOutput(["对话", "列表刷新"], detail, "error");
    }
  }, [refreshList]);

  const openConversation = useCallback(
    async (id: string, pageSize = settings.messagePageSize) => {
      const selection = ++conversationSelection.current;
      const conv = await api.getConversation(id, pageSize);
      if (selection !== conversationSelection.current) return;
      setChat({ current: conv, displayOffset: Math.max(0, conv.messages.length - pageSize) });
      await refreshSidebar();
    },
    [refreshSidebar, settings.messagePageSize],
  );

  useEffect(() => {
    let cancelled = false;

    const waitForBackend = async () => {
      let lastFailure = "";
      while (!cancelled) {
        try {
          await api.health();
          if (cancelled) return;

          const s = await api.getSettings();
          if (cancelled) return;

          let list = await api.listConversations();
          let conv: Conversation | null = null;

          if (list.currentId) {
            try {
              conv = await api.getConversation(list.currentId);
            } catch {
              conv = null;
            }
          }

          if (!conv || conv.messages.length > 0) {
            conv = await api.createConversation();
            list = await api.listConversations();
          }

          if (cancelled) return;

          setSettings(withDefaults(s));
          setConversations(list.items);
          const offset = Math.max(
            0,
            conv.messages.length - (s.messagePageSize || 30),
          );
          setChat({ current: conv, displayOffset: offset });
          setBackendError(null);
          setBackendReady(true);
          writeOutput(["系统", "后端连接"], "服务已就绪", "success", false, "启动");
          return;
        } catch (err) {
          if (cancelled) return;
          setBackendReady(false);
          const detail = err instanceof Error ? err.message : "后端未就绪";
          setBackendError(detail);
          if (detail !== lastFailure) writeOutput(["系统", "后端连接"], detail, "error", true, "启动");
          lastFailure = detail;
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    };

    void waitForBackend();
    return () => {
      cancelled = true;
    };
  }, []);

  const litLlm = useMemo(
    () => resolveFeatureLlm(settings, settings.translateModel),
    [settings],
  );
  const ocrLlm = useMemo(
    () => resolveFeatureLlm(settings, settings.ocrTranslateModel),
    [settings],
  );

  useEffect(() => {
    void api
      .getVendorModels()
      .then((res) => setVendorModelsOverrideCache(res.vendors || {}))
      .catch(() => {
        /* keep built-ins */
      });
  }, []);

  const visibleMessages = useMemo(() => {
    if (!current) return [];
    return current.messages.slice(displayOffset);
  }, [current, displayOffset]);

  const hiddenCount = displayOffset + (current?.messageOffset ?? 0);
  const loadingEarlierRef = useRef(false);

  const onNewChat = async () => {
    if (!current) return;
    const selection = ++conversationSelection.current;
    setSearch("");
    if (isNarrowChat()) setChatSidebarOpen(false);
    if (current.messages.length === 0) {
      setChat(value => ({ ...value, displayOffset: 0 }));
      return;
    }
    const conv = await api.createConversation();
    if (selection === conversationSelection.current) setChat({ current: conv, displayOffset: 0 });
    await refreshSidebar();
  };

  const onSelectConversation = async (id: string) => {
    await openConversation(id);
    if (isNarrowChat()) setChatSidebarOpen(false);
  };

  const onDeleteConversation = async (id: string) => {
    const selection = conversationSelection.current;
    const res = await api.deleteConversation(id);
    if (selection === conversationSelection.current) {
      setChat(value => value.current?.id === id ? {
        current: res.current,
        displayOffset: Math.max(0, res.current.messages.length - settings.messagePageSize),
      } : value);
    }
    await refreshSidebar();
  };

  const onRenameConversation = async (id: string, title: string) => {
    const updated = await api.renameConversation(id, title);
    setConversations(list => list.map(item => item.id === id ? { ...item, title: updated.title } : item));
    setChat(value => value.current?.id === id ? {
      ...value,
      current: { ...value.current, title: updated.title },
    } : value);
    void refreshSidebar();
  };

  const onSend = async (text: string) => {
    if (!current || sending) return;
    const content = text.trim();
    if (!content) return;

    const id = current.id;
    setSending(true);
    const optimistic: Conversation = {
      ...current,
      messages: [...current.messages, { role: "user", content }],
      title: current.title === "新对话" ? content.slice(0, 20) : current.title,
    };
    setChat({ current: optimistic, displayOffset: 0 });

    try {
      const { conversation } = await api.chat(id, content, settings.apiUrl);
      setChat(value => value.current?.id === id ? {
        current: conversation,
        displayOffset: Math.max(0, conversation.messages.length - settings.messagePageSize),
      } : value);
      writeOutput(["对话", "模型回复"], "已收到回复", "success", false, id);
    } catch (error) {
      const detail = toFriendlyError(error);
      writeOutput(["对话", "模型回复"], detail, "error", true, id);
      setChat(value => value.current?.id === id ? {
        ...value,
        current: { ...value.current, messages: [...value.current.messages, { role: "assistant", content: "错误：" + detail }] },
      } : value);
      return;
    } finally {
      setSending(false);
    }
    void refreshSidebar();
  };

  const onLoadEarlier = async () => {
    if (displayOffset > 0) {
      setChat(value => ({ ...value, displayOffset: Math.max(0, value.displayOffset - settings.messagePageSize) }));
      return;
    }
    if (!current?.messageOffset || loadingEarlierRef.current) return;
    loadingEarlierRef.current = true;
    try {
      const page = await api.getConversation(current.id, settings.messagePageSize, current.messageOffset);
      setChat(value => value.current?.id === current.id && value.current.messageOffset === current.messageOffset ? {
        ...value,
        current: { ...value.current, messages: [...page.messages, ...value.current.messages], messageOffset: page.messageOffset },
      } : value);
      writeOutput(["对话", "历史消息"], "已加载较早的消息", "success", false, current.id);
    } catch (error) {
      const detail = toFriendlyError(error, "加载历史消息失败");
      setBackendError(detail); writeOutput(["对话", "历史消息"], detail, "error", true, current.id);
    }
    finally { loadingEarlierRef.current = false; }
  };

  const saveSettingsPatch = (patch: Partial<Settings>) => {
    if (!Object.keys(patch).length) return Promise.resolve();

    const save = settingsSaveQueue.current.then(async () => {
      // The API wrapper still types this request as a full form; the endpoint accepts a field patch.
      const res = await api.saveSettings(patch as Settings);
      setSettings(previous => {
        const next = { ...previous, ...patch };
        const resolved = res.textProjectsDirResolved || next.textProjectsDirResolved || next.textProjectsDir;
        return {
          ...next,
          textProjectsDir: patch.textProjectsDir === undefined ? previous.textProjectsDir : patch.textProjectsDir.trim() || resolved || "",
          textProjectsDirResolved: resolved,
          dataDir: res.dataDir || previous.dataDir,
        };
      });
    });
    settingsSaveQueue.current = save.catch(() => {});
    return save;
  };

  const onSaveSettings = (next: Settings) => {
    const { textProjectsDirResolved, dataDir, port, ...fields } = next;
    const patch = Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== settings[key as keyof Settings]));
    return saveSettingsPatch(patch);
  };

  if (!backendReady) {
    if (backendError) {
      return (
        <div className="boot">
          <div className="boot-card">
            <h1>LLMChat</h1>
            <p className="boot-error">{backendError}</p>
            <p className="hint">请确认已启动 backend\build\Release\llmchat-backend.exe</p>
            <button
              className="save-btn"
              style={{ marginTop: 12 }}
              onClick={() => window.location.reload()}
            >
              重试
            </button>
          </div>
        </div>
      );
    }
    // Quiet boot: no gray splash card while connecting.
    return <div className="boot boot-quiet" aria-busy="true" />;
  }

  return (
    <div className="app-shell" onPointerDownCapture={() => { startupInteracted.current = true; }} onKeyDownCapture={() => { startupInteracted.current = true; }}>
      <nav aria-label="主导航" className={`nav-rail${navRailHidden ? " is-collapsed" : ""}`}>
        {navigation.map((group, index) => <div key={group[0]} className={index === 0 ? "nav-links" : "nav-utilities"}>
          {group.map(id => id === "downloads" ? <AppDownloadsButton key={id} railHidden={navRailHidden} /> :
            id === "benchmark" ? <TestQueueButton key={id} railHidden={navRailHidden} selected={page === "unity"}
              onOpen={() => { setOpenGameQueue(true); setPage("unity"); }} /> :
            id === "appearance" ? <AppearanceButton key={id} railHidden={navRailHidden} /> : (
            <button key={id} type="button" className={(id === "output" ? outputExpanded : page === id) ? "nav-item active" : "nav-item"}
              aria-current={page === id ? "page" : undefined} aria-label={pageLabels[id]} data-tooltip={pageLabels[id]}
              aria-expanded={id === "output" ? outputExpanded : undefined}
              aria-controls={id === "output" && outputExpanded ? "app-output-drawer" : undefined}
              onClick={() => {
                if (id === "output") { setOutputExpanded(expanded => !expanded); return; }
                if (id === "settings" || id === "chat") setSettingsInitialTab(undefined);
                if (id === "help" && isHelpModule(page)) setHelpSection(page);
                setPage(id);
              }}>
              <FeatureIcon feature={id === "redraw" ? "image" : id} size={20} /><span>{pageLabels[id]}</span>{id === "output" && <OutputBadge />}
            </button>
          ))}
        </div>)}
        <button
          type="button"
          className="nav-rail-toggle"
          aria-label={navRailHidden ? "显示左侧导航栏" : "隐藏左侧导航栏"}
          aria-expanded={!navRailHidden}
          data-tooltip={navRailHidden ? "显示左侧导航栏" : "隐藏左侧导航栏"}
          onClick={() => setNavRailHidden((hidden) => !hidden)}
        >
          {navRailHidden && <OutputBadge />}
          <span
            className={`nav-rail-toggle-icon${navRailHidden ? " is-expand" : ""}`}
            aria-hidden="true"
          />
        </button>
      </nav>

      <div className="app-main">
        <div className={page === "chat" ? "literature-host" : "literature-host is-hidden"} aria-hidden={page !== "chat"} inert={page !== "chat"}>
          <div className="chat-layout">
            {chatSidebarOpen && <Sidebar
              conversations={conversations}
              currentId={current?.id}
              search={search}
              onSearchChange={setSearch}
              onNewChat={() => void onNewChat()}
              onSelect={(id) => void onSelectConversation(id)}
              onDelete={(id) => void onDeleteConversation(id)}
              onRename={onRenameConversation}
            />}
            <ChatView
              conversation={current}
              messages={visibleMessages}
              hiddenCount={hiddenCount}
              sending={sending}
              model={settings.model}
              sidebarOpen={chatSidebarOpen}
              onToggleSidebar={() => setChatSidebarOpen(open => !open)}
              onNewChat={() => void onNewChat()}
              onOpenModelSettings={() => {
                setSettingsInitialTab("chat");
                setPage("settings");
              }}
              onSend={(t) => void onSend(t)}
              onLoadEarlier={onLoadEarlier}
            />
          </div>
        </div>
        {/* Keep mounted so PDF + reading position survive nav switches.
            Hidden panes use visibility (not display:none) so PDF layout stays valid. */}
        <PagePanel feature="literature" active={page === "literature"}><LiteratureView
            visible={page === "literature"}
            ocrMode={settings.ocrMode}
            translateProvider={settings.translateProvider}
            translateSource={settings.translateSource}
            translateTarget={settings.translateTarget}
            translateMaxLength={settings.translateMaxLength}
            translateAutoChunk={settings.translateAutoChunk}
            translateClearLineBreaks={settings.translateClearLineBreaks}
            translateContextParagraphs={settings.translateContextParagraphs}
            translateGlossary={settings.translateGlossary}
            translatePromptCatalog={settings.translatePromptCatalog}
            translatePromptId={settings.translatePromptId}
            translatePromptKind={settings.translatePromptKind}
            translatePrompt={settings.translatePrompt}
            model={litLlm.model}
            apiUrl={litLlm.apiUrl}
            apiKey={litLlm.apiKey}
            onOpenImageOcr={openImageOcr}
            onOcrModeChange={async (ocrMode) => {
              await saveSettingsPatch({ ocrMode });
            }}
            onTranslateSourceChange={async (translateSource) => {
              await saveSettingsPatch({ translateSource });
            }}
            onTranslateTargetChange={async (translateTarget) => {
              await saveSettingsPatch({ translateTarget });
            }}
            onClearLineBreaksChange={async (translateClearLineBreaks) => {
              await saveSettingsPatch({ translateClearLineBreaks });
            }}
            onPromptCatalogChange={async ({ catalog, activeId, prompt }) => {
              await saveSettingsPatch({
                translatePromptCatalog:
                  stringifyLiteraturePromptCatalog(catalog),
                translatePromptId: activeId,
                translatePromptKind: activeId,
                translatePrompt: prompt,
              });
            }}
          /></PagePanel>
        <PagePanel feature="image" active={page === "image"}><ImageOcrView
            active={page === "image"}
            ocrMode={settings.imageOcrMode}
            autoTranslate={settings.ocrAutoTranslate}
            onAutoTranslateChange={async (ocrAutoTranslate) => {
              await saveSettingsPatch({ ocrAutoTranslate });
            }}
            translateProvider={settings.ocrTranslateProvider}
            translateSource={settings.ocrTranslateSource}
            translateTarget={settings.ocrTranslateTarget}
            translateMaxLength={settings.ocrTranslateMaxLength}
            translateAutoChunk={settings.ocrTranslateAutoChunk}
            model={ocrLlm.model}
            apiUrl={ocrLlm.apiUrl}
            apiKey={ocrLlm.apiKey}
            incomingImage={ocrIncoming}
            onIncomingHandled={() => setOcrIncoming(null)}
            onOcrModeChange={async (ocrMode) => {
              await saveSettingsPatch({ imageOcrMode: ocrMode });
            }}
            onTranslateSourceChange={async (ocrTranslateSource) => {
              await saveSettingsPatch({ ocrTranslateSource });
            }}
            onTranslateTargetChange={async (ocrTranslateTarget) => {
              await saveSettingsPatch({ ocrTranslateTarget });
            }}
          /></PagePanel>
        <PagePanel feature="text" active={page === "text"}><TextTranslateView settings={settings} active={page === "text"} onLanguageChange={async (field, code) => {
            await saveSettingsPatch({ [field === "source" ? "textTranslateSource" : "textTranslateTarget"]: code });
          }} /></PagePanel>
        <PagePanel feature="redraw" active={page === "redraw"}><StyleRedraw active={page === "redraw"} /></PagePanel>
        <PagePanel feature="speech" active={page === "speech"}><SpeechView active={page === "speech"} /></PagePanel>
        <PagePanel feature="unity" active={page === "unity"}><UnityTranslateView
            active={page === "unity"}
            settings={settings}
            onRestoreWorkspace={() => { if (!startupInteracted.current) setPage("unity"); }}
            onOpenGeneralSettings={() => {
              setSettingsInitialTab("general");
              setPage("settings");
            }}
          /></PagePanel>
        <PagePanel feature="stats" active={page === "stats"}><StatsView active={page === "stats"} /></PagePanel>
        <PagePanel feature="help" active={page === "help"}><ApplicationHelpPage section={helpSection} onSection={setHelpSection} /></PagePanel>
        <PagePanel feature="buildSpeed" active={page === "buildSpeed"}><BuildSpeedTest /></PagePanel>
        <PagePanel feature="settings" active={page === "settings"}><SettingsView
            settings={settings}
            onSave={onSaveSettings}
            initialTab={settingsInitialTab}
            active={page === "settings"}
            onNavigate={(p) => {
              if (p === "chat") setSettingsInitialTab(undefined);
              setPage(p);
            }}
          /></PagePanel>
        {outputExpanded && <GlobalOutputView onClose={() => {
          document.querySelector<HTMLButtonElement>('[aria-controls="app-output-drawer"]')?.focus();
          setOutputExpanded(false);
        }} />}
      </div>
    </div>
  );
}
