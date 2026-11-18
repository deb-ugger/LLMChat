import { useState } from "react";

export function GamePageNumber({ page, pages, onPage }: { page: number; pages: number; onPage: (page: number) => void }) {
  const [draft, setDraft] = useState<{ page: number; pages: number; value: string }>();
  const current = Math.min(Math.max(0, page), pages - 1);
  const value = draft?.page === current && draft.pages === pages ? draft.value : String(current + 1);

  return <span className="game-page-number">
    <input type="text" inputMode="numeric" aria-label="当前页码" data-tooltip="输入页码，按 Enter 跳转"
      disabled={pages <= 1} value={value} style={{ width: `${Math.max(1, String(pages).length)}ch` }}
      onFocus={event => event.currentTarget.select()}
      onChange={event => setDraft({ page: current, pages, value: event.currentTarget.value })}
      onBlur={() => setDraft(undefined)}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.key !== "Enter" && event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Enter") {
          const entered = event.currentTarget.value.trim().normalize("NFKC");
          const requested = Number(entered);
          if (/^\d+$/.test(entered) && Number.isSafeInteger(requested)) onPage(Math.max(0, Math.min(pages - 1, requested - 1)));
        }
        event.currentTarget.blur();
      }} />
    <span> / {pages}</span>
  </span>;
}
