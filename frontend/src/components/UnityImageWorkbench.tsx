import { SearchHighlight, SearchTextarea } from "./SearchHighlight";
import { useGameFileDrop } from "../hooks/useGameFileDrop";
import { importSourceName,type GameImportSource } from "../gameImageImport";
import { open, save as saveDialog, confirm } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { readFileBytes } from "../localDocFile";
import { sortGameImages, exportGameImages, validateGameImageArchive, type ImageArchiveReplacement } from "../gameImageArchive";
import { createContext, useContext, useId, useDeferredValue, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { acquireUnityImagePreview, peekUnityImagePreview, unityImagePreviewKey, type ImagePreviewReader } from "../unityImagePreview";
import type { OcrMode } from "../api";
import { OCR_MODE_OPTIONS } from "../ocr/modes";
import { type UnityImage, type UnityImageRegion, type UnityProject } from "../unityOffline";
import { unityImageParticipates, unityImageUsesRegionMask, unityImageHasText, unityImageResultGroup, unityImageTranslationRegions, maskUnityImageRegions } from "../unityImages";

export const ImagePreviewReaderContext = createContext<ImagePreviewReader | undefined>(undefined);

const ImagePreview = memo(function ImagePreview({ project, image, translated, compact = false, full = false, enabled = true, zoom = 1, threshold = 50, activeRegion = -1, onRegion, onOpen, onMenu }: { project: UnityProject; image: UnityImage; translated: boolean; compact?: boolean; full?: boolean; enabled?: boolean; zoom?: number; threshold?: number; activeRegion?: number; onRegion?: (index: number) => void; onOpen?: () => void; onMenu?: (x: number, y: number) => void }) {
  const reader=useContext(ImagePreviewReaderContext);
  const key = unityImagePreviewKey(project, image, translated, compact);
  const figure = useRef<HTMLElement>(null); const [visible, setVisible] = useState(!compact);
  useEffect(() => { if (!compact || !enabled || !figure.current) return; const observer = new IntersectionObserver(entries => setVisible(entries[0]?.isIntersecting || false), { root: figure.current.closest(".unity-gallery-scroll") }); observer.observe(figure.current); return () => observer.disconnect(); }, [compact, enabled]);
  const [loaded, setLoaded] = useState<{ key: string; error?: string;url?:string }>({ key: "" });
  const [ignoreAlpha, setIgnoreAlpha] = useState(true);
  const file = translated ? image.renderedFile : image.sourceFile;
  useEffect(() => {
    if (!file || !enabled || compact && !visible) return;
    let cancelled = false; setIgnoreAlpha(true);
    const handle = acquireUnityImagePreview(project, image, translated, compact, reader);
    void handle.ready.then(() => { if (!cancelled) setLoaded({ key }); }, error => { if (!cancelled) setLoaded({ key, error: String(error) }); });
    return () => { cancelled = true; handle.release(); };
  }, [key, file, enabled, compact, visible, reader]);
  const value = peekUnityImagePreview(key);
  const effectiveRegions = unityImageTranslationRegions(image.regions, threshold,image);
  const excluded = translated&&unityImageUsesRegionMask(image) ? effectiveRegions.filter(region => !region.selected) : [];
  const maskKey = key + JSON.stringify(excluded.map(({ x0, x1, y0, y1 }) => [x0, y0, x1, y1]));
  const [masked, setMasked] = useState<{ key: string; url: string }>({ key: "", url: "" });
  useEffect(() => {
    if (!enabled || !translated || !value || !excluded.length) return;
    let cancelled = false, url = ""; const source = acquireUnityImagePreview(project, image, false, false, reader);
    void source.ready.then(async original => {
      const [raw, rendered] = await Promise.all([fetch(original.url).then(response => response.blob()), fetch(value.url).then(response => response.blob())]);
      const blob = await maskUnityImageRegions(raw, rendered, effectiveRegions);
      if (!cancelled) { url = URL.createObjectURL(blob); setLoaded({key});setMasked({ key: maskKey, url }); }
    }).catch(error => { if (!cancelled) setLoaded({ key, error: `更新译图预览失败：${String(error)}` }); });
    return () => { cancelled = true; source.release(); };
  }, [enabled, value?.url, maskKey]);
  useEffect(()=>()=>{if(masked.url)URL.revokeObjectURL(masked.url);},[masked.url]);
  const url = excluded.length ? masked.key === maskKey ? masked.url : "" : value?.url || "", opaqueUrl = value?.opaqueUrl || "", displayUrl=ignoreAlpha&&opaqueUrl?opaqueUrl:url,error = loaded.key === key&&(!loaded.url||loaded.url===displayUrl) ? loaded.error || "" : "";  return <figure ref={figure} onDoubleClick={onOpen} onContextMenu={event => { if (onMenu) { event.preventDefault(); event.stopPropagation(); onMenu(event.clientX, event.clientY); } }}>{!compact && <figcaption>{translated ? "译图" : "原图"}{opaqueUrl && <label title="原图完全透明；忽略透明度只改变预览，不改写原图缓存"><input type="checkbox" checked={ignoreAlpha} onChange={event => setIgnoreAlpha(event.target.checked)} />忽略透明度</label>}</figcaption>}{error ? <p className="unity-offline-error" role="alert">{error}</p> : url ? <div className="unity-image-preview-surface"><div className="unity-image-stage" style={{ width: full ? image.width * zoom : Math.min(image.width, (compact ? 130 : 320) * image.width / Math.max(1, image.height)) }}><img src={displayUrl} alt={`${image.name} ${translated ? "译图" : "原图"}`} draggable={false} onError={event => {if(event.currentTarget.currentSrc===displayUrl)setLoaded({ key,url:displayUrl,error: "图片解码失败，请检查原图缓存或重新扫描" });}} />{!compact && onRegion && (!translated||unityImageUsesRegionMask(image)) && <svg viewBox={`0 0 ${image.width} ${image.height}`} preserveAspectRatio="none" className="unity-image-region-overlay" aria-label="图片文字区域">{image.regions.map((region, index) => translated && !effectiveRegions[index].selected ? null : <rect key={index} x={region.x0} y={region.y0} width={Math.max(1, region.x1 - region.x0)} height={Math.max(1, region.y1 - region.y0)} role="button" tabIndex={0} aria-label={`区域 ${index + 1}：${region.text}`} className={activeRegion === index ? "is-active" : ""} onClick={() => onRegion(index)} onFocus={() => onRegion(index)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onRegion(index); } }} />)}</svg>}</div></div> : <p className="hint">{file ? "正在读取图片…" : translated ? "尚未生成译图" : image.error || "没有可读取的原图"}</p>}</figure>;
});

export function unityImageFit(width: number, height: number, availableWidth: number, availableHeight: number) {
  return Math.min(1, Math.max(1, availableWidth - 24) / Math.max(1, width), Math.max(1, availableHeight - 52) / Math.max(1, height));
}

function ImageViewer({ project, image, translated, allowDetails, threshold, onClose, onDetails }: { project: UnityProject; image: UnityImage; translated: boolean; allowDetails: boolean; threshold: number; onClose: () => void; onDetails: () => void }) {
  const [zoom, setZoom] = useState(1), [panning, setPanning] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const body = useRef<HTMLDivElement>(null), pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  useLayoutEffect(() => { if (body.current) setZoom(unityImageFit(image.width, image.height, body.current.clientWidth, body.current.clientHeight)); }, [image.width, image.height]);
  useEffect(() => {
    const element = body.current; if (!element) return;
    const wheel = (event: WheelEvent) => { event.preventDefault(); setZoom(value => Math.max(.01, Math.min(8, value * Math.exp(-event.deltaY * .002)))); };
    element.addEventListener("wheel", wheel, { passive: false }); return () => element.removeEventListener("wheel", wheel);
  }, []);
  return createPortal(<div className="unity-original-viewer" role="dialog" aria-label={translated ? "查看译图" : "查看原图"} aria-modal="true" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); else setMenu(null); }} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <section className="unity-original-viewer-window">
      <div className="unity-original-viewer-header"><strong>{image.name} · {translated ? "译图" : "原图"}</strong><div className="unity-image-button-group"><button className="unity-btn" title="缩小" aria-label="缩小图片" onClick={() => setZoom(value => Math.max(.01, value / 1.2))}>−</button><button className="unity-btn" title="恢复原始比例" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button><button className="unity-btn" title="放大" aria-label="放大图片" onClick={() => setZoom(value => Math.min(8, value * 1.2))}>+</button><button className="unity-btn unity-viewer-close" title="关闭（Esc）" aria-label="关闭图片" autoFocus onClick={onClose}>×</button></div></div>
      <div ref={body} className={`unity-original-viewer-body${panning ? " is-panning" : ""}`} onPointerDown={event => {
        if (event.button !== 0 || !(event.target as Element).closest("img")) return;
        event.preventDefault(); event.stopPropagation(); const element = event.currentTarget;
        pan.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop }; setPanning(true); element.setPointerCapture(event.pointerId);
      }} onPointerMove={event => { if (!pan.current) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.scrollLeft = pan.current.left - (event.clientX - pan.current.x); event.currentTarget.scrollTop = pan.current.top - (event.clientY - pan.current.y); }} onPointerUp={() => { pan.current = null; setPanning(false); }} onPointerCancel={() => { pan.current = null; setPanning(false); }} onLostPointerCapture={() => { pan.current = null; setPanning(false); }} onContextMenu={event => {
        event.preventDefault(); event.stopPropagation();
        if (allowDetails && (event.target as Element).closest("img")) setMenu({ x: Math.min(event.clientX, window.innerWidth - 170), y: Math.min(event.clientY, window.innerHeight - 70) });
      }}><ImagePreview project={project} image={image} translated={translated} full zoom={zoom} threshold={threshold} /></div>
    </section>
    {menu && allowDetails && <div className="unity-gallery-menu" role="menu" aria-label="图片操作" style={{ left: menu.x, top: menu.y }}><button role="menuitem" onClick={onDetails}>查看详情</button></div>}
  </div>, document.body);
}

export function unityGalleryToggle(current: Set<string>, id: string, additive: boolean) {
  const next = additive ? new Set(current) : new Set<string>();
  if (current.has(id)) next.delete(id); else next.add(id);
  return next;
}
export function unityGalleryBox(items: { id: string; left: number; top: number; right: number; bottom: number }[], box: { left: number; top: number; right: number; bottom: number }, base: Set<string>) {
  const next = new Set(base);
  for (const item of items) if (item.left < box.right && item.right > box.left && item.top < box.bottom && item.bottom > box.top) next.add(item.id);
  return next;
}

export function unityGalleryChanges(images: UnityImage[], selected: Set<string>, value: boolean) {
  return images.filter(image => selected.has(image.id) && !!image.sourceFile && image.selected !== value).map(image => ({ id: image.id, selected: image.selected }));
}
export function unityGalleryRect(start: { x: number; y: number }, point: { x: number; y: number }, width: number, height: number) {
  const x = (value: number) => Math.max(0, Math.min(width, value));
  const y = (value: number) => Math.max(0, Math.min(height, value));
  return { left: x(Math.min(start.x, point.x)), right: x(Math.max(start.x, point.x)), top: y(Math.min(start.y, point.y)), bottom: y(Math.max(start.y, point.y)) };
}

function ImageGallery({ query, project, images, allImages, filterKey, refreshKey, hidden, disabled, onSelect, onView, onOpen }: { query: string; project: UnityProject; images: UnityImage[]; allImages: UnityImage[]; filterKey: string; refreshKey:number; hidden: boolean; disabled: boolean; onSelect: (images: UnityImage[], value: boolean) => void; onView: (id: string) => void; onOpen: (id: string) => void }) {
  const [selected, setSelected] = useState(new Set<string>()), [page, setPage] = useState(0);
  const [snapshot, setSnapshot] = useState(() => images.map(image => ({ id: image.id, selected: image.selected })));
  const [history, setHistory] = useState<{ id: string; selected: boolean }[][]>([]);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const applyFilter = () => { setSnapshot(images.map(image => ({ id: image.id, selected: image.selected }))); setSelected(new Set());setHistory([]); setPage(0); };
  useEffect(applyFilter, [filterKey]);
  useEffect(()=>{setSnapshot(images.map(image=>({id:image.id,selected:image.selected})));setSelected(new Set());setHistory([]);},[refreshKey]);
  const currentImages = useMemo(() => new Map(allImages.map(image => [image.id, image])), [allImages]);
  const displayed = useMemo(() => snapshot.map(item => currentImages.get(item.id)).filter((image): image is UnityImage => !!image), [snapshot, currentImages]);
  const baseline = useMemo(() => new Map(snapshot.map(item => [item.id, item.selected])), [snapshot]);
  const change = (value: boolean) => {
    const previous = unityGalleryChanges(displayed, selected, value);
    if (!previous.length) return;
    setHistory(current => [...current, previous]); onSelect(previous.map(item => currentImages.get(item.id)!), value);
  };
  const undo = () => {
    const previous = history.at(-1); if (!previous || disabled) return;
    for (const value of [true, false]) onSelect(previous.filter(item => item.selected === value).map(item => currentImages.get(item.id)).filter((image): image is UnityImage => !!image), value);
    setHistory(current => current.slice(0, -1));
  };
  const [box, setBox] = useState<{ left: number; top: number; right: number; bottom: number } | null>(null);
  const grid = useRef<HTMLDivElement>(null), scroller = useRef<HTMLDivElement>(null), suppressClick = useRef(false);
  const scrollPosition = useRef(0);
  useEffect(() => { if (!hidden) { const frame = requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollTop = scrollPosition.current; }); return () => cancelAnimationFrame(frame); } }, [hidden]);
  const drag = useRef<{ x: number; y: number; base: Set<string>; moved: boolean; onCard: boolean } | null>(null);
  const pages = Math.max(1, Math.ceil(displayed.length / 24)), currentPage = Math.min(page, pages - 1), visible = displayed.slice(currentPage * 24, (currentPage + 1) * 24);
  const chosen = displayed.filter(image => selected.has(image.id));
  const point = (event: React.PointerEvent) => { const rect = grid.current!.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  return <div className="unity-image-gallery" title="Ctrl+A 选择当前页图片；Ctrl 多选；拖动框选；双击查看原图；右键查看详情；Ctrl+Z 撤销批量操作" style={hidden ? { display: "none" } : undefined} onClick={() => setMenu(null)} onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); setSelected(new Set(visible.map(image => image.id))); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); undo(); }
    if (event.key === "Escape") { if (menu) setMenu(null); else setSelected(new Set()); drag.current = null; setBox(null); }
  }} role="listbox" aria-label="原图缩略图" aria-multiselectable="true" tabIndex={0} onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }} onPointerDown={event => {
      if (event.button !== 0) return;
      suppressClick.current = false;
      if ((event.target as Element).closest("button,input,select,textarea,[role=menu],[role=dialog]")) return;
      const viewport = scroller.current?.getBoundingClientRect();
      if (viewport && scroller.current && event.clientY >= viewport.top && event.clientY <= viewport.bottom && event.clientX >= viewport.left + scroller.current.clientWidth) return;
      event.preventDefault(); const p = point(event), base = event.ctrlKey || event.metaKey ? new Set(selected) : new Set<string>();
      event.currentTarget.focus(); suppressClick.current = false;
      drag.current = { ...p, base, moved: false, onCard: !!(event.target as Element).closest('[data-gallery-id]') };
    }} onPointerMove={event => {
      if (!drag.current) return;
      const p = point(event), start = drag.current;
      if (!start.moved && Math.hypot(p.x - start.x, p.y - start.y) < 4) return;
      if (!start.moved) { start.moved = true; event.currentTarget.setPointerCapture(event.pointerId); }
      const rect = unityGalleryRect(start, p, grid.current!.offsetWidth, grid.current!.offsetHeight);
      const origin = grid.current!.getBoundingClientRect();
      const items = Array.from(grid.current!.querySelectorAll<HTMLElement>('[data-gallery-id]')).map(item => { const r = item.getBoundingClientRect(); return { id: item.dataset.galleryId!, left: r.left - origin.left, right: r.right - origin.left, top: r.top - origin.top, bottom: r.bottom - origin.top }; });
      setBox(rect); setSelected(unityGalleryBox(items, rect, start.base));
      const viewport = scroller.current?.getBoundingClientRect();
      if (viewport && scroller.current) { if (event.clientY < viewport.top + 24) scroller.current.scrollTop -= 24; else if (event.clientY > viewport.bottom - 24) scroller.current.scrollTop += 24; }
    }} onPointerUp={() => { if (drag.current?.moved) suppressClick.current = true; else if (drag.current && !drag.current.onCard) setSelected(drag.current.base); drag.current = null; setBox(null); }} onPointerCancel={() => { drag.current = null; setBox(null); }}>
    <div className="unity-gallery-actions"><span>已选 {chosen.length} 张</span><div className="unity-image-button-group"><button className="unity-btn" disabled={disabled || !chosen.length} title="勾选所选图片，允许后续处理和生成补丁；保留当前列表位置" onClick={() => change(true)}>批量勾选</button><button className="unity-btn" disabled={disabled || !chosen.length} title="取消所选图片的处理与补丁勾选，保留识别结果和译文" onClick={() => change(false)}>批量取消勾选</button></div></div>
    <div ref={scroller} className="unity-gallery-scroll" onScroll={event => { if (!hidden) scrollPosition.current = event.currentTarget.scrollTop; }}><div ref={grid} className="unity-gallery-grid">
      {visible.map(image => <div key={image.id} data-gallery-id={image.id} role="option" aria-selected={selected.has(image.id)} tabIndex={0} className={`unity-gallery-card${baseline.get(image.id) !== image.selected ? image.selected ? " became-checked" : " became-unchecked" : ""}${selected.has(image.id) ? " is-selected" : ""}`} onClick={event => setSelected(current => unityGalleryToggle(current, image.id, event.ctrlKey || event.metaKey))} onDoubleClick={() => onOpen(image.id)} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setSelected(current => current.has(image.id) ? current : new Set([image.id])); setMenu({ id: image.id, x: Math.min(event.clientX, window.innerWidth - 170), y: Math.min(event.clientY, window.innerHeight - 110) }); }} onKeyDown={event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); setSelected(current => unityGalleryToggle(current, image.id, event.ctrlKey || event.metaKey)); } }}>
        <ImagePreview project={project} image={image} translated={false} compact enabled={!hidden} /><strong title={image.name}><SearchHighlight text={image.name} query={query} /></strong><small>{image.width} × {image.height} · {image.selected ? "已勾选" : "未勾选"}</small>
      </div>)}
      {box && <div className="unity-gallery-selection-box" style={{ left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top }} />}
    </div></div>
    <div className="unity-gallery-pages"><button className="unity-btn" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage + 1} / {pages}</span><button className="unity-btn" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button></div>
    {menu && <div className="unity-gallery-menu" role="menu" aria-label="图片操作" style={{ left: menu.x, top: menu.y }}><button role="menuitem" onClick={() => { setMenu(null); onOpen(menu.id); }}>查看原图</button><button role="menuitem" onClick={() => { setMenu(null); onView(menu.id); }}>查看详情</button></div>}
  </div>;
}

export function UnityImageWorkbench({ project, disabled, active = true, dirty = false, saving = false, saveNotice = "", ocrMode = "fast", onRecognize, onTranslate, confidenceThreshold = 50, onChange, onChangeMany, onRender, onImport, onSave, onDiscard, leaveGuard,onImportArchive,onArchiveMessage }: {
  project: UnityProject | null; disabled: boolean; active?: boolean; dirty?: boolean; saving?: boolean; saveNotice?: string; ocrMode?: OcrMode; onRecognize?: (image: UnityImage, mode: OcrMode) => void; onTranslate?:(image:UnityImage)=>void; confidenceThreshold?: number;
  onChange: (image: UnityImage) => void; onChangeMany?: (images: UnityImage[]) => void; onRender: (image: UnityImage) => void;
  onImportArchive:(items:ImageArchiveReplacement[])=>Promise<boolean>;onArchiveMessage:(text:string,error?:boolean)=>void;
  onImport: (image: UnityImage,source?:GameImportSource) => Promise<unknown>; onSave: () => Promise<boolean>;onDiscard:()=>Promise<boolean>;leaveGuard?:{current:((change:()=>void)=>void)|null};
}) {
  const reader=useContext(ImagePreviewReaderContext);
  const [viewer, setViewer] = useState<{ id: string; translated: boolean; allowDetails: boolean } | null>(null);
  const [previewMenu, setPreviewMenu] = useState<{ id: string; translated: boolean; x: number; y: number } | null>(null);
  const openViewer = (id: string, translated: boolean, allowDetails: boolean) => { setPreviewMenu(null); setViewer({ id, translated, allowDetails }); };
  useEffect(() => { if (!active) { setViewer(null); setPreviewMenu(null); } }, [active]);
  const [detailMode, setDetailMode] = useState<OcrMode>(ocrMode);
  const [selectedId, setSelectedId] = useState(""), [search, setSearch] = useState("");
  const [pendingFilter,setPendingFilter]=useState<null|(()=>void)>(null),[resolvingFilter,setResolvingFilter]=useState(false),[filterRevision,setFilterRevision]=useState(0);
  const requestChange=(change:()=>void,refresh=true)=>{const apply=()=>{change();if(refresh)setFilterRevision(value=>value+1);};if(dirty){filterMenu.current?.hidePopover();setPendingFilter(()=>apply);}else apply();};
  const requestFilter=(change:()=>void)=>requestChange(change);
  const [viewRevision,setViewRevision]=useState(0);
  const requestView=(change:()=>void)=>requestChange(()=>{change();setViewRevision(value=>value+1);},false);
  useEffect(()=>{if(!active||!leaveGuard)return;const guard=(change:()=>void)=>requestChange(change,false);leaveGuard.current=guard;return()=>{if(leaveGuard.current===guard)leaveGuard.current=null;};},[active,dirty,leaveGuard]);
  const resolveFilter=async(action:"save"|"discard")=>{if(!pendingFilter||resolvingFilter)return;setResolvingFilter(true);try{if(await(action==="save"?onSave():onDiscard())){pendingFilter();setPendingFilter(null);}}finally{setResolvingFilter(false);}};
  const allFilters={checked:true,unchecked:true,done:true,pending:true,failed:true};
  const [imageFilters,setImageFilters]=useState(allFilters);
  const filterMenu=useRef<HTMLDivElement>(null),filterId=useId();
  useEffect(()=>{if(!active){filterMenu.current?.hidePopover();setPendingFilter(null);droppedImportDone.current?.();droppedImportDone.current=null;}},[active]);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ empty: true });
  const [galleryScope,setGalleryScope]=useState<string|null>(null);
  const [groupMenu,setGroupMenu]=useState<{group:string;label:string;x:number;y:number}|null>(null);
  useEffect(()=>{if(!groupMenu)return;const close=()=>setGroupMenu(null);const key=(event:KeyboardEvent)=>{if(event.key==="Escape")close();};window.addEventListener("click",close);window.addEventListener("scroll",close,true);window.addEventListener("resize",close);window.addEventListener("keydown",key);return()=>{window.removeEventListener("click",close);window.removeEventListener("scroll",close,true);window.removeEventListener("resize",close);window.removeEventListener("keydown",key);};},[groupMenu]);
  const [gallery, setGallery] = useState(false), [galleryVisited, setGalleryVisited] = useState(false), [returnToGallery, setReturnToGallery] = useState(false), [activeRegion, setActiveRegion] = useState(-1);
  const [selectedRegions,setSelectedRegions]=useState<ReadonlySet<number>>(new Set());
  const [regionMenu,setRegionMenu]=useState<{x:number;y:number}|null>(null);
  useEffect(()=>{if(!regionMenu)return;const close=()=>setRegionMenu(null);window.addEventListener("click",close);window.addEventListener("resize",close);window.addEventListener("scroll",close,true);return()=>{window.removeEventListener("click",close);window.removeEventListener("resize",close);window.removeEventListener("scroll",close,true);};},[regionMenu]);
  const workbench = useRef<HTMLElement>(null);
  useEffect(() => { setSelectedId(""); setSearch(""); setGalleryScope(null); setGroupMenu(null); setCollapsed({ empty: true }); setImageFilters(allFilters); setGallery(false); setGalleryVisited(false); setReturnToGallery(false); setViewer(null); setPreviewMenu(null);
    if (!disabled) {const changed=(project?.images||[]).filter(image=>image.ocrCompleted&&!unityImageHasText(image)&&!image.renderedFile&&image.selected&&!image.selectionManual).map(image=>({...image,selected:false}));if(onChangeMany)onChangeMany(changed);else changed.forEach(onChange);} }, [project?.folder]);
  const viewBaseline=useRef(new Map<string,{selected:boolean;completed:boolean;error:string;group:ReturnType<typeof unityImageResultGroup>}>());
  const baselineFolder=useRef(project?.folder);
  const images=useMemo(()=>{
    const rows=(project?.images||[]).filter(unityImageParticipates);
    if(!dirty||baselineFolder.current!==project?.folder){viewBaseline.current=new Map(rows.map(image=>[image.id,{selected:image.selected,completed:image.completed,error:image.error,group:unityImageResultGroup(image)}]));baselineFolder.current=project?.folder;}
    return sortGameImages(rows,new Map([...viewBaseline.current].map(([id,value])=>[id,value.selected])));
  },[project?.images,project?.folder,dirty]);
  const searchCache=useRef(new WeakMap<UnityImage,string>());
  const searchIndex=useMemo(()=>images.map(image=>{let text=searchCache.current.get(image);if(text===undefined){text=(image.name+" "+image.file+" "+image.regions.map(region=>region.text+" "+region.translation).join(" ")).toLowerCase();searchCache.current.set(image,text);}return {image,text};}),[images]);
  const deferredSearch=useDeferredValue(search.trim().toLowerCase());
  const imageSearchSnapshot=useRef<{key:string;ids:Set<string>}|null>(null);
  const imageSearchKey=JSON.stringify([project?.folder,deferredSearch,viewRevision,filterRevision]);
  const searchMatches=useMemo(()=>{
    if(dirty&&imageSearchSnapshot.current?.key===imageSearchKey)return imageSearchSnapshot.current.ids;
    const ids=new Set(searchIndex.filter(item=>!deferredSearch||item.text.includes(deferredSearch)).map(item=>item.image.id));
    imageSearchSnapshot.current={key:imageSearchKey,ids};return ids;
  },[searchIndex,deferredSearch,dirty,imageSearchKey]);
  const filtered=useMemo(()=>images.filter(image=>{const view=viewBaseline.current.get(image.id)||image;return (view.selected?imageFilters.checked:imageFilters.unchecked)&&(view.error?imageFilters.failed:view.completed?imageFilters.done:imageFilters.pending)&&searchMatches.has(image.id);}),[images,searchMatches,imageFilters,dirty]);
  const groups=useMemo(()=>{const result:{[key:string]:{items:UnityImage[];eligible:number;checked:number}}={candidate:{items:[],eligible:0,checked:0},text:{items:[],eligible:0,checked:0},pending:{items:[],eligible:0,checked:0},failed:{items:[],eligible:0,checked:0},empty:{items:[],eligible:0,checked:0},review:{items:[],eligible:0,checked:0},excluded:{items:[],eligible:0,checked:0}};for(const item of filtered){const group=result[dirty?viewBaseline.current.get(item.id)?.group||unityImageResultGroup(item):unityImageResultGroup(item)];group.items.push(item);if(item.sourceFile){group.eligible++;if(item.selected)group.checked++;}}return result;},[filtered,dirty]);
  const [groupPages,setGroupPages]=useState<Record<string,number>>({});
  useEffect(()=>setGroupPages({}),[deferredSearch,imageFilters,project?.folder]);
  const counts=useMemo(()=>({selected:images.filter(item=>item.selected).length,done:images.filter(item=>item.selected&&item.completed).length,failed:images.filter(item=>item.error).length}),[images]);
  const image = (returnToGallery ? images : filtered).find(image => image.id === selectedId) || filtered.find(item=>item.screening?.state==="candidate") || filtered.find(unityImageHasText) || filtered[0];
  useEffect(() => { setActiveRegion(-1);setSelectedRegions(new Set());setRegionMenu(null); setDetailMode(ocrMode); }, [image?.id, ocrMode]);
  const locateRegion = (index: number) => { setActiveRegion(index);setSelectedRegions(new Set([index])); workbench.current?.querySelector<HTMLElement>(`[data-region-index="${index}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); };
  const selectImages = (items: UnityImage[], selected: boolean) => {const changed=items.filter(item=>item.sourceFile&&item.selected!==selected).map(item=>({...item,selected}));if(onChangeMany)onChangeMany(changed);else changed.forEach(onChange);};
  const edit = (index: number, patch: Partial<UnityImageRegion>) => image && onChange({ ...image, completed: image.renderedKind==="imported"?image.completed:false, error: "", regions: image.regions.map((region, i) => i === index ? { ...region, ...patch, error: "" } : region) });
  const renderRegions=image?unityImageTranslationRegions(image.regions,confidenceThreshold,image).filter(region=>region.selected):[];
  const renderHint=!image?.ocrCompleted?"请先识别图片":!renderRegions.length?"没有勾选区域，将保留原图生成译图":renderRegions.some(region=>!region.translation.trim())?"勾选区域还有空译文，请先翻译图片或填写译文":"使用当前勾选区域与现有译文重新嵌字，不重新识别或翻译";
  const focusedDetail = returnToGallery && !gallery;
  const viewerImage = viewer && images.find(item => item.id === viewer.id);
  const checkAllRegions=(selected:boolean)=>{if(!image||disabled)return;onChange({...image,completed:image.renderedKind==="imported"?image.completed:false,error:"",regions:image.regions.map(region=>({...region,selected,manualSelected:selected}))});setRegionMenu(null);};
  const droppedImportDone=useRef<(()=>void)|null>(null);
  const cancelPending=()=>{setPendingFilter(null);droppedImportDone.current?.();droppedImportDone.current=null;};
  const [archiveBusy,setArchiveBusy]=useState("");
  const saveCurrent=async()=>{if(await onSave())setViewRevision(value=>value+1);};
  const discardCurrent=async()=>{if(!await confirm("取消当前尚未保存的图片勾选、区域和译文修改？已保存内容保留。",{title:"取消当前修改",kind:"warning",okLabel:"取消当前修改",cancelLabel:"返回"}))return;if(await onDiscard())setViewRevision(value=>value+1);};
  const exportArchive=async()=>{if(!project)return;const selected=images.filter(image=>image.selected);if(!selected.length)return;
    const path=await saveDialog({defaultPath:"selected-images.zip",filters:[{name:"图片压缩包",extensions:["zip"]}]});if(!path)return;
    setArchiveBusy("导出");try{const bytes=await exportGameImages(selected,async image=>reader?reader(image,false,false,new AbortController().signal):new Blob([await readFileBytes(project.folder+"/"+image.sourceFile)],{type:"image/png"}),text=>setArchiveBusy(text));await invoke("write_file_bytes",{path,contents:Array.from(bytes)});onArchiveMessage(`已导出 ${selected.length} 张图片：${path}`);}catch(error){onArchiveMessage(error instanceof Error?error.message:String(error),true);}finally{setArchiveBusy("");}};
  const importArchive=async(source?:GameImportSource)=>{const path=source||await open({multiple:false,filters:[{name:"图片压缩包",extensions:["zip"]}]});if(!path)return;setArchiveBusy("校验压缩包");
    try{const result=await validateGameImageArchive(typeof path==="string"?await readFileBytes(path):await path.arrayBuffer(),images);if(result.replacements.length&&!await onImportArchive(result.replacements))return;onArchiveMessage(`图片包导入：替换 ${result.replacements.length} 张，忽略不存在的对象 ${result.ignored} 个，跳过未提供的图片 ${result.missing} 张`);}catch(error){onArchiveMessage(error instanceof Error?error.message:String(error),true);}finally{setArchiveBusy("");}};
  const fileDrop=useGameFileDrop({active:active&&!disabled&&!archiveBusy,root:workbench,
    match:(target,names)=>{if(names.length>1)return null;const name=names[0]||"";if(!name||/\.(png|jpe?g|webp|bmp)$/i.test(name)){const detail=target?.closest<HTMLElement>(".unity-image-detail");if(detail&&image)return detail;}return /\.zip$/i.test(name)||!name?workbench.current:null;},
    label:target=>target.classList.contains("unity-image-detail")?"松开以替换当前图片的译图":"松开以导入图片 ZIP",
    drop:async(source,target)=>{if(/\.zip$/i.test(importSourceName(source))){if(dirty)await new Promise<void>(resolve=>{droppedImportDone.current=resolve;requestFilter(()=>void importArchive(source).finally(()=>{droppedImportDone.current=null;resolve();}));});else await importArchive(source);}else if(image&&target.classList.contains("unity-image-detail"))await onImport(image,source);},
    error:text=>onArchiveMessage(text,true)
  });
  const showDetails = (id: string) => requestView(()=>{ setViewer(null); setSelectedId(id); setReturnToGallery(true); setGallery(false); });
  const toggleGallery=()=>requestView(()=>{if(gallery){setGallery(false);setReturnToGallery(false);}else{setGalleryVisited(true);setGallery(true);}});

  return <section data-game-drop-zone="images" {...fileDrop.handlers} ref={workbench} onClick={() => setPreviewMenu(null)} className="unity-offline-workbench unity-image-workbench" aria-label="图片识别与翻译结果">
    {focusedDetail ? null : <div className="unity-offline-toolbar unity-image-toolbar"><button className="unity-btn" onClick={toggleGallery} title={gallery ? "返回文字区域并更新筛选结果" : "批量查看原图并调整勾选状态"}>{gallery ? "返回文字区域" : returnToGallery ? "返回缩略图位置" : "原图批量阅览"}</button><button type="button" className="unity-image-filter-trigger" aria-label="筛选图片" aria-controls={filterId} aria-haspopup="dialog" title="筛选图片" onClick={event=>{const menu=filterMenu.current!;if(menu.matches(":popover-open")){menu.hidePopover();return;}const rect=event.currentTarget.getBoundingClientRect();Object.assign(menu.style,{left:`${Math.max(8,Math.min(rect.left,window.innerWidth-248))}px`,top:`${Math.min(rect.bottom+6,window.innerHeight-320)}px`});menu.showPopover();}}><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg></button>
{createPortal(<div ref={filterMenu} id={filterId} popover="auto" role="dialog" aria-label="图片筛选" className="unity-image-filter-menu">
<div className="unity-image-filter-presets"><button type="button" onClick={()=>requestFilter(()=>setImageFilters(allFilters))}>全部选取</button><button type="button" onClick={()=>requestFilter(()=>setImageFilters({checked:false,unchecked:false,done:false,pending:false,failed:false}))}>取消全部选取</button></div>
{([["checked","已勾选"],["unchecked","未勾选"],["pending","未完成"],["failed","失败"],["done","已完成"]] as const).map(([key,label])=><label key={key}><input type="checkbox" checked={imageFilters[key]} onChange={event=>{const checked=event.currentTarget.checked;requestFilter(()=>setImageFilters(current=>({...current,[key]:checked})));}}/>{label}</label>)}
</div>,document.body)}<button className="unity-btn unity-text-action" aria-label="下载图片" disabled={disabled||!!archiveBusy||!counts.selected} title="下载所有已勾选图片及定位清单为 ZIP；同名资源保留独立编号" onClick={()=>void exportArchive()}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/></svg>下载</button><button className="unity-btn unity-text-action" aria-label="导入图片" disabled={disabled||!!archiveBusy} title="导入本软件导出的 ZIP，校验定位信息、原资源版本和 PNG 尺寸后替换译图" onClick={()=>requestFilter(()=>void importArchive())}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 16V4m-5 5 5-5 5 5M4 17v4h16v-4"/></svg>导入</button>{archiveBusy&&<span role="status">{archiveBusy}</span>}<span className="unity-image-statistics">{images.length} 张图片 · 已选 {counts.selected} 张 · 已完成 {counts.done} 张{counts.failed ? ` · 失败 ${counts.failed} 张` : ""}</span><input type="search" placeholder="搜索" aria-label="搜索游戏图片" title="搜索名称、路径、原文和译文" value={search} onChange={event => {const value=event.currentTarget.value;requestFilter(()=>setSearch(value));}} /><button className="unity-btn unity-image-discard" disabled={disabled||!dirty||saving||!!archiveBusy} title="取消当前未保存的图片修改，需要再次确认" onClick={()=>void discardCurrent()}>取消当前修改</button><button className="unity-btn" disabled={disabled || !!archiveBusy || !project || !dirty || saving} title="保存图片勾选状态、识别区域和图片译文修改" onClick={()=>void saveCurrent()}>保存图片与译文修改</button>{(saving || saveNotice === "保存失败") && <span className="hint" role="status">{saving ? "保存中…" : saveNotice}</span>}</div>}
    {!project || (project.scanRevision || 0) < 5 ? <div className="unity-offline-empty">请更新扫描以提取游戏图片；已有文本和译文保留。</div> : !images.length ? <div className="unity-offline-empty">未扫描到可读取的图片资源，可以跳过步骤 2.2。</div> : <>{galleryVisited && project && <ImageGallery query={deferredSearch} project={project} images={galleryScope?groups[galleryScope].items:filtered} allImages={images} filterKey={JSON.stringify([search,imageFilters,galleryScope,filterRevision])} refreshKey={viewRevision} hidden={!gallery || !active} disabled={disabled||!!archiveBusy} onSelect={selectImages} onView={showDetails} onOpen={id => openViewer(id, false, true)} />}{!gallery && <div className="unity-image-body">
      {!focusedDetail && <div className="unity-image-list" aria-label="游戏图片列表">{([['candidate','待正式识别'], ['text', '识别到文字'], ['pending', '未执行 OCR'], ['failed', '识别失败'], ['empty', '未检测到文字'], ['review','待复核'], ['excluded','无需翻译']] as const).map(([group, label]) => {
        const {items,eligible,checked}=groups[group];const pages=Math.max(1,Math.ceil(items.length/60)),page=Math.min(groupPages[group]||0,pages-1);const visible=collapsed[group]?[]:items.slice(page*60,(page+1)*60);const changePage=(next:number)=>{setGroupPages(current=>({...current,[group]:next}));setSelectedId(items[next*60]?.id||"");};
        return items.length > 0 && <details key={group} className={`unity-image-result-group${groupMenu?.group===group?" is-context-selected":""}`} open={!collapsed[group]} onToggle={event => { const closed = !event.currentTarget.open; setCollapsed(previous => previous[group] === closed ? previous : { ...previous, [group]: closed }); }}><summary onContextMenu={event=>{event.preventDefault();setGroupMenu({group,label,x:Math.max(8,Math.min(event.clientX,window.innerWidth-200)),y:Math.max(8,Math.min(event.clientY,window.innerHeight-52))});}}><span>{label} · {items.length}</span><input className="unity-image-group-check" type="checkbox" aria-label={`${checked===eligible&&eligible>0?"取消全选":"全选"}：${label}`} title={`${checked===eligible&&eligible>0?"取消本组全部勾选":"勾选本组全部图片"}（包含其他分页）`} disabled={disabled || !!archiveBusy || !eligible} checked={eligible>0&&checked===eligible} ref={node=>{if(node)node.indeterminate=checked>0&&checked<eligible;}} onClick={event=>event.stopPropagation()} onChange={event=>selectImages(items,event.target.checked)}/></summary>{visible.map(item => <div key={item.id} className={`unity-image-item${item.id === image?.id ? " is-selected" : ""}${item.error ? " has-error" : ""}`}>
        <input type="checkbox" aria-label={`选择图片 ${item.name}`} disabled={disabled || !!archiveBusy || !item.sourceFile} checked={item.selected} onChange={event => onChange({ ...item, selected: event.target.checked })} />
        <button onClick={() => setSelectedId(item.id)} title={item.file}><strong><SearchHighlight text={item.name} query={deferredSearch} /></strong><small>{item.width} × {item.height} · {item.completed ? unityImageHasText(item) ? "已完成" : "未识别出文字" : item.error ? "识别或处理失败" : item.ocrCompleted ? "已识别" : item.screening?.state==="candidate"?"待正式识别":"未执行 OCR"}{item.screening ? ` · ${item.screening.reason}` : ""}</small></button>
      </div>)}{!collapsed[group]&&pages>1&&<div className="unity-image-list-pages" aria-label={`${label}列表分页`}><button type="button" disabled={page===0} onClick={()=>changePage(page-1)}>上一页</button><span>{page+1} / {pages}</span><button type="button" disabled={page===pages-1} onClick={()=>changePage(page+1)}>下一页</button></div>}</details>;
      })}</div>}
      {!focusedDetail && !filtered.length && <div className="unity-offline-empty">没有符合筛选条件的图片。</div>}
      {image && <div className="unity-image-detail" tabIndex={0} aria-label="当前图片详情" onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="a"){event.preventDefault();event.stopPropagation();setSelectedRegions(new Set(image.regions.map((_,index)=>index)));setActiveRegion(-1);}if(event.key==="Escape")setRegionMenu(null);}} onContextMenu={event=>{event.preventDefault();event.stopPropagation();setRegionMenu({x:Math.max(8,Math.min(event.clientX,window.innerWidth-190)),y:Math.max(8,Math.min(event.clientY,window.innerHeight-90))});}}>
        <div className="unity-image-actions">{focusedDetail && <button className="unity-btn unity-image-back" aria-label="返回缩略图位置" title="返回原来的缩略图位置" onClick={() => requestView(()=>setGallery(true))}>←</button>}<strong title={image.file}><SearchHighlight text={image.name} query={deferredSearch} />{deferredSearch && image.file.toLowerCase().includes(deferredSearch) && <small className="search-matched-field"><SearchHighlight text={image.file} query={deferredSearch} /></small>}</strong><div className="unity-image-button-group"><select aria-label="当前图片识别模型" title="选择重新识别当前图片时使用的本地模型，不影响其他图片" value={detailMode} disabled={disabled||!!archiveBusy} onChange={event => setDetailMode(event.target.value as OcrMode)}>{OCR_MODE_OPTIONS.map(mode => <option key={mode.id} value={mode.id}>{mode.title}</option>)}</select><button className="unity-btn unity-image-text-action" aria-label="重新识别" title="仅使用所选模型重新识别当前图片，不调用翻译引擎；已有译文会在确认后替换" disabled={disabled || !!archiveBusy || !onRecognize || !image.sourceFile} onClick={() => onRecognize?.(image, detailMode)}>识别</button><button className="unity-btn unity-image-text-action" aria-label="翻译当前图片" title="仅翻译当前图片的勾选区域，覆盖这些区域的已有译文；未勾选区域保留" disabled={disabled||!onTranslate||!image.ocrCompleted||!renderRegions.length} onClick={()=>onTranslate?.(image)}>翻译</button><button className="unity-btn unity-image-text-action" aria-label="重新生成译图" disabled={disabled || !!archiveBusy || !image.sourceFile || !image.ocrCompleted} title={renderHint} onClick={() => onRender(image)}>重绘</button><button className="unity-btn unity-image-text-action" aria-label="替换译图" disabled={disabled || !!archiveBusy || !image.sourceFile} title="选择同尺寸静态图片替换当前译图，导入时转为 PNG；也可直接拖入详情" onClick={() => onImport(image)}>替换</button>{focusedDetail&&<button className="unity-btn unity-image-discard" disabled={disabled||!!archiveBusy||!dirty||saving} onClick={()=>void discardCurrent()}>取消当前修改</button>}{focusedDetail && <button className="unity-btn" disabled={disabled || !!archiveBusy || !dirty || saving} title="保存图片与译文编辑内容" onClick={()=>void saveCurrent()}>{saving ? "保存中…" : "保存图片与译文修改"}</button>}{focusedDetail && saveNotice === "保存失败" && <span role="status">{saveNotice}</span>}</div></div>
        {image.error && <p className="unity-offline-error" role="alert">{image.error}</p>}
        <div className="unity-image-previews"><ImagePreview project={project} image={image} translated={false} enabled={active} threshold={confidenceThreshold} activeRegion={activeRegion} onRegion={locateRegion} onOpen={() => openViewer(image.id, false, false)} onMenu={(x, y) => setPreviewMenu({ id: image.id, translated: false, x, y })} /><ImagePreview project={project} image={image} translated enabled={active} threshold={confidenceThreshold} activeRegion={activeRegion} onRegion={locateRegion} onOpen={image.renderedFile ? () => openViewer(image.id, true, false) : undefined} onMenu={image.renderedFile ? (x, y) => setPreviewMenu({ id: image.id, translated: true, x, y }) : undefined} /></div>
        <div className="unity-image-regions">{unityImageTranslationRegions(image.regions,confidenceThreshold,image).map((region, index) => <div key={index} data-region-index={index} tabIndex={0} className={`unity-image-region${activeRegion === index||selectedRegions.has(index) ? " is-active" : ""}`} onClick={() => {setActiveRegion(index);setSelectedRegions(new Set([index]));}} onFocus={() => setActiveRegion(index)}>
          <label title="低于置信度阈值的区域不自动翻译，可手动勾选后处理"><input type="checkbox" checked={region.selected && (region.confidence >= confidenceThreshold || !!region.manualSelected)} disabled={disabled||!!archiveBusy} onChange={event => edit(index, { selected: event.target.checked, manualSelected: event.target.checked })} />区域 {index + 1} · 置信度 {(Math.floor(region.confidence * 10) / 10).toFixed(1)}%{region.reviewReason ? ` · 待复核：${region.reviewReason}` : ""}{region.confidence < confidenceThreshold ? " · 低于阈值" : ""}</label>
          <label>原文<SearchTextarea query={deferredSearch} value={region.text} rows={1} disabled={disabled||!!archiveBusy} onChange={event => edit(index, { text: event.target.value, translation: "" })} /></label>
          <label>译文<SearchTextarea query={deferredSearch} value={region.translation} rows={1} disabled={disabled||!!archiveBusy} onChange={event => edit(index, { translation: event.target.value })} /></label>
          <details className="unity-image-position"><summary>位置</summary><div className="unity-image-coordinates">{(["x0", "y0", "x1", "y1"] as const).map(key => <label key={key}>{({ x0: "左", y0: "上", x1: "右", y1: "下" })[key]}<input type="number" min={0} max={key.startsWith("x") ? image.width : image.height} value={Math.round(region[key])} disabled={disabled||!!archiveBusy} onChange={event => edit(index, { [key]: Number(event.target.value) })} /></label>)}</div></details>
          {region.error && <p className="unity-offline-error">{region.error}</p>}
        </div>)}</div>
      </div>}
    </div>}</>}

    {regionMenu&&createPortal(<div className="unity-gallery-menu" role="menu" aria-label="当前图片区域操作" style={{left:regionMenu.x,top:regionMenu.y}}><button type="button" role="menuitem" disabled={disabled||!image?.regions.length} onClick={()=>checkAllRegions(true)}>全部勾选</button><button type="button" role="menuitem" disabled={disabled||!image?.regions.length} onClick={()=>checkAllRegions(false)}>全部取消勾选</button></div>,document.body)}
    {fileDrop.overlay}
    {pendingFilter&&createPortal(<div className="unity-image-unsaved-backdrop" onKeyDown={event=>{if(event.key==="Escape"&&!resolvingFilter)cancelPending();}}><section role="dialog" aria-modal="true" aria-label="未保存的图片修改" className="unity-image-unsaved-dialog"><p>图片修改尚未保存，请选择如何处理。</p><div><button type="button" disabled={resolvingFilter} onClick={()=>void resolveFilter("save")}>保存修改</button><button type="button" disabled={resolvingFilter} onClick={()=>void resolveFilter("discard")}>取消修改</button><button type="button" autoFocus disabled={resolvingFilter} onClick={cancelPending}>取消</button></div></section></div>,document.body)}
    {groupMenu&&createPortal(<div className="unity-gallery-menu" role="menu" aria-label={`${groupMenu.label}图片操作`} style={{left:groupMenu.x,top:groupMenu.y}}><button role="menuitem" onClick={()=>{const group=groupMenu.group;setGroupMenu(null);requestFilter(()=>{setGalleryScope(group);setGalleryVisited(true);setGallery(true);setReturnToGallery(false);});}}>批量查看：{groupMenu.label}</button></div>,document.body)}
    {previewMenu && <div className="unity-gallery-menu" role="menu" aria-label="预览图片操作" style={{ left: Math.min(previewMenu.x, window.innerWidth - 170), top: Math.min(previewMenu.y, window.innerHeight - 70) }}><button role="menuitem" onClick={() => openViewer(previewMenu.id, previewMenu.translated, false)}>{previewMenu.translated ? "查看译图" : "查看原图"}</button></div>}
    {active && project && viewer && viewerImage && <ImageViewer key={viewer.id + String(viewer.translated)} project={project} image={viewerImage} translated={viewer.translated} allowDetails={viewer.allowDetails} threshold={confidenceThreshold} onClose={() => setViewer(null)} onDetails={() => showDetails(viewer.id)} />}
  </section>;
}
