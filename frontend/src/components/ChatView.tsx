import { useEffect, useRef, useState } from "react";
import type { ChatMessage, Conversation } from "../api";
import { RichText } from "./RichText";

type Props = {
  conversation: Conversation | null;
  messages: ChatMessage[];
  hiddenCount: number;
  sending: boolean;
  onSend: (text: string) => void;
  onLoadEarlier: () => Promise<void>;
};

export function ChatView({
  conversation,
  messages,
  hiddenCount,
  sending,
  onSend,
  onLoadEarlier,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previousPosition = useRef({ id: conversation?.id, hiddenCount });
  const loadingEarlier = useRef(false);
  const loadEarlier = async () => {
    if (loadingEarlier.current) return;
    loadingEarlier.current = true;
    const list = listRef.current, height = list?.scrollHeight ?? 0;
    try { await onLoadEarlier(); }
    finally { requestAnimationFrame(() => { if (list) list.scrollTop = list.scrollHeight - height; loadingEarlier.current = false; }); }
  };

  useEffect(() => {
    const previous = previousPosition.current;
    if (previous.id !== conversation?.id || hiddenCount >= previous.hiddenCount) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    previousPosition.current = { id: conversation?.id, hiddenCount };
  }, [messages.length, sending, conversation?.id, hiddenCount]);

  const empty = !conversation || conversation.messages.length === 0;

  return (
    <section className="chat-panel">
      {!empty && (
        <header className="chat-title">
          {conversation?.title || "新对话"}
        </header>
      )}

      {empty ? (
        <div className="empty-state">
          <h2>今天有什么计划？</h2>
          <p>在下方输入消息开始对话</p>
        </div>
      ) : (
        <div
          className="message-list"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollTop < 24 && hiddenCount > 0) {
              void loadEarlier();
            }
          }}
        >
          {hiddenCount > 0 && (
            <button className="load-earlier" onClick={() => void loadEarlier()}>
              加载更早的 {Math.min(hiddenCount, 30)} 条消息
            </button>
          )}
          {messages.map((m, i) => (
            <div
              key={`${conversation?.id}-${hiddenCount + i}-${m.role}`}
              className={m.role === "user" ? "bubble user" : "bubble ai"}
            >
              <RichText
                content={m.content}
                variant={m.role === "user" ? "user" : "ai"}
              />
            </div>
          ))}
          {sending && <div className="bubble ai thinking">思考中…</div>}
          <div ref={bottomRef} />
        </div>
      )}

      <ChatComposer sending={sending} onSend={onSend} />
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
    <div className="input-panel">
      <textarea
        className="input-box"
        placeholder="支持 Markdown / LaTeX；$公式$、$$公式$$、Enter 发送"
        value={text}
        disabled={sending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={3}
      />
      <div className="input-actions">
        <button
          className="send-btn"
          disabled={sending || !text.trim()}
          onClick={submit}
        >
          发送
        </button>
      </div>
    </div>
  );
}
