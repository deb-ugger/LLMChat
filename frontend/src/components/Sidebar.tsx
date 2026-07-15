import { useEffect, useRef, useState } from "react";
import type { ConversationSummary } from "../api";

type Props = {
  conversations: ConversationSummary[];
  currentId?: string;
  search: string;
  onSearchChange: (v: string) => void;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void | Promise<void>;
};

type ContextMenuState = {
  id: string;
  title: string;
  x: number;
  y: number;
};

export function Sidebar({
  conversations,
  currentId,
  search,
  onSearchChange,
  onNewChat,
  onSelect,
  onDelete,
  onRename,
}: Props) {
  const filtered = conversations.filter((c) =>
    c.title.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const committingRef = useRef(false);

  useEffect(() => {
    if (renamingId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingId]);

  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const commitRename = async () => {
    if (committingRef.current) return;
    const id = renamingId;
    if (!id) return;
    committingRef.current = true;
    const next = renameDraft.trim();
    const prev = conversations.find((c) => c.id === id)?.title ?? "";
    setRenamingId(null);
    setRenameDraft("");
    try {
      if (next && next !== prev) {
        await onRename(id, next);
      }
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "重命名失败");
    } finally {
      committingRef.current = false;
    }
  };

  return (
    <aside className="sidebar">
      <button className="new-chat-btn" onClick={onNewChat}>
        新聊天
      </button>
      <input
        className="search-box"
        placeholder="搜索聊天"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
      />
      <div className="recent-label">最近</div>
      <ul className="conv-list">
        {filtered.map((c) => (
          <li
            key={c.id}
            className={c.id === currentId ? "conv-item active" : "conv-item"}
            onClick={() => {
              if (renamingId === c.id) return;
              onSelect(c.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setRenamingId(null);
              setMenu({
                id: c.id,
                title: c.title,
                x: e.clientX,
                y: e.clientY,
              });
            }}
            title={c.title}
          >
            {renamingId === c.id ? (
              <input
                ref={renameInputRef}
                className="conv-rename-input"
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitRename();
                  }
                  if (e.key === "Escape") {
                    setRenamingId(null);
                    setRenameDraft("");
                  }
                }}
                onBlur={() => void commitRename()}
              />
            ) : (
              c.title
            )}
          </li>
        ))}
      </ul>

      {menu && (
        <div
          ref={menuRef}
          className="conv-context-menu"
          style={{ top: menu.y, left: menu.x }}
          role="menu"
        >
          <button
            type="button"
            className="conv-context-item"
            role="menuitem"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setRenameDraft(menu.title);
              setRenamingId(menu.id);
              setMenu(null);
            }}
          >
            重命名
          </button>
          <button
            type="button"
            className="conv-context-item danger"
            role="menuitem"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const { id, title } = menu;
              setMenu(null);
              if (window.confirm(`删除对话「${title}」？`)) {
                onDelete(id);
              }
            }}
          >
            删除
          </button>
        </div>
      )}
    </aside>
  );
}
