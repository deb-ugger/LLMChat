import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getFixedMenuPoint } from "../viewportLayout";
import { GameImagePreviewFrame } from "./GameImageBrowserLayout";

export type GameImageView = {
  label: string;
  width: number;
  height: number;
} & ({ src: string | Blob } | { render: (zoom: number) => ReactNode });

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

export function unityImageFit(width: number, height: number, availableWidth: number, availableHeight: number) {
  return Math.min(1, Math.max(1, availableWidth - 24) / Math.max(1, width), Math.max(1, availableHeight - 52) / Math.max(1, height));
}

function BitmapPreview({ view, title, zoom }: { view: GameImageView & { src: string | Blob }; title: string; zoom: number }) {
  const url = useImageBlobUrl(typeof view.src === "string" ? undefined : view.src);
  const src = typeof view.src === "string" ? view.src : url;
  return <GameImagePreviewFrame caption={view.label} fallback={<p className="hint">正在读取图片…</p>}>
    {src && <div className="unity-image-stage" style={{ width: view.width * zoom }}>
      <img src={src} alt={title + " " + view.label} draggable={false} />
    </div>}
  </GameImagePreviewFrame>;
}

export function GameImageViewer({ title, views, initialIndex = 0, resultLabel, onPrevious, onNext, onClose, onDetails }: {
  title: string;
  views: GameImageViews;
  initialIndex?: number;
  resultLabel: "译图" | "去码结果";
  onPrevious?: (showResult: boolean) => void;
  onNext?: (showResult: boolean) => void;
  onClose: () => void;
  onDetails?: () => void;
}) {
  const [index, setIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const scrollAnchor = useRef({ x: .5, y: .5 });
  const pan = useRef<{ pointer: number; x: number; y: number; left: number; top: number } | null>(null);
  const showResult = index > 0 && views.length > 1;
  const view = showResult ? views[Math.min(index, views.length - 1)] : views[0];
  const { width, height } = view;
  const hasResult = views.length > 1;
  const switchLabel = "查看" + (showResult ? "原图" : resultLabel);
  const selectView = useCallback((result: boolean) => {
    if (result && !hasResult) return;
    setMenu(null);
    setIndex(result ? Math.min(views.length - 1, Math.max(initialIndex, 1)) : 0);
  }, [hasResult, initialIndex, views.length]);

  useLayoutEffect(() => {
    const element = body.current;
    if (element) setZoom(unityImageFit(width, height, element.clientWidth, element.clientHeight));
  }, [width, height]);

  useLayoutEffect(() => { scrollAnchor.current = { x: .5, y: .5 }; }, [title, width, height, index]);

  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    element.scrollLeft = (element.scrollWidth - element.clientWidth) * scrollAnchor.current.x;
    element.scrollTop = (element.scrollHeight - element.clientHeight) * scrollAnchor.current.y;
  }, [title, width, height, zoom, index]);

  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom(value => Math.max(.01, Math.min(8, value * Math.exp(-event.deltaY * .002))));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
          !["Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowUp") onPrevious?.(showResult);
      else if (event.key === "ArrowDown") onNext?.(showResult);
      else selectView(event.key === "ArrowRight");
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose, onPrevious, onNext, selectView, showResult]);

  const endPan = (pointer: number) => {
    if (pan.current?.pointer !== pointer) return;
    pan.current = null;
    setPanning(false);
  };
  return createPortal(<div className="unity-original-viewer" role="dialog" aria-label={"查看" + view.label}
    aria-modal="true" aria-keyshortcuts="Escape ArrowLeft ArrowRight ArrowUp ArrowDown"
    onPointerDown={event => event.stopPropagation()} onClick={event => {
      event.stopPropagation();
      if (event.target === event.currentTarget) onClose();
      else setMenu(null);
    }}>
    <section className="unity-original-viewer-window">
      <div className="unity-original-viewer-header">
        <strong>{title} · {view.label}</strong>
        <div className="unity-image-button-group">
          <button type="button" className="unity-btn" disabled={!onPrevious} aria-keyshortcuts="ArrowUp"
            data-tooltip="上一张（↑）" onClick={() => onPrevious?.(showResult)}>上一张</button>
          <button type="button" className="unity-btn" disabled={!onNext} aria-keyshortcuts="ArrowDown"
            data-tooltip="下一张（↓）" onClick={() => onNext?.(showResult)}>下一张</button>
          <button type="button" className="unity-btn" disabled={!hasResult} aria-keyshortcuts={showResult ? "ArrowLeft" : "ArrowRight"}
            data-tooltip={switchLabel + (showResult ? "（←）" : "（→）")} onClick={() => selectView(!showResult)}>{switchLabel}</button>
          <button type="button" className="unity-btn" data-tooltip="缩小" aria-label="缩小图片" onClick={() => setZoom(value => Math.max(.01, value / 1.2))}>−</button>
          <button type="button" className="unity-btn" data-tooltip="恢复原始比例" aria-label="恢复原始比例" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button type="button" className="unity-btn" data-tooltip="放大" aria-label="放大图片" onClick={() => setZoom(value => Math.min(8, value * 1.2))}>+</button>
          <button type="button" className="unity-btn unity-viewer-close" data-tooltip="关闭（Esc）" aria-label="关闭图片" autoFocus onClick={onClose}>×</button>
        </div>
      </div>
      <div ref={body} className={"unity-original-viewer-body" + (panning ? " is-panning" : "")} onScroll={event => {
        const element = event.currentTarget;
        scrollAnchor.current = {
          x: element.scrollLeft / Math.max(1, element.scrollWidth - element.clientWidth),
          y: element.scrollTop / Math.max(1, element.scrollHeight - element.clientHeight),
        };
      }} onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary || pan.current ||
            (event.target as Element).closest("button, input, textarea, select, a")) return;
        event.preventDefault();
        event.stopPropagation();
        const element = event.currentTarget;
        pan.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY,
          left: element.scrollLeft, top: element.scrollTop };
        setPanning(true);
        element.setPointerCapture(event.pointerId);
      }} onPointerMove={event => {
        const start = pan.current;
        if (start?.pointer !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const element = event.currentTarget;
        const scale = element.currentCSSZoom;
        element.scrollLeft = start.left - (event.clientX - start.x) / scale;
        element.scrollTop = start.top - (event.clientY - start.y) / scale;
      }} onPointerUp={event => endPan(event.pointerId)} onPointerCancel={event => endPan(event.pointerId)}
        onLostPointerCapture={event => endPan(event.pointerId)} onContextMenu={event => {
        event.preventDefault();
        event.stopPropagation();
        if (onDetails && (event.target as Element).closest("img"))
          setMenu(getFixedMenuPoint(event.clientX, event.clientY, 170, 70));
      }}>
        <div className="unity-original-viewer-track">
          {"src" in view ? <BitmapPreview view={view} title={title} zoom={zoom} /> : view.render(zoom)}
        </div>
      </div>
    </section>
    {menu && onDetails && <div className="unity-gallery-menu" role="menu" aria-label="图片操作" style={{ left: menu.x, top: menu.y }}>
      <button type="button" role="menuitem" onClick={onDetails}>查看详情</button>
    </div>}
  </div>, document.body);
}
