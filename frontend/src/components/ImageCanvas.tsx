import { useCallback, useEffect, useRef, useState, useLayoutEffect, useMemo, type ComponentPropsWithRef, type CSSProperties, type ReactNode } from "react";
import "./imageBrowser.css";

/** Shared wheel boundary; editors keep their own gestures and original-image coordinates. */
export function ImageCanvasViewport({ onWheelZoom, ...props }: ComponentPropsWithRef<"div"> & {
  onWheelZoom?: (event: WheelEvent) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const wheel = useRef(onWheelZoom); wheel.current = onWheelZoom;
  useEffect(() => {
    const area = element.current;
    if (!area) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.deltaY || !wheel.current) return;
      event.preventDefault(); wheel.current(event);
    };
    area.addEventListener("wheel", onWheel, { passive: false });
    return () => area.removeEventListener("wheel", onWheel);
  }, []);
  return <div {...props} ref={node => {
    element.current = node;
    const ref = props.ref;
    if (typeof ref === "function") return ref(node);
    if (ref) ref.current = node;
  }} className={["image-canvas-viewport", props.className].filter(Boolean).join(" ")} />;
}

/** Fit-image canvas with zoom and panning, also usable with a controlled zoom toolbar. */
export function ImageCanvas({ editing = false, onBackground, children, className, stageClassName, style,
  stageStyle, zoom: controlledZoom, onZoomChange, minZoom = 1, maxZoom = 8 }: {
  editing?: boolean; onBackground?: () => void; children: ReactNode;
  className?: string; stageClassName?: string; style?: CSSProperties; stageStyle?: CSSProperties;
  zoom?: number; onZoomChange?: (zoom: number) => void; minZoom?: number; maxZoom?: number;
}) {
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [panReady, setPanReady] = useState(false), [panning, setPanning] = useState(false);
  const spaceHeld = useRef(false), surface = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null);
  const pan = useRef<{ pointer: number; clientX: number; clientY: number; x: number; y: number; clearOnClick: boolean } | null>(null);
  const zoom = controlledZoom ?? view.zoom;
  const latestView = useRef(view);
  latestView.current = { ...view, zoom };
  const containPan = useCallback((zoom: number, x: number, y: number) => {
    const image = stage.current;
    if (!image) return { zoom, x: 0, y: 0 };
    const maxX = image.offsetWidth * zoom / 2, maxY = image.offsetHeight * zoom / 2;
    return { zoom, x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
  }, []);
  useEffect(() => {
    const area = surface.current;
    if (!area) return;
    const observer = new ResizeObserver(() => {
      setView(current => current.x || current.y ? containPan(controlledZoom ?? current.zoom, current.x, current.y) : current);
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, [containPan, controlledZoom]);
  useEffect(() => {
    const onSpaceDown = (event: KeyboardEvent) => {
      const area = surface.current;
      if (event.code !== "Space" || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || !area?.matches(":hover")) return;
      if (event.target instanceof Element && (event.target.closest("input, textarea, select, [contenteditable]") ||
          (event.target.closest("button, a, [role='button']") && !area.closest("figure")?.contains(event.target)))) return;
      event.preventDefault(); event.stopPropagation(); spaceHeld.current = true; setPanReady(true);
    };
    const endSpace = () => { spaceHeld.current = false; setPanReady(false); };
    const onSpaceUp = (event: KeyboardEvent) => {
      if (event.code !== "Space" || !spaceHeld.current) return;
      event.preventDefault(); event.stopPropagation(); endSpace();
    };
    window.addEventListener("keydown", onSpaceDown, true);
    window.addEventListener("keyup", onSpaceUp, true);
    window.addEventListener("blur", endSpace);
    return () => {
      window.removeEventListener("keydown", onSpaceDown, true);
      window.removeEventListener("keyup", onSpaceUp, true);
      window.removeEventListener("blur", endSpace);
    };
  }, []);
  const endPan = (pointer: number) => {
    if (pan.current?.pointer !== pointer) return;
    pan.current = null; setPanning(false);
  };
  return <ImageCanvasViewport ref={surface} tabIndex={0}
    className={[className ?? "image-canvas-fit", panning ? "is-panning" : panReady ? "is-pan-ready" : ""].join(" ")}
    style={style} onWheelZoom={event => {
      const current = latestView.current;
      const next = Math.max(minZoom, Math.min(maxZoom, current.zoom * Math.exp(-event.deltaY * .002)));
      if (next === current.zoom) return;
      const nextView = containPan(next, current.x * next / current.zoom, current.y * next / current.zoom);
      latestView.current = nextView;
      setView(nextView);
      onZoomChange?.(next);
    }}
    onPointerDownCapture={event => {
      if (!event.isPrimary || pan.current) return;
      const target = event.target as Element;
      const moveOnly = event.button === 1 || (event.button === 0 && spaceHeld.current);
      const background = !stage.current?.contains(target);
      if (!moveOnly && (event.button !== 0 || (!background && (editing || target.closest('svg.is-editing, [role="button"]'))))) return;
      event.preventDefault(); event.stopPropagation();
      (event.currentTarget.closest<HTMLElement>("[data-game-image-preview-pane]") ?? event.currentTarget).focus({ preventScroll: true });
      pan.current = { pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: latestView.current.x, y: latestView.current.y, clearOnClick: !moveOnly };
      event.currentTarget.setPointerCapture(event.pointerId); setPanning(true);
    }} onPointerMove={event => {
      const start = pan.current;
      if (start?.pointer !== event.pointerId) return;
      const scale = event.currentTarget.currentCSSZoom || 1;
      setView(current => containPan(controlledZoom ?? current.zoom, start.x + (event.clientX - start.clientX) / scale,
        start.y + (event.clientY - start.clientY) / scale));
    }} onPointerUp={event => {
      const start = pan.current;
      if (start?.pointer !== event.pointerId) return;
      endPan(event.pointerId);
      if (start.clearOnClick && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 4) onBackground?.();
    }} onPointerCancel={event => endPan(event.pointerId)} onLostPointerCapture={event => endPan(event.pointerId)}>
    <div ref={stage} className={["image-canvas-stage", stageClassName].filter(Boolean).join(" ")}
      style={{ ...stageStyle, translate: view.x + "px " + view.y + "px", scale: zoom, "--mosaic-preview-zoom": zoom } as CSSProperties}>
      {children}
    </div>
  </ImageCanvasViewport>;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const minimapMax = 120;

type CanvasLayout = { L: number; T: number; W: number; H: number };

function clampCanvasScroll(view: HTMLDivElement, layout: CanvasLayout) {
  const { L, T, W, H } = layout;
  const vw = view.clientWidth, vh = view.clientHeight;
  const axis = (value: number, start: number, size: number, port: number, limit: number) => {
    const maxScroll = Math.max(0, limit - port);
    // Keep half of the smaller image/viewport span visible while allowing every edge to be reached.
    const visible = Math.min(size, port) / 2;
    const min = start + visible - port;
    const max = start + size - visible;
    return clamp(clamp(value, min, max), 0, maxScroll);
  };
  const s = axis(view.scrollLeft, L, W, vw, view.scrollWidth);
  const t = axis(view.scrollTop, T, H, vh, view.scrollHeight);
  if (s !== view.scrollLeft) view.scrollLeft = s;
  if (t !== view.scrollTop) view.scrollTop = t;
  return { left: s, top: t };
}

/** Scroll-based canvas for editors working in original-image pixel coordinates. */
export function useImageCanvasScroll({ width, height, src, canZoom }: {
  width: number; height: number; src: string; canZoom: () => boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null), bitmap = useRef<HTMLDivElement>(null);
  const canZoomRef = useRef(canZoom); canZoomRef.current = canZoom;
  const [fit, setFit] = useState(1), [manualZoom, setManualZoom] = useState<number>();
  const zoom = manualZoom ?? fit;
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [panScroll, setPanScroll] = useState({ left: 0, top: 0 });
  const [canvasLayout, setCanvasLayout] = useState<CanvasLayout>();
  const anchor = useRef<{ x: number; y: number; clientX: number; clientY: number } | undefined>(undefined);
  const canvasPadding = useMemo(() => {
    const vw = viewportSize.width || 1, vh = viewportSize.height || 1;
    const iw = width * zoom, ih = height * zoom;
    const padX = iw <= vw ? Math.max(12, (vw - iw) / 2) : vw * 0.5;
    const padY = ih <= vh ? Math.max(12, (vh - ih) / 2) : vh * 0.5;
    return { padX, padY };
  }, [viewportSize, width, height, zoom]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      const viewWidth = element.clientWidth, viewHeight = element.clientHeight;
      setViewportSize(current => current.width === viewWidth && current.height === viewHeight ? current : { width: viewWidth, height: viewHeight });
      setFit(Math.max(.01, Math.min(4, (element.clientWidth - 58) / width, (element.clientHeight - 26) / height)));
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [width, height]);
  function measureCanvasLayout(): CanvasLayout | undefined {
    const imageEl = bitmap.current;
    if (!imageEl) return;
    return { L: imageEl.offsetLeft, T: imageEl.offsetTop, W: imageEl.offsetWidth, H: imageEl.offsetHeight };
  }
  function syncCanvasScroll() {
    const view = viewport.current;
    if (!view) return;
    const layout = measureCanvasLayout();
    if (!layout) return;
    setPanScroll(clampCanvasScroll(view, layout));
    setCanvasLayout(layout);
  }
  function panToImagePoint(nx: number, ny: number) {
    const view = viewport.current, layout = measureCanvasLayout();
    if (!view || !layout) return;
    const { L, T, W, H } = layout;
    view.scrollLeft = L + nx * W - view.clientWidth / 2;
    view.scrollTop = T + ny * H - view.clientHeight / 2;
    syncCanvasScroll();
  }
  const minimap = useMemo(() => {
    if (!canvasLayout || !src) return undefined;
    const { L, T, W, H } = canvasLayout;
    const vw = viewportSize.width, vh = viewportSize.height;
    if (!vw || !vh || !W || !H) return undefined;
    const scale = minimapMax / Math.max(W, H);
    const mapW = W * scale, mapH = H * scale;
    const { left: s, top: t } = panScroll;
    const iL = Math.max(L, s), iT = Math.max(T, t);
    const iR = Math.min(L + W, s + vw), iB = Math.min(T + H, t + vh);
    const iW = Math.max(0, iR - iL), iH = Math.max(0, iB - iT);
    return {
      mapW, mapH, url: src,
      view: { left: (iL - L) / W * mapW, top: (iT - T) / H * mapH, width: iW / W * mapW, height: iH / H * mapH },
    };
  }, [canvasLayout, panScroll, viewportSize, src]);
  function changeZoom(value: number, clientX?: number, clientY?: number) {
    const view = viewport.current, imageElement = bitmap.current;
    if (!view || !imageElement || !canZoomRef.current()) return;
    const next = clamp(value, .25, 4);
    if (next === zoomRef.current) return;
    const v = view.getBoundingClientRect(), r = imageElement.getBoundingClientRect();
    const x = clientX ?? v.left + view.clientLeft + view.clientWidth / 2;
    const y = clientY ?? v.top + view.clientTop + view.clientHeight / 2;
    // Wheel events can arrive before React paints the previous zoom; read the displayed image geometry.
    anchor.current = { x: (x - r.left) / r.width * width, y: (y - r.top) / r.height * height, clientX: x, clientY: y };
    zoomRef.current = next;
    setManualZoom(next);
  }
  useLayoutEffect(() => {
    const view = viewport.current, imageElement = bitmap.current;
    if (!view || !imageElement) return;
    const point = anchor.current;
    if (point) {
      const r = imageElement.getBoundingClientRect();
      view.scrollLeft += r.left + point.x * zoom - point.clientX;
      view.scrollTop += r.top + point.y * zoom - point.clientY;
      anchor.current = undefined;
    } else {
      view.scrollLeft = (view.scrollWidth - view.clientWidth) / 2;
      view.scrollTop = (view.scrollHeight - view.clientHeight) / 2;
    }
    syncCanvasScroll();
  }, [zoom, viewportSize, src]);
  function onWheelZoom(event: WheelEvent) {
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.current!.clientHeight : 1);
    changeZoom(zoomRef.current * Math.exp(-clamp(pixels, -100, 100) * Math.log(1.1) / 100), event.clientX, event.clientY);
  }
  return { viewport, bitmap, zoom, changeZoom, canvasPadding, minimap, panToImagePoint, syncCanvasScroll, onWheelZoom };
}

export function ImageCanvasMinimap({ map, onNavigate, className, imageClassName, viewClassName }: {
  map: { mapW: number; mapH: number; url: string; view: { left: number; top: number; width: number; height: number } };
  onNavigate: (x: number, y: number) => void; className: string; imageClassName: string; viewClassName: string;
}) {
  const image = useRef<HTMLSpanElement>(null);
  return <div className={className} role="img" aria-label="画布导航" onPointerDown={event => {
    if (event.button !== 0) return;
    event.preventDefault();
    const bounds = image.current!.getBoundingClientRect();
    onNavigate(clamp((event.clientX - bounds.left) / bounds.width, 0, 1), clamp((event.clientY - bounds.top) / bounds.height, 0, 1));
  }}>
    <span ref={image} className={imageClassName} style={{ width: map.mapW, height: map.mapH }}>
      <img src={map.url} alt="" draggable={false} />
      <span className={viewClassName} style={map.view} aria-hidden="true" />
    </span>
  </div>;
}
