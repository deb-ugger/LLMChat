import { ImageCanvasMinimap, ImageCanvasViewport, useImageCanvasScroll } from "./ImageCanvas";
import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getFixedMenuPoint } from "../viewportLayout";

export type GameImageView = {
  label: string;
  width: number;
  height: number;
} & ({ src?: string | Blob; error?: string } | { render: (zoom: number) => ReactNode });

export type GameImageViews = readonly [GameImageView, ...GameImageView[]];

export function useImageBlobUrl(blob?: Blob) {
  const [preview, setPreview] = useState<{ blob: Blob; url: string }>();
  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    setPreview({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return preview && preview.blob === blob ? preview.url : "";
}

function BitmapPreview({ view, title, zoom }: { view: GameImageView & { src?: string | Blob; error?: string }; title: string; zoom: number }) {
  const url = useImageBlobUrl(typeof view.src === "string" ? undefined : view.src);
  const src = typeof view.src === "string" ? view.src : url;
  return <div className="unity-image-stage unity-image-preview-surface unity-viewer-bitmap" style={{ width: view.width * zoom, height: view.height * zoom }}>
    {src ? <img src={src} alt={title + " " + view.label} draggable={false} /> : view.error
      ? <p className="game-mosaic-error" role="alert">{view.error}</p> : <p className="hint">正在读取图片…</p>}
  </div>;
}

export function GameImageViewer({ title, views, initialIndex = 0, resultLabel, onPrevious, onNext, onClose, onDetails, closeOnEscape = true }: {
  title: string;
  views: GameImageViews;
  initialIndex?: number;
  resultLabel?: "译图" | "去码结果";
  onPrevious?: (showResult: boolean) => void;
  onNext?: (showResult: boolean) => void;
  onClose: () => void;
  onDetails?: () => void;
  closeOnEscape?: boolean;
}) {
  const [index, setIndex] = useState(initialIndex);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const showResult = index > 0 && views.length > 1;
  const view = showResult ? views[Math.min(index, views.length - 1)] : views[0];
  const { width, height } = view;
  const { viewport, bitmap, zoom, changeZoom, canvasPadding, minimap, panToImagePoint, syncCanvasScroll, onWheelZoom,
    panning, startPan, movePan, endPan } = useImageCanvasScroll({ width, height, fitMax: 1, minZoom: .01, maxZoom: 8,
    fitInsetX: 24, fitInsetY: resultLabel === "译图" ? 52 : 24, resetKey: title, wheelScale: .002 });
  const hasResult = views.length > 1;
  const switchLabel = "查看" + (showResult ? "原图" : resultLabel);
  const selectView = useCallback((result: boolean) => {
    if (result && !hasResult) return;
    setMenu(null);
    setIndex(result ? Math.min(views.length - 1, Math.max(initialIndex, 1)) : 0);
  }, [hasResult, initialIndex, views.length]);

  useLayoutEffect(() => { panToImagePoint(.5, .5); }, [index]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
          !["Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") { if (closeOnEscape) onClose(); }
      else if (event.key === "ArrowUp" || event.key === "PageUp") onPrevious?.(showResult);
      else if (event.key === "ArrowDown" || event.key === "PageDown") onNext?.(showResult);
      else selectView(event.key === "ArrowRight");
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose, onPrevious, onNext, selectView, showResult, closeOnEscape]);

  return createPortal(<div className="unity-original-viewer" role="dialog" aria-label={"查看" + view.label}
    aria-modal="true" aria-keyshortcuts={(closeOnEscape ? "Escape " : "") + "ArrowLeft ArrowRight ArrowUp ArrowDown PageUp PageDown"}
    onPointerDown={event => event.stopPropagation()} onClick={event => {
      event.stopPropagation();
      if (event.target === event.currentTarget) onClose();
      else setMenu(null);
    }}>
    <section className="unity-original-viewer-window">
      <div className="unity-original-viewer-header">
        <strong>{title}</strong>
        <div className="unity-image-button-group">
          {(resultLabel || onPrevious || onNext) && <>
            <button type="button" className="unity-btn" disabled={!onPrevious} aria-keyshortcuts="ArrowUp PageUp"
              data-tooltip="上一张（↑ / Page Up）" onClick={() => onPrevious?.(showResult)}>上一张</button>
            <button type="button" className="unity-btn" disabled={!onNext} aria-keyshortcuts="ArrowDown PageDown"
              data-tooltip="下一张（↓ / Page Down）" onClick={() => onNext?.(showResult)}>下一张</button>
          </>}
          {resultLabel && <button type="button" className="unity-btn" disabled={!hasResult} aria-keyshortcuts={showResult ? "ArrowLeft" : "ArrowRight"}
            data-tooltip={switchLabel + (showResult ? "（←）" : "（→）")} onClick={() => selectView(!showResult)}>{switchLabel}</button>}
          <button type="button" className="unity-btn" data-tooltip="缩小" aria-label="缩小图片" onClick={() => changeZoom(Math.max(.01, zoom / 1.2))}>−</button>
          <button type="button" className="unity-btn" data-tooltip="恢复原始比例" aria-label="恢复原始比例" onClick={() => changeZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button type="button" className="unity-btn" data-tooltip="放大" aria-label="放大图片" onClick={() => changeZoom(Math.min(8, zoom * 1.2))}>+</button>
          <button type="button" className="unity-btn unity-viewer-close" data-tooltip={closeOnEscape ? "关闭（Esc）" : "关闭"} aria-label="关闭图片" autoFocus onClick={onClose}>×</button>
        </div>
      </div>
      <div className="image-canvas-viewer-frame">
        <ImageCanvasViewport ref={viewport} tabIndex={0} className={"unity-original-viewer-body image-canvas-scroll-viewport" + (panning ? " is-panning" : "")}
          onWheelZoom={onWheelZoom} onScroll={syncCanvasScroll} onPointerDown={event => {
            if ((event.button !== 0 && event.button !== 1) || !event.isPrimary ||
                (event.target as Element).closest("button, input, textarea, select, a")) return;
            event.stopPropagation(); startPan(event);
          }} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={endPan}
          onContextMenu={event => {
            event.preventDefault(); event.stopPropagation();
            if (onDetails && (event.target as Element).closest("img")) setMenu(getFixedMenuPoint(event.clientX, event.clientY, 170, 70));
          }}>
          <div className="image-canvas-scroll-track" style={{ paddingInline: canvasPadding.padX, paddingBlock: canvasPadding.padY }}>
            <div ref={bitmap} className="image-canvas-stage" style={{ width: width * zoom, height: "render" in view ? undefined : height * zoom }}>
              {"render" in view ? view.render(zoom) : <BitmapPreview view={view} title={title} zoom={zoom} />}
            </div>
          </div>
        </ImageCanvasViewport>
        {minimap && <ImageCanvasMinimap map={minimap} onNavigate={panToImagePoint} />}
      </div>
    </section>
    {menu && onDetails && <div className="unity-gallery-menu" role="menu" aria-label="图片操作" style={{ left: menu.x, top: menu.y }}>
      <button type="button" role="menuitem" onClick={onDetails}>查看详情</button>
    </div>}
  </div>, document.body);
}
