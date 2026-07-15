import type { ConversationSummary } from "../api";

type Props = {
  conversations: ConversationSummary[];
  currentId?: string;
  search: string;
  onSearchChange: (v: string) => void;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
};

export function Sidebar({
  conversations,
  currentId,
  search,
  onSearchChange,
  onNewChat,
  onSelect,
  onDelete,
}: Props) {
  const filtered = conversations.filter((c) =>
    c.title.toLowerCase().includes(search.trim().toLowerCase()),
  );

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
            onClick={() => onSelect(c.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              if (window.confirm(`删除对话「${c.title}」？`)) {
                onDelete(c.id);
              }
            }}
            title={c.title}
          >
            {c.title}
          </li>
        ))}
      </ul>
    </aside>
  );
}
