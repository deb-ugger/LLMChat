import { ImageBrowser, focusImagePreview } from "./ImageBrowser";
import { ImageCanvas } from "./ImageCanvas";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { loadAnnotatedSampleSet, type AnnotatedImage, type AnnotatedSampleSet } from "../benchmark/imageSampleSet";
import { UNITY_LANGUAGES } from "../unityTranslation";
import "./ImageSampleSetBrowser.css";

const pageSize = 20;
const mosaicLabels = { present: "有码", none: "无码", uncertain: "不确定", unmarked: "未标注" };
const textLabels = { present: "有文字", none: "无文字", uncertain: "不确定", unmarked: "未标注" };
type AnnotationFilter = "all" | keyof typeof textLabels;
type RuleFilter = "all" | "keep" | "language";

function languageName(language: string) {
  return UNITY_LANGUAGES.find(item => item.value === language)?.label ?? language;
}

function AnnotationFilterField({ label, labels, value, onChange }: {
  label: string;
  labels: typeof textLabels;
  value: AnnotationFilter;
  onChange: (value: AnnotationFilter) => void;
}) {
  return <label>{label}
    <select value={value} onChange={event => onChange(event.target.value as AnnotationFilter)}>
      <option value="all">全部</option>
      {Object.entries(labels).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
    </select>
  </label>;
}

function SamplePreview({ image, read }: { image: AnnotatedImage; read: AnnotatedSampleSet["read"] }) {
  const [preview, setPreview] = useState<{ url: string } | { error: string }>();
  const [hidden, setHidden] = useState<string[]>([]);
  const { mosaic, text, provenance } = image.annotation;
  const regions = text?.regions ?? [];
  const overlays = [
    { kind: "mosaic", label: "去码框", boxes: mosaic?.boxes },
    { kind: "initial", label: "初筛框", boxes: text?.initialBoxes },
    { kind: "region", label: "文字框", boxes: regions.map(region => region.box) },
  ].filter(group => !!group.boxes?.length);

  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    void read(image, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setPreview({ url });
    }).catch(error => {
      if (!controller.signal.aborted) setPreview({ error: String(error) });
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [image, read]);

  return <section className="image-sample-set-preview" aria-label="图片标注" tabIndex={0} data-game-image-preview-pane="" onPointerDown={focusImagePreview}>
    <header>
      <strong title={image.file}>{image.name}</strong>
      <span className="hint">{image.width} × {image.height}</span>
    </header>
    <dl className="image-sample-set-states">
      <div><dt>打码</dt><dd>{mosaicLabels[mosaic?.state ?? "unmarked"]}</dd></div>
      <div><dt>文字</dt><dd>{textLabels[text?.state ?? "unmarked"]}</dd></div>
      {provenance && <div><dt>标注来源</dt><dd>{provenance}</dd></div>}
    </dl>
    <div className="image-sample-set-canvas">
      {!preview ? <p className="hint" role="status">正在读取原图…</p> : "error" in preview ? (
        <p className="image-sample-set-error" role="alert">读取原图失败。{preview.error}</p>
      ) : (
        <ImageCanvas className="image-canvas-fit image-sample-set-image-canvas"><svg viewBox={`0 0 ${image.width} ${image.height}`} width={image.width} height={image.height} role="img" aria-label={`${image.name} 原图`}>
          <image href={preview.url} width={image.width} height={image.height}
            onError={() => setPreview({ error: "无法解码此图片。" })} />
          {overlays.filter(group => !hidden.includes(group.kind)).map(group => (
            <g key={group.kind} data-box={group.kind}>
              {group.boxes?.map(([x0, y0, x1, y1], index) => (
                <rect key={index} x={x0} y={y0} width={x1 - x0} height={y1 - y0} vectorEffect="non-scaling-stroke">
                  <title>{group.label} {index + 1}</title>
                </rect>
              ))}
            </g>
          ))}
        </svg></ImageCanvas>
      )}
    </div>
    {overlays.length > 0 && <div className="image-sample-set-overlays" aria-label="定位框">
      {overlays.map(({ kind, label, boxes }) => <label key={kind} data-box={kind}>
        <input type="checkbox" checked={!hidden.includes(kind)} onChange={event => {
          const visible = event.target.checked;
          setHidden(current => visible ? current.filter(item => item !== kind) : [...current, kind]);
        }} />
        <span aria-hidden="true" />{label} {boxes?.length}
      </label>)}
    </div>}
    {regions.length > 0 && <table className="image-sample-set-regions">
      <caption>文字区域</caption>
      <thead><tr><th scope="col">原文</th><th scope="col">原文语言</th><th scope="col">处理规则</th></tr></thead>
      <tbody>{regions.map((region, index) => <tr key={index}>
        <td>{index + 1}. {region.text?.trim() || "未标注"}</td>
        <td>{region.language ? languageName(region.language) : "未标注"}</td>
        <td>{region.keep ? "保留原文" : "按测试语言设置"}</td>
      </tr>)}</tbody>
    </table>}
  </section>;
}

function SampleSetContents({ data }: { data: AnnotatedSampleSet }) {
  const [mosaic, setMosaic] = useState<AnnotationFilter>("all");
  const [text, setText] = useState<AnnotationFilter>("all");
  const [language, setLanguage] = useState("");
  const [rule, setRule] = useState<RuleFilter>("all");
  const list = useRef<HTMLUListElement>(null);
  const workspace = useRef<HTMLDivElement>(null), keyboardFocus = useRef<"list" | "preview" | undefined>(undefined);
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const languages = useMemo(() => {
    const values = new Set<string>();
    for (const { annotation } of data.images) {
      for (const region of annotation.text?.regions ?? []) {
        if (region.language) values.add(region.language);
      }
    }
    return [...values].sort((a, b) => languageName(a).localeCompare(languageName(b), "zh"));
  }, [data]);
  const images = useMemo(() => data.images.filter(({ annotation }) => {
    if (mosaic !== "all" && mosaic !== (annotation.mosaic?.state ?? "unmarked")) return false;
    if (text !== "all" && text !== (annotation.text?.state ?? "unmarked")) return false;
    if (!language && rule === "all") return true;
    return annotation.text?.regions?.some(region => (!language || language === region.language) &&
      (rule === "all" || (rule === "keep" ? !!region.keep : !region.keep)));
  }), [data, mosaic, text, language, rule]);
  const visible = images.slice(page * pageSize, (page + 1) * pageSize);
  const pages = Math.ceil(images.length / pageSize);
  const selected = visible.find(image => image.id === selectedId) ?? visible[0];
  useLayoutEffect(() => {
    const focus = keyboardFocus.current;
    if (!focus) return;
    keyboardFocus.current = undefined;
    workspace.current?.querySelector<HTMLElement>(focus === "preview" ? "[data-game-image-preview-pane]" : '[aria-pressed="true"]')?.focus({ preventScroll: true });
  }, [selected?.id]);

  function showPage(next: number) {
    setPage(next);
    setSelectedId("");
    if (list.current) list.current.scrollTop = 0;
  }

  function navigatePage(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        !["PageUp", "PageDown"].includes(event.key) || (event.target as Element).closest("input, textarea, select, [contenteditable]")) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(pages - 1, page + (event.key === "PageUp" ? -1 : 1)));
    if (next === page) return;
    keyboardFocus.current = (event.target as Element).closest("[data-game-image-preview-pane]") ? "preview" : "list";
    showPage(next);
  }

  return <div className="image-sample-set-main">
    <div className="image-sample-set-filters">
      <AnnotationFilterField label="打码" labels={mosaicLabels} value={mosaic} onChange={value => { setMosaic(value); showPage(0); }} />
      <AnnotationFilterField label="文字" labels={textLabels} value={text} onChange={value => { setText(value); showPage(0); }} />
      <label>原文语言
        <select value={language} disabled={!languages.length} onChange={event => { setLanguage(event.target.value); showPage(0); }}>
          <option value="">全部</option>
          {languages.map(code => <option key={code} value={code}>{languageName(code)}</option>)}
        </select>
      </label>
      <label>处理规则
        <select value={rule} onChange={event => { setRule(event.target.value as RuleFilter); showPage(0); }}>
          <option value="all">全部</option>
          <option value="keep">含保留原文区域</option>
          <option value="language">含按测试语言设置的区域</option>
        </select>
      </label>
      <span className="hint" role="status">显示 {images.length} / {data.images.length} 张</span>
    </div>
    {!selected ? <p className="image-sample-set-empty">{data.images.length ? "没有符合筛选条件的图片。" : "此测试集没有图片。"}</p> : (
      <ImageBrowser ref={workspace} className="image-sample-set-workspace" onListKeyDown={navigatePage} onPreviewKeyDown={navigatePage}
        listProps={{ className: "image-sample-set-list", tabIndex: 0, "aria-label": "样本图片列表", "aria-keyshortcuts": "PageUp PageDown" }} list={<>
          <ul ref={list} aria-label="样本图片">
            {visible.map(image => <li key={image.id}><button type="button" title={image.file}
              aria-pressed={image.id === selected.id}
              onClick={() => setSelectedId(image.id)}>
              <span>{image.name}</span>
              <small>{mosaicLabels[image.annotation.mosaic?.state ?? "unmarked"]} · {textLabels[image.annotation.text?.state ?? "unmarked"]}</small>
            </button></li>)}
          </ul>
          {pages > 1 && <nav aria-label="样本分页">
            <button type="button" className="unity-btn" disabled={page === 0} onClick={() => showPage(page - 1)}>上一页</button>
            <span className="hint">{page + 1} / {pages}</span>
            <button type="button" className="unity-btn" disabled={page + 1 === pages} onClick={() => showPage(page + 1)}>下一页</button>
          </nav>}
        </>}>
        <SamplePreview key={selected.id} image={selected} read={data.read} />
      </ImageBrowser>
    )}
  </div>;
}

type SetLoad = { path: string } & ({ data: AnnotatedSampleSet } | { error: string });

export function ImageSampleSetBrowser({ path, onChoose, onClose }: {
  path: string;
  onChoose: (path: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [pickedPath, setPickedPath] = useState("");
  const [load, setLoad] = useState<SetLoad>();
  const [choosing, setChoosing] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const previewPath = pickedPath || path;
  const current = load?.path === previewPath ? load : undefined;
  const data = current && "data" in current ? current.data : undefined;

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  useEffect(() => {
    if (!previewPath) return;
    let active = true;
    void loadAnnotatedSampleSet(previewPath, { includeUnannotated: true }).then(data => {
      if (active) setLoad({ path: previewPath, data });
    }).catch(error => {
      if (active) setLoad({ path: previewPath, error: String(error) });
    });
    return () => { active = false; };
  }, [previewPath]);

  async function pick() {
    setChoosing(true);
    setPickerError("");
    try {
      const selected = await open({
        title: "选择图片测试集的 manifest.json",
        multiple: false,
        defaultPath: previewPath || "E:\\",
        filters: [{ name: "测试集清单", extensions: ["json"] }],
      });
      if (typeof selected !== "string") return;
      if (selected.split(/[\\/]/).at(-1)?.toLowerCase() !== "manifest.json") {
        setPickerError("请选择测试集目录里的 manifest.json。");
      } else {
        setPickedPath(selected);
      }
    } catch (error) {
      setPickerError(String(error));
    } finally {
      setChoosing(false);
    }
  }

  function choose() {
    onChoose(previewPath);
    onClose();
  }

  return createPortal(<dialog ref={dialog} className="image-sample-set-browser" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="image-sample-set-header">
      <h2 id={titleId}>浏览图片测试集</h2>
      <button type="button" className="unity-btn" aria-label="关闭测试集浏览" onClick={onClose}>关闭</button>
    </header>
    <div className="image-sample-set-source">
      <button type="button" className="unity-btn" disabled={choosing} onClick={() => void pick()} autoFocus>选择清单</button>
      <div>
        {data && <strong>{data.title}</strong>}
        <span className="hint" title={previewPath}>{previewPath || "选择测试集目录中的 manifest.json"}</span>
      </div>
    </div>
    {pickerError && <p className="image-sample-set-error" role="alert">{pickerError}</p>}
    {current && "error" in current && <p className="image-sample-set-error" role="alert">读取测试集失败。{current.error}</p>}
    {previewPath && !current && <p className="image-sample-set-empty" role="status">正在读取测试集…</p>}
    {data && <SampleSetContents key={previewPath} data={data} />}
    <footer className="image-sample-set-footer">
      <button type="button" className="unity-btn unity-btn-primary" disabled={!data?.images.length}
        onClick={choose}>使用此测试集</button>
    </footer>
  </dialog>, document.body);
}
