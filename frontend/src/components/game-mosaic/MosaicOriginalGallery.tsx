import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type Ref, type SetStateAction } from "react";
import { mosaicStatusLabels, type MosaicStatus } from "../../gameMosaicStatus";
import type { UnityImage } from "../../unityOffline";
import { GameImageListPagination } from "../GameImageBrowserLayout";
import { SearchHighlight } from "../SearchHighlight";
import type { MosaicWorkbenchProps } from "./mosaicWorkbenchTypes";

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

const galleryColumns = 6;
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
  checked: (image: UnityImage) => boolean;
  status: (image: UnityImage) => MosaicStatus;
  draftChanges: (image: UnityImage) => { checked: boolean; mask: boolean };
  disabled: boolean;
  onPreview: (id: string) => void;
  onCheck: (images: readonly UnityImage[], checked: boolean) => void;
};

function arrowDestination(index: number, key: string, length: number): number | undefined {
  if (!length) return;
  if (index < 0) return 0;
  const column = index % galleryColumns;
  switch (key) {
    case "ArrowLeft": return (index + length - 1) % length;
    case "ArrowRight": return (index + 1) % length;
    case "ArrowUp": return index >= galleryColumns ? index - galleryColumns
      : column + Math.floor((length - 1 - column) / galleryColumns) * galleryColumns;
    case "ArrowDown": return index + galleryColumns < length ? index + galleryColumns : column;
    default: return undefined;
  }
}

export function MosaicOriginalGallery({ images, navigationRef, activeId, page, onPage, selectedIds, setSelectedIds,
  query, read, checked, status, draftChanges, disabled, onPreview, onCheck }: Props) {
  const [focusId, setFocusId] = useState<string>();
  const grid = useRef<HTMLUListElement>(null);
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

  function changePage(next: number) {
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
    } else {
      const next = arrowDestination(index, event.key, visible.length);
      if (next === undefined) return;
      nextImage = visible[next];
    }
    if (!nextImage) return;
    selectImage(nextImage.id);
    setFocusId(nextImage.id);
  }

  useImperativeHandle(navigationRef, () => navigateGallery);

  return <section className="game-mosaic-original-browser" aria-label="原图批量浏览" tabIndex={0} onKeyDown={navigateGallery}>
    <div className="game-mosaic-original-browser-controls">
      <div className="game-mosaic-original-selection">
        <span role="status">选中 {chosen.length} 张</span>
        <button type="button" className="unity-btn" disabled={!visible.length}
          onClick={selectPage}>全选本页</button>
        <button type="button" className="unity-btn" disabled={disabled || !chosen.length}
          onClick={() => onCheck(chosen, true)}>批量勾选</button>
        <button type="button" className="unity-btn" disabled={disabled || !chosen.length}
          onClick={() => onCheck(chosen, false)}>批量取消勾选</button>
      </div>
    </div>
    <ul ref={grid} className="game-mosaic-original-grid" style={{ gridTemplateColumns: `repeat(${galleryColumns}, minmax(0, 1fr))` }}>
      {visible.map(image => {
        const change = draftChanges(image);
        const label = mosaicStatusLabels[status(image)];
        return <li key={image.id} data-mosaic-gallery-item={image.id}>
          <label className="game-mosaic-original-check">
            <input type="checkbox" aria-label={"勾选去码 " + image.name} checked={checked(image)} disabled={disabled}
              onChange={event => onCheck([image], event.target.checked)} />
          </label>
          <button type="button" className={"game-mosaic-original-tile" + (change.checked ? " is-mosaic-check-draft" : "")}
            data-mosaic-gallery-tile={image.id}
            aria-pressed={selectedIds.has(image.id)} aria-current={image.id === activeId || undefined}
            data-tooltip={image.file + "\n" + image.width + " × " + image.height + " · " + label}
            onClick={event => selectImage(image.id, event.ctrlKey || event.metaKey)}>
            <MosaicOriginalThumbnail image={image} read={read} />
            <strong><SearchHighlight text={image.name} query={query} /></strong>
            <small>{image.width} × {image.height}</small>
            <small className="game-mosaic-original-status">{label}</small>
            {change.mask && <span className="game-mosaic-mask-draft">蒙版变动</span>}
          </button>
        </li>;
      })}
      {!visible.length && <li className="hint game-mosaic-original-empty">没有符合筛选条件的图片。</li>}
    </ul>
    <GameImageListPagination label="原图分页" page={currentPage} pages={pages} onPage={changePage} />
  </section>;
}
