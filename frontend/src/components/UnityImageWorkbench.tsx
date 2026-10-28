import { useEffect, useState } from "react";
import { readFileBytes } from "../localDocFile";
import type { UnityImage, UnityImageRegion, UnityProject } from "../unityOffline";

function ImagePreview({ project, image, translated }: { project: UnityProject; image: UnityImage; translated: boolean }) {
  const [url, setUrl] = useState(""), [error, setError] = useState("");
  const file = translated ? image.renderedFile : image.sourceFile;
  useEffect(() => {
    let cancelled = false, objectUrl = ""; setUrl(""); setError("");
    if (file) void readFileBytes(project.folder + "/" + file).then(bytes => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: "image/png" })); setUrl(objectUrl);
    }).catch(error => { if (!cancelled) setError(String(error)); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [project.folder, file, image.renderedHash, image.sourceHash]);
  return <figure><figcaption>{translated ? "译图" : "原图"}</figcaption>{url ? <img src={url} alt={`${image.name} ${translated ? "译图" : "原图"}`} /> : <p className={error ? "unity-offline-error" : "hint"}>{error || (file ? "正在读取图片…" : translated ? "尚未生成译图" : image.error || "没有可读取的原图")}</p>}</figure>;
}

export function UnityImageWorkbench({ project, disabled, onChange, onRender, onImport, onSave }: {
  project: UnityProject | null; disabled: boolean;
  onChange: (image: UnityImage) => void; onRender: (image: UnityImage) => void;
  onImport: (image: UnityImage) => void; onSave: () => void;
}) {
  const [selectedId, setSelectedId] = useState(""), [search, setSearch] = useState("");
  useEffect(() => { setSelectedId(""); setSearch(""); }, [project?.folder]);
  const images = project?.images || [], filtered = images.filter(image => !search || (image.name + " " + image.file + " " + image.regions.map(region => region.text).join(" ")).toLowerCase().includes(search.toLowerCase()));
  const image = filtered.find(image => image.id === selectedId) || filtered[0];
  const edit = (index: number, patch: Partial<UnityImageRegion>) => image && onChange({ ...image, completed: false, error: "", regions: image.regions.map((region, i) => i === index ? { ...region, ...patch, error: "" } : region) });
  return <section className="unity-offline-workbench unity-image-workbench" aria-label="图片识别与翻译结果">
    <div className="unity-offline-toolbar"><strong>图片与译图</strong><input type="search" placeholder="搜索" aria-label="搜索游戏图片" value={search} onChange={event => setSearch(event.target.value)} /><button className="unity-btn" disabled={disabled || !project} onClick={onSave}>保存工程</button></div>
    {!project || (project.scanRevision || 0) < 5 ? <div className="unity-offline-empty">请更新扫描以提取游戏图片；已有文本和译文保留。</div> : !images.length ? <div className="unity-offline-empty">未扫描到可读取的图片资源，可以跳过步骤 2.2。</div> : <div className="unity-image-body">
      <div className="unity-image-list" aria-label="游戏图片列表">{filtered.map(item => <div key={item.id} className={`unity-image-item${item.id === image?.id ? " is-selected" : ""}`}>
        <input type="checkbox" aria-label={`选择图片 ${item.name}`} disabled={disabled || !item.sourceFile} checked={item.selected} onChange={event => onChange({ ...item, selected: event.target.checked })} />
        <button onClick={() => setSelectedId(item.id)} title={item.file}><strong>{item.name}</strong><small>{item.width} × {item.height} · {item.completed ? item.regions.length ? "已完成" : "未检测到文字" : item.error ? "未完成" : item.ocrCompleted ? "已识别" : "待识别"}</small></button>
      </div>)}</div>
      {image && <div className="unity-image-detail">
        <div className="unity-image-actions"><strong title={image.file}>{image.name}</strong><button className="unity-btn" disabled={disabled || !image.sourceFile || !image.ocrCompleted} onClick={() => onRender(image)}>重新生成译图</button><button className="unity-btn" disabled={disabled || !image.sourceFile} onClick={() => onImport(image)}>替换译图</button></div>
        {image.error && <p className="unity-offline-error" role="alert">{image.error}</p>}
        <div className="unity-image-previews"><ImagePreview project={project} image={image} translated={false} /><ImagePreview project={project} image={image} translated /></div>
        <div className="unity-image-regions">{image.regions.map((region, index) => <div key={index} className="unity-image-region">
          <label><input type="checkbox" checked={region.selected} disabled={disabled} onChange={event => edit(index, { selected: event.target.checked })} />区域 {index + 1} · 置信度 {region.confidence.toFixed(0)}%</label>
          <label>原文<textarea value={region.text} rows={2} disabled={disabled} onChange={event => edit(index, { text: event.target.value, translation: "" })} /></label>
          <label>译文<textarea value={region.translation} rows={2} disabled={disabled} onChange={event => edit(index, { translation: event.target.value })} /></label>
          <div className="unity-image-coordinates">{(["x0", "y0", "x1", "y1"] as const).map(key => <label key={key}>{({ x0: "左", y0: "上", x1: "右", y1: "下" })[key]}<input type="number" min={0} max={key.startsWith("x") ? image.width : image.height} value={Math.round(region[key])} disabled={disabled} onChange={event => edit(index, { [key]: Number(event.target.value) })} /></label>)}</div>
          {region.error && <p className="unity-offline-error">{region.error}</p>}
        </div>)}</div>
      </div>}
    </div>}
    {project && <div className="unity-results-footer"><span>{images.length} 张图片 · 已选 {images.filter(image => image.selected).length} 张 · 已完成 {images.filter(image => image.selected && image.completed).length} 张</span></div>}
  </section>;
}
