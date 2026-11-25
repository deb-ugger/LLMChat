import { TrainingView } from "./TrainingView";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useId, useRef, useState, type PointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { AnnotatedImage, AnnotatedSampleSet } from "../benchmark/imageSampleSet";
import { copyTrainingDataset, datasetManifestIn, datasetParts, datasetPurposeLabels, datasetPurposes, datasetVerdict,
  datasetVerdictLabels, importTrainingDataset, labelDatasetImages, openTrainingDataset, partFor, readDatasetCatalog,
  rememberDataset, renameTrainingDataset, saveDatasetLabels, setDatasetPart, writeTrainingDatasetFile, type DatasetPart, type DatasetPurpose,
  type DatasetReference, type DatasetVerdict, type DatasetWriter, type TrainingDataset } from "../benchmark/trainingDatasets";
import { api } from "../api";
import { getFixedMenuPoint } from "../viewportLayout";
import { GameDialog } from "./GameActionConfirm";
import { showAppNotice } from "./AppNotice";
import type { MosaicBox } from "../gameMosaic";
import "../styles/trainingDatasets.css";

const pageSizes = [24, 48, 96];
const verdicts = ["present", "none", "unmarked"] as const;
type Filter = DatasetVerdict | "all";

function SamplePicture({ image, read }: { image: AnnotatedImage; read: AnnotatedSampleSet["read"] }) {
  const [source, setSource] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let url = "";
    setSource("");
    setFailed(false);
    void read(image, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setSource(url);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [image.sourceHash, read]);
  return source ? <img src={source} alt="" draggable={false} /> : <span className="training-dataset-picture-state">{failed ? "图片读取失败" : "读取中…"}</span>;
}

function SampleBadges({ image, purpose }: { image: AnnotatedImage; purpose: DatasetPurpose }) {
  const state = datasetVerdict(image.annotation, purpose);
  return <span className="training-dataset-badge" data-state={state}>{datasetVerdictLabels[purpose][state]}</span>;
}

function SampleDetails({ dataset, image, purpose, busy, onBoxes, onPart }: {
  dataset: TrainingDataset; image: AnnotatedImage; purpose: DatasetPurpose; busy: boolean;
  onBoxes: (boxes: MosaicBox[]) => void; onPart: (box: MosaicBox, part: DatasetPart | "") => void;
}) {
  const [boxIndex, setBoxIndex] = useState(0);
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<MosaicBox>();
  const origin = useRef<[number, number] | undefined>(undefined);
  const mosaicBoxes = image.annotation.mosaic?.boxes ?? [];
  const boxes = purpose === "mosaic" ? mosaicBoxes : image.annotation.text?.regions?.map(region => region.box) ?? image.annotation.text?.initialBoxes ?? [];
  const selectedIndex = Math.min(boxIndex, boxes.length - 1);
  const box = boxes[selectedIndex];
  const part = purpose === "mosaic" && box ? partFor(dataset, image.sourceHash, box) : undefined;
  const editable = !!dataset.reference.workId && purpose === "mosaic";

  function position(event: PointerEvent<HTMLDivElement>): [number, number] {
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = (value: number, extent: number, pixels: number) => Math.max(0, Math.min(pixels, Math.round(value / extent * pixels)));
    return [scale(event.clientX - rect.left, rect.width, image.width), scale(event.clientY - rect.top, rect.height, image.height)];
  }

  function dragBox([x0, y0]: [number, number], [x1, y1]: [number, number]): MosaicBox {
    return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  }

  return <>
    <div className="training-dataset-detail-preview">
      <div className="training-dataset-detail-picture" data-drawing={drawing} style={{
        aspectRatio: `${image.width} / ${image.height}`, width: `min(100%, ${image.width / image.height * 150}px)`,
      }} onPointerDown={event => {
        if (!drawing || !editable || busy || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        origin.current = position(event);
      }} onPointerMove={event => {
        if (origin.current) setDraft(dragBox(origin.current, position(event)));
      }} onPointerCancel={() => { origin.current = undefined; setDraft(undefined); }} onPointerUp={event => {
        if (!origin.current) return;
        const next = dragBox(origin.current, position(event));
        origin.current = undefined;
        setDraft(undefined);
        if (next[2] <= next[0] || next[3] <= next[1]) return;
        setDrawing(false);
        setBoxIndex(boxes.length);
        onBoxes([...boxes, next]);
      }}>
        <SamplePicture image={image} read={dataset.data.read} />
        {[...boxes, ...(draft ? [draft] : [])].map(([left, top, right, bottom], index) => <span key={index} aria-hidden="true"
          className="training-dataset-mask" data-active={index === selectedIndex || index === boxes.length}
          style={{ left: `${left / image.width * 100}%`, top: `${top / image.height * 100}%`,
            width: `${(right - left) / image.width * 100}%`, height: `${(bottom - top) / image.height * 100}%` }} />)}
      </div>
    </div>
    <dl className="training-dataset-detail-fields">
      <div><dt>文件</dt><dd title={image.name}>{image.name}</dd></div>
      <div><dt>尺寸</dt><dd>{image.width} × {image.height}</dd></div>
      <div><dt>来源</dt><dd title={image.file}>{image.file}</dd></div>
      <div><dt>用途</dt><dd>{datasetPurposeLabels[purpose]}</dd></div>
      <div><dt>标注</dt><dd><SampleBadges image={image} purpose={purpose} /></dd></div>
      <div><dt>蒙版数</dt><dd>{boxes.length}{boxes.length > 1 && <select aria-label="选择蒙版" value={selectedIndex}
        onChange={event => setBoxIndex(Number(event.target.value))}>{boxes.map((_, index) => <option key={index} value={index}>蒙版 {index + 1}</option>)}</select>}</dd></div>
      <div><dt>部位</dt><dd>{editable && box ? <select aria-label="确认部位" value={part ?? ""} disabled={busy}
        onChange={event => onPart(box, event.target.value as DatasetPart | "")}>
        <option value="">未标注</option>
        {Object.entries(datasetParts).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select> : part ? datasetParts[part] : "—"}</dd></div>
      <div><dt>置信度</dt><dd>—</dd></div>
    </dl>
    {editable && <div className="training-dataset-actions training-dataset-mask-actions">
      <button type="button" className="unity-btn" disabled={busy} aria-pressed={drawing} onClick={() => setDrawing(!drawing)}>{drawing ? "取消绘制" : "添加蒙版"}</button>
      {box && <button type="button" className="unity-btn" disabled={busy} onClick={() => onBoxes(boxes.filter((_, index) => index !== selectedIndex))}>删除蒙版</button>}
      {drawing && <span className="hint">在预览图上拖动框选</span>}
    </div>}
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
  const [renameTitle, setRenameTitle] = useState("");
  const editable = desktop && !!dataset?.reference.workId;
  const query = search.trim().toLowerCase();
  const images = dataset?.data.images.filter(image => (filter === "all" || datasetVerdict(image.annotation, purpose) === filter) &&
    (!query || image.file.toLowerCase().includes(query))) ?? [];
  const pages = Math.max(1, Math.ceil(images.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visible = images.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const focused = images.find(image => image.id === focusedId) ?? visible[0];
  const targets = checked.size ? checked : new Set(focused ? [focused.sourceHash] : []);

  function apply(next: TrainingDataset, select = true) {
    setDataset(next);
    setCatalog(rememberDataset(next.reference));
    if (select) {
      setPurpose(next.reference.purposes[0]);
      setFilter("all");
      setSearch("");
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
      pointer ? event.clientY : bounds.bottom, 190, 100);
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

  function editBoxes(boxes: MosaicBox[]) {
    if (!dataset || !focused || !editable) return;
    const hash = focused.sourceHash;
    const samples = { ...dataset.data.annotations.samples,
      [hash]: { ...focused.annotation, mosaic: { state: "present", boxes, boxCoverage: "partial" } } } as const;
    run("正在保存蒙版…", () => saveDatasetLabels(dataset, samples, dataset.parts, writer), false);
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
    </div>
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
    <div className="training-dataset-workspace" id={`${id}-dataset-panel`} role="tabpanel" aria-labelledby={`${id}-datasets`} hidden={view !== "datasets"}>
      <aside className="training-dataset-library" aria-label="数据集列表">
        <div className="training-dataset-column-head">
          <h3>数据集列表</h3><button className="unity-btn" type="button" disabled={!desktop || !!busy} onClick={openDirectory}>打开目录</button>
        </div>
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
          </div>
          <input ref={element => { importInput.current = element; element?.setAttribute("webkitdirectory", ""); }} type="file" hidden multiple
            aria-label="选择图片集目录" onChange={event => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              if (files.length) run("正在导入图片集…", () => importTrainingDataset(files, files[0].webkitRelativePath.split("/")[0], writer, new AbortController().signal));
            }} />
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
      <div className="training-dataset-gallery">
        <div className="training-dataset-toolbar" style={{ flexShrink: 0 }}>
          <div className="training-dataset-toolbar-row">
            <div className="training-dataset-switch" role="group" aria-label="用途">
              {datasetPurposes.map(item => <button key={item} type="button" className="unity-btn" aria-pressed={purpose === item}
                onClick={() => { setPurpose(item); setFilter("all"); resetSelection(); }}>{datasetPurposeLabels[item]}</button>)}
            </div>
            <div className="training-dataset-gallery-controls">
              <input type="search" aria-label="搜索文件名" placeholder="搜索文件名" value={search}
                onChange={event => { setSearch(event.target.value); resetSelection(); }} />
              <div className="training-dataset-switch" role="group" aria-label="图片视图">
                <button type="button" className="unity-btn" aria-pressed={layout === "grid"} onClick={() => setLayout("grid")}>网格</button>
                <button type="button" className="unity-btn" aria-pressed={layout === "list"} onClick={() => setLayout("list")}>列表</button>
              </div>
            </div>
          </div>
          <div className="training-dataset-toolbar-row">
            <div className="training-dataset-switch" role="group" aria-label="标注状态">
              {(["all", ...verdicts] as const).map(item => <button key={item} type="button" className="unity-btn" aria-pressed={filter === item}
                onClick={() => { setFilter(item); resetSelection(); }}>{item === "all" ? "全部" : datasetVerdictLabels[purpose][item]}</button>)}
            </div>
            <span className="training-dataset-result-count" aria-live="polite">{images.length} 张</span>
          </div>
          <nav className="training-dataset-toolbar-row" aria-label="数据集分页">
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
        {dataset && visible.length ? <ul className="training-dataset-images" data-layout={layout}>
          {visible.map(image => <li key={image.id} className="training-dataset-tile" data-active={focused?.id === image.id}>
            <button type="button" className="training-dataset-sample" aria-pressed={focused?.id === image.id} onClick={() => setFocusedId(image.id)}>
              <span className="training-dataset-thumbnail"><SamplePicture image={image} read={dataset.data.read} /></span>
              <span className="training-dataset-tile-meta"><strong title={image.name}>{image.name}</strong><SampleBadges image={image} purpose={purpose} /></span>
            </button>
            <input type="checkbox" aria-label={`选择 ${image.name}`} checked={checked.has(image.sourceHash)}
              onChange={event => toggleChecked([image.sourceHash], event.target.checked)} />
          </li>)}
        </ul> : <p className="training-dataset-gallery-empty hint">{dataset ? "没有符合筛选条件的图片。" : "选择数据集后查看图片。"}</p>}
      </div>
      <aside className="training-dataset-details" aria-label="图片详情">
        <section>
          <h3>图片详情</h3>
          {dataset && focused ? <SampleDetails key={`${dataset.reference.path}:${focused.id}:${purpose}`} dataset={dataset}
            image={focused} purpose={purpose} busy={!!busy} onBoxes={editBoxes}
            onPart={(box, part) => run("正在保存部位…", () => setDatasetPart(dataset, focused.sourceHash, box, part, writer), false)} />
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
  </section>;
}
