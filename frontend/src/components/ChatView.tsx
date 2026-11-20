import { useEffect, useRef, useState } from "react";
import type { ChatMessage, Conversation } from "../api";
import { copyText } from "../clipboard";
import { showAppNotice } from "./AppNotice";
import { FeatureIcon } from "./FeatureIcon";
import { RichText } from "./RichText";

type Props = {
  conversation: Conversation | null;
  messages: ChatMessage[];
  hiddenCount: number;
  sending: boolean;
  model: string;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onNewChat: () => void;
  onOpenModelSettings: () => void;
  onSend: (text: string) => void;
  onLoadEarlier: () => Promise<void>;
};

export function ChatView({
  conversation,
  messages,
  hiddenCount,
  sending,
  model,
  sidebarOpen,
  onToggleSidebar,
  onNewChat,
  onOpenModelSettings,
  onSend,
  onLoadEarlier,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const previousPosition = useRef({ id: conversation?.id, hiddenCount });
  const loadingEarlier = useRef(false);
  const loadEarlier = async () => {
    if (loadingEarlier.current) return;
    loadingEarlier.current = true;
    const list = listRef.current;
    const height = list?.scrollHeight ?? 0;
    const top = list?.scrollTop ?? 0;
    try { await onLoadEarlier(); }
    finally {
      requestAnimationFrame(() => {
        if (list === listRef.current && list) list.scrollTop = top + list.scrollHeight - height;
        loadingEarlier.current = false;
      });
    }
  };

  useEffect(() => {
    const previous = previousPosition.current;
    const list = listRef.current;
    if (list && (previous.id !== conversation?.id || hiddenCount >= previous.hiddenCount)) {
      list.scrollTop = list.scrollHeight;
    }
    previousPosition.current = { id: conversation?.id, hiddenCount };
  }, [messages.length, sending, conversation?.id, hiddenCount]);

  const empty = !conversation || conversation.messages.length === 0;
  const sidebarLabel = sidebarOpen ? "收起对话侧栏" : "展开对话侧栏";
  const modelLabel = model.split(/[\\/]/).at(-1) || model || "设置对话模型";

  return (
    <section className={empty ? "chat-panel is-empty" : "chat-panel"} aria-label="对话工作区">
      <header className="chat-topbar" data-tauri-drag-region="deep">
        <button type="button" className="chat-icon-button" aria-label={sidebarLabel} aria-expanded={sidebarOpen}
          aria-controls={sidebarOpen ? "chat-conversations" : undefined} data-tooltip={sidebarLabel}
          onClick={onToggleSidebar}><FeatureIcon feature="chat-sidebar" /></button>
        {!sidebarOpen && <button type="button" className="chat-icon-button" aria-label="新建对话" data-tooltip="新建对话"
          onClick={onNewChat}><FeatureIcon feature="new-chat" /></button>}
        {!empty && <h1 className="chat-title" data-tooltip={conversation.title}>{conversation.title}</h1>}
        <button type="button" className="chat-model" aria-label={`对话模型设置 · ${modelLabel}`}
          data-tooltip={model || "设置对话模型"} onClick={onOpenModelSettings}>
          <span>{modelLabel}</span><FeatureIcon feature="settings" size={15} />
        </button>
      </header>
      {!empty && (
        <div
          className="message-list"
          aria-label="消息记录"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollTop < 24 && hiddenCount > 0) {
              void loadEarlier();
            }
          }}
        >
          <div className="chat-thread">
            {hiddenCount > 0 && (
              <button type="button" className="load-earlier" onClick={() => void loadEarlier()}>加载更早的消息</button>
            )}
            {messages.map((message, index) => {
              const user = message.role === "user";
              const copyLabel = user ? "复制消息" : "复制回复";
              return <article key={`${conversation.id}-${hiddenCount + index}-${message.role}`}
                className={user ? "chat-message is-user" : "chat-message"} aria-label={user ? "你的消息" : "模型回复"}>
                <div className="bubble"><RichText content={message.content} variant={user ? "user" : "ai"} /></div>
                <button type="button" className="chat-icon-button chat-copy" aria-label={copyLabel} data-tooltip={copyLabel}
                  onClick={() => void copyText(message.content).then(ok => showAppNotice(ok ? "已复制" : "复制失败", ok ? "success" : "error"))}>
                  <FeatureIcon feature="copy" size={15} />
                </button>
              </article>;
            })}
            {sending && <div className="chat-thinking" role="status"><span aria-hidden="true" />正在等待模型回复</div>}
          </div>
        </div>
      )}

      <div className="chat-compose-zone">
        {empty && <h1>开始对话</h1>}
        <ChatComposer sending={sending} onSend={onSend} />
      </div>
    </section>
  );
}
function ChatComposer({ sending, onSend }: Pick<Props, "sending" | "onSend">) {
  const [text, setText] = useState("");

  const submit = () => {
    if (!text.trim() || sending) return;
    onSend(text);
    setText("");
  };

  return (
    <form className="chat-composer" onSubmit={event => { event.preventDefault(); submit(); }}>
      <textarea
        className="input-box"
        aria-label="消息"
        placeholder="输入消息"
        value={text}
        readOnly={sending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        rows={2}
      />
      <div className="chat-compose-actions">
        <span>Enter 发送 · Shift + Enter 换行</span>
        <button type="submit" className="chat-send" aria-label="发送消息" disabled={sending || !text.trim()}>
          <FeatureIcon feature="send" size={16} />发送
        </button>
      </div>
    </form>
  );
}
