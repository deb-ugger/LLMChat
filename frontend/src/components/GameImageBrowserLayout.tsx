import { getLayoutRect, getLayoutViewport } from "../viewportLayout";
import { useId, useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type KeyboardEventHandler, type ReactNode, type Ref, type RefObject } from "react";
import { createPortal } from "react-dom";
import { usePersistedWidth } from "../hooks/usePersistedWidth";
import { GamePageNumber } from "./GamePageNumber";

export function GameImageSplit({ listId, listRef, listLabel, listClassName, widthKey, onListKeyDown, list, children }: {
  listId: string;
  listRef?: Ref<HTMLDivElement>;
  listLabel: string;
  listClassName?: string;
  widthKey: string;
  onListKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  list: ReactNode;
  children: ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [bodyWidth, setBodyWidth] = useState(0);
  const maxWidth = bodyWidth > 0 ? Math.min(520, Math.floor(bodyWidth * .5)) : 520;
  const minWidth = Math.min(136, maxWidth);
  const listWidth = usePersistedWidth(widthKey, 180, minWidth, maxWidth, "guide");
  useLayoutEffect(() => {
    const element = body.current!;
    const update = () => { if (element.clientWidth > 0) setBodyWidth(element.clientWidth); };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div ref={body} className="unity-image-body">
    {list != null && <>
      <div id={listId} ref={listRef} className={`unity-image-list${listClassName ? " " + listClassName : ""}`}
        style={{ width: listWidth.width }} aria-label={listLabel} tabIndex={onListKeyDown ? 0 : undefined} onKeyDown={onListKeyDown}>
        {list}
      </div>
      <button type="button" role="separator" aria-orientation="vertical" aria-controls={listId} aria-label="调整图片列表宽度"
        aria-valuemin={minWidth} aria-valuemax={maxWidth} aria-valuenow={Math.round(listWidth.width)}
        className="unity-image-list-divider" data-tooltip="拖动调整图片列表宽度"
        onMouseDown={event => listWidth.beginResize(event, "grow-right")} onKeyDown={event => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            listWidth.setWidth(listWidth.width + (event.key === "ArrowRight" ? 16 : -16));
          }
        }} />
    </>}
    {children}
  </div>;
}

export function GameImageListPagination({ label, page, pages, onPage }: {
  label: string; page: number; pages: number; onPage: (page: number) => void;
}) {
  return pages > 1 && <nav className="unity-image-list-pages" aria-label={label}>
    <button type="button" disabled={page === 0} onClick={() => onPage(page - 1)}>上一页</button>
    <GamePageNumber page={page} pages={pages} onPage={onPage} />
    <button type="button" disabled={page === pages - 1} onClick={() => onPage(page + 1)}>下一页</button>
  </nav>;
}

export function GameImageFilter({ menuRef, children }: { menuRef: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  const id = useId();
  return <>
    <button type="button" className="unity-image-filter-trigger" aria-label="筛选图片" aria-controls={id}
      aria-haspopup="dialog" data-tooltip="筛选图片" onClick={event => {
        const menu = menuRef.current!;
        if (menu.matches(":popover-open")) { menu.hidePopover(); return; }
        const viewport = getLayoutViewport();
        const rect = getLayoutRect(event.currentTarget.getBoundingClientRect(), viewport.scale);
        menu.showPopover();
        menu.style.left = `${Math.max(8, Math.min(rect.left, viewport.width - menu.offsetWidth - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(rect.bottom + 6, viewport.height - menu.offsetHeight - 8))}px`;
      }}>
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M3 5h18l-7 8v6l-4 2v-8z" />
      </svg>
    </button>
    {createPortal(<div ref={menuRef} id={id} popover="auto" role="dialog" aria-label="图片筛选" className="unity-image-filter-menu">
      {children}
    </div>, document.body)}
  </>;
}

export function GameImagePreviewFrame({ caption, fallback, children, ...props }: ComponentPropsWithRef<"figure"> & {
  caption?: ReactNode; fallback?: ReactNode;
}) {
  return <figure {...props}>
    {caption && <figcaption>{caption}</figcaption>}
    {children ? <div className="unity-image-preview-surface">{children}</div> : fallback}
  </figure>;
}
