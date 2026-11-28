import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentPropsWithRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import "./imageBrowser.css";

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const minimapMax = 120;
const canvasControls = "[data-image-canvas-controls]";
type Bounds = { left: number; top: number; width: number; height: number };
export type ImageCanvasMap = { mapW: number; mapH: number; url: string; view: Bounds };

/** Keep at least half the smaller image/viewport span visible on each axis. */
export function imageCanvasPanLimit(imageSize: number, viewportSize: number) {
  return Math.max(imageSize, viewportSize) / 2;
}

export function imageCanvasMap(image: Bounds, viewport: Bounds, url: string): ImageCanvasMap | undefined {
  if (!url || image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return;
  const scale = minimapMax / Math.max(image.width, image.height);
  const mapW = image.width * scale, mapH = image.height * scale;
  const left = clamp((viewport.left - image.left) / image.width, 0, 1) * mapW;
  const top = clamp((viewport.top - image.top) / image.height, 0, 1) * mapH;
  const right = clamp((viewport.left + viewport.width - image.left) / image.width, 0, 1) * mapW;
  const bottom = clamp((viewport.top + viewport.height - image.top) / image.height, 0, 1) * mapH;
  return { mapW, mapH, url, view: { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) } };
}

function viewportBounds(element: HTMLDivElement): Bounds {
  const rect = element.getBoundingClientRect(), scale = element.currentCSSZoom || 1;
  return { left: rect.left + element.clientLeft * scale, top: rect.top + element.clientTop * scale,
    width: element.clientWidth * scale, height: element.clientHeight * scale };
}

function canvasPicture(stage: HTMLDivElement) {
  return stage.querySelector<HTMLImageElement | SVGImageElement | HTMLCanvasElement>("img, image, canvas");
}

function useImageCanvasOverview(viewport: RefObject<HTMLDivElement | null>, stage: RefObject<HTMLDivElement | null>) {
  const [minimap, setMinimap] = useState<ImageCanvasMap>();
  const canvasSnapshots = useRef(new WeakMap<HTMLCanvasElement, string>());
  const refreshMap = useCallback(() => {
    const area = viewport.current, content = stage.current;
    if (!area || !content) return;
    const picture = canvasPicture(content);
    let url: string;
    if (picture instanceof HTMLCanvasElement) {
      url = canvasSnapshots.current.get(picture) ?? picture.toDataURL("image/png");
      canvasSnapshots.current.set(picture, url);
    } else {
      url = picture instanceof HTMLImageElement
        ? picture.complete && picture.naturalWidth > 0 ? picture.currentSrc || picture.src : ""
        : picture?.getAttribute("href") ?? "";
    }
    const next = picture ? imageCanvasMap(picture.getBoundingClientRect(), viewportBounds(area), url) : undefined;
    setMinimap(current => {
      if (!current || !next) return current === next ? current : next;
      return current.url === next.url && current.mapW === next.mapW && current.mapH === next.mapH &&
        current.view.left === next.view.left && current.view.top === next.view.top &&
        current.view.width === next.view.width && current.view.height === next.view.height ? current : next;
    });
  }, [viewport, stage]);
  useLayoutEffect(() => {
    const area = viewport.current, content = stage.current;
    if (!area || !content) return;
    refreshMap();
    const resize = new ResizeObserver(refreshMap);
    resize.observe(area); resize.observe(content);
    const changes = new MutationObserver(records => {
      for (const record of records) if (record.target instanceof HTMLCanvasElement) canvasSnapshots.current.delete(record.target);
      refreshMap();
    });
    changes.observe(content, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "href", "width", "height"] });
    content.addEventListener("load", refreshMap, true);
    return () => { resize.disconnect(); changes.disconnect(); content.removeEventListener("load", refreshMap, true); };
  }, [viewport, stage, refreshMap]);
  return { minimap, refreshMap };
}

function useImagePanModifier(surface: RefObject<HTMLDivElement | null>) {
  const spaceHeld = useRef(false), [panReady, setPanReady] = useState(false);
  useEffect(() => {
    const onSpaceDown = (event: KeyboardEvent) => {
      const area = surface.current;
      if (event.code !== "Space" || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || !area?.matches(":hover")) return;
      const target = event.target as Element;
      if (target.closest("input, textarea, select, [contenteditable], " + canvasControls) ||
          (target.closest("button, a, [role='button']") && !area.closest("figure")?.contains(target))) return;
      event.preventDefault(); event.stopPropagation(); spaceHeld.current = true; setPanReady(true);
    };
    const endSpace = () => { spaceHeld.current = false; setPanReady(false); };
    const onSpaceUp = (event: KeyboardEvent) => {
      if (event.code !== "Space" || !spaceHeld.current) return;
      event.preventDefault(); event.stopPropagation(); endSpace();
    };
    window.addEventListener("keydown", onSpaceDown, true); window.addEventListener("keyup", onSpaceUp, true); window.addEventListener("blur", endSpace);
    return () => {
      window.removeEventListener("keydown", onSpaceDown, true); window.removeEventListener("keyup", onSpaceUp, true); window.removeEventListener("blur", endSpace);
    };
  }, [surface]);
  return { spaceHeld, panReady };
}

/** Shared wheel boundary; editors keep their original-image coordinates. */
export function ImageCanvasViewport({ onWheelZoom, ...props }: ComponentPropsWithRef<"div"> & {
  onWheelZoom?: (event: WheelEvent) => void;
}) {
  const element = useRef<HTMLDivElement>(null), wheel = useRef(onWheelZoom); wheel.current = onWheelZoom;
  useEffect(() => {
    const area = element.current;
    if (!area) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.deltaY || !wheel.current) return;
      event.preventDefault();
      if (!(event.target as Element).closest(canvasControls)) wheel.current(event);
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

/** Fit-image canvas with a shared overview and bounded default panning. */
export function ImageCanvas({ editing = false, onBackground, children, className, stageClassName, style,
  stageStyle, zoom: controlledZoom, onZoomChange, minZoom = 1, maxZoom = 8 }: {
  editing?: boolean; onBackground?: () => void; children: ReactNode;
  className?: string; stageClassName?: string; style?: CSSProperties; stageStyle?: CSSProperties;
  zoom?: number; onZoomChange?: (zoom: number) => void; minZoom?: number; maxZoom?: number;
}) {
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 }), [panning, setPanning] = useState(false);
  const surface = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null);
  const { spaceHeld, panReady } = useImagePanModifier(surface);
  const { minimap, refreshMap } = useImageCanvasOverview(surface, stage);
  const pan = useRef<{ pointer: number; clientX: number; clientY: number; x: number; y: number; clearOnClick: boolean } | null>(null);
  const zoom = controlledZoom ?? view.zoom, latestView = useRef(view);
  latestView.current = { ...view, zoom };
  const containPan = useCallback((zoom: number, x: number, y: number) => {
    const image = stage.current, area = surface.current;
    if (!image || !area) return { zoom, x: 0, y: 0 };
    const maxX = imageCanvasPanLimit(image.offsetWidth * zoom, area.clientWidth);
    const maxY = imageCanvasPanLimit(image.offsetHeight * zoom, area.clientHeight);
    return { zoom, x: clamp(x, -maxX, maxX), y: clamp(y, -maxY, maxY) };
  }, []);
  useLayoutEffect(() => {
    const area = surface.current;
    if (!area) return;
    const constrain = () => setView(current => {
      const next = containPan(controlledZoom ?? current.zoom, current.x, current.y);
      return current.x === next.x && current.y === next.y ? current : next;
    });
    constrain();
    const observer = new ResizeObserver(constrain); observer.observe(area);
    return () => observer.disconnect();
  }, [containPan, controlledZoom]);
  useLayoutEffect(refreshMap, [refreshMap, zoom, view.x, view.y, children]);
  const endPan = (pointer: number) => {
    if (pan.current?.pointer !== pointer) return;
    pan.current = null; setPanning(false);
  };
  const panToImagePoint = (x: number, y: number) => {
    const area = surface.current, picture = stage.current && canvasPicture(stage.current);
    if (!area || !picture) return;
    const image = picture.getBoundingClientRect(), port = viewportBounds(area), scale = area.currentCSSZoom || 1;
    setView(current => containPan(controlledZoom ?? current.zoom,
      current.x + (port.left + port.width / 2 - image.left - x * image.width) / scale,
      current.y + (port.top + port.height / 2 - image.top - y * image.height) / scale));
  };
  return <ImageCanvasViewport ref={surface} tabIndex={0}
    className={[className ?? "image-canvas-fit", panning ? "is-panning" : !editing || panReady ? "is-pan-ready" : ""].join(" ")}
    style={style} onWheelZoom={event => {
      const current = latestView.current;
      const next = clamp(current.zoom * Math.exp(-event.deltaY * .002), minZoom, maxZoom);
      if (next === current.zoom || pan.current) return;
      const nextView = containPan(next, current.x * next / current.zoom, current.y * next / current.zoom);
      latestView.current = nextView; setView(nextView); onZoomChange?.(next);
    }} onPointerDownCapture={event => {
      if (!event.isPrimary || pan.current) return;
      const target = event.target as Element;
      if (target.closest(canvasControls)) return;
      const moveOnly = event.button === 1 || (event.button === 0 && spaceHeld.current);
      const background = !stage.current?.contains(target);
      if (!moveOnly && (event.button !== 0 || (!background && (editing || target.closest('svg.is-editing, [role="button"]'))))) return;
      event.preventDefault(); event.stopPropagation();
      (event.currentTarget.closest<HTMLElement>("[data-game-image-preview-pane]") ?? event.currentTarget).focus({ preventScroll: true });
      pan.current = { pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY,
        x: latestView.current.x, y: latestView.current.y, clearOnClick: !moveOnly };
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
    {minimap && <ImageCanvasMinimap map={minimap} onNavigate={panToImagePoint} />}
  </ImageCanvasViewport>;
}

type CanvasLayout = { L: number; T: number; W: number; H: number };
function clampCanvasScroll(view: HTMLDivElement, layout: CanvasLayout) {
  const axis = (value: number, start: number, size: number, port: number, limit: number) => {
    const center = start + (size - port) / 2, range = imageCanvasPanLimit(size, port);
    return clamp(clamp(value, center - range, center + range), 0, Math.max(0, limit - port));
  };
  view.scrollLeft = axis(view.scrollLeft, layout.L, layout.W, view.clientWidth, view.scrollWidth);
  view.scrollTop = axis(view.scrollTop, layout.T, layout.H, view.clientHeight, view.scrollHeight);
}

/** Scroll-based canvas shared by pixel editors and the full-screen viewer. */
export function useImageCanvasScroll({ width, height, src, canZoom = () => true, fitMax = 4,
  minZoom = .25, maxZoom = 4, fitInsetX = 58, fitInsetY = 26, resetKey, wheelScale = Math.log(1.1) / 100 }: {
  width: number; height: number; src?: string; canZoom?: () => boolean;
  fitMax?: number; minZoom?: number; maxZoom?: number; fitInsetX?: number; fitInsetY?: number; resetKey?: string; wheelScale?: number;
}) {
  const viewport = useRef<HTMLDivElement>(null), bitmap = useRef<HTMLDivElement>(null), canZoomRef = useRef(canZoom);
  canZoomRef.current = canZoom;
  const { spaceHeld, panReady } = useImagePanModifier(viewport);
  const { minimap, refreshMap } = useImageCanvasOverview(viewport, bitmap);
  const [fit, setFit] = useState(1), [manualZoom, setManualZoom] = useState<number>(), [panning, setPanning] = useState(false);
  const zoom = manualZoom ?? fit, zoomRef = useRef(zoom); zoomRef.current = zoom;
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const anchor = useRef<{ x: number; y: number; clientX: number; clientY: number } | undefined>(undefined);
  const pan = useRef<{ pointer: number; x: number; y: number; left: number; top: number } | undefined>(undefined);
  const canvasPadding = useMemo(() => {
    const vw = viewportSize.width, vh = viewportSize.height;
    // Even a fitted image needs scrollable space for default drag-to-pan.
    return { padX: Math.max(12, vw / 2 + Math.max(0, (vw - width * zoom) / 2)),
      padY: Math.max(12, vh / 2 + Math.max(0, (vh - height * zoom) / 2)) };
  }, [viewportSize, width, height, zoom]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      const viewWidth = element.clientWidth, viewHeight = element.clientHeight;
      setViewportSize(current => current.width === viewWidth && current.height === viewHeight ? current : { width: viewWidth, height: viewHeight });
      setFit(Math.max(.01, Math.min(fitMax, (viewWidth - fitInsetX) / width, (viewHeight - fitInsetY) / height)));
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [width, height, fitMax, fitInsetX, fitInsetY]);
  useLayoutEffect(() => { setManualZoom(undefined); }, [resetKey, width, height]);
  function measureCanvasLayout(): CanvasLayout | undefined {
    const view = viewport.current, content = bitmap.current;
    if (!view || !content) return;
    const rect = (canvasPicture(content) ?? content).getBoundingClientRect(), port = viewportBounds(view), scale = view.currentCSSZoom || 1;
    return { L: (rect.left - port.left) / scale + view.scrollLeft, T: (rect.top - port.top) / scale + view.scrollTop,
      W: rect.width / scale, H: rect.height / scale };
  }
  function syncCanvasScroll() {
    const view = viewport.current, layout = measureCanvasLayout();
    if (view && layout) clampCanvasScroll(view, layout);
    refreshMap();
  }
  function panToImagePoint(x: number, y: number) {
    const view = viewport.current, layout = measureCanvasLayout();
    if (!view || !layout) return;
    view.scrollLeft = layout.L + x * layout.W - view.clientWidth / 2;
    view.scrollTop = layout.T + y * layout.H - view.clientHeight / 2;
    syncCanvasScroll();
  }
  function changeZoom(value: number, clientX?: number, clientY?: number) {
    const view = viewport.current, imageElement = bitmap.current;
    if (!view || !imageElement || pan.current || !canZoomRef.current()) return;
    const next = clamp(value, minZoom, maxZoom);
    if (next === zoomRef.current) return;
    const port = viewportBounds(view), rect = (canvasPicture(imageElement) ?? imageElement).getBoundingClientRect();
    const x = clientX ?? port.left + port.width / 2, y = clientY ?? port.top + port.height / 2;
    anchor.current = { x: (x - rect.left) / rect.width, y: (y - rect.top) / rect.height, clientX: x, clientY: y };
    zoomRef.current = next; setManualZoom(next);
  }
  useLayoutEffect(() => {
    const view = viewport.current, imageElement = bitmap.current;
    if (!view || !imageElement) return;
    const point = anchor.current, scale = view.currentCSSZoom || 1;
    if (point) {
      const rect = (canvasPicture(imageElement) ?? imageElement).getBoundingClientRect();
      view.scrollLeft += (rect.left + point.x * rect.width - point.clientX) / scale;
      view.scrollTop += (rect.top + point.y * rect.height - point.clientY) / scale;
      anchor.current = undefined;
    } else {
      view.scrollLeft = (view.scrollWidth - view.clientWidth) / 2;
      view.scrollTop = (view.scrollHeight - view.clientHeight) / 2;
    }
    syncCanvasScroll();
  }, [zoom, viewportSize, src, resetKey]);
  function onWheelZoom(event: WheelEvent) {
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.current!.clientHeight : 1);
    changeZoom(zoomRef.current * Math.exp(-clamp(pixels, -100, 100) * wheelScale), event.clientX, event.clientY);
  }
  function startPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (pan.current || !event.isPrimary || (event.target as Element).closest(canvasControls)) return;
    event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    pan.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
    setPanning(true);
  }
  function movePan(event: ReactPointerEvent) {
    const start = pan.current, view = viewport.current;
    if (!start || !view) return false;
    if (start.pointer === event.pointerId) {
      const scale = view.currentCSSZoom || 1;
      view.scrollLeft = start.left - (event.clientX - start.x) / scale;
      view.scrollTop = start.top - (event.clientY - start.y) / scale;
      syncCanvasScroll();
    }
    return true;
  }
  function endPan() {
    if (!pan.current) return;
    const { pointer } = pan.current;
    pan.current = undefined; setPanning(false);
    if (viewport.current?.hasPointerCapture(pointer)) viewport.current.releasePointerCapture(pointer);
    syncCanvasScroll();
  }
  return { viewport, bitmap, zoom, changeZoom, canvasPadding, minimap, panToImagePoint, syncCanvasScroll, onWheelZoom,
    pan, panning, panReady, spaceHeld, startPan, movePan, endPan };
}

export function ImageCanvasMinimap({ map, onNavigate }: { map: ImageCanvasMap; onNavigate: (x: number, y: number) => void }) {
  const image = useRef<HTMLButtonElement>(null), pointer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(() => { try { return localStorage.getItem("llmchat-image-minimap-visible") !== "false"; } catch { return true; } });
  const toggle = () => {
    setOpen(!open);
    try { localStorage.setItem("llmchat-image-minimap-visible", String(!open)); } catch { /* Keep the current view usable without browser storage. */ }
  };
  const mapIcon = <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true"><path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Zm6-2v16m6-14v16" /></svg>;
  function navigate(event: ReactPointerEvent) {
    const bounds = image.current!.getBoundingClientRect();
    onNavigate(clamp((event.clientX - bounds.left) / bounds.width, 0, 1), clamp((event.clientY - bounds.top) / bounds.height, 0, 1));
  }
  return <div className={open ? "image-canvas-minimap" : "image-canvas-minimap-toggle"} data-image-canvas-controls=""
    role="group" aria-label="画布导航" onPointerDown={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}>
    {open ? <>
      <button type="button" className="image-canvas-minimap-close" aria-label="收起小地图" data-tooltip="收起小地图" onClick={toggle}>×</button>
      <button ref={image} type="button" className="image-canvas-minimap-image" style={{ width: map.mapW, height: map.mapH }}
        aria-label="定位图片可见区域" data-tooltip="拖动小地图定位图片" onClick={event => { if (event.detail === 0) onNavigate(.5, .5); }}
        onPointerDown={event => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
          pointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); navigate(event);
        }} onPointerMove={event => { if (pointer.current === event.pointerId) navigate(event); }}
        onPointerUp={event => { pointer.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { pointer.current = undefined; }} onLostPointerCapture={() => { pointer.current = undefined; }}>
        <img src={map.url} alt="图片全貌" draggable={false} />
        <span className="image-canvas-minimap-viewport" style={map.view} aria-hidden="true" />
      </button>
    </> : <button type="button" aria-label="展开小地图" aria-expanded="false" data-tooltip="展开小地图" onClick={toggle}>{mapIcon}</button>}
  </div>;
}
