import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { mosaicProcessingError, mosaicStatusLabels, type MosaicStatus } from "../../gameMosaicStatus";
import type { UnityImage } from "../../unityOffline";
import { GameImageFilter, GameImageFilterOptions, GameImageListPagination, GameImageSplit, type GameImageFilters } from "../GameImageBrowserLayout";
import { SearchHighlight } from "../SearchHighlight";
import type { MosaicGroupMenu, RefineMovement, Result } from "./mosaicWorkbenchTypes";

export const mosaicStatusPageSize = 40;

type Props = {
  listId: string;
  filterMenu: RefObject<HTMLDivElement | null>;
  filters: { query: string; needle: string; scope: string; imageFilters: GameImageFilters; failuresOnly: boolean };
  onImageFiltersChange: (filters: GameImageFilters) => void;
  onQueryChange: (query: string) => void;
  onToggleFailureFilter: () => void;
  counts: { visible: number; checked: number; saved: number; failed: number };
  active?: UnityImage;
  groups: ReadonlyMap<MosaicStatus, readonly UnityImage[]>;
  ordered: readonly { id: MosaicStatus; image: UnityImage }[];
  refineChanges: ReadonlyMap<MosaicStatus, { added: number; removed: number }>;
  groupPages: Partial<Record<MosaicStatus, number>>;
  setGroupPages: Dispatch<SetStateAction<Partial<Record<MosaicStatus, number>>>>;
  collapsed: Partial<Record<MosaicStatus, boolean>>;
  setCollapsed: Dispatch<SetStateAction<Partial<Record<MosaicStatus, boolean>>>>;
  browseOriginals: boolean;
  setBrowseOriginals: (browse: boolean) => void;
  originalGallery: ReactNode;
  actionsDisabled: boolean;
  getRow: (image: UnityImage) => Result;
  draftChanges: (image: UnityImage) => { checked: boolean; mask: boolean };
  imageStatus: (image: UnityImage) => MosaicStatus;
  refineMovementFor: (row: Result) => RefineMovement | undefined;
  isRefineRetrying: (image: UnityImage) => boolean;
  selectPreview: (id: string) => void;
  setMosaicChecked: (images: readonly UnityImage[], checked: boolean) => void;
  groupMenu: MosaicGroupMenu | null;
  openGroupMenu: (event: ReactMouseEvent<HTMLElement>, key: string | undefined) => void;
  closeGroupMenu: () => void;
  deleteGroup: (key: string) => Promise<void>;
  children: ReactNode;
};

export function MosaicGroupTree({ listId, filterMenu, filters, onImageFiltersChange, onQueryChange,
  onToggleFailureFilter, counts, active, groups, ordered, refineChanges, groupPages, setGroupPages, collapsed, setCollapsed,
  browseOriginals, setBrowseOriginals, originalGallery, actionsDisabled, getRow, draftChanges, imageStatus, refineMovementFor,
  isRefineRetrying, selectPreview, setMosaicChecked, groupMenu, openGroupMenu, closeGroupMenu, deleteGroup, children }: Props) {
  const { query, needle, scope, imageFilters, failuresOnly } = filters;
  const listRef = useRef<HTMLUListElement>(null);
  const [keyboardTarget, setKeyboardTarget] = useState<string>();
  const groupMenuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [needle, scope, imageFilters]);
  useLayoutEffect(() => {
    if (!keyboardTarget) return;
    const button = listRef.current?.querySelector<HTMLButtonElement>(
      `button[data-mosaic-row="${CSS.escape(keyboardTarget)}"]`);
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest" });
    setKeyboardTarget(undefined);
  }, [keyboardTarget, groupPages, collapsed]);
  useEffect(() => {
    if (!groupMenu) return;
    const focused = document.activeElement;
    groupMenuRef.current?.querySelector("button")?.focus({ preventScroll: true });
    const close = closeGroupMenu;
    const outside = (event: Event) => {
      if (!groupMenuRef.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [groupMenu, closeGroupMenu]);

  function navigateList(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const element = event.target as HTMLElement;
    if (element.matches("input:not([type=checkbox]), select, textarea")) return;
    const summary = element.closest<HTMLElement>("summary[data-mosaic-status]");
    if (summary) {
      const status = summary.dataset.mosaicStatus as MosaicStatus;
      event.preventDefault();
      if (event.key === "ArrowLeft" || event.key === "ArrowRight")
        setCollapsed(previous => ({ ...previous, [status]: event.key === "ArrowLeft" }));
      else {
        const headings = [...listRef.current!.querySelectorAll<HTMLElement>("summary[data-mosaic-status]")];
        headings[Math.max(0, Math.min(headings.length - 1, headings.indexOf(summary) + (event.key === "ArrowUp" ? -1 : 1)))]?.focus();
      }
      return;
    }
    if (!ordered.length) return;
    event.preventDefault();
    const focused = element.closest<HTMLElement>("[data-mosaic-item]")?.dataset.mosaicItem;
    const index = ordered.findIndex(item => item.image.id === (focused || active?.id));
    let next = Math.max(0, index);
    if (index >= 0 && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      next = Math.max(0, Math.min(ordered.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
    } else if (index >= 0) {
      const status = ordered[index].id;
      const images = groups.get(status)!;
      const local = images.findIndex(image => image.id === ordered[index].image.id);
      const page = Math.min(groupPages[status] || 0, Math.ceil(images.length / mosaicStatusPageSize) - 1);
      const destination = page + (event.key === "ArrowLeft" ? -1 : 1);
      if (destination < 0 || destination * mosaicStatusPageSize >= images.length) return;
      const image = images[Math.min(images.length - 1, destination * mosaicStatusPageSize + local % mosaicStatusPageSize)];
      next = ordered.findIndex(item => item.image.id === image.id);
    }
    const { id: status, image } = ordered[next];
    const id = image.id;
    const local = groups.get(status)!.findIndex(item => item.id === id);
    setGroupPages(previous => ({ ...previous, [status]: Math.floor(local / mosaicStatusPageSize) }));
    selectPreview(id);
    setKeyboardTarget(id);
  }

  return <>
    <div className="unity-offline-toolbar unity-image-toolbar">
      <GameImageFilter menuRef={filterMenu}>
        <GameImageFilterOptions filters={imageFilters} onChange={onImageFiltersChange} doneHint="已采用去码图，含已纳入补丁的图片" />
      </GameImageFilter>
      <span className="unity-image-statistics">{counts.visible} 张图片 · 已勾选 {counts.checked} 张 · 已采用去码图 {counts.saved} 张</span>
      {(counts.failed > 0 || failuresOnly) && <button type="button" className="unity-btn game-mosaic-failed-filter"
        aria-pressed={failuresOnly} onClick={onToggleFailureFilter}>处理失败 · {counts.failed} 张</button>}
      <input type="search" aria-label="搜索去码图片" data-tooltip="搜索文件名和路径" placeholder="搜索" value={query}
        onChange={event => onQueryChange(event.target.value)} />
    </div>
    <GameImageSplit listId={listId} listLabel="去码图片列表" listClassName="game-mosaic-list" widthKey="game-mosaic-image-list-width" onListKeyDown={browseOriginals ? undefined : navigateList}
      list={<>
        <div className="game-mosaic-list-views" role="group" aria-label="左侧图片列表视图">
          <button type="button" className="unity-btn" aria-pressed={!browseOriginals} onClick={() => setBrowseOriginals(false)}>分组</button>
          <button type="button" className="unity-btn" aria-pressed={browseOriginals} onClick={() => setBrowseOriginals(true)}
            data-tooltip="浏览原图缩略图；Ctrl 或 Command 点击多选">浏览</button>
        </div>
        {browseOriginals ? originalGallery : <ul ref={listRef}>{[...groups].map(([id, items]) => {
          if (!items.length) return null;
          const label = mosaicStatusLabels[id];
          const pages = Math.ceil(items.length / mosaicStatusPageSize);
          const page = Math.min(groupPages[id] || 0, pages - 1);
          const checked = items.filter(image => getRow(image).checked).length;
          const delta = refineChanges.get(id);
          return <li key={id} className={`game-mosaic-status-group${id === "failed" ? " has-error" : ""}`}>
            <details className="unity-image-result-group" open={!collapsed[id]} onToggle={event => {
              const closed = !event.currentTarget.open;
              setCollapsed(previous => previous[id] === closed ? previous : { ...previous, [id]: closed });
            }}>
              <summary tabIndex={0} data-mosaic-status={id}><span>{label} · {items.length}</span>
                {delta && <span className="unity-image-change-counts">
                  {delta.added > 0 && <span className="is-added" title="复筛移入">+{delta.added}</span>}
                  {delta.removed > 0 && <span className="is-removed" title="复筛移出">−{delta.removed}</span>}
                </span>}
                <input type="checkbox" className="unity-image-group-check" aria-label={"全选：" + label}
                  disabled={actionsDisabled || !items.length} checked={!!items.length && checked === items.length}
                  ref={node => { if (node) node.indeterminate = checked > 0 && checked < items.length; }}
                  onClick={event => event.stopPropagation()} onChange={event => setMosaicChecked(items, event.target.checked)} />
              </summary>
            <ul>{!collapsed[id] && items.slice(page*mosaicStatusPageSize,(page+1)*mosaicStatusPageSize).map(image => {
                const row = getRow(image);
                const edited = draftChanges(image);
                const state = imageStatus(image);
                const status = mosaicStatusLabels[state] + (state === "candidate" || state === "refinedCandidate" ? ` · ${row.boxes.length} 区域` : "");
                const movement = refineMovementFor(row);
                const change = movement && movement.from !== movement.to
                  ? " · 复筛 " + mosaicStatusLabels[movement.from] + " → " + mosaicStatusLabels[movement.to] : "";
                const failure = mosaicProcessingError(row);
                const retrying = !!row.refineError && isRefineRetrying(image);
                const detail = `${image.width} × ${image.height} · ${retrying ? "重试中 · 上次" + failure : row.manualStatus ? [status, failure].filter(Boolean).join(" · ") : failure || status + change}`;
                return <li key={image.id} data-mosaic-item={image.id} className={`unity-image-item${image.id === active?.id ? " is-selected" : ""}${state === "failed" ? " has-error" : ""}${edited.checked ? " is-mosaic-check-draft" : ""}`}>
                  <input type="checkbox" aria-label={"勾选去码 " + image.name} checked={row.checked} disabled={actionsDisabled}
                    onChange={event => setMosaicChecked([image], event.target.checked)} />
                  <button type="button" data-mosaic-row={image.id} aria-current={image.id === active?.id || undefined} data-tooltip={image.file + "\n" + detail}
                    onClick={() => selectPreview(image.id)}
                    onContextMenu={event => openGroupMenu(event, row.group)}>
                    <strong><SearchHighlight text={image.name} query={needle} /></strong>
                    <small>{detail}</small>
                    {edited.mask && <span className="game-mosaic-mask-draft">蒙版变动</span>}
                  </button>
                </li>;
            })}</ul>
            {!collapsed[id] && <GameImageListPagination label={label+"列表分页"} page={page} pages={pages} onPage={page => setGroupPages(previous => ({...previous,[id]:page}))}/>}
            </details></li>;
        })}</ul>}
      </>}>
      {children}
    </GameImageSplit>
    {groupMenu && createPortal(<div ref={groupMenuRef} className="unity-gallery-menu" role="menu" aria-label="独立组操作"
      style={{ left: groupMenu.x, top: groupMenu.y }}>
      <button type="button" role="menuitem" onClick={() => void deleteGroup(groupMenu.group)}>删除独立组</button>
    </div>, document.body)}
  </>;
}
