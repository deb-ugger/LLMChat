import { useEffect, useRef, useState } from "react";
import { readFileBytes } from "../localDocFile";
import { unityRun, type UnityImage, type UnityImageRegion, type UnityProject } from "../unityOffline";
import { unityImageParticipates, unityImageHasText, unityImageResultGroup, unityImageTranslationRegions } from "../unityImages";

let activePreviews = 0;
const previewWaiters: (() => void)[] = [];
async function loadPreview(project: UnityProject, image: UnityImage, cancelled: () => boolean) {
  if (activePreviews >= 3) await new Promise<void>(resolve => previewWaiters.push(resolve));
  activePreviews++;
  try { if (cancelled()) return null; return await unityRun<{ data: string; opaque: string; fullyTransparent: boolean }>("preview-image", { path: project.folder, imageId: image.id }); }
  finally { activePreviews--; previewWaiters.shift()?.(); }
}

function ImagePreview({ project, image, translated, compact = false, activeRegion = -1, onRegion }: { project: UnityProject; image: UnityImage; translated: boolean; compact?: boolean; activeRegion?: number; onRegion?: (index: number) => void }) {
  const [url, setUrl] = useState(""), [error, setError] = useState("");
  const [opaqueUrl, setOpaqueUrl] = useState(""), [ignoreAlpha, setIgnoreAlpha] = useState(false);
  const file = translated ? image.renderedFile : image.sourceFile;
  useEffect(() => {
    let cancelled = false; const urls: string[] = []; setUrl(""); setOpaqueUrl(""); setIgnoreAlpha(false); setError("");
    const createUrl = (bytes: BlobPart) => { const value = URL.createObjectURL(new Blob([bytes], { type: "image/png" })); urls.push(value); return value; };
    if (file) void (async () => {
      if (translated) { const bytes = await readFileBytes(project.folder + "/" + file); if (!cancelled) setUrl(createUrl(bytes)); }
      else {
        const preview = await loadPreview(project, image, () => cancelled);
        if (cancelled || !preview) return;
        const decode = (data: string) => Uint8Array.from(atob(data), char => char.charCodeAt(0));
        setUrl(createUrl(decode(preview.data)));
        if (preview.fullyTransparent) { setOpaqueUrl(createUrl(decode(preview.opaque))); setIgnoreAlpha(true); }
      }
    })().catch(error => { if (!cancelled) setError(String(error)); });
    return () => { cancelled = true; urls.forEach(value => URL.revokeObjectURL(value)); };
  }, [project.folder, file, image.renderedHash, image.sourceHash]);
  return <figure>{!compact && <figcaption>{translated ? "译图" : "原图"}{opaqueUrl && <label><input type="checkbox" checked={ignoreAlpha} onChange={event => setIgnoreAlpha(event.target.checked)} />忽略透明度</label>}</figcaption>}{error ? <p className="unity-offline-error" role="alert">{error}</p> : url ? <div className="unity-image-preview-surface"><div className="unity-image-stage" style={{ width: Math.min(image.width, (compact ? 130 : 320) * image.width / Math.max(1, image.height)) }}><img src={ignoreAlpha ? opaqueUrl : url} alt={`${image.name} ${translated ? "译图" : "原图"}`} draggable={false} onError={() => setError("图片解码失败，请检查原图缓存或重新扫描")} />{!compact && onRegion && <svg viewBox={`0 0 ${image.width} ${image.height}`} preserveAspectRatio="none" className="unity-image-region-overlay" aria-label="图片文字区域">{image.regions.map((region, index) => <rect key={index} x={region.x0} y={region.y0} width={Math.max(1, region.x1 - region.x0)} height={Math.max(1, region.y1 - region.y0)} role="button" tabIndex={0} aria-label={`区域 ${index + 1}：${region.text}`} className={activeRegion === index ? "is-active" : ""} onClick={() => onRegion(index)} onFocus={() => onRegion(index)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onRegion(index); } }} />)}</svg>}</div></div> : <p className="hint">{file ? "正在读取图片…" : translated ? "尚未生成译图" : image.error || "没有可读取的原图"}</p>}{opaqueUrl && !compact && <p className="hint">原图完全透明，忽略透明度可查看 RGB 图案，仅影响预览。</p>}</figure>;
}

export function unityGalleryToggle(current: Set<string>, id: string, additive: boolean) {
  const next = additive ? new Set(current) : new Set<string>();
  if (additive && next.has(id)) next.delete(id); else next.add(id);
  return next;
}
export function unityGalleryBox(items: { id: string; left: number; top: number; right: number; bottom: number }[], box: { left: number; top: number; right: number; bottom: number }, base: Set<string>) {
  const next = new Set(base);
  for (const item of items) if (item.left < box.right && item.right > box.left && item.top < box.bottom && item.bottom > box.top) next.add(item.id);
  return next;
}

function ImageGallery({ project, images, disabled, onSelect, onView }: { project: UnityProject; images: UnityImage[]; disabled: boolean; onSelect: (images: UnityImage[], value: boolean) => void; onView: (id: string) => void }) {
  const [selected, setSelected] = useState(new Set<string>()), [page, setPage] = useState(0);
  const [box, setBox] = useState<{ left: number; top: number; right: number; bottom: number } | null>(null);
  const grid = useRef<HTMLDivElement>(null), drag = useRef<{ x: number; y: number; base: Set<string> } | null>(null);
  const pages = Math.max(1, Math.ceil(images.length / 24)), currentPage = Math.min(page, pages - 1), visible = images.slice(currentPage * 24, (currentPage + 1) * 24);
  const chosen = images.filter(image => selected.has(image.id));
  const point = (event: React.PointerEvent) => { const rect = grid.current!.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  return <div className="unity-image-gallery">
    <div className="unity-gallery-actions"><span>已选 {chosen.length} 张</span><button className="unity-btn" onClick={() => setSelected(new Set(images.map(image => image.id)))}>选中全部筛选结果</button><button className="unity-btn" onClick={() => setSelected(new Set())}>清空选择</button><button className="unity-btn" disabled={disabled || !chosen.length} onClick={() => onSelect(chosen, false)}>批量取消勾选</button><button className="unity-btn" disabled={disabled || !chosen.length} onClick={() => onSelect(chosen, true)}>批量勾选</button><span className="hint">Ctrl 多选；拖动空白处框选；双击查看。</span></div>
    <div className="unity-gallery-scroll"><div ref={grid} className="unity-gallery-grid" onPointerDown={event => {
      if (event.button !== 0 || (event.target as Element).closest('[data-gallery-id]')) return;
      event.preventDefault(); const p = point(event), base = event.ctrlKey || event.metaKey ? new Set(selected) : new Set<string>();
      drag.current = { ...p, base }; setSelected(base); setBox({ left: p.x, right: p.x, top: p.y, bottom: p.y }); event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={event => {
      if (!drag.current) return;
      const p = point(event), start = drag.current, rect = { left: Math.min(start.x, p.x), right: Math.max(start.x, p.x), top: Math.min(start.y, p.y), bottom: Math.max(start.y, p.y) };
      const origin = grid.current!.getBoundingClientRect();
      const items = Array.from(grid.current!.querySelectorAll<HTMLElement>('[data-gallery-id]')).map(item => { const r = item.getBoundingClientRect(); return { id: item.dataset.galleryId!, left: r.left - origin.left, right: r.right - origin.left, top: r.top - origin.top, bottom: r.bottom - origin.top }; });
      setBox(rect); setSelected(unityGalleryBox(items, rect, start.base));
    }} onPointerUp={() => { drag.current = null; setBox(null); }} onPointerCancel={() => { drag.current = null; setBox(null); }}>
      {visible.map(image => <div key={image.id} data-gallery-id={image.id} role="option" aria-selected={selected.has(image.id)} tabIndex={0} className={`unity-gallery-card${selected.has(image.id) ? " is-selected" : ""}`} onClick={event => setSelected(current => unityGalleryToggle(current, image.id, event.ctrlKey || event.metaKey))} onDoubleClick={() => onView(image.id)} onKeyDown={event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); setSelected(current => unityGalleryToggle(current, image.id, event.ctrlKey || event.metaKey)); } }}>
        <ImagePreview project={project} image={image} translated={false} compact /><strong title={image.name}>{image.name}</strong><small>{image.width} × {image.height} · {image.selected ? "已勾选" : "未勾选"}</small>
      </div>)}
      {box && <div className="unity-gallery-selection-box" style={{ left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top }} />}
    </div></div>
    <div className="unity-gallery-pages"><button className="unity-btn" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage + 1} / {pages}</span><button className="unity-btn" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button></div>
  </div>;
}

export function UnityImageWorkbench({ project, disabled, confidenceThreshold = 50, onChange, onRender, onImport, onSave }: {
  project: UnityProject | null; disabled: boolean; confidenceThreshold?: number;
  onChange: (image: UnityImage) => void; onRender: (image: UnityImage) => void;
  onImport: (image: UnityImage) => void; onSave: () => void;
}) {
  const [selectedId, setSelectedId] = useState(""), [search, setSearch] = useState("");
  const [unfinishedOnly, setUnfinishedOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ empty: true });
  const [gallery, setGallery] = useState(false), [activeRegion, setActiveRegion] = useState(-1);
  const workbench = useRef<HTMLElement>(null);
  useEffect(() => { setSelectedId(""); setSearch(""); setCollapsed({ empty: true }); setUnfinishedOnly(false); setGallery(false);
    if (!disabled) (project?.images || []).filter(image => image.ocrCompleted && !unityImageHasText(image) && !image.renderedFile && image.selected).forEach(image => onChange({ ...image, selected: false })); }, [project?.folder]);
  const images = (project?.images || []).filter(unityImageParticipates), filtered = images.filter(image => (!unfinishedOnly || !image.completed || !!image.error) && (!search || (image.name + " " + image.file + " " + image.regions.map(region => region.text).join(" ")).toLowerCase().includes(search.toLowerCase())));
  const image = filtered.find(image => image.id === selectedId) || filtered.find(unityImageHasText) || filtered[0];
  useEffect(() => setActiveRegion(-1), [image?.id]);
  const locateRegion = (index: number) => { setActiveRegion(index); workbench.current?.querySelector<HTMLElement>(`[data-region-index="${index}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); };
  const selectImages = (items: UnityImage[], selected: boolean) => items.filter(item => item.sourceFile && item.selected !== selected).forEach(item => onChange({ ...item, selected }));
  const edit = (index: number, patch: Partial<UnityImageRegion>) => image && onChange({ ...image, completed: false, error: "", regions: image.regions.map((region, i) => i === index ? { ...region, ...patch, error: "" } : region) });
  return <section ref={workbench} className="unity-offline-workbench unity-image-workbench" aria-label="图片识别与翻译结果">
    <div className="unity-offline-toolbar unity-image-toolbar"><strong>图片与译图</strong><button className="unity-btn" onClick={() => setGallery(value => !value)}>{gallery ? "返回文字区域" : "原图批量阅览"}</button><label><input type="checkbox" checked={unfinishedOnly} onChange={event => setUnfinishedOnly(event.target.checked)} />仅看未完成 / 失败</label><input type="search" placeholder="搜索" aria-label="搜索游戏图片" value={search} onChange={event => setSearch(event.target.value)} /><button className="unity-btn" disabled={disabled || !filtered.length} onClick={() => selectImages(filtered, true)}>全选</button><button className="unity-btn" disabled={disabled || !filtered.some(item => item.selected)} onClick={() => selectImages(filtered, false)}>取消全选</button><button className="unity-btn" disabled={disabled || !project} onClick={onSave}>保存工程</button></div>
    {!project || (project.scanRevision || 0) < 5 ? <div className="unity-offline-empty">请更新扫描以提取游戏图片；已有文本和译文保留。</div> : !images.length ? <div className="unity-offline-empty">未扫描到可读取的图片资源，可以跳过步骤 2.2。</div> : gallery && project ? <ImageGallery project={project} images={filtered} disabled={disabled} onSelect={selectImages} onView={id => { setSelectedId(id); setGallery(false); }} /> : <div className="unity-image-body">
      <div className="unity-image-list" aria-label="游戏图片列表">{([['text', '识别到文字'], ['pending', '待识别'], ['failed', '识别失败'], ['empty', '未识别出文字']] as const).map(([group, label]) => {
        const items = filtered.filter(item => unityImageResultGroup(item) === group);
        return items.length > 0 && <details key={group} className="unity-image-result-group" open={!collapsed[group]} onToggle={event => { const closed = !event.currentTarget.open; setCollapsed(previous => previous[group] === closed ? previous : { ...previous, [group]: closed }); }}><summary><span>{label} · {items.length}</span><button type="button" disabled={disabled || !items.some(item => item.sourceFile)} onClick={event => { event.preventDefault(); event.stopPropagation(); selectImages(items, !items.filter(item => item.sourceFile).every(item => item.selected)); }}>{items.filter(item => item.sourceFile).every(item => item.selected) ? "取消全选" : "全选"}</button></summary>{items.map(item => <div key={item.id} className={`unity-image-item${item.id === image?.id ? " is-selected" : ""}${item.error ? " has-error" : ""}`}>
        <input type="checkbox" aria-label={`选择图片 ${item.name}`} disabled={disabled || !item.sourceFile} checked={item.selected} onChange={event => onChange({ ...item, selected: event.target.checked })} />
        <button onClick={() => setSelectedId(item.id)} title={item.file}><strong>{item.name}</strong><small>{item.width} × {item.height} · {item.completed ? unityImageHasText(item) ? "已完成" : "未识别出文字" : item.error ? "识别或处理失败" : item.ocrCompleted ? "已识别" : "待识别"}</small></button>
      </div>)}</details>;
      })}</div>
      {!filtered.length && <div className="unity-offline-empty">没有符合筛选条件的图片。</div>}
      {image && <div className="unity-image-detail">
        <div className="unity-image-actions"><strong title={image.file}>{image.name}</strong><button className="unity-btn" disabled={disabled || !image.sourceFile || !image.ocrCompleted || !unityImageTranslationRegions(image.regions, confidenceThreshold).some(region => region.selected)} onClick={() => onRender(image)}>重新生成译图</button><button className="unity-btn" disabled={disabled || !image.sourceFile} onClick={() => onImport(image)}>替换译图</button></div>
        {image.error && <p className="unity-offline-error" role="alert">{image.error}</p>}
        <div className="unity-image-previews"><ImagePreview project={project} image={image} translated={false} activeRegion={activeRegion} onRegion={locateRegion} /><ImagePreview project={project} image={image} translated activeRegion={activeRegion} onRegion={locateRegion} /></div>
        <div className="unity-image-regions">{image.regions.map((region, index) => <div key={index} data-region-index={index} tabIndex={0} className={`unity-image-region${activeRegion === index ? " is-active" : ""}`} onClick={() => setActiveRegion(index)} onFocus={() => setActiveRegion(index)}>
          <label><input type="checkbox" checked={region.selected && (region.confidence >= confidenceThreshold || !!region.manualSelected)} disabled={disabled} onChange={event => edit(index, { selected: event.target.checked, manualSelected: event.target.checked })} />区域 {index + 1} · 置信度 {(Math.floor(region.confidence * 10) / 10).toFixed(1)}%{region.confidence < confidenceThreshold ? " · 低于阈值，可手动勾选" : ""}</label>
          <label>原文<textarea value={region.text} rows={2} disabled={disabled} onChange={event => edit(index, { text: event.target.value, translation: "" })} /></label>
          <label>译文<textarea value={region.translation} rows={2} disabled={disabled} onChange={event => edit(index, { translation: event.target.value })} /></label>
          <div className="unity-image-coordinates">{(["x0", "y0", "x1", "y1"] as const).map(key => <label key={key}>{({ x0: "左", y0: "上", x1: "右", y1: "下" })[key]}<input type="number" min={0} max={key.startsWith("x") ? image.width : image.height} value={Math.round(region[key])} disabled={disabled} onChange={event => edit(index, { [key]: Number(event.target.value) })} /></label>)}</div>
          {region.error && <p className="unity-offline-error">{region.error}</p>}
        </div>)}</div>
      </div>}
    </div>}
    {project && <div className="unity-results-footer"><span>{images.length} 张图片 · 已选 {images.filter(image => image.selected).length} 张 · 已完成 {images.filter(image => image.selected && image.completed).length} 张{images.some(image => image.error) ? ` · 失败 ${images.filter(image => image.error).length} 张` : ""}</span></div>}
  </section>;
}
