import { TrainingView } from "./TrainingView";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { AnnotatedImage } from "../benchmark/imageSampleSet";
import { copyTrainingDataset, datasetManifestIn, datasetPurposeLabels, datasetPurposes, datasetVerdict,
  datasetVerdictLabels, importTrainingDataset, labelDatasetImages, openTrainingDataset, partFor, readDatasetCatalog,
  rememberDataset, renameTrainingDataset, removeTrainingDataset, saveDatasetLabels, saveDatasetMasks, removeDatasetImage, emptyDatasetFilters, matchesDatasetFilters, writeTrainingDatasetFile, type DatasetPurpose,
  type DatasetReference, type DatasetVerdict, type DatasetWriter, type TrainingDataset } from "../benchmark/trainingDatasets";
import { api } from "../api";
import { getFixedMenuPoint, positionWindowPopover } from "../viewportLayout";
import { GameDialog } from "./GameActionConfirm";
import { showAppNotice } from "./AppNotice";
import { copyText } from "../clipboard";
import { SamplePicture, TrainingDatasetImage, copyDatasetPicture, useSamplePicture, type DatasetMask } from "./TrainingDatasetImage";
import { GameImageViewer } from "./GameImageViewer";
import "../styles/trainingDatasets.css";

const pageSizes = [24, 48, 96];
const verdicts = ["present", "none", "unmarked"] as const;
type Filter = DatasetVerdict | "all";
type ImageLayout = "list" | "thumbnails";
const layoutKey = "llmchat-training-dataset-image-layout";

function maskCount(dataset: TrainingDataset) {
  return dataset.data.images.reduce((sum, image) => sum + (image.annotation.mosaic?.boxes?.length ?? 0), 0);
}

function DatasetOriginal({ dataset, image, onClose }: {
  dataset: TrainingDataset; image: AnnotatedImage; onClose: () => void;
}) {
  const picture = useSamplePicture(image, dataset.data.read);
  return <GameImageViewer title={image.name} views={[{ label: "原图", width: image.width, height: image.height,
    src: picture.url, error: picture.failed ? "图片读取失败" : undefined }]} closeOnEscape={false} onClose={onClose} />;
}

export function TrainingDatasetsPage(_props: { channel?: BroadcastChannel }) {
  const id = useId();
  const [view, setView] = useState<"datasets" | "training">("datasets");
  const [catalog, setCatalog] = useState(readDatasetCatalog);
  const [dataset, setDataset] = useState<TrainingDataset>();
  const datasetRef = useRef<TrainingDataset | undefined>(undefined);
  const maskWrites = useRef<Promise<void>>(Promise.resolve());
  const maskWriteCount = useRef(0), undoRef = useRef<TrainingDataset[]>([]);
  function setCurrentDataset(value: TrainingDataset | undefined) { datasetRef.current = value; setDataset(value); }
  function updateUndoHistory(value: TrainingDataset[] | ((previous: TrainingDataset[]) => TrainingDataset[])) {
    undoRef.current = typeof value === "function" ? value(undoRef.current) : value; setUndoHistory(undoRef.current);
  }
  const [purpose, setPurpose] = useState<DatasetPurpose>("mosaic");
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [more, setMore] = useState(false);
  const [conditions, setConditions] = useState({ ...emptyDatasetFilters });
  const panel = useRef<HTMLDivElement>(null), list = useRef<HTMLUListElement>(null);
  const keyboardFocus = useRef<"list" | "canvas" | undefined>(undefined);
  const [preview, setPreview] = useState<AnnotatedImage>();
  const [listOpen, setListOpen] = useState(false);
  const imageMenu = useRef<HTMLDivElement>(null);
  const [menuImage, setMenuImage] = useState<AnnotatedImage>();
  const [deleting, setDeleting] = useState<AnnotatedImage>();
  const [layout, setLayout] = useState<ImageLayout>(() => localStorage.getItem(layoutKey) === "thumbnails" ? "thumbnails" : "list");
  useEffect(() => { localStorage.setItem(layoutKey, layout); }, [layout]);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(48);
  const [focusedId, setFocusedId] = useState("");
  const [checked, setChecked] = useState(new Set<string>());
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [maskWriteFailed, setMaskWriteFailed] = useState(false);
  const [undoHistory, setUndoHistory] = useState<TrainingDataset[]>([]);
  const busyRef = useRef(false);
  const importInput = useRef<HTMLInputElement>(null);
  const desktop = isTauri();
  const writer: DatasetWriter = writeTrainingDatasetFile;
  const datasetPicker = useRef<HTMLDivElement>(null), batchMenu = useRef<HTMLDivElement>(null);
  const datasetMenu = useRef<HTMLDivElement>(null);
  const [maskCounts, setMaskCounts] = useState<Record<string, number | null>>({});
  const requestedCounts = useRef(new Set<string>());
  const [menuReference, setMenuReference] = useState<DatasetReference>();
  const [renaming, setRenaming] = useState<DatasetReference>();
  const [deletingDataset, setDeletingDataset] = useState<DatasetReference>();
  const [renameTitle, setRenameTitle] = useState("");
  const editable = desktop && !!dataset?.reference.workId;
  const blocked = !!busy || maskWriteFailed;
  const query = search.trim().toLowerCase();
  const images = useMemo(() => dataset?.data.images.filter(image => (filter === "all" || datasetVerdict(image.annotation, purpose) === filter) &&
    (!query || image.file.toLowerCase().includes(query)) && matchesDatasetFilters(image, conditions, dataset?.parts)) ?? [], [dataset, filter, purpose, query, conditions]);
  const pages = Math.max(1, Math.ceil(images.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visible = images.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const focused = visible.find(image => image.id === focusedId) ?? visible[0];
  const scenes = [...new Set(dataset?.data.images.map(image => image.scene).filter((value): value is string => !!value))];
  const hasAdoption = dataset?.data.images.some(image => typeof image.adopted === "boolean");
  const conditionCount = Number(!!(conditions.widthMin || conditions.widthMax)) + Number(!!(conditions.heightMin || conditions.heightMax)) +
    Number(!!conditions.source) + Number(!!conditions.scene) + Number(conditions.masks !== "all") + Number(conditions.adopted !== "all") + Number(filter !== "all") + Number(!!query);
  const targets = checked.size ? checked : new Set(focused ? [focused.sourceHash] : []);
  useLayoutEffect(() => {
    const button = list.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    if (button?.getClientRects().length) button.scrollIntoView({ block: "nearest" });
    if (keyboardFocus.current === "list") button?.focus({ preventScroll: true });
    if (keyboardFocus.current === "canvas") panel.current?.querySelector<HTMLElement>(".training-dataset-canvas")?.focus({ preventScroll: true });
    keyboardFocus.current = undefined;
  }, [focused?.id, layout, listOpen, view]);

  function apply(next: TrainingDataset, select = true) {
    setCurrentDataset(next);
    setCatalog(rememberDataset(next.reference));
    setMaskCounts(counts => ({ ...counts, [next.reference.path]: maskCount(next) }));
    if (select) {
      updateUndoHistory([]);
      setPurpose(next.reference.purposes[0]);
      setFilter("all");
      setSearch("");
      setConditions({ ...emptyDatasetFilters });
      setPreview(undefined);
      resetSelection();
    }
  }

  function run(status: string, operation: () => Promise<TrainingDataset | undefined>, select = true, undoable = false) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(status);
    setError("");
    void operation().then(next => {
      if (!next) return;
      if (undoable && dataset) updateUndoHistory(history => [...history.slice(-99), dataset]);
      apply(next, select);
    })
      .catch(error => setError(String(error).replace(/^Error: /, "")))
      .finally(() => { busyRef.current = false; setBusy(""); });
  }

  function openReference(reference: DatasetReference) {
    datasetPicker.current?.hidePopover();
    if (reference.path === dataset?.reference.path) return;
    run("正在打开数据集…", async () => { await maskWrites.current; return openTrainingDataset(reference.path, reference.workId); });
  }

  function loadCatalogCounts() {
    for (const reference of catalog) {
      if (Object.hasOwn(maskCounts, reference.path) || requestedCounts.current.has(reference.path)) continue;
      requestedCounts.current.add(reference.path);
      void openTrainingDataset(reference.path).then(maskCount, () => null).then(count => {
        setMaskCounts(counts => Object.hasOwn(counts, reference.path) ? counts : { ...counts, [reference.path]: count });
      });
    }
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
    datasetPicker.current?.hidePopover();
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
    event.preventDefault();
    event.stopPropagation();
    if (blocked || !datasetMenu.current) return;
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
      setMaskCounts(counts => {
        const next = { ...counts }; delete next[reference.path]; return next;
      });
      requestedCounts.current.delete(reference.path);
      if (dataset?.reference.path === reference.path) {
        setCurrentDataset(undefined); updateUndoHistory([]); resetSelection(); setPreview(undefined); setMenuImage(undefined);
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
    run("正在保存标注…", () => saveDatasetLabels(dataset, labelDatasetImages(dataset, targets, purpose, verdict), dataset.parts, writer), false, true);
  }

  function saveMasks(hash: string, masks: DatasetMask[]): Promise<void> {
    const owner = datasetRef.current?.reference.path;
    maskWriteCount.current++;
    setBusy("正在写入标注…");
    const write = maskWrites.current.catch(() => {}).then(async () => {
      const current = datasetRef.current;
      if (!current || current.reference.path !== owner) throw new Error("数据集已切换，未写入其他工程");
      const next = await saveDatasetMasks(current, hash, masks, writer);
      updateUndoHistory(history => [...history.slice(-99), current]);
      apply(next, false); setError(""); setMaskWriteFailed(false);
    });
    maskWrites.current = write;
    return write.catch(error => { setMaskWriteFailed(true); throw error; }).finally(() => {
      maskWriteCount.current--;
      if (!maskWriteCount.current) setBusy(current => current === "正在写入标注…" ? "" : current);
    });
  }

  function undoEdit() {
    if (busyRef.current || !datasetRef.current) return;
    run("正在撤销标注…", async () => {
      await maskWrites.current.catch(() => {});
      const current = datasetRef.current, previous = undoRef.current.at(-1);
      if (!current || !previous || previous.reference.path !== current.reference.path) return;
      const restored = await saveDatasetLabels(current, previous.data.annotations.samples, previous.parts, writer);
      updateUndoHistory(history => history.slice(0, -1)); return restored;
    }, false);
  }

  function confirmSaved() {
    void maskWrites.current.then(() => showAppNotice("标注已保存", "success"))
      .catch(error => showAppNotice("标注尚未写入，请先重试：" + String(error), "error"));
  }

  function navigateImage(index: number, focus?: "list" | "canvas") {
    const next = Math.max(0, Math.min(images.length - 1, index));
    const image = images[next];
    if (blocked || !image || image.id === focused?.id) return;
    keyboardFocus.current = focus;
    setPage(Math.floor(next / pageSize));
    setFocusedId(image.id);
  }

  function annotateParts(reference: DatasetReference) {
    run("正在打开待标部位图片…", async () => {
      await maskWrites.current;
      const next = await openTrainingDataset(reference.path, reference.workId);
      if (reference.path !== datasetRef.current?.reference.path) updateUndoHistory([]);
      setPurpose("mosaic"); setFilter("all"); setSearch(""); setConditions({ ...emptyDatasetFilters, masks: "unmarked-parts" });
      setMore(true); resetSelection(); setPreview(undefined); setView("datasets"); return next;
    }, false);
  }


  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (view !== "datasets" || maskWriteFailed || (busy && busy !== "正在写入标注…") || preview || deleting || deletingDataset || renaming || event.isComposing ||
          !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "z" ||
          (event.target instanceof Element && event.target.closest("input,textarea,[contenteditable]")) || (!undoHistory.length && !maskWriteCount.current)) return;
      event.preventDefault(); event.stopPropagation(); undoEdit();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [view, busy, maskWriteFailed, preview, deleting, deletingDataset, renaming, undoHistory, dataset]);

  useEffect(() => {
    if (view !== "datasets") return;
    const key = (event: KeyboardEvent) => {
      const active = document.activeElement, inList = !!list.current?.contains(active);
      if (blocked || !focused || preview || renaming || deleting || deletingDataset || event.defaultPrevented || event.isComposing ||
        event.ctrlKey || event.metaKey || event.altKey || document.querySelector(":popover-open") ||
        (active instanceof Element && active.closest("input,textarea,select,[contenteditable]")) ||
        !(panel.current?.contains(active) || panel.current?.matches(":hover"))) return;
      const index = images.indexOf(focused);
      let next: number;
      switch (event.key) {
        case "ArrowUp": case "ArrowLeft": next = index - 1; break;
        case "ArrowDown": case "ArrowRight": next = index + 1; break;
        case "Home": if (!inList) return; next = 0; break;
        case "End": if (!inList) return; next = images.length - 1; break;
        case "PageUp": next = Math.max(0, currentPage - 1) * pageSize; break;
        case "PageDown": if (currentPage + 1 === pages) return; next = (currentPage + 1) * pageSize; break;
        case " ":
          if (!inList) return;
          event.preventDefault(); toggleChecked([focused.sourceHash], !checked.has(focused.sourceHash)); return;
        default: return;
      }
      event.preventDefault();
      navigateImage(next, inList ? "list" : "canvas");
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [view, blocked, focused, preview, renaming, deleting, deletingDataset, images, currentPage, pageSize, pages, checked]);

  function openImageMenu(event: ReactMouseEvent<HTMLElement>, image: AnnotatedImage) {
    event.preventDefault(); event.stopPropagation();
    if (blocked || !imageMenu.current) return;
    setMenuImage(image); setFocusedId(image.id);
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = getFixedMenuPoint(event.clientX || bounds.left, event.clientY || bounds.top, 190, 190);
    imageMenu.current.style.left = point.x + "px"; imageMenu.current.style.top = point.y + "px";
    imageMenu.current.showPopover();
    imageMenu.current.querySelector("button")?.focus({ preventScroll: true });
  }

  return <section className="training-dataset-page">
    <div className="training-dataset-subnav">
      <div className="game-benchmark-tabs" role="tablist" aria-label="训练与数据集">
        <button type="button" id={`${id}-datasets`} aria-controls={`${id}-dataset-panel`} role="tab" aria-selected={view === "datasets"} onClick={() => setView("datasets")}>数据集</button>
        <button type="button" id={`${id}-training`} aria-controls={`${id}-training-panel`} role="tab" aria-selected={view === "training"} disabled={blocked} onClick={() => setView("training")}>训练</button>
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
    {renaming && <GameDialog className="training-dataset-rename-dialog" title="重命名数据集" description={renaming.title} disabled={!!busy}
      onCancel={() => setRenaming(undefined)} details={<form id={`${id}-rename`} onSubmit={event => {
        event.preventDefault(); rename();
      }}>
        <textarea rows={3} aria-label="数据集名称" value={renameTitle} autoFocus required disabled={!!busy}
          onFocus={event => event.currentTarget.select()} onChange={event => setRenameTitle(event.target.value)} />
        <p className="hint">当前 {[...renameTitle].length} 个字符</p>
        {error && <p className="training-dataset-error" role="alert">{error}</p>}
      </form>}>
      <button type="submit" form={`${id}-rename`} className="game-confirm-primary"
        disabled={!!busy || !renameTitle.trim()}>保存</button>
      <button type="button" className="game-confirm-cancel" disabled={!!busy} onClick={() => setRenaming(undefined)}>取消</button>
    </GameDialog>}
    <div className="training-dataset-placeholder" id={`${id}-training-panel`} role="tabpanel" aria-labelledby={`${id}-training`} hidden={view !== "training"}>
      <TrainingView onOpenDatasets={() => setView("datasets")} onAnnotateParts={annotateParts} />
    </div>
    <div ref={panel} className="training-dataset-data-view" id={`${id}-dataset-panel`} role="tabpanel" aria-labelledby={`${id}-datasets`} hidden={view !== "datasets"}>
      <div className="training-dataset-toolbar">
        <div className="training-dataset-command-row">
          <button type="button" className="unity-btn training-dataset-list-toggle" aria-controls={id + "-image-list"}
            aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>列表</button>
          <button type="button" className="unity-btn training-dataset-picker-trigger" popoverTarget={id + "-catalog"} disabled={blocked}
            onClick={event => { positionWindowPopover(event.currentTarget, datasetPicker.current); loadCatalogCounts(); }}
            onContextMenu={event => { if (dataset) openDatasetMenu(event, dataset.reference); }}>
            <span title={dataset?.reference.title}>{dataset ? `数据集：${dataset.reference.title}` : "选择数据集"}</span>
            {dataset && <small>· {dataset.reference.count} 张 · {maskCounts[dataset.reference.path]} 蒙版</small>}
            <span aria-hidden="true">▾</span>
          </button>
          <div ref={datasetPicker} id={id + "-catalog"} popover="auto" className="training-dataset-catalog" aria-label="选择数据集">
            {catalog.map(reference => <button key={reference.path} type="button" className="training-dataset-catalog-item"
              aria-current={reference.path === dataset?.reference.path} onClick={() => openReference(reference)}
              onContextMenu={event => openDatasetMenu(event, reference)}>
              <span title={reference.title}>{reference.title}</span>
              <small>· {reference.count} 张 · {maskCounts[reference.path] ?? (maskCounts[reference.path] === null ? "—" : "…")} 蒙版</small>
            </button>)}
            <button type="button" className="training-dataset-catalog-item" disabled={!desktop} onClick={openDirectory}>打开目录</button>
          </div>
          <div className="training-dataset-actions training-dataset-commands">
            <button type="button" className="unity-btn" aria-expanded={more} aria-controls={id + "-filters"} onClick={() => setMore(!more)}>更多筛选</button>
            <button type="button" className="unity-btn" disabled={!desktop || blocked} onClick={() => importInput.current?.click()}>从图片集导入</button>
            <button type="button" className="unity-btn" disabled={!desktop || !dataset || blocked}
              data-tooltip="共用图片，单独保存标注；要求位于同一磁盘分区。直接修改图片内容会影响共用副本。" onClick={() => duplicate(true)}>新建标注副本</button>
            <button type="button" className="unity-btn" disabled={!desktop || !dataset || blocked}
              data-tooltip="完整拷贝图片和标注，适合跨盘或需要独立修改图片的情况" onClick={() => duplicate(false)}>复制全部图片</button>
            <button type="button" className="unity-btn unity-btn-primary" disabled={!editable || (!!busy && !maskWriteCount.current)}
              onClick={confirmSaved}>保存</button>
          </div>
          <input ref={element => { importInput.current = element; element?.setAttribute("webkitdirectory", ""); }} type="file" hidden multiple
            aria-label="选择图片集目录" onChange={event => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              if (files.length) run("正在导入图片集…", () => importTrainingDataset(files, files[0].webkitRelativePath.split("/")[0], writer, new AbortController().signal));
            }} />
        </div>
        <fieldset className="training-dataset-toolbar-row" disabled={blocked} aria-label="图片筛选">
          <div className="training-dataset-switch" role="group" aria-label="用途">
            {datasetPurposes.map(item => <button key={item} type="button" className="unity-btn" aria-pressed={purpose === item}
              onClick={() => { setPurpose(item); setFilter("all"); resetSelection(); }}>{datasetPurposeLabels[item]}</button>)}
          </div>
          <div className="training-dataset-switch" role="group" aria-label="标注状态">
            {(["all", ...verdicts] as const).map(item => <button key={item} type="button" className="unity-btn" aria-pressed={filter === item}
              onClick={() => { setFilter(item); resetSelection(); }}>{item === "all" ? "全部" : datasetVerdictLabels[purpose][item]}</button>)}
          </div>
          <input type="search" aria-label="搜索文件名" placeholder="搜索文件名" value={search}
            onChange={event => { setSearch(event.target.value); resetSelection(); }} />
          {conditionCount > 0 && <button type="button" className="unity-btn" onClick={() => {
            setConditions({ ...emptyDatasetFilters }); setFilter("all"); setSearch(""); resetSelection();
          }}>清除全部</button>}
        </fieldset>
        <fieldset className="training-dataset-filters" id={id + "-filters"} aria-label="更多筛选" disabled={blocked} hidden={!more}>
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
            <option value="all">全部</option><option value="yes">有蒙版</option><option value="no">无蒙版</option><option value="unmarked-parts">有蒙版未标部位</option>
          </select></label>
          {hasAdoption && <label>采用<select aria-label="采用筛选" value={conditions.adopted} onChange={event => { setConditions({ ...conditions, adopted: event.target.value as typeof conditions.adopted }); resetSelection(); }}>
            <option value="all">全部</option><option value="yes">已采用</option><option value="no">未采用</option>
          </select></label>}
        </fieldset>
      </div>
      <div className="training-dataset-workspace" data-list-open={listOpen}>
        <aside className="training-dataset-image-list" id={id + "-image-list"} aria-label="图片列表">
          <header className="training-dataset-list-head">
            <h3>图片列表</h3>
            <span className="training-dataset-range" aria-live="polite">
              {images.length ? currentPage * pageSize + 1 : 0}–{Math.min((currentPage + 1) * pageSize, images.length)} / {images.length}
            </span>
            <div className="training-dataset-switch" role="group" aria-label="图片列表展示方式">
              <button type="button" className="unity-btn" aria-pressed={layout === "list"} onClick={() => setLayout("list")}>列表</button>
              <button type="button" className="unity-btn" aria-pressed={layout === "thumbnails"} onClick={() => setLayout("thumbnails")}>缩略图</button>
            </div>
          </header>
          <ul ref={list} aria-label="数据集图片" aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home End PageUp PageDown Space"
            className="training-dataset-images" data-layout={layout}>
            {dataset && visible.map(image => {
              const verdict = datasetVerdict(image.annotation, purpose);
              const boxes = image.annotation.mosaic?.boxes?.length ?? 0;
              const status = purpose === "mosaic" && boxes ? `${boxes} 蒙版` : datasetVerdictLabels[purpose][verdict];
              const active = focused?.id === image.id;
              return <li key={image.id} className="training-dataset-tile" data-active={active} data-checked={checked.has(image.sourceHash)}
                onContextMenu={event => openImageMenu(event, image)}>
                <button type="button" className="training-dataset-sample" data-image-id={image.id} tabIndex={active ? 0 : -1}
                  aria-pressed={active} disabled={blocked} onClick={() => setFocusedId(image.id)}>
                  <span className="training-dataset-thumbnail"><SamplePicture image={image} read={dataset.data.read} /></span>
                  <span className="training-dataset-tile-meta">
                    <strong title={image.name}>{image.name}</strong>
                    <small>{image.width} × {image.height} · {status}</small>
                  </span>
                  <span className="training-dataset-status-dot" data-marked={verdict !== "unmarked"} aria-hidden="true" />
                </button>
                <input type="checkbox" aria-label={`选择 ${image.name}`} checked={checked.has(image.sourceHash)} disabled={blocked}
                  onChange={event => toggleChecked([image.sourceHash], event.target.checked)} />
              </li>;
            })}
          </ul>
          <footer className="training-dataset-list-footer">
            <div className="training-dataset-pagination" aria-label="批量选择">
              <label><input type="checkbox" disabled={blocked || !visible.length} checked={!!visible.length && visible.every(image => checked.has(image.sourceHash))}
                onChange={event => toggleChecked(visible.map(image => image.sourceHash), event.target.checked)} />本页</label>
              <span className="training-dataset-result-count" aria-live="polite">已选 {checked.size} 张</span>
              <button type="button" className="unity-btn" disabled={blocked || !dataset} popoverTarget={id + "-batch"}
                onClick={event => positionWindowPopover(event.currentTarget, batchMenu.current)}>批量打标</button>
              <div ref={batchMenu} id={id + "-batch"} popover="auto" className="training-dataset-batch" aria-label="批量打标">
                {verdicts.map(verdict => <button key={verdict} type="button" className="training-dataset-catalog-item" disabled={blocked || !editable || !targets.size}
                  onClick={() => { batchMenu.current?.hidePopover(); label(verdict); }}>
                  {verdict === "unmarked" ? "清除标注" : `标记${datasetVerdictLabels[purpose][verdict]}`}
                </button>)}
                {dataset && !editable && <p className="hint">创建标注副本后可打标。</p>}
              </div>
            </div>
            <nav className="training-dataset-pagination" aria-label="数据集分页">
              <select className="unity-btn" aria-label="每页图片数量" disabled={blocked} value={pageSize} onChange={event => {
                setPageSize(Number(event.target.value)); setPage(0); setFocusedId("");
              }}>{pageSizes.map(size => <option value={size} key={size}>每页 {size} 张</option>)}</select>
              <button type="button" className="unity-btn" disabled={blocked || currentPage === 0} aria-label="上一页"
                onClick={() => navigateImage((currentPage - 1) * pageSize)}>‹</button>
              <select className="unity-btn" aria-label="跳转到数据集页" disabled={blocked || !images.length} value={currentPage}
                onChange={event => navigateImage(Number(event.target.value) * pageSize)}>
                {Array.from({ length: pages }, (_, index) => <option value={index} key={index}>{images.length ? index + 1 : 0} / {images.length ? pages : 0}</option>)}
              </select>
              <button type="button" className="unity-btn" disabled={blocked || currentPage + 1 >= pages} aria-label="下一页"
                onClick={() => navigateImage((currentPage + 1) * pageSize)}>›</button>
            </nav>
          </footer>
        </aside>
        {focused && dataset ? <TrainingDatasetImage key={dataset.reference.path + ":" + focused.id}
          image={focused} read={dataset.data.read} editable={editable && purpose === "mosaic"} busy={busyRef.current}
          readOnlyHint={purpose !== "mosaic" ? "切换到去码用途可编辑部位蒙版" : undefined}
          masks={(focused.annotation.mosaic?.boxes ?? []).map(box => ({ box, part: partFor(dataset, focused.sourceHash, box) ?? "" }))}
          onChange={masks => saveMasks(focused.sourceHash, masks)} onUndo={undoEdit} canUndo={!blocked && !!undoHistory.length}
          onPreview={() => setPreview(focused)} onContextMenu={event => openImageMenu(event, focused)} />
          : <p className="training-dataset-gallery-empty hint">{dataset ? "没有符合筛选条件的图片。" : "打开已有数据集，或从图片集导入。"}</p>}
      </div>
    </div>
    <div ref={imageMenu} popover="auto" className="unity-gallery-menu" role="menu" aria-label="样本图片操作" style={{ inset: "auto", margin: 0 }}>
      <button type="button" role="menuitem" onClick={() => {
        imageMenu.current?.hidePopover(); if (menuImage) setPreview(menuImage);
      }}>查看原图</button>
      <button type="button" role="menuitem" onClick={() => {
        imageMenu.current?.hidePopover();
        if (dataset && menuImage) void copyDatasetPicture(menuImage, dataset.data.read).catch(error => showAppNotice(String(error), "error"));
      }}>复制图片</button>
      <button type="button" role="menuitem" onClick={() => {
        imageMenu.current?.hidePopover(); if (menuImage) void copyText(menuImage.name).catch(error => showAppNotice(String(error), "error"));
      }}>复制文件名</button>
      <button type="button" role="menuitem" onClick={() => {
        imageMenu.current?.hidePopover();
        if (dataset && menuImage) void api.revealPath(dataset.data.project.root + "images/" + menuImage.sourceHash + ".png")
          .catch(error => showAppNotice(String(error), "error"));
      }}>在文件管理器中显示</button>
      <button type="button" role="menuitem" disabled={!editable} onClick={() => { imageMenu.current?.hidePopover(); setDeleting(menuImage); }}>删除这一张</button>
    </div>
    {dataset && preview && <DatasetOriginal dataset={dataset} image={preview} onClose={() => setPreview(undefined)} />}
    {deleting && <GameDialog title="删除这一张" description={"将从工作副本移除 " + deleting.name + " 及其标注，不影响源数据集。"}
      disabled={!!busy} onCancel={() => setDeleting(undefined)}>
      <button type="button" className="game-confirm-cancel" disabled={!!busy} onClick={() => setDeleting(undefined)}>取消</button>
      <button type="button" className="game-confirm-accept" disabled={!!busy} onClick={() => {
        if (!dataset) return;
        const image = deleting;
        run("正在删除图片…", async () => {
          const next = await removeDatasetImage(dataset, image.sourceHash, writer);
          updateUndoHistory([]);
          setDeleting(undefined); setChecked(values => new Set([...values].filter(hash => hash !== image.sourceHash)));
          return next;
        }, false);
      }}>删除</button>
    </GameDialog>}
  </section>;
}
