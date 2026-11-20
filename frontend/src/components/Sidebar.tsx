import { getFixedMenuPoint } from "../viewportLayout";
import { showAppNotice } from "./AppNotice";
import { useEffect, useRef, useState } from "react";
import type { ConversationSummary } from "../api";
import { FeatureIcon } from "./FeatureIcon";

type Props = {
  conversations: ConversationSummary[];
  currentId?: string;
  search: string;
  onSearchChange: (v: string) => void;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
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
  const query = search.trim().toLowerCase();
  const filtered = conversations.filter(c => c.title.toLowerCase().includes(query));

  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
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
      if (menuRef.current?.contains(e.target as Node) || (e.target instanceof Element && e.target.closest(".conv-more"))) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        menuButton.current?.focus();
        setMenu(null);
      }
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
    setRenameSaving(true);
    try {
      if (next && next !== prev) {
        await onRename(id, next);
      }
      setRenamingId(null);
      setRenameDraft("");
    } catch (e) {
      showAppNotice(e instanceof Error ? e.message : "重命名失败", "error");
    } finally {
      committingRef.current = false;
      setRenameSaving(false);
    }
  };

  const showMenu = (conversation: ConversationSummary, x: number, y: number) => {
    setMenu({
      id: conversation.id,
      title: conversation.title,
      ...getFixedMenuPoint(x, y, 146, 88, 4),
    });
  };

  return (
    <aside id="chat-conversations" className="sidebar" aria-label="对话记录">
      <button type="button" className="new-chat-btn" onClick={onNewChat}>
        <FeatureIcon feature="new-chat" />新建对话
      </button>
      <label className="chat-search">
        <FeatureIcon feature="search" size={16} />
        <input type="search" aria-label="搜索对话" placeholder="搜索对话"
          value={search} onChange={(e) => onSearchChange(e.target.value)} />
      </label>
      <h2 className="recent-label">对话记录</h2>
      {filtered.length === 0 && <p className="chat-history-empty">{query ? "没有匹配的对话" : "暂无对话"}</p>}
      <ul className="conv-list" aria-label="对话列表">
        {filtered.map((c) => (
          <li
            key={c.id}
            className={c.id === currentId ? "conv-item active" : "conv-item"}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (c.id !== renamingId) {
                menuButton.current = null;
                showMenu(c, e.clientX, e.clientY);
              }
            }}
          >
            {renamingId === c.id ? (
              <input
                ref={renameInputRef}
                className="conv-rename-input"
                aria-label="对话名称"
                value={renameDraft}
                readOnly={renameSaving}
                aria-busy={renameSaving}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitRename();
                  }
                  if (e.key === "Escape" && !committingRef.current) {
                    e.preventDefault();
                    setRenamingId(null);
                    setRenameDraft("");
                  }
                }}
                onBlur={() => void commitRename()}
              />
            ) : (
              <>
                <button type="button" className="conv-select" aria-current={c.id === currentId ? "true" : undefined}
                  data-tooltip={c.title} onClick={() => onSelect(c.id)}>{c.title}</button>
                <button type="button" className="chat-icon-button conv-more" aria-label={`${c.title}的操作`}
                  aria-haspopup="menu" aria-expanded={menu?.id === c.id} data-tooltip="对话操作"
                  onClick={(event) => {
                    if (menu?.id === c.id) {
                      setMenu(null);
                      return;
                    }
                    menuButton.current = event.currentTarget;
                    const target = event.currentTarget.getBoundingClientRect();
                    showMenu(c, target.right, target.top);
                  }}><FeatureIcon feature="more" size={16} /></button>
              </>
            )}
          </li>
        ))}
      </ul>

      {menu && (
        <div
          ref={menuRef}
          className="conv-context-menu"
          aria-label="对话操作"
          style={{ top: menu.y, left: menu.x }}
          role="menu"
        >
          <button
            type="button"
            className="conv-context-item"
            role="menuitem"
            autoFocus
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (committingRef.current) return;
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
