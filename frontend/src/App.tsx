import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type Conversation,
  type ConversationSummary,
  type Settings,
} from "./api";
import { ChatView } from "./components/ChatView";
import { SettingsView } from "./components/SettingsView";
import { Sidebar } from "./components/Sidebar";

type Page = "chat" | "settings";

const defaultSettings: Settings = {
  apiUrl: "https://api.openai.com/v1/chat/completions",
  apiKey: "",
  model: "gpt-4o",
  messagePageSize: 30,
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

          setSettings(s);
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
            content: `错误: ${err instanceof Error ? err.message : String(err)}`,
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
    await api.saveSettings(next);
    setSettings(next);
    setPage("chat");
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
        <div className="nav-brand">Chat</div>
        <button
          className={page === "chat" ? "nav-item active" : "nav-item"}
          onClick={() => setPage("chat")}
        >
          Chat
        </button>
        <button
          className={page === "settings" ? "nav-item active" : "nav-item"}
          onClick={() => setPage("settings")}
        >
          Set
        </button>
        <div className="nav-version">v1.0</div>
      </nav>

      {page === "chat" ? (
        <div className="chat-layout">
          <Sidebar
            conversations={conversations}
            currentId={current?.id}
            search={search}
            onSearchChange={setSearch}
            onNewChat={() => void onNewChat()}
            onSelect={(id) => void onSelectConversation(id)}
            onDelete={(id) => void onDeleteConversation(id)}
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
      ) : (
        <SettingsView settings={settings} onSave={(s) => void onSaveSettings(s)} />
      )}
    </div>
  );
}
