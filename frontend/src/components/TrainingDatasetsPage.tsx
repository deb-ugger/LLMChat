import { TrainingView } from "./TrainingView";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import type { AnnotatedImage } from "../benchmark/imageSampleSet";
import { copyTrainingDataset, datasetManifestIn, datasetParts, datasetPurposeLabels, datasetPurposes, datasetVerdict,
  datasetVerdictLabels, importTrainingDataset, labelDatasetImages, openTrainingDataset, partFor, readDatasetCatalog,
  rememberDataset, renameTrainingDataset, removeTrainingDataset, saveDatasetLabels, saveDatasetMasks, removeDatasetImage, emptyDatasetFilters, matchesDatasetFilters, writeTrainingDatasetFile, type DatasetPurpose,
  type DatasetReference, type DatasetVerdict, type DatasetWriter, type TrainingDataset } from "../benchmark/trainingDatasets";
import { api } from "../api";
import { getFixedMenuPoint } from "../viewportLayout";
import { GameDialog } from "./GameActionConfirm";
import { showAppNotice } from "./AppNotice";
import { copyText } from "../clipboard";
import { SamplePicture, TrainingDatasetImage, copyDatasetPicture, type DatasetMask } from "./TrainingDatasetImage";
import "../styles/trainingDatasets.css";

const pageSizes = [24, 48, 96];
const verdicts = ["present", "none", "unmarked"] as const;
type Filter = DatasetVerdict | "all";

function SampleBadges({ image, purpose }: { image: AnnotatedImage; purpose: DatasetPurpose }) {
  const state = datasetVerdict(image.annotation, purpose);
  return <span className="training-dataset-badge" data-state={state}>{datasetVerdictLabels[purpose][state]}</span>;
}

function SampleDetails({ dataset, image, purpose, busy, onPreview }: {
  dataset: TrainingDataset; image: AnnotatedImage; purpose: DatasetPurpose; busy: boolean;
  onPreview: (editing: boolean) => void;
}) {
  const boxes = purpose === "mosaic" ? image.annotation.mosaic?.boxes ?? []
    : image.annotation.text?.regions?.map(region => region.box) ?? image.annotation.text?.initialBoxes ?? [];
  const parts = (image.annotation.mosaic?.boxes ?? []).map(box => partFor(dataset, image.sourceHash, box));
  return <>
    <div className="training-dataset-detail-preview" onDoubleClick={() => onPreview(false)}>
      <button type="button" className="training-dataset-detail-picture" aria-label="打开原图" onClick={() => onPreview(false)}>
        <SamplePicture image={image} read={dataset.data.read} />
      </button>
    </div>
    <div className="training-dataset-actions">
      <button type="button" className="unity-btn" onClick={() => onPreview(false)}>查看原图</button>
      {!!dataset.reference.workId && purpose === "mosaic" && <button type="button" className="unity-btn" disabled={busy}
        onClick={() => onPreview(true)}>{boxes.length ? "编辑蒙版" : "添加蒙版"}</button>}
    </div>
    <dl className="training-dataset-detail-fields">
      <div><dt>文件</dt><dd title={image.name}>{image.name}</dd></div>
      <div><dt>尺寸</dt><dd>{image.width} × {image.height}</dd></div>
      <div><dt>来源</dt><dd title={image.sourceDirectory || image.file}>{image.sourceDirectory || image.file}</dd></div>
      <div><dt>用途</dt><dd>{datasetPurposeLabels[purpose]}</dd></div>
      <div><dt>标注</dt><dd><SampleBadges image={image} purpose={purpose} /></dd></div>
      <div><dt>蒙版数</dt><dd>{boxes.length}</dd></div>
      <div><dt>部位</dt><dd className="training-dataset-parts">{parts.length ? parts.map((part,index) =>
        <span key={index}>蒙版 {index + 1}：{part ? datasetParts[part] : "未知"}</span>) : "—"}</dd></div>
      <div><dt>置信度</dt><dd>—</dd></div>
    </dl>
  </>;
}

export function TrainingDatasetsPage(_props: { channel?: BroadcastChannel }) {
  const id = useId();
  const [view, setView] = useState<"datasets" | "training">("datasets");
  const [catalog, setCatalog] = useState(readDatasetCatalog);
  const [dataset, setDataset] = useState<TrainingDataset>();
  const [purpose, setPurpose] = useState<DatasetPurpose>("mosaic");
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [more, setMore] = useState(false);
  const [conditions, setConditions] = useState({ ...emptyDatasetFilters });
  const [libraryWidth, setLibraryWidth] = useState(() => {
    const saved = Number(localStorage.getItem("llmchat-dataset-list-width"));
    return saved ? Math.max(200, Math.min(560, saved)) : 248;
  });
  const [resizing, setResizing] = useState(false);
  const resizeOrigin = useRef<{ x: number; width: number } | undefined>(undefined);
  const list = useRef<HTMLUListElement>(null), keyboardFocus = useRef(false);
  const [preview, setPreview] = useState<{ image: AnnotatedImage; editing: boolean }>();
  const imageMenu = useRef<HTMLDivElement>(null);
  const [menuImage, setMenuImage] = useState<AnnotatedImage>();
  const [deleting, setDeleting] = useState<AnnotatedImage>();
  useEffect(() => { localStorage.setItem("llmchat-dataset-list-width", String(libraryWidth)); }, [libraryWidth]);
  useEffect(() => {
    if (!resizing) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
    return () => { document.body.style.cursor = cursor; document.body.style.userSelect = userSelect; };
  }, [resizing]);
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(48);
  const [focusedId, setFocusedId] = useState("");
  const [checked, setChecked] = useState(new Set<string>());
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const importInput = useRef<HTMLInputElement>(null);
  const desktop = isTauri();
  const writer: DatasetWriter = writeTrainingDatasetFile;
  const datasetMenu = useRef<HTMLDivElement>(null);
  const [menuReference, setMenuReference] = useState<DatasetReference>();
  const [renaming, setRenaming] = useState<DatasetReference>();
  const [deletingDataset, setDeletingDataset] = useState<DatasetReference>();
  const [renameTitle, setRenameTitle] = useState("");
  const editable = desktop && !!dataset?.reference.workId;
  const query = search.trim().toLowerCase();
  const images = dataset?.data.images.filter(image => (filter === "all" || datasetVerdict(image.annotation, purpose) === filter) &&
    (!query || image.file.toLowerCase().includes(query)) && matchesDatasetFilters(image, conditions)) ?? [];
  const pages = Math.max(1, Math.ceil(images.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visible = images.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const focused = visible.find(image => image.id === focusedId) ?? visible[0];
  const scenes = [...new Set(dataset?.data.images.map(image => image.scene).filter((value): value is string => !!value))];
  const hasAdoption = dataset?.data.images.some(image => typeof image.adopted === "boolean");
  const conditionCount = Number(!!(conditions.widthMin || conditions.widthMax)) + Number(!!(conditions.heightMin || conditions.heightMax)) +
    Number(!!conditions.source) + Number(!!conditions.scene) + Number(conditions.masks !== "all") + Number(conditions.adopted !== "all") + Number(filter !== "all") + Number(!!query);
  useLayoutEffect(() => {
    if (!keyboardFocus.current) return;
    const button = list.current?.querySelector<HTMLButtonElement>('[data-image-id="' + CSS.escape(focusedId) + '"]');
    if (button) { button.focus({ preventScroll: true }); button.scrollIntoView({ block: "nearest" }); keyboardFocus.current = false; }
  }, [focusedId, currentPage]);
  useEffect(() => {
    if (view !== "datasets") return;
    const key = (event: KeyboardEvent) => {
      const grid = list.current, active = document.activeElement;
      if (!grid || busy || preview || deleting || deletingDataset || renaming || event.isComposing || event.ctrlKey || event.metaKey || event.altKey ||
        (active instanceof Element && active.closest("input,textarea,select,[contenteditable=true]")) ||
        !(grid.contains(active) || grid.matches(":hover"))) return;
      const index = Math.max(0, images.findIndex(image => image.id === focused?.id));
      const columns = layout === "list" ? 1 : getComputedStyle(grid).gridTemplateColumns.split(" ").length;
      const last = images.length - 1;
      let next: number;
      switch (event.key) {
        case "ArrowLeft": next = index - 1; break;
        case "ArrowRight": next = index + 1; break;
        case "ArrowUp": next = index - columns; break;
        case "ArrowDown": next = index + columns; break;
        case "Home": next = 0; break;
        case "End": next = last; break;
        case "PageUp": next = Math.max(0, currentPage - 1) * pageSize; break;
        case "PageDown": next = Math.min(pages - 1, currentPage + 1) * pageSize; break;
        case " ":
          event.preventDefault();
          if (focused) toggleChecked([focused.sourceHash], !checked.has(focused.sourceHash));
          return;
        case "Enter": event.preventDefault(); if (focused) setPreview({ image: focused, editing: false }); return;
        default: return;
      }
      event.preventDefault(); next = Math.max(0, Math.min(last, next));
      if (images[next]) { keyboardFocus.current = true; setPage(Math.floor(next / pageSize)); setFocusedId(images[next].id); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [view, busy, preview, deleting, deletingDataset, renaming, images, focused, layout, currentPage, pageSize, pages, checked]);
  const targets = checked.size ? checked : new Set(focused ? [focused.sourceHash] : []);

  function apply(next: TrainingDataset, select = true) {
    setDataset(next);
    setCatalog(rememberDataset(next.reference));
    if (select) {
      setPurpose(next.reference.purposes[0]);
      setFilter("all");
      setSearch("");
      setConditions({ ...emptyDatasetFilters });
      resetSelection();
    }
  }

  function run(status: string, operation: () => Promise<TrainingDataset | undefined>, select = true) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(status);
    setError("");
    void operation().then(next => { if (next) apply(next, select); })
      .catch(error => setError(String(error).replace(/^Error: /, "")))
      .finally(() => { busyRef.current = false; setBusy(""); });
  }

  function openReference(reference: DatasetReference) {
    if (reference.path === dataset?.reference.path) return;
    run("正在打开数据集…", () => openTrainingDataset(reference.path, reference.workId));
  }

  useEffect(() => {
    const previous = readDatasetCatalog()[0];
    if (previous && isTauri()) openReference(previous);
  }, []);

  function resetSelection() {
    setPage(0);
    setFocusedId("");
    setChecked(new Set());
  }

  function openDirectory() {
    run("正在打开数据集…", async () => {
      const directory = await open({ title: "打开数据集", directory: true, multiple: false });
      if (typeof directory !== "string") return;
      const path = datasetManifestIn(directory);
      return openTrainingDataset(path, catalog.find(reference => reference.path.toLowerCase() === path.toLowerCase())?.workId);
    });
  }

  function duplicate(shareImages: boolean) {
    if (!dataset) return;
    const status = shareImages ? "正在创建标注副本…" : "正在复制数据集…";
    run(status, () => copyTrainingDataset(dataset, `${dataset.reference.title}（副本）`, writer,
      new AbortController().signal, { shareImages,
        onProgress: (completed, total) => setBusy(`${status} ${completed} / ${total} 张`) }));
  }

  function openDatasetMenu(event: ReactMouseEvent<HTMLElement>, reference: DatasetReference) {
    if (busy || !datasetMenu.current) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointer = event.clientX !== 0 || event.clientY !== 0;
    const { x, y } = getFixedMenuPoint(pointer ? event.clientX : bounds.left,
      pointer ? event.clientY : bounds.bottom, 190, 150);
    datasetMenu.current.style.left = x + "px";
    datasetMenu.current.style.top = y + "px";
    setMenuReference(reference);
    datasetMenu.current.showPopover();
    datasetMenu.current.querySelector("button")?.focus({ preventScroll: true });
  }

  function rename() {
    if (!renaming) return;
    const reference = renaming;
    run("正在重命名…", async () => {
      const current = dataset?.reference.path === reference.path;
      const source = dataset && current ? dataset : await openTrainingDataset(reference.path, reference.workId);
      const renamed = await renameTrainingDataset(source, renameTitle, writer);
      setCatalog(rememberDataset(renamed.reference));
      setRenaming(undefined);
      return current ? renamed : undefined;
    }, false);
  }

  function deleteDataset() {
    if (!deletingDataset || busyRef.current) return;
    const reference = deletingDataset;
    busyRef.current = true;
    setBusy("正在删除数据集…");
    void removeTrainingDataset(reference).then(remaining => {
      setCatalog(remaining);
      if (dataset?.reference.path === reference.path) {
        setDataset(undefined); resetSelection(); setPreview(undefined); setMenuImage(undefined);
      }
      setDeletingDataset(undefined);
      showAppNotice(reference.workId ? "已删除数据集" : "已从列表移除数据集");
    }).catch(error => showAppNotice(String(error), "error"))
      .finally(() => { busyRef.current = false; setBusy(""); });
  }

  function toggleChecked(hashes: string[], selected: boolean) {
    setChecked(previous => {
      const next = new Set(previous);
      for (const hash of hashes) selected ? next.add(hash) : next.delete(hash);
      return next;
    });
  }

  function label(verdict: DatasetVerdict) {
    if (!dataset || !editable || !targets.size) return;
    run("正在保存标注…", () => saveDatasetLabels(dataset, labelDatasetImages(dataset, targets, purpose, verdict), dataset.parts, writer), false);
  }

  function saveMasks(masks: DatasetMask[]) {
    if (!dataset || !preview || !editable) return;
    run("正在保存蒙版与部位…", async () => {
      const next = await saveDatasetMasks(dataset, preview.image.sourceHash, masks, writer);
      setPreview(undefined);
      return next;
    }, false);
  }

  function openImageMenu(event: ReactMouseEvent<HTMLElement>, image: AnnotatedImage) {
    if (busy || !imageMenu.current) return;
    event.preventDefault(); event.stopPropagation();
    setMenuImage(image); setFocusedId(image.id);
    const point = getFixedMenuPoint(event.clientX, event.clientY, 190, 150);
    imageMenu.current.style.left = point.x + "px"; imageMenu.current.style.top = point.y + "px";
    imageMenu.current.showPopover();
    imageMenu.current.querySelector("button")?.focus({ preventScroll: true });
  }

  return <section className="training-dataset-page">
    <div className="training-dataset-subnav">
      <div className="game-benchmark-tabs" role="tablist" aria-label="训练与数据集">
        <button type="button" id={`${id}-datasets`} aria-controls={`${id}-dataset-panel`} role="tab" aria-selected={view === "datasets"} onClick={() => setView("datasets")}>数据集</button>
        <button type="button" id={`${id}-training`} aria-controls={`${id}-training-panel`} role="tab" aria-selected={view === "training"} onClick={() => setView("training")}>训练</button>
      </div>
      {busy && <span className="hint" role="status">{busy}</span>}
    </div>
    {error && !renaming && <p className="training-dataset-error" role="alert">{error}</p>}
    <div ref={datasetMenu} popover="auto" className="unity-gallery-menu" role="menu"
      aria-label="数据集操作" style={{ inset: "auto", margin: 0 }}>
      <button type="button" role="menuitem" onClick={() => {
        datasetMenu.current?.hidePopover();
        if (menuReference) void api.revealPath(menuReference.path).catch(error => showAppNotice(String(error), "error"));
      }}>打开所在文件夹</button>
      <button type="button" role="menuitem" onClick={() => {
        datasetMenu.current?.hidePopover();
        if (menuReference) {
          setError(""); setRenameTitle(menuReference.title); setRenaming(menuReference);
        }
      }}>重命名</button>
      <button type="button" role="menuitem" disabled={!!busy} onClick={() => {
        datasetMenu.current?.hidePopover(); setDeletingDataset(menuReference);
      }}>删除数据集</button>
    </div>
    {deletingDataset && <GameDialog title="删除数据集" description={deletingDataset.workId
      ? `将「${deletingDataset.title}」的工作副本图片和标注移入系统回收站，并从列表移除。共用图片的其他副本仍可使用。`
      : `将「${deletingDataset.title}」从列表移除，原始图片和标注保留在原目录。`}
      disabled={!!busy} onCancel={() => setDeletingDataset(undefined)}>
      <button type="button" className="game-confirm-cancel" disabled={!!busy} onClick={() => setDeletingDataset(undefined)}>取消</button>
      <button type="button" className="game-confirm-accept" disabled={!!busy} onClick={deleteDataset}>确认删除</button>
    </GameDialog>}
    {renaming && <GameDialog title="重命名数据集" description={renaming.title} disabled={!!busy}
      onCancel={() => setRenaming(undefined)} details={<form id={`${id}-rename`} onSubmit={event => {
        event.preventDefault(); rename();
      }}>
        <input aria-label="数据集名称" value={renameTitle} autoFocus required disabled={!!busy}
          onFocus={event => event.currentTarget.select()} onChange={event => setRenameTitle(event.target.value)} />
        {error && <p className="training-dataset-error" role="alert">{error}</p>}
      </form>}>
      <button type="submit" form={`${id}-rename`} className="game-confirm-primary"
        disabled={!!busy || !renameTitle.trim()}>保存</button>
      <button type="button" className="game-confirm-cancel" disabled={!!busy} onClick={() => setRenaming(undefined)}>取消</button>
    </GameDialog>}
    <div className="training-dataset-placeholder" id={`${id}-training-panel`} role="tabpanel" aria-labelledby={`${id}-training`} hidden={view !== "training"}>
      <TrainingView onOpenDatasets={() => setView("datasets")} />
    </div>
    <div className="training-dataset-data-view" hidden={view !== "datasets"}>
      <div className="training-dataset-toolbar">
        <div className="training-dataset-toolbar-row">
          <div className="training-dataset-switch" role="group" aria-label="用途">
            {datasetPurposes.map(item => <button key={item} type="button" className="unity-btn" aria-pressed={purpose === item}
              onClick={() => { setPurpose(item); setFilter("all"); resetSelection(); }}>{datasetPurposeLabels[item]}</button>)}
          </div>
          <div className="training-dataset-switch" role="group" aria-label="标注状态">
            {(["all", ...verdicts] as const).map(item => <button key={item} type="button" className="unity-btn" aria-pressed={filter === item}
              onClick={() => { setFilter(item); resetSelection(); }}>{item === "all" ? "全部" : datasetVerdictLabels[purpose][item]}</button>)}
          </div>
          <button type="button" className="unity-btn" aria-expanded={more} aria-controls={id + "-filters"} onClick={() => setMore(!more)}>更多筛选</button>
          <div className="training-dataset-gallery-controls">
            <input type="search" aria-label="搜索文件名" placeholder="搜索文件名" value={search}
              onChange={event => { setSearch(event.target.value); resetSelection(); }} />
            <div className="training-dataset-switch" role="group" aria-label="图片视图">
              <button type="button" className="unity-btn" aria-pressed={layout === "grid"} onClick={() => setLayout("grid")}>网格</button>
              <button type="button" className="unity-btn" aria-pressed={layout === "list"} onClick={() => setLayout("list")}>列表</button>
            </div>
          </div>
          <span className="training-dataset-filter-count">已启用 {conditionCount} 项筛选</span>
          {conditionCount > 0 && <button type="button" className="unity-btn" onClick={() => {
            setConditions({ ...emptyDatasetFilters }); setFilter("all"); setSearch(""); resetSelection();
          }}>清除全部</button>}
        </div>
        {more && <div className="training-dataset-filters" id={id + "-filters"}>
          {(["width", "height"] as const).map(axis => <label key={axis}>{axis === "width" ? "宽度" : "高度"}
            <input type="number" min={0} aria-label={axis === "width" ? "最小宽度" : "最小高度"} placeholder="最小"
              value={conditions[axis + "Min" as "widthMin"]} onChange={event => { setConditions({ ...conditions, [axis + "Min"]: event.target.value }); resetSelection(); }} />
            <span>–</span><input type="number" min={0} aria-label={axis === "width" ? "最大宽度" : "最大高度"} placeholder="最大"
              value={conditions[axis + "Max" as "widthMax"]} onChange={event => { setConditions({ ...conditions, [axis + "Max"]: event.target.value }); resetSelection(); }} />
          </label>)}
          <label>来源<input type="text" aria-label="来源目录前缀" placeholder="来源目录前缀" value={conditions.source} onChange={event => { setConditions({ ...conditions, source: event.target.value }); resetSelection(); }} /></label>
          {scenes.length > 0 && <label>场景<select aria-label="场景" value={conditions.scene} onChange={event => { setConditions({ ...conditions, scene: event.target.value }); resetSelection(); }}>
            <option value="">全部</option>{scenes.map(scene => <option key={scene}>{scene}</option>)}
          </select></label>}
          <label>蒙版<select aria-label="蒙版筛选" value={conditions.masks} onChange={event => { setConditions({ ...conditions, masks: event.target.value as typeof conditions.masks }); resetSelection(); }}>
            <option value="all">全部</option><option value="yes">有蒙版</option><option value="no">无蒙版</option>
          </select></label>
          {hasAdoption && <label>采用<select aria-label="采用筛选" value={conditions.adopted} onChange={event => { setConditions({ ...conditions, adopted: event.target.value as typeof conditions.adopted }); resetSelection(); }}>
            <option value="all">全部</option><option value="yes">已采用</option><option value="no">未采用</option>
          </select></label>}
        </div>}
        <div className="training-dataset-operation-row">
        <div className="training-dataset-create" aria-label="新建数据集">
          <div className="training-dataset-actions">
            <button type="button" className="unity-btn unity-btn-primary" disabled={!desktop || !!busy}
              onClick={() => importInput.current?.click()}>从图片集导入</button>
            <button type="button" className="unity-btn" disabled={!desktop || !dataset || !!busy}
              data-tooltip="共用图片，单独保存标注；要求位于同一磁盘分区。直接修改图片内容会影响共用它的副本。"
              onClick={() => duplicate(true)}>新建标注副本</button>
            <button type="button" className="unity-btn" disabled={!desktop || !dataset || !!busy}
              data-tooltip="完整拷贝图片和标注，适合跨盘或需要独立修改图片的情况"
              onClick={() => duplicate(false)}>复制全部图片</button>
            <button type="button" className="unity-btn" disabled={!desktop || !dataset || !!busy}
              onClick={() => setDeletingDataset(dataset?.reference)}>删除数据集</button>
          </div>
          <input ref={element => { importInput.current = element; element?.setAttribute("webkitdirectory", ""); }} type="file" hidden multiple
            aria-label="选择图片集目录" onChange={event => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              if (files.length) run("正在导入图片集…", () => importTrainingDataset(files, files[0].webkitRelativePath.split("/")[0], writer, new AbortController().signal));
            }} />
        </div>

          <span className="training-dataset-result-count" aria-live="polite">{images.length} 张 · 已选 {checked.size} 张</span>
        </div>
      </div>
    <div className="training-dataset-workspace" style={{ "--dataset-list-width": libraryWidth + "px" } as CSSProperties} id={`${id}-dataset-panel`} role="tabpanel" aria-labelledby={`${id}-datasets`} hidden={view !== "datasets"}>
      <aside className="training-dataset-library" aria-label="数据集列表">
        <div className="training-dataset-column-head">
          <h3>数据集列表</h3><button className="unity-btn" type="button" disabled={!desktop || !!busy} onClick={openDirectory}>打开目录</button>
        </div>
        <ul className="training-dataset-library-list">
          {catalog.map(reference => <li key={reference.path}><button type="button" className="training-dataset-entry"
            aria-pressed={reference.path === dataset?.reference.path} disabled={!!busy} onClick={() => openReference(reference)}
            onContextMenu={event => openDatasetMenu(event, reference)}>
            <strong title={reference.title}>{reference.title}</strong>
            <span className="training-dataset-entry-meta">{reference.count} 张 · 已标注 {reference.labeled}</span>
            <span className="training-dataset-entry-badges">
              {reference.purposes.map(item => <span className="training-dataset-badge" key={item}>{datasetPurposeLabels[item]}</span>)}
              {reference.imageStorage && <span className="training-dataset-badge"
                data-tooltip={reference.imageStorage === "shared" ? "图片通过硬链接共用，标注单独保存；直接修改图片内容会影响共用副本" : "图片已完整拷贝"}>
                {reference.imageStorage === "shared" ? "共用图片" : "独立图片"}
              </span>}
              <span className="training-dataset-library-state">{reference.workId ? "正常" : "只读"}</span>
            </span>
          </button></li>)}
        </ul>
        {!catalog.length && <p className="training-dataset-empty hint">{desktop ? "打开已有数据集，或从图片集新建。" : "请在桌面版中管理数据集。"}</p>}
      </aside>
      <div className="training-dataset-resizer" role="separator" aria-label="调整数据集列表宽度" aria-orientation="vertical"
        tabIndex={0} aria-valuemin={200} aria-valuemax={560} aria-valuenow={libraryWidth} onDoubleClick={() => setLibraryWidth(248)}
        onKeyDown={event => {
          if (["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) {
            event.preventDefault(); setLibraryWidth(event.key === "Home" ? 248 : Math.max(200, Math.min(560, libraryWidth + (event.key === "ArrowLeft" ? -16 : 16))));
          }
        }} onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
          resizeOrigin.current = { x: event.clientX, width: libraryWidth }; setResizing(true);
        }} onPointerMove={event => {
          if (!resizeOrigin.current) return;
          const scale = event.currentTarget.currentCSSZoom || 1;
          setLibraryWidth(Math.max(200, Math.min(560, Math.round(resizeOrigin.current.width + (event.clientX - resizeOrigin.current.x) / scale))));
        }} onPointerUp={() => { resizeOrigin.current = undefined; setResizing(false); }}
        onPointerCancel={() => { resizeOrigin.current = undefined; setResizing(false); }}
        onLostPointerCapture={() => { resizeOrigin.current = undefined; setResizing(false); }} />
      <div className="training-dataset-gallery">
        {dataset && visible.length ? <ul ref={list} tabIndex={0} aria-label="数据集图片" aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home End PageUp PageDown Space Enter" className="training-dataset-images" data-layout={layout}>
          {visible.map(image => <li key={image.id} className="training-dataset-tile" data-active={focused?.id === image.id} onContextMenu={event => openImageMenu(event, image)}>
            <button type="button" className="training-dataset-sample" data-image-id={image.id} tabIndex={focused?.id === image.id ? 0 : -1} onDoubleClick={() => setPreview({ image, editing: false })} aria-pressed={focused?.id === image.id} onClick={() => setFocusedId(image.id)}>
              <span className="training-dataset-thumbnail"><SamplePicture image={image} read={dataset.data.read} /></span>
              <span className="training-dataset-tile-meta"><strong title={image.name}>{image.name}</strong><SampleBadges image={image} purpose={purpose} /></span>
            </button>
            <input type="checkbox" aria-label={`选择 ${image.name}`} checked={checked.has(image.sourceHash)}
              onChange={event => toggleChecked([image.sourceHash], event.target.checked)} />
          </li>)}
        </ul> : <p className="training-dataset-gallery-empty hint">{dataset ? "没有符合筛选条件的图片。" : "选择数据集后查看图片。"}</p>}
          <nav className="training-dataset-pagination" aria-label="数据集分页">
            <div className="training-dataset-actions">
              <label><input type="checkbox" disabled={!visible.length} checked={!!visible.length && visible.every(image => checked.has(image.sourceHash))}
                onChange={event => toggleChecked(visible.map(image => image.sourceHash), event.target.checked)} />选择本页</label>
              <select className="unity-btn" aria-label="每页图片数量" value={pageSize} onChange={event => {
                setPageSize(Number(event.target.value)); setPage(0); setFocusedId("");
              }}>{pageSizes.map(size => <option value={size} key={size}>每页 {size} 张</option>)}</select>
              <span className="hint" aria-live="polite">显示 {images.length ? currentPage * pageSize + 1 : 0}–{Math.min((currentPage + 1) * pageSize, images.length)} 张</span>
            </div>
            <div className="training-dataset-actions">
              <button type="button" className="unity-btn" disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); setFocusedId(""); }}>上一页</button>
              <select className="unity-btn" aria-label="跳转到数据集页" disabled={!images.length} value={currentPage} onChange={event => {
                setPage(Number(event.target.value)); setFocusedId("");
              }}>{Array.from({ length: pages }, (_, index) => <option value={index} key={index}>第 {images.length ? index + 1 : 0} / {images.length ? pages : 0} 页</option>)}</select>
              <button type="button" className="unity-btn" disabled={currentPage + 1 >= pages} onClick={() => { setPage(currentPage + 1); setFocusedId(""); }}>下一页</button>
            </div>
          </nav>
      </div>
      <aside className="training-dataset-details" aria-label="图片详情">
        <section>
          <h3>图片详情</h3>
          {dataset && focused ? <SampleDetails key={`${dataset.reference.path}:${focused.id}:${purpose}`} dataset={dataset}
            image={focused} purpose={purpose} busy={!!busy} onPreview={editing => setPreview({ image: focused, editing })} />
            : <p className="training-dataset-empty hint">选择图片后查看标注。</p>}
        </section>
        <section>
          <div className="training-dataset-column-head"><h3>批量打标</h3><span className="hint">已选 {checked.size} 张</span></div>
          <div className="training-dataset-actions">
            {verdicts.map(verdict => <button key={verdict} type="button" className="unity-btn" disabled={!editable || !targets.size || !!busy}
              onClick={() => label(verdict)}>{verdict === "unmarked" ? "清除标注" : `标记${datasetVerdictLabels[purpose][verdict]}`}</button>)}
          </div>
          {dataset && !editable && <p className="hint">复制到工作副本后即可打标。</p>}
        </section>

      </aside>
    </div>
    </div>
    <div ref={imageMenu} popover="auto" className="unity-gallery-menu" role="menu" aria-label="样本图片操作" style={{ inset: "auto", margin: 0 }}>
      <button type="button" role="menuitem" onClick={() => {
        imageMenu.current?.hidePopover();
        if (dataset && menuImage) void copyDatasetPicture(menuImage, dataset.data.read).catch(error => showAppNotice(String(error), "error"));
      }}>复制图片</button>
      <button type="button" role="menuitem" onClick={() => {
        imageMenu.current?.hidePopover(); if (menuImage) void copyText(menuImage.name).catch(error => showAppNotice(String(error), "error"));
      }}>复制文件名</button>
      <button type="button" role="menuitem" onClick={() => {
        imageMenu.current?.hidePopover();
        if (dataset && menuImage) void api.revealPath(dataset.reference.path.replace(/[^/\\\\]+$/, "images/" + menuImage.sourceHash + ".png")).catch(error => showAppNotice(String(error), "error"));
      }}>在文件管理器中显示</button>
      <button type="button" role="menuitem" disabled={!editable} onClick={() => { imageMenu.current?.hidePopover(); setDeleting(menuImage); }}>删除这一张</button>
    </div>
    {deleting && <GameDialog title="删除这一张" description={"将从工作副本移除 " + deleting.name + " 及其标注，不影响源数据集。"}
      disabled={!!busy} onCancel={() => setDeleting(undefined)}>
      <button type="button" className="game-confirm-cancel" disabled={!!busy} onClick={() => setDeleting(undefined)}>取消</button>
      <button type="button" className="game-confirm-accept" disabled={!!busy} onClick={() => {
        if (!dataset) return;
        const image = deleting;
        run("正在删除图片…", async () => {
          const next = await removeDatasetImage(dataset, image.sourceHash, writer);
          setDeleting(undefined); setChecked(values => new Set([...values].filter(hash => hash !== image.sourceHash)));
          return next;
        }, false);
      }}>删除</button>
    </GameDialog>}
    {preview && dataset && <TrainingDatasetImage key={preview.image.id + String(preview.editing)}
      image={preview.image} read={dataset.data.read} editing={preview.editing} busy={!!busy} onClose={() => setPreview(undefined)}
      masks={(preview.image.annotation.mosaic?.boxes ?? []).map(box => ({ box, part: partFor(dataset, preview.image.sourceHash, box) ?? "" }))}
      onSave={saveMasks} />}
  </section>;
}
