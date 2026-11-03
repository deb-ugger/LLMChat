import {
useCallback,
useEffect,
useLayoutEffect,
useMemo,
useRef,
useState,
type ButtonHTMLAttributes,
type MouseEvent as ReactMouseEvent,
type PointerEvent as ReactPointerEvent
} from "react";
export type OcrBlock = {
  id: string;
  pageId: string;
  text: string;
  translation: string;
  status: "idle" | "pending" | "done" | "error";
  /** normalized 0–1 relative to image */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Source text is primarily vertical (used to fit translated overlays). */
  vertical?: boolean;
};

function OcrMetrics({ count, milliseconds, text, busy, failed, total = false }: {
  count: number; milliseconds: number; text: string; busy: boolean; failed: boolean; total?: boolean;
}) {
  const displayText = text.replace(/^(.+?) 识别到 \d+ 段文字$/, "$1 · 识别完成");
  return <span className={`ocr-metrics${total ? " is-total" : ""}`}>
    <span className="ocr-metric"><span>{total ? "累计段数" : "识别段数"}</span><strong>{count}</strong><small>段</small></span>
    <span className="ocr-metric"><span>{total ? "累计用时" : "页面用时"}</span><strong>{(milliseconds / 1000).toFixed(1)}</strong><small>秒</small></span>
    <span className={`ocr-metric-state ${failed ? "is-error" : busy ? "is-working" : "is-ready"}`} title={displayText}>
      <i aria-hidden="true" />{displayText}
    </span>
  </span>;
}

type OcrPage = {
  elapsedMs?: number;
  recognitionMs?: number;
  id: string;
  imageUrl: string;
  label: string;
  /** Original file retained for an explicit re-recognition request. */
  file: File;
  blocks: OcrBlock[];
  statusText: string | null;
  error: string | null;
  busy: boolean;
};

type OcrSelectionField = "source" | "translation";

type OcrResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

function formatOverlayText(text: string, boxWpx: number, boxHpx: number): string {
  const t = text.trim();
  if (!t) return t;
  if (boxHpx < boxWpx * 0.4) return t;
  return t
    .replace(/\s*([。；;！？!?])\s*/g, "$1\n")
    .replace(/\n+/g, "\n")
    .trim();
}

function overlayFontSize(boxWpx: number, boxHpx: number, text: string): number {
  if (boxWpx <= 0 || boxHpx <= 0) return 10;
  const lineHeight = 1.2;
  const charEm = 0.95;
  // Match the overlay's border and horizontal padding so calculated wrapping
  // is the same as the text that is actually painted on the image.
  const availW = Math.max(8, boxWpx - 8);
  const availH = Math.max(8, boxHpx - 2);
  const segments = text
    .split(/\n/)
    .map((s) => s.replace(/\s+/g, ""))
    .filter(Boolean);
  const parts = segments.length ? segments : [""];

  const fits = (fontPx: number) => {
    let lines = 0;
    for (const seg of parts) {
      const chars = Math.max(1, Array.from(seg).length);
      const charsPerLine = Math.max(1, Math.floor(availW / (fontPx * charEm)));
      lines += Math.ceil(chars / charsPerLine);
    }
    return lines * fontPx * lineHeight <= availH;
  };

  let lo = 7;
  // Paragraph translations become visually dominant if a two-line OCR box is
  // treated as one very tall line. Short labels may remain large; prose is
  // capped to the surrounding document's typical reading size.
  const proseCap = Array.from(text.replace(/\s+/g, "")).length >= 12 ? 26 : 56;
  let hi = Math.min(availH * 0.9, proseCap);
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return Math.max(7, +lo.toFixed(1));
}

function FittedOcrOverlay({
  rawLabel, boxWidth, boxHeight, style, ...buttonProps
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  rawLabel: string; boxWidth: number; boxHeight: number;
}) {
  const boxRef = useRef<HTMLButtonElement>(null);
  const label = useMemo(
    () => formatOverlayText(rawLabel, boxWidth, boxHeight),
    [rawLabel, boxWidth, boxHeight],
  );
  const maximum = useMemo(
    () => label ? overlayFontSize(boxWidth, boxHeight, label) : Math.max(8, boxHeight * 0.75),
    [label, boxWidth, boxHeight],
  );
  const writingMode = style?.writingMode;
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || boxWidth <= 0 || boxHeight <= 0) return;
    const fits = () =>
      box.scrollHeight <= box.clientHeight + 1 &&
      box.scrollWidth <= box.clientWidth + 1;
    box.style.fontSize = `${maximum}px`;
    if (fits()) return;
    let low = 5, high = maximum;
    box.style.fontSize = `${low}px`;
    if (!fits()) return;
    for (let i = 0; i < 12; i += 1) {
      const mid = (low + high) / 2;
      box.style.fontSize = `${mid}px`;
      if (fits()) low = mid;
      else high = mid;
    }
    box.style.fontSize = `${Math.max(5, low - 0.2).toFixed(1)}px`;
  }, [label, maximum, boxWidth, boxHeight, writingMode]);
  return <button {...buttonProps} ref={boxRef} style={{
    ...style,
    fontSize: `${maximum.toFixed(1)}px`,
    lineHeight: 1.2,
    whiteSpace: label.includes("\n") ? "pre-wrap" : "normal",
  }}>{label}</button>;
}

function OcrPageCard({
  page,
  index,
  selected,
  selectedBlockId,
  selectedField,
  showTranslation,
  onSelectPage,
  onSelectBlock,
  onRerun,
  onContextMenu,
}: {
  page: OcrPage;
  index: number;
  selected: boolean;
  selectedBlockId: string | null;
  selectedField: OcrSelectionField | null;
  showTranslation: boolean;
  onSelectPage: () => void;
  onSelectBlock: (id: string, field: OcrSelectionField) => void;
  onRerun: () => void;
  onContextMenu: (e: ReactMouseEvent, pageId: string) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [baseImageWidth, setBaseImageWidth] = useState<number | null>(null);
  const [imageScale, setImageScale] = useState(1);
  const [imageResizing, setImageResizing] = useState(false);
  const [draggedOverlay, setDraggedOverlay] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const initializedImageRef = useRef<string | null>(null);

  const beginOverlayDrag = useCallback(
    (
      e: ReactPointerEvent<HTMLButtonElement>,
      id: string,
      field: OcrSelectionField,
    ) => {
      if (field !== "translation" || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      onSelectBlock(id, field);
      const startX = e.clientX;
      const startY = e.clientY;
      setDraggedOverlay({ id, x: 0, y: 0 });

      const onMove = (event: PointerEvent) => {
        setDraggedOverlay({
          id,
          x: event.clientX - startX,
          y: event.clientY - startY,
        });
      };
      const onUp = () => {
        setDraggedOverlay(null);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [onSelectBlock],
  );

  useEffect(() => {
    initializedImageRef.current = null;
    setBaseImageWidth(null);
    setImageScale(1);
  }, [page.imageUrl]);

  const beginImageResize = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>, direction: OcrResizeDirection) => {
      e.preventDefault();
      e.stopPropagation();
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startY = e.clientY;
      const startScale = imageScale;
      const aspect = rect.width / rect.height;
      const horizontalSign = direction.includes("e")
        ? 1
        : direction.includes("w")
          ? -1
          : 0;
      const verticalSign = direction.includes("s")
        ? 1
        : direction.includes("n")
          ? -1
          : 0;
      setImageResizing(true);
      e.currentTarget.setPointerCapture(pointerId);

      const onMove = (event: PointerEvent) => {
        let widthDelta = horizontalSign * (event.clientX - startX);
        const verticalWidthDelta =
          verticalSign * (event.clientY - startY) * aspect;
        if (!horizontalSign) widthDelta = verticalWidthDelta;
        else if (verticalSign && Math.abs(verticalWidthDelta) > Math.abs(widthDelta)) {
          widthDelta = verticalWidthDelta;
        }
        const nextScale = startScale * ((rect.width + widthDelta) / rect.width);
        setImageScale(Math.min(2, Math.max(0.05, nextScale)));
      };
      const onUp = () => {
        setImageResizing(false);
        document.body.classList.remove("ocr-image-resizing");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      document.body.classList.add("ocr-image-resizing");
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [imageScale],
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      setStageSize({ w: 0, h: 0 });
      return;
    }
    const measure = () => {
      const img = stage.querySelector(".ocr-image") as HTMLImageElement | null;
      if (
        img?.complete &&
        img.naturalWidth > 0 &&
        initializedImageRef.current !== page.imageUrl
      ) {
        const card = stage.closest(".ocr-page") as HTMLElement | null;
        const wrap = stage.closest(".ocr-canvas-wrap") as HTMLElement | null;
        const header = card?.querySelector(".ocr-page-head") as HTMLElement | null;
        const availableWidth = Math.max(
          1,
          (card?.clientWidth || stage.parentElement?.clientWidth || img.naturalWidth) - 24,
        );
        const fittedWidth = Math.min(img.naturalWidth, availableWidth);
        const fittedHeight = fittedWidth * (img.naturalHeight / img.naturalWidth);
        const availableHeight = Math.max(
          1,
          (wrap?.clientHeight || fittedHeight) - (header?.offsetHeight || 0) - 36,
        );
        const fitScale = Math.min(1, availableHeight / Math.max(1, fittedHeight));
        initializedImageRef.current = page.imageUrl;
        setBaseImageWidth(fittedWidth);
        setImageScale(Math.max(0.02, fitScale));
      }
      const w = img?.clientWidth || stage.clientWidth;
      const h = img?.clientHeight || stage.clientHeight;
      setStageSize((prev) =>
        prev.w === w && prev.h === h ? prev : { w, h },
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    const img = stage.querySelector(".ocr-image") as HTMLImageElement | null;
    if (img) {
      ro.observe(img);
      if (!img.complete) img.addEventListener("load", measure);
    }
    return () => {
      ro.disconnect();
      img?.removeEventListener("load", measure);
    };
  }, [page.imageUrl, page.blocks.length]);


  return (
    <article
      className={
        "ocr-page" +
        (selected ? " is-selected" : "") +
        (page.busy ? " is-busy" : "")
      }
      data-page-id={page.id}
      onClick={onSelectPage}
      onContextMenu={(e) => onContextMenu(e, page.id)}
    >
      <header className="ocr-page-head">
        <span className="ocr-page-title">
          图 {index + 1}
          {page.label ? ` · ${page.label}` : ""}
        </span>
        <span className="ocr-page-meta">
          <span className="ocr-image-scale" title="拖拽图片边缘可等比例缩放；双击边缘恢复大小">
            缩放 {Math.round(imageScale * 100)}%
          </span>
          <OcrMetrics count={page.blocks.length} milliseconds={page.elapsedMs ?? 0}
            text={page.error ? "识别失败" : (page.statusText || "等待识别").replace(/^识别 \d+ 段 · /, "")}
            busy={page.busy} failed={!!page.error || /失败/.test(page.statusText ?? "")} />
          <button
            type="button"
            className="ocr-copy-btn ocr-rerun-btn"
            disabled={page.busy}
            title="使用当前识别模式重新识别此图片"
            onClick={(e) => {
              e.stopPropagation();
              onRerun();
            }}
          >
            重新识别
          </button>
        </span>
      </header>
      <div
        className={
          selectedBlockId && page.blocks.some((b) => b.id === selectedBlockId)
            ? `ocr-stage has-selection${imageResizing ? " is-resizing" : ""}`
            : `ocr-stage${imageResizing ? " is-resizing" : ""}`
        }
        ref={stageRef}
        style={{
          width: baseImageWidth
            ? `${baseImageWidth * imageScale}px`
            : `${imageScale * 100}%`,
        }}
      >
        <img
          src={page.imageUrl}
          alt={page.label || `OCR ${index + 1}`}
          className="ocr-image"
          draggable={false}
        />
        {page.blocks.map((b) => {
          const blockSelected = b.id === selectedBlockId;
          const displayTranslation = blockSelected
            ? selectedField === "translation"
            : showTranslation;
          const hasTranslation = b.status === "done" && b.translation.trim();
          const displayedField: OcrSelectionField =
            displayTranslation && hasTranslation ? "translation" : "source";
          const rawLabel = displayedField === "translation" ? b.translation : b.text;
          const boxW = b.w * stageSize.w;
          const boxH = b.h * stageSize.h;
          const dragOffset = draggedOverlay?.id === b.id ? draggedOverlay : null;
          return (
            <FittedOcrOverlay
              key={b.id}
              rawLabel={rawLabel}
              boxWidth={boxW}
              boxHeight={boxH}
              type="button"
              data-block-id={b.id}
              data-field={displayedField}
              className={
                blockSelected
                  ? `ocr-box active${dragOffset ? " is-dragging" : ""}`
                  : selected && !selectedBlockId
                    ? "ocr-box page-active"
                    : "ocr-box"
              }
              style={{
                left: `${b.x * 100}%`,
                top: `${b.y * 100}%`,
                width: `${b.w * 100}%`,
                height: `${b.h * 100}%`,
                writingMode:
                  displayedField === "translation" && b.vertical
                    ? "vertical-rl"
                    : undefined,
                transform: dragOffset
                  ? `translate3d(${dragOffset.x}px, ${dragOffset.y}px, 0)`
                  : undefined,
              }}
              onPointerDown={(e) => beginOverlayDrag(e, b.id, displayedField)}
              onClick={(e) => {
                e.stopPropagation();
                onSelectBlock(b.id, displayedField);
              }}
              title={b.text}
            />
          );
        })}
        {(["n", "ne", "e", "se", "s", "sw", "w", "nw"] as OcrResizeDirection[]).map(
          (direction) => (
            <button
              key={direction}
              type="button"
              className={`ocr-image-resize-handle is-${direction}`}
              aria-label="等比例缩放图片"
              title="拖动以等比例缩放；双击恢复为 100%"
              onPointerDown={(e) => beginImageResize(e, direction)}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setImageScale(1);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ),
        )}
      </div>
      {page.error && <p className="boot-error ocr-error">{page.error}</p>}
    </article>
  );
}
export { OcrMetrics,OcrPageCard };
export type { OcrPage, OcrSelectionField };
