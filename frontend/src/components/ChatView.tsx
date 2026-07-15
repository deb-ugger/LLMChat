import { useEffect, useRef, useState } from "react";
import type { ChatMessage, Conversation } from "../api";
import { RichText } from "./RichText";

type Props = {
  conversation: Conversation | null;
  messages: ChatMessage[];
  hiddenCount: number;
  sending: boolean;
  onSend: (text: string) => void;
  onLoadEarlier: () => void;
};

export function ChatView({
  conversation,
  messages,
  hiddenCount,
  sending,
  onSend,
  onLoadEarlier,
}: Props) {
  const [text, setText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, sending]);

  const empty = !conversation || conversation.messages.length === 0;

  const submit = () => {
    if (!text.trim() || sending) return;
    onSend(text);
    setText("");
  };

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
              const prevHeight = el.scrollHeight;
              onLoadEarlier();
              requestAnimationFrame(() => {
                el.scrollTop = el.scrollHeight - prevHeight;
              });
            }
          }}
        >
          {hiddenCount > 0 && (
            <button className="load-earlier" onClick={onLoadEarlier}>
              加载更早的 {Math.min(hiddenCount, 30)} 条消息
            </button>
          )}
          {messages.map((m, i) => (
            <div
              key={`${i}-${m.role}-${m.content.slice(0, 12)}`}
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
    </section>
  );
}
