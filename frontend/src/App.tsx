import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type Conversation,
  type ConversationSummary,
  type Settings,
} from "./api";
import { ChatView } from "./components/ChatView";
import { ImageOcrView } from "./components/ImageOcrView";
import { LiteratureView } from "./components/LiteratureView";
import { SettingsView } from "./components/SettingsView";
import { Sidebar } from "./components/Sidebar";
import { TextTranslateView } from "./components/TextTranslateView";
import { UnityTranslateView } from "./components/UnityTranslateView";
import { toFriendlyError } from "./friendlyError";
import {
  DEFAULT_MTOOL_PROMPT,
  DEFAULT_SUBTITLE_PROMPT,
  DEFAULT_SUBTITLE_RETIME_TRANSLATE_PROMPT,
  DEFAULT_TEXT_PROMPT,
} from "./textTranslate";
import { resolveFeatureLlm } from "./modelPresets";

type Page = "chat" | "literature" | "image" | "text" | "unity" | "settings";

const defaultSettings: Settings = {
  apiUrl: "https://api.openai.com/v1/chat/completions",
  apiKey: "",
  model: "gpt-4o",
  messagePageSize: 30,
  proxyMode: "direct",
  httpProxy: "",
  translateProvider: "bing",
  translateSource: "en",
  translateTarget: "zh-CN",
  translateModel: "",
  translateMaxLength: 0,
  translateAutoChunk: true,
  ocrLang: "eng",
  ocrAutoTranslate: true,
  ocrTranslateProvider: "bing",
  ocrTranslateSource: "en",
  ocrTranslateTarget: "zh-CN",
  ocrTranslateModel: "",
  ocrTranslateMaxLength: 0,
  ocrTranslateAutoChunk: true,
  textTranslateSource: "en",
  textTranslateTarget: "zh-CN",
  textTranslateProvider: "llm",
  textTranslateModel: "",
  textTranslatePrompt: DEFAULT_TEXT_PROMPT,
  textPromptMtool: DEFAULT_MTOOL_PROMPT,
  textPromptSubtitle: DEFAULT_SUBTITLE_PROMPT,
  textPromptSubtitleRetime: DEFAULT_SUBTITLE_RETIME_TRANSLATE_PROMPT,
  textGlossary: "[]",
  textPreReplace: "[]",
  textPostReplace: "[]",
  textProjectsDir: "",
  translateEngineKeys: "{}",
};

export default function App() {
  const [page, setPage] = useState<Page>("chat");
  const [backendReady, setBackendReady] = useState(false);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [current, setCurrent] = useState<Conversation | null>(null);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState(false);
  const [displayOffset, setDisplayOffset] = useState(0);
  const [ocrIncoming, setOcrIncoming] = useState<{
    file: File;
    id: number;
  } | null>(null);
  const ocrIncomingSeq = useRef(0);

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
      const conv = await api.getConversation(id);
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

          setSettings({
            ...defaultSettings,
            ...s,
            proxyMode: (s.proxyMode as Settings["proxyMode"]) || "direct",
            httpProxy: String(s.httpProxy || ""),
            translateProvider: (() => {
              const p = String(s.translateProvider || "bing");
              if (p === "llm") return "llm";
              if (p === "free") return "mymemory";
              if (p === "blind") return "bing";
              return p as Settings["translateProvider"];
            })(),
            translateSource: s.translateSource || "en",
            translateTarget: s.translateTarget || "zh-CN",
            translateModel: String(s.translateModel || s.model || ""),
            translateMaxLength: s.translateMaxLength ?? 0,
            translateAutoChunk: s.translateAutoChunk ?? true,
            ocrLang: s.ocrLang || "eng",
            ocrAutoTranslate: s.ocrAutoTranslate ?? true,
            ocrTranslateProvider: (() => {
              const p = String(s.ocrTranslateProvider || "bing");
              if (p === "llm") return "llm";
              if (p === "free") return "mymemory";
              if (p === "blind") return "bing";
              return p as Settings["translateProvider"];
            })(),
            ocrTranslateSource: (() => {
              const lang = s.ocrLang || "eng";
              if (lang === "chi_sim") return "zh-CN";
              if (lang === "chi_tra") return "zh-TW";
              if (lang === "jpn") return "ja";
              if (lang === "kor") return "ko";
              return "en";
            })(),
            ocrTranslateTarget: s.ocrTranslateTarget || "zh-CN",
            ocrTranslateModel: String(s.ocrTranslateModel || s.model || ""),
            ocrTranslateMaxLength: s.ocrTranslateMaxLength ?? 0,
            ocrTranslateAutoChunk: s.ocrTranslateAutoChunk ?? true,
            textTranslateSource: s.textTranslateSource || "en",
            textTranslateTarget: s.textTranslateTarget || "zh-CN",
            textTranslateProvider: (() => {
              const p = String(s.textTranslateProvider || "llm");
              if (p === "free") return "mymemory";
              if (p === "blind") return "bing";
              return p as Settings["textTranslateProvider"];
            })(),
            textTranslateModel: String(s.textTranslateModel || s.model || ""),
            textTranslatePrompt:
              s.textTranslatePrompt || DEFAULT_TEXT_PROMPT,
            textPromptMtool: s.textPromptMtool || DEFAULT_MTOOL_PROMPT,
            textPromptSubtitle:
              s.textPromptSubtitle || DEFAULT_SUBTITLE_PROMPT,
            textPromptSubtitleRetime:
              s.textPromptSubtitleRetime ||
              DEFAULT_SUBTITLE_RETIME_TRANSLATE_PROMPT,
            textGlossary: s.textGlossary || "[]",
            textPreReplace: s.textPreReplace || "[]",
            textPostReplace: s.textPostReplace || "[]",
            textProjectsDir:
              s.textProjectsDir ||
              s.textProjectsDirResolved ||
              (s.dataDir ? `${s.dataDir}\\text-projects` : ""),
            textProjectsDirResolved: s.textProjectsDirResolved,
            dataDir: s.dataDir,
            translateEngineKeys: s.translateEngineKeys || "{}",
          });
          setConversations(list.items);
          const offset = Math.max(
            0,
            conv.messages.length - (s.messagePageSize || 30),
          );
          setDisplayOffset(offset);
          setCurrent(conv);
          setBackendError(null);
          setBackendReady(true);
          return;
        } catch (err) {
          if (cancelled) return;
          setBackendReady(false);
          setBackendError(
            err instanceof Error ? err.message : "后端未就绪",
          );
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

  const visibleMessages = useMemo(() => {
    if (!current) return [];
    return current.messages.slice(displayOffset);
  }, [current, displayOffset]);

  const hiddenCount = displayOffset;

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
      const res = await api.chat(current.id, content);
      setCurrent(res.conversation);
      setDisplayOffset(
        Math.max(
          0,
          res.conversation.messages.length - settings.messagePageSize,
        ),
      );
      await refreshList();
    } catch (err) {
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

  const onLoadEarlier = () => {
    setDisplayOffset((v) => Math.max(0, v - settings.messagePageSize));
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
    return (
      <div className="boot">
        <div className="boot-card">
          <h1>LLMChat</h1>
          <p>正在连接本地后端…</p>
          <p className="hint">请确认已启动 backend\build\Release\llmchat-backend.exe</p>
          {backendError && <p className="boot-error">{backendError}</p>}
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

  return (
    <div className="app-shell">
      <nav className="nav-rail">
        <div className="nav-brand" title="LLMChat">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
            <path
              fill="currentColor"
              d="M12 2a7 7 0 0 0-7 7c0 2.9 1.7 5.4 4.2 6.5L8 21l4-2.2L16 21l-1.2-5.5A7 7 0 0 0 19 9a7 7 0 0 0-7-7zm0 3.2A3.8 3.8 0 1 1 8.2 9 3.8 3.8 0 0 1 12 5.2z"
            />
          </svg>
        </div>
        <button
          className={page === "chat" ? "nav-item active" : "nav-item"}
          onClick={() => setPage("chat")}
          title="对话"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
            <path
              fill="currentColor"
              d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2zm3 5v2h10V9H7zm0 4v2h7v-2H7z"
            />
          </svg>
          <span>对话</span>
        </button>
        <button
          className={page === "literature" ? "nav-item active" : "nav-item"}
          onClick={() => setPage("literature")}
          title="文献翻译"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
            <path
              fill="currentColor"
              d="M6 3h9a3 3 0 0 1 3 3v14.5a.5.5 0 0 1-.8.4L14 18.2l-3.2 2.7a.5.5 0 0 1-.8-.4V6a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1v12H3V6a3 3 0 0 1 3-3zm10 2h-1v12.6l1.5-1.2a1 1 0 0 1 1.2 0l1.3 1V6a1 1 0 0 0-1-1z"
            />
          </svg>
          <span>文献翻译</span>
        </button>
        <button
          className={page === "image" ? "nav-item active" : "nav-item"}
          onClick={() => setPage("image")}
          title="图片文字识别"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
            <path
              fill="currentColor"
              d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v8.5l3.5-3.5 2.5 2.5 4-4L19 14V6H5zm3.5 2.5A1.5 1.5 0 1 1 8.5 11a1.5 1.5 0 0 1 0-3z"
            />
          </svg>
          <span>图片文字识别</span>
        </button>
        <button
          className={page === "text" ? "nav-item active" : "nav-item"}
          onClick={() => setPage("text")}
          title="文本翻译工程"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
            <path
              fill="currentColor"
              d="M4 5h9v2H4V5zm0 4h16v2H4V9zm0 4h11v2H4v-2zm0 4h16v2H4v-2zm14.5-12.5L20 6l-1.5 1.5L17 6l1.5-1.5zM17 11.5 18.5 13 17 14.5 15.5 13 17 11.5z"
            />
          </svg>
          <span>文本翻译工程</span>
        </button>
        <button
          className={page === "unity" ? "nav-item active" : "nav-item"}
          onClick={() => setPage("unity")}
          title="在线翻译"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
            <path
              fill="currentColor"
              d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm6.5 9h-3.1a13.7 13.7 0 0 0-1.2-4.6A8 8 0 0 1 18.5 11zM12 4a12 12 0 0 1 1.7 5H10.3A12 12 0 0 1 12 4zM5.6 6.4A13.7 13.7 0 0 0 4.4 11H1.5a8 8 0 0 1 4.1-4.6zM4.4 13a13.7 13.7 0 0 0 1.2 4.6A8 8 0 0 1 1.5 13zm5.9 0h3.4A12 12 0 0 1 12 20a12 12 0 0 1-1.7-7zm5.1 4.6A13.7 13.7 0 0 0 16.6 13h3a8 8 0 0 1-4.2 4.6z"
            />
          </svg>
          <span>在线翻译</span>
        </button>
        <button
          className={page === "settings" ? "nav-item active" : "nav-item"}
          onClick={() => setPage("settings")}
          title="设置"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
            <path
              fill="currentColor"
              d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.59.22-1.14.53-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.83 14.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.43.34.68.22l2.39-.96c.49.41 1.04.72 1.63.94l.36 2.54c.05.24.25.42.49.42h3.8c.24 0 .44-.18.49-.42l.36-2.54c.59-.22 1.14-.53 1.63-.94l2.39.96c.25.12.54.02.68-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"
            />
          </svg>
          <span>设置</span>
        </button>
        <div className="nav-version">v1.0</div>
      </nav>

      <div className="app-main">
        {page === "chat" && (
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
        )}
        {/* Keep mounted so PDF + reading position survive nav switches.
            Hidden panes use visibility (not display:none) so PDF layout stays valid. */}
        <div
          className={
            page === "literature"
              ? "literature-host"
              : "literature-host is-hidden"
          }
          aria-hidden={page !== "literature"}
        >
          <LiteratureView
            visible={page === "literature"}
            translateProvider={settings.translateProvider}
            translateSource={settings.translateSource}
            translateTarget={settings.translateTarget}
            translateMaxLength={settings.translateMaxLength}
            translateAutoChunk={settings.translateAutoChunk}
            model={litLlm.model}
            apiUrl={litLlm.apiUrl}
            apiKey={litLlm.apiKey}
            onOpenImageOcr={openImageOcr}
          />
        </div>
        <div
          className={
            page === "image" ? "literature-host" : "literature-host is-hidden"
          }
          aria-hidden={page !== "image"}
        >
          <ImageOcrView
            active={page === "image"}
            ocrLang={settings.ocrLang}
            autoTranslate={settings.ocrAutoTranslate}
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
          />
        </div>
        <div
          className={
            page === "text" ? "literature-host" : "literature-host is-hidden"
          }
          aria-hidden={page !== "text"}
        >
          <TextTranslateView settings={settings} />
        </div>
        <div
          className={
            page === "unity" ? "literature-host" : "literature-host is-hidden"
          }
          aria-hidden={page !== "unity"}
        >
          <UnityTranslateView active={page === "unity"} />
        </div>
        {page === "settings" && (
          <SettingsView
            settings={settings}
            onSave={(s) => void onSaveSettings(s)}
          />
        )}
      </div>
    </div>
  );
}
