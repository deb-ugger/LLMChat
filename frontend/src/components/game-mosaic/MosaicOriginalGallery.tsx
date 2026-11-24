import { createContext, useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type Ref, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { mosaicStatusLabels, type MosaicStatus } from "../../gameMosaicStatus";
import type { UnityImage } from "../../unityOffline";
import { getFixedMenuPoint } from "../../viewportLayout";
import { GameImageListPagination } from "../GameImageBrowserLayout";
import { SearchHighlight } from "../SearchHighlight";
import { MosaicImageBadges } from "./MosaicImageBadges";
import type { MosaicWorkbenchProps, Result } from "./mosaicWorkbenchTypes";

function MosaicOriginalThumbnail({ image, read }: { image: UnityImage; read: MosaicWorkbenchProps["read"] }) {
  const thumbnail = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"waiting" | "ready" | "error">("waiting");

  useEffect(() => {
    const canvas = thumbnail.current!;
    const controller = new AbortController();
    setState("waiting");

    async function load() {
      try {
        const blob = await read(image, controller.signal);
        if (controller.signal.aborted) return;
        const scale = Math.min(1, 180 / Math.max(image.width, image.height));
        const bitmap = await createImageBitmap(blob, {
          resizeWidth: Math.max(1, Math.round(image.width * scale)),
          resizeHeight: Math.max(1, Math.round(image.height * scale)),
        });
        try {
          if (controller.signal.aborted) return;
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
          setState("ready");
        } finally { bitmap.close(); }
      } catch {
        if (!controller.signal.aborted) setState("error");
      }
    }

    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void load();
    });
    observer.observe(canvas.parentElement!);
    return () => { observer.disconnect(); controller.abort(); };
  }, [image, read]);

  return <span className="game-mosaic-original-thumbnail">
    <canvas ref={thumbnail} aria-hidden="true" hidden={state !== "ready"} />
    {state === "error" && <span>缩略图无法读取</span>}
  </span>;
}

export const mosaicGalleryPageSize = 24;

type Props = {
  images: readonly UnityImage[];
  navigationRef: Ref<(event: ReactKeyboardEvent<HTMLElement>) => void>;
  activeId?: string;
  page: number;
  onPage: (page: number) => void;
  selectedIds: ReadonlySet<string>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  query: string;
  read: MosaicWorkbenchProps["read"];
  getRow: (image: UnityImage) => Result;
  isAdopted: (image: UnityImage) => boolean;
  status: (image: UnityImage) => MosaicStatus;
  draftChanges: (image: UnityImage) => { checked: boolean; mask: boolean };
  disabled: boolean;
  onPreview: (id: string) => void;
  onCheck: (images: readonly UnityImage[], checked: boolean) => void;
  hasDraft: (image: UnityImage) => boolean;
  onDiscard: (image: UnityImage) => void;
};

function arrowDestination(index: number, key: string, length: number, columns: number): number | undefined {
  if (!length) return;
  if (index < 0) return 0;
  const column = index % columns;
  switch (key) {
    case "ArrowLeft": return (index + length - 1) % length;
    case "ArrowRight": return index + 1;
    case "ArrowUp": return index >= columns ? index - columns
      : column + Math.floor((length - 1 - column) / columns) * columns;
    case "ArrowDown": return index + columns < length ? index + columns : column;
    default: return undefined;
  }
}

export const MosaicOriginalSelectionTarget = createContext<HTMLDivElement | null>(null);

export function MosaicOriginalGallery({ images, navigationRef, activeId, page, onPage, selectedIds, setSelectedIds,
  query, read, getRow, isAdopted, status, draftChanges, disabled, onPreview, onCheck, hasDraft, onDiscard }: Props) {
  const [focusId, setFocusId] = useState<string>();
  const [menu, setMenu] = useState<{ id: string; sourceHash: string; x: number; y: number }>();
  const menuRef = useRef<HTMLDivElement>(null);
  const gallery = useRef<HTMLElement>(null);
  const grid = useRef<HTMLUListElement>(null);
  const selectionTarget = useContext(MosaicOriginalSelectionTarget);
  const pages = Math.max(1, Math.ceil(images.length / mosaicGalleryPageSize));
  const currentPage = Math.min(page, pages - 1);
  const visible = images.slice(currentPage * mosaicGalleryPageSize, (currentPage + 1) * mosaicGalleryPageSize);
  const chosen = images.filter(image => selectedIds.has(image.id));
  const selectPage = () => setSelectedIds(new Set(visible.map(image => image.id)));

  useLayoutEffect(() => {
    if (!focusId) return;
    const tile = grid.current?.querySelector<HTMLButtonElement>(`button[data-mosaic-gallery-tile="${CSS.escape(focusId)}"]`);
    tile?.focus({ preventScroll: true });
    tile?.scrollIntoView({ block: "nearest", inline: "nearest" });
    setFocusId(undefined);
  }, [focusId, currentPage]);

  const menuImage = menu && visible.find(image => image.id === menu.id && image.sourceHash === menu.sourceHash);
  useEffect(() => {
    if (!menuImage) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenu(undefined);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenu(undefined);
      setFocusId(menuImage.id);
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", escape);
    };
  }, [menuImage]);

  function changePage(next: number) {
    setMenu(undefined);
    onPage(next);
    if (grid.current) grid.current.scrollTop = 0;
  }

  function selectImage(id: string, additive = false) {
    setSelectedIds(previous => {
      if (!additive) return new Set([id]);
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    onPreview(id);
  }

  function navigateGallery(event: ReactKeyboardEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("input:not([type=checkbox]), select, textarea, [contenteditable]")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectPage();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || !visible.length) return;
    const paging = event.key === "PageUp" || event.key === "PageDown";
    if (!paging && !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;

    event.preventDefault();
    const focused = target.closest<HTMLElement>("[data-mosaic-gallery-item]")?.dataset.mosaicGalleryItem;
    const index = visible.findIndex(image => image.id === (focused ?? activeId));
    let nextImage: UnityImage | undefined;
    if (paging) {
      const nextPage = currentPage + (event.key === "PageUp" ? -1 : 1);
      if (nextPage < 0 || nextPage >= pages) return;
      const start = nextPage * mosaicGalleryPageSize;
      const last = Math.min(start + mosaicGalleryPageSize, images.length) - 1;
      nextImage = images[Math.min(start + Math.max(0, index), last)];
      changePage(nextPage);
    } else if (event.key === "ArrowRight" && index === visible.length - 1) {
      const nextPage = currentPage + 1;
      if (nextPage >= pages) return;
      nextImage = images[nextPage * mosaicGalleryPageSize];
      changePage(nextPage);
    } else {
      const columns = getComputedStyle(grid.current!).gridTemplateColumns.split(" ").length;
      const next = arrowDestination(index, event.key, visible.length, columns);
      if (next === undefined) return;
      nextImage = visible[next];
    }
    if (!nextImage) return;
    selectImage(nextImage.id);
    setFocusId(nextImage.id);
  }

  useImperativeHandle(navigationRef, () => navigateGallery);

  const selection = chosen.length > 0 && <div className="game-mosaic-original-selection" role="group" aria-label="已选图片操作">
    <span role="status">选中 {chosen.length} 张</span>
    <div className="game-mosaic-original-selection-actions">
      <button type="button" className="unity-btn" disabled={disabled}
        onClick={() => onCheck(chosen, true)}>勾选</button>
      <button type="button" className="unity-btn" disabled={disabled}
        onClick={() => onCheck(chosen, false)}>取消勾选</button>
      <button type="button" className="unity-btn game-mosaic-selection-text" disabled={!visible.length}
        onClick={selectPage}>全选本页</button>
      <button type="button" className="unity-btn game-mosaic-selection-text" onClick={() => {
        setSelectedIds(new Set());
        gallery.current?.focus({ preventScroll: true });
      }}>清空选择</button>
    </div>
  </div>;

  return <section ref={gallery} className="game-mosaic-original-browser" aria-label="原图批量浏览" tabIndex={0} onKeyDown={navigateGallery}>
    {selection && (selectionTarget ? createPortal(selection, selectionTarget) : selection)}
    <ul ref={grid} className="game-mosaic-original-grid">
      {visible.map(image => {
        const row = getRow(image);
        const change = draftChanges(image);
        const state = status(image);
        const label = mosaicStatusLabels[state];
        return <li key={image.id} data-mosaic-gallery-item={image.id}>
          <label className="game-mosaic-original-check">
            <input type="checkbox" aria-label={"勾选去码 " + image.name} checked={row.checked} disabled={disabled}
              onChange={event => onCheck([image], event.target.checked)} />
          </label>
          <button type="button" className={"game-mosaic-original-tile" + (change.checked ? " is-mosaic-check-draft" : "")}
            onContextMenu={event => {
              event.preventDefault();
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              const x = event.clientX || event.clientY ? event.clientX : rect.left;
              const y = event.clientX || event.clientY ? event.clientY : rect.bottom;
              setMenu({ id: image.id, sourceHash: image.sourceHash, ...getFixedMenuPoint(x, y, 166, 55) });
            }}
            data-mosaic-gallery-tile={image.id}
            aria-pressed={selectedIds.has(image.id)} aria-current={image.id === activeId || undefined}
            data-tooltip={image.file + "\n" + image.width + " × " + image.height + " · " + label}
            onClick={event => selectImage(image.id, event.ctrlKey || event.metaKey)}>
            <MosaicOriginalThumbnail image={image} read={read} />
            <span className="game-mosaic-image-heading">
              <strong><SearchHighlight text={image.name} query={query} /></strong>
              <MosaicImageBadges adopted={isAdopted(image)} reference={!!(row.saved && row.reference)} />
            </span>
            <small>{image.width} × {image.height}</small>
            {state !== "confirmed" && <small className="game-mosaic-original-status">{label}</small>}
            {change.mask && <span className="game-mosaic-mask-draft">蒙版变动</span>}
          </button>
        </li>;
      })}
      {!visible.length && <li className="hint game-mosaic-original-empty">没有符合筛选条件的图片。</li>}
    </ul>
    <GameImageListPagination label="原图分页" page={currentPage} pages={pages} onPage={changePage} />
    {menu && menuImage && createPortal(<div ref={menuRef} className="unity-gallery-menu" role="menu"
      aria-label={"图片操作 " + menuImage.name} style={{ left: menu.x, top: menu.y }}>
      <button type="button" role="menuitem" disabled={disabled || !hasDraft(menuImage)} onClick={() => {
        setMenu(undefined);
        onDiscard(menuImage);
        setFocusId(menuImage.id);
      }}>撤销改动</button>
    </div>, document.body)}
  </section>;
}
