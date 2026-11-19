import { FeatureIcon } from "./components/FeatureIcon";
import { AppDownloadsButton } from "./components/AppDownloadsButton";
import { GlobalOutputView, OutputBadge } from "./components/GlobalOutputView";
import { initializeAppOutput, writeOutput } from "./appOutput";
import { lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
const StatsView = lazy(() => import("./components/StatsView").then(module => ({ default: module.StatsView })));
const TextTranslateView = lazy(() => import("./components/TextTranslateView").then(module => ({ default: module.TextTranslateView })));
const UnityTranslateView = lazy(() => import("./components/UnityTranslateView").then(module => ({ default: module.UnityTranslateView })));
const SpeechView = lazy(() => import("./components/SpeechView").then(module => ({ default: module.SpeechView })));
import { toFriendlyError } from "./friendlyError";
import { stringifyLiteraturePromptCatalog } from "./literaturePrompt";
import { defaultSettings, withDefaults } from "./settingsDefaults";
import { resolveFeatureLlm, setVendorModelsOverrideCache } from "./modelPresets";

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
  settings: "设置",
} as const;
type NavigationItem = keyof typeof pageLabels;
type Page = Exclude<NavigationItem, "output" | "downloads">;
const navigation: readonly NavigationItem[][] = [
  ["chat", "literature", "image", "redraw", "speech", "text", "unity"],
  ["output", "downloads", "stats", "settings"],
];

function PagePanel({ feature, active, children }: { feature: Page; active: boolean; children: React.ReactNode }) {
  return <div className={active ? "literature-host" : "literature-host is-hidden"} aria-hidden={!active} inert={!active}>
    <DeferredPanel active={active} label={pageLabels[feature]}>{children}</DeferredPanel>
  </div>;
}

export default function App() {
  const [page, setPage] = useState<Page>("chat");
  const [outputExpanded, setOutputExpanded] = useState(false);
  const startupInteracted = useRef(false);

  const [navRailHidden, setNavRailHidden] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<
    "unity" | "general" | undefined
  >(undefined);
  const [backendReady, setBackendReady] = useState(false);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [current, setCurrent] = useState<Conversation | null>(null);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => { if (backendReady) void initializeAppOutput(); }, [backendReady]);
  const [displayOffset, setDisplayOffset] = useState(0);
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

  const openConversation = useCallback(
    async (id: string, pageSize = settings.messagePageSize) => {
      const conv = await api.getConversation(id, pageSize);
      const offset = Math.max(0, conv.messages.length - pageSize);
      setDisplayOffset(offset);
      setCurrent(conv);
      await refreshList();
    },
    [refreshList, settings.messagePageSize],
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
          setDisplayOffset(offset);
          setCurrent(conv);
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
    if (current.messages.length === 0) {
      setDisplayOffset(0);
      return;
    }
    const conv = await api.createConversation();
    setCurrent(conv);
    setDisplayOffset(0);
    await refreshList();
  };

  const onSelectConversation = async (id: string) => {
    await openConversation(id);
  };

  const onDeleteConversation = async (id: string) => {
    const res = await api.deleteConversation(id);
    setCurrent(res.current);
    setDisplayOffset(
      Math.max(0, res.current.messages.length - settings.messagePageSize),
    );
    await refreshList();
  };

  const onRenameConversation = async (id: string, title: string) => {
    try {
      const updated = await api.renameConversation(id, title);
      setConversations((list) =>
        list.map((c) => (c.id === id ? { ...c, title: updated.title } : c)),
      );
      setCurrent((cur) =>
        cur && cur.id === id ? { ...cur, title: updated.title } : cur,
      );
      await refreshList();
    } catch (e) {
      throw e instanceof Error ? e : new Error("重命名失败");
    }
  };

  const onSend = async (text: string) => {
    if (!current || sending) return;
    const content = text.trim();
    if (!content) return;

    setSending(true);
    const optimistic: Conversation = {
      ...current,
      messages: [...current.messages, { role: "user", content }],
      title:
        current.title === "新对话"
          ? content.slice(0, 20)
          : current.title,
    };
    setCurrent(optimistic);
    setDisplayOffset(0);

    try {
      const res = await api.chat(current.id, content, settings.apiUrl);
      writeOutput(["对话", "模型回复"], "已收到回复", "success");
      setCurrent(res.conversation);
      setDisplayOffset(
        Math.max(
          0,
          res.conversation.messages.length - settings.messagePageSize,
        ),
      );
      await refreshList();
    } catch (err) {
      writeOutput(["对话", "模型回复"], toFriendlyError(err), "error");
      setCurrent({
        ...optimistic,
        messages: [
          ...optimistic.messages,
          {
            role: "assistant",
            content: `错误：${toFriendlyError(err)}`,
          },
        ],
      });
    } finally {
      setSending(false);
    }
  };

  const onLoadEarlier = async () => {
    if (displayOffset > 0) { setDisplayOffset(v => Math.max(0, v - settings.messagePageSize)); return; }
    if (!current?.messageOffset || loadingEarlierRef.current) return;
    loadingEarlierRef.current = true;
    try {
      const page = await api.getConversation(current.id, settings.messagePageSize, current.messageOffset);
      setCurrent(value => value?.id === current.id && value.messageOffset === current.messageOffset ? { ...value, messages: [...page.messages, ...value.messages], messageOffset: page.messageOffset } : value);
      writeOutput(["对话", "历史消息"], "已加载较早的消息", "success", false, current.id);
    } catch (error) {
      const detail = toFriendlyError(error, "加载历史消息失败");
      setBackendError(detail); writeOutput(["对话", "历史消息"], detail, "error", true, current.id);
    }
    finally { loadingEarlierRef.current = false; }
  };

  const onSaveSettings = async (next: Settings) => {
    const res = await api.saveSettings(next);
    const resolved =
      res.textProjectsDirResolved ||
      next.textProjectsDirResolved ||
      next.textProjectsDir;
    setSettings({
      ...next,
      textProjectsDir: next.textProjectsDir.trim() || resolved || "",
      textProjectsDirResolved: resolved,
      dataDir: res.dataDir || next.dataDir,
    });
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
          {group.map(id => id === "downloads" ? <AppDownloadsButton key={id} railHidden={navRailHidden} /> : (
            <button key={id} type="button" className={(id === "output" ? outputExpanded : page === id) ? "nav-item active" : "nav-item"}
              aria-current={page === id ? "page" : undefined} aria-label={pageLabels[id]} data-tooltip={pageLabels[id]}
              aria-expanded={id === "output" ? outputExpanded : undefined}
              aria-controls={id === "output" && outputExpanded ? "app-output-drawer" : undefined}
              onClick={() => {
                if (id === "output") { setOutputExpanded(expanded => !expanded); return; }
                if (id === "settings") setSettingsInitialTab(undefined);
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
            <Sidebar
              conversations={conversations}
              currentId={current?.id}
              search={search}
              onSearchChange={setSearch}
              onNewChat={() => void onNewChat()}
              onSelect={(id) => void onSelectConversation(id)}
              onDelete={(id) => void onDeleteConversation(id)}
              onRename={(id, title) => void onRenameConversation(id, title)}
            />
            <ChatView
              conversation={current}
              messages={visibleMessages}
              hiddenCount={hiddenCount}
              sending={sending}
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
              await onSaveSettings({ ...settings, ocrMode });
            }}
            onTranslateSourceChange={async (translateSource) => {
              await onSaveSettings({ ...settings, translateSource });
            }}
            onTranslateTargetChange={async (translateTarget) => {
              await onSaveSettings({ ...settings, translateTarget });
            }}
            onClearLineBreaksChange={async (translateClearLineBreaks) => {
              await onSaveSettings({ ...settings, translateClearLineBreaks });
            }}
            onPromptCatalogChange={async ({ catalog, activeId, prompt }) => {
              await onSaveSettings({
                ...settings,
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
              await onSaveSettings({ ...settings, ocrAutoTranslate });
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
              await onSaveSettings({ ...settings, imageOcrMode: ocrMode });
            }}
            onTranslateSourceChange={async (ocrTranslateSource) => {
              await onSaveSettings({
                ...settings,
                ocrTranslateSource,
              });
            }}
            onTranslateTargetChange={async (ocrTranslateTarget) => {
              await onSaveSettings({ ...settings, ocrTranslateTarget });
            }}
          /></PagePanel>
        <PagePanel feature="text" active={page === "text"}><TextTranslateView settings={settings} active={page === "text"} onLanguageChange={async (field, code) => {
            await onSaveSettings({ ...settings, [field === "source" ? "textTranslateSource" : "textTranslateTarget"]: code });
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
            onOpenUnitySettings={() => {
              setSettingsInitialTab("unity");
              setPage("settings");
            }}
          /></PagePanel>
        <PagePanel feature="stats" active={page === "stats"}><StatsView active={page === "stats"} /></PagePanel>
        <PagePanel feature="settings" active={page === "settings"}><SettingsView
            settings={settings}
            onSave={onSaveSettings}
            initialTab={settingsInitialTab}
            active={page === "settings"}
            onNavigate={(p) => setPage(p)}
          /></PagePanel>
        {outputExpanded && <GlobalOutputView onClose={() => {
          document.querySelector<HTMLButtonElement>('[aria-controls="app-output-drawer"]')?.focus();
          setOutputExpanded(false);
        }} />}
      </div>
    </div>
  );
}
