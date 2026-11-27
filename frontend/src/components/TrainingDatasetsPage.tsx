import { TrainingView } from "./TrainingView";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useDatasetListSplit } from "../hooks/useDatasetListSplit";
import type { AnnotatedImage } from "../benchmark/imageSampleSet";
import { copyTrainingDataset, datasetManifestIn, datasetPurposeLabels, datasetPurposes, datasetVerdict,
  datasetVerdictLabels, datasetParts, importTrainingDataset, labelDatasetImages, labelDatasetParts, openTrainingDataset, partFor, readDatasetCatalog,
  rememberDataset, renameTrainingDataset, removeTrainingDataset, saveDatasetLabels, saveDatasetMasks, removeDatasetImage, emptyDatasetFilters, matchesDatasetFilters, writeTrainingDatasetFile, type DatasetPurpose,
  type DatasetPart, type DatasetReference, type DatasetVerdict, type DatasetWriter, type TrainingDataset } from "../benchmark/trainingDatasets";
import { api } from "../api";
import { getFixedMenuPoint, positionWindowPopover } from "../viewportLayout";
import { GameDialog } from "./GameActionConfirm";
import { showAppNotice } from "./AppNotice";
import { copyText } from "../clipboard";
import { SamplePicture, TrainingDatasetImage, copyDatasetPicture, useSamplePicture, type DatasetMask } from "./TrainingDatasetImage";
import { GameImageViewer } from "./GameImageViewer";
import { UnityIconButton } from "./UnityIconButton";
import { UnityActionIcon } from "./UnityActionIcon";
import "../styles/trainingDatasets.css";

const pageSizes = [24, 48, 96];
const verdicts = ["present", "none", "unmarked"] as const;
type Filter = DatasetVerdict | "all";
type ImageLayout = "list" | "thumbnails";
const layoutKey = "llmchat-training-dataset-image-layout";

function maskCount(dataset: TrainingDataset) {
  return dataset.data.images.reduce((sum, image) => sum + (image.annotation.mosaic?.boxes?.length ?? 0), 0);
}

function DatasetCounts({ images, masks }: { images: number; masks: number | null | undefined }) {
  return <span className="training-dataset-counts">
    <span>{images} 张</span>
    <span>{masks ?? (masks === null ? "—" : "…")} 蒙版</span>
  </span>;
}

function DatasetOriginal({ dataset, image, onClose }: {
  dataset: TrainingDataset; image: AnnotatedImage; onClose: () => void;
}) {
  const picture = useSamplePicture(image, dataset.data.read);
  return <GameImageViewer title={image.name} views={[{ label: "原图", width: image.width, height: image.height,
    src: picture.url, error: picture.failed ? "图片读取失败" : undefined }]} closeOnEscape={false} onClose={onClose} />;
}

export function TrainingDatasetsPage({ channel: _channel, headerTools }: { channel?: BroadcastChannel; headerTools?: HTMLDivElement | null }) {
  const id = useId();
  const [view, setView] = useState<"datasets" | "training">("datasets");
  const [catalog, setCatalog] = useState(readDatasetCatalog);
  const [dataset, setDataset] = useState<TrainingDataset>();
  const datasetRef = useRef<TrainingDataset | undefined>(undefined);
  const maskWrites = useRef<Promise<void>>(Promise.resolve());
  const unsavedMasks = useRef(new Map<string, DatasetMask[]>());
  const [pendingMaskWrites, setPendingMaskWrites] = useState(0);
  const [confirmingSave, setConfirmingSave] = useState(false);
  const maskWriteCount = useRef(0), undoRef = useRef<TrainingDataset[]>([]);
  function setCurrentDataset(value: TrainingDataset | undefined) { datasetRef.current = value; setDataset(value); }
  const redoRef = useRef<TrainingDataset[]>([]);
  const [redoHistory, setRedoHistory] = useState<TrainingDataset[]>([]);
  function updateRedoHistory(value: TrainingDataset[]) { redoRef.current = value; setRedoHistory(value); }
  function updateUndoHistory(value: TrainingDataset[] | ((previous: TrainingDataset[]) => TrainingDataset[]), resetRedo = true) {
    if (resetRedo) updateRedoHistory([]);
    undoRef.current = typeof value === "function" ? value(undoRef.current) : value; setUndoHistory(undoRef.current);
  }
  const [purpose, setPurpose] = useState<DatasetPurpose>("mosaic");
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const [conditions, setConditions] = useState({ ...emptyDatasetFilters });
  const panel = useRef<HTMLDivElement>(null), list = useRef<HTMLUListElement>(null);
  const listSplit = useDatasetListSplit(view === "datasets");
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
  const [selectedIds, setSelectedIds] = useState(new Set<string>());
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [maskCounts, setMaskCounts] = useState<Record<string, number | null>>({});
  const requestedCounts = useRef(new Set<string>());
  const [menuReference, setMenuReference] = useState<DatasetReference>();
  const [renaming, setRenaming] = useState<DatasetReference>();
  const [deletingDataset, setDeletingDataset] = useState<DatasetReference>();
  const [renameTitle, setRenameTitle] = useState("");
  const editable = desktop && !!dataset?.reference.workId;
  const blocked = !!busy || maskWriteFailed || confirmingSave;
  const hasUnsavedChanges = pendingMaskWrites > 0 || maskWriteFailed;
  const canSave = editable && hasUnsavedChanges && !confirmingSave && (!busy || pendingMaskWrites > 0);
  const query = search.trim().toLowerCase();
  const images = useMemo(() => dataset?.data.images.filter(image => (filter === "all" || datasetVerdict(image.annotation, purpose) === filter) &&
    (!query || image.file.toLowerCase().includes(query)) && matchesDatasetFilters(image, conditions, dataset?.parts)) ?? [], [dataset, filter, purpose, query, conditions]);
  const pages = Math.max(1, Math.ceil(images.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visible = images.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const focused = focusedId ? images.find(image => image.id === focusedId) : undefined;
  const focusedGalleryIndex = focused ? images.indexOf(focused) + 1 : 0;
  const [pageJump, setPageJump] = useState("1");
  useEffect(() => { setPageJump(String(currentPage + 1)); }, [currentPage]);
  const scenes = [...new Set(dataset?.data.images.map(image => image.scene).filter((value): value is string => !!value))];
  const hasAdoption = dataset?.data.images.some(image => typeof image.adopted === "boolean");
  const conditionCount = Number(!!(conditions.widthMin || conditions.widthMax)) + Number(!!(conditions.heightMin || conditions.heightMax)) +
    Number(!!conditions.source) + Number(!!conditions.scene) + Number(conditions.masks !== "all") + Number(conditions.adopted !== "all") + Number(filter !== "all") + Number(!!query);
  const targets = new Set(images.filter(image => selectedIds.has(image.id)).map(image => image.sourceHash));
  useLayoutEffect(() => {
    const button = focusedId ? list.current?.querySelector<HTMLButtonElement>(`[data-image-id="${CSS.escape(focusedId)}"]`) : undefined;
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
    setSelectedIds(new Set());
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
    openDatasetOpsMenu(event, reference);
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

  function pickListImage(image: AnnotatedImage, event: ReactMouseEvent) {
    if (blocked) return;
    const extend = event.ctrlKey || event.metaKey;
    if (extend) event.preventDefault();
    if (event.detail > 1) return;
    setSelectedIds(previous => {
      if (!extend) return new Set([image.id]);
      const next = new Set(previous);
      if (next.has(image.id)) next.delete(image.id);
      else next.add(image.id);
      return next;
    });
    setFocusedId(image.id);
  }

  function openListImage(image: AnnotatedImage) {
    if (blocked) return;
    keyboardFocus.current = "canvas";
    setFocusedId(image.id);
  }

  function label(verdict: DatasetVerdict) {
    if (!dataset || !editable || !targets.size) return;
    run("正在保存标注…", () => saveDatasetLabels(dataset, labelDatasetImages(dataset, targets, purpose, verdict), dataset.parts, writer), false, true);
  }

  function labelParts(part: DatasetPart) {
    if (!dataset || !editable || !targets.size || purpose !== "mosaic") return;
    run("正在保存部位标注…", () => {
      const next = labelDatasetParts(dataset, targets, part);
      return saveDatasetLabels(dataset, next.samples, next.parts, writer);
    }, false, true);
  }

  function saveMasks(hash: string, masks: DatasetMask[]): Promise<void> {
    const owner = datasetRef.current?.reference.path;
    const pendingMasks = masks.map(({ box, part }) => ({ box: [...box] as DatasetMask["box"], part }));
    unsavedMasks.current.set(hash, pendingMasks);
    maskWriteCount.current++;
    setPendingMaskWrites(maskWriteCount.current);
    setBusy("正在写入标注…");
    const write = maskWrites.current.catch(() => {}).then(async () => {
      const current = datasetRef.current;
      if (!current || current.reference.path !== owner) throw new Error("数据集已切换，未写入其他工程");
      const next = await saveDatasetMasks(current, hash, pendingMasks, writer);
      updateUndoHistory(history => [...history.slice(-99), current]);
      apply(next, false); setError("");
      if (unsavedMasks.current.get(hash) === pendingMasks) unsavedMasks.current.delete(hash);
    });
    maskWrites.current = write;
    return write.catch(error => { setMaskWriteFailed(true); throw error; }).finally(() => {
      maskWriteCount.current--;
      setPendingMaskWrites(maskWriteCount.current);
      if (!maskWriteCount.current) {
        setMaskWriteFailed(unsavedMasks.current.size > 0);
        setBusy(current => current === "正在写入标注…" ? "" : current);
      }
    });
  }

  function undoEdit() {
    if (busyRef.current || !datasetRef.current) return;
    run("正在撤销标注…", async () => {
      await maskWrites.current.catch(() => {});
      const current = datasetRef.current, previous = undoRef.current.at(-1);
      if (!current || !previous || previous.reference.path !== current.reference.path) return;
      const restored = await saveDatasetLabels(current, previous.data.annotations.samples, previous.parts, writer);
      updateRedoHistory([...redoRef.current.slice(-99), current]);
      updateUndoHistory(history => history.slice(0, -1), false); return restored;
    }, false);
  }

  function redoEdit() {
    if (busyRef.current || !datasetRef.current) return;
    run("正在重做标注…", async () => {
      await maskWrites.current.catch(() => {});
      const current = datasetRef.current, next = redoRef.current.at(-1);
      if (!current || !next || next.reference.path !== current.reference.path) return;
      const restored = await saveDatasetLabels(current, next.data.annotations.samples, next.parts, writer);
      updateUndoHistory(history => [...history.slice(-99), current], false);
      updateRedoHistory(redoRef.current.slice(0, -1)); return restored;
    }, false);
  }

  async function confirmSaved() {
    if (!canSave) return;
    setConfirmingSave(true);
    try {
      await maskWrites.current.catch(() => {});
      const retries = [...unsavedMasks.current].map(([hash, masks]) => saveMasks(hash, masks));
      const results = await Promise.allSettled(retries);
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      showAppNotice("标注已保存", "success");
    } catch (error) {
      showAppNotice("标注尚未写入，请先重试：" + String(error), "error");
    } finally { setConfirmingSave(false); }
  }

  function navigateImage(index: number, focus?: "list" | "canvas") {
    const next = Math.max(0, Math.min(images.length - 1, index));
    const image = images[next];
    if (blocked || !image) return;
    keyboardFocus.current = focus;
    setPage(Math.floor(next / pageSize));
    setSelectedIds(new Set([image.id]));
    setFocusedId(image.id);
  }

  function jumpToPage(value: string) {
    if (blocked || !images.length) return;
    const parsed = Number.parseInt(value.trim(), 10);
    if (!Number.isFinite(parsed)) { setPageJump(String(currentPage + 1)); return; }
    const target = Math.max(1, Math.min(pages, parsed));
    setPageJump(String(target));
    if (target !== currentPage + 1) navigateImage((target - 1) * pageSize, "list");
  }

  function annotateParts(reference: DatasetReference) {
    run("正在打开待标部位图片…", async () => {
      await maskWrites.current;
      const next = await openTrainingDataset(reference.path, reference.workId);
      if (reference.path !== datasetRef.current?.reference.path) updateUndoHistory([]);
      setPurpose("mosaic"); setFilter("all"); setSearch(""); setConditions({ ...emptyDatasetFilters, masks: "unmarked-parts" });
      resetSelection(); setPreview(undefined); setView("datasets");
      requestAnimationFrame(() => setAdvancedOpen(true));
      return next;
    }, false);
  }


  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (view !== "datasets" || maskWriteFailed || (busy && busy !== "正在写入标注…") || preview || deleting || deletingDataset || renaming || event.isComposing ||
          event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey || !["z", "y"].includes(event.key.toLowerCase()) ||
          (event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable]"))) return;
      const redo = event.shiftKey || event.key.toLowerCase() === "y";
      if (!(redo ? redoHistory.length : undoHistory.length || maskWriteCount.current)) return;
      event.preventDefault(); event.stopPropagation(); (redo ? redoEdit : undoEdit)();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [view, busy, maskWriteFailed, preview, deleting, deletingDataset, renaming, undoHistory, redoHistory, dataset]);

  useEffect(() => {
    if (view !== "datasets") return;
    const key = (event: KeyboardEvent) => {
      const active = document.activeElement, inList = !!list.current?.contains(active);
      if (blocked || !images.length || preview || renaming || deleting || deletingDataset || event.defaultPrevented || event.isComposing ||
        event.ctrlKey || event.metaKey || event.altKey || document.querySelector(":popover-open") ||
        (active instanceof Element && active.closest("input,textarea,select,[contenteditable]")) ||
        !(panel.current?.contains(active) || panel.current?.matches(":hover"))) return;
      const index = focused ? images.indexOf(focused) : currentPage * pageSize;
      let next: number;
      switch (event.key) {
        case "ArrowLeft": next = focused ? index - 1 : index; break;
        case "ArrowRight": next = focused ? index + 1 : index; break;
        case "ArrowUp": case "ArrowDown": {
          if (!focused) { next = index; break; }
          if (!inList) { next = index + (event.key === "ArrowUp" ? -1 : 1); break; }
          const columns = layout === "list" ? 1 : getComputedStyle(list.current!).gridTemplateColumns.split(" ").length;
          const local = index - currentPage * pageSize;
          const column = local % columns;
          let destination = local + (event.key === "ArrowUp" ? -columns : columns);
          if (destination < 0) destination = column + Math.floor((visible.length - 1 - column) / columns) * columns;
          else if (destination >= visible.length) destination = column;
          next = currentPage * pageSize + destination;
          break;
        }
        case "Home": if (!inList) return; next = 0; break;
        case "End": if (!inList) return; next = images.length - 1; break;
        case "PageUp": next = Math.max(0, currentPage - 1) * pageSize; break;
        case "PageDown": if (currentPage + 1 === pages) return; next = (currentPage + 1) * pageSize; break;
        case " ":
          if (!inList || !focused) return;
          event.preventDefault(); setSelectedIds(new Set([focused.id])); return;
        default: return;
      }
      event.preventDefault();
      navigateImage(next, inList ? "list" : "canvas");
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [view, blocked, focused, preview, renaming, deleting, deletingDataset, images, visible.length, layout, currentPage, pageSize, pages]);

  function openDatasetOpsMenu(event: ReactMouseEvent<HTMLElement>, reference?: DatasetReference) {
    if (blocked || !datasetMenu.current) return;
    setMenuReference(reference ?? dataset?.reference);
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointer = event.clientX !== 0 || event.clientY !== 0;
  const { x, y } = getFixedMenuPoint(pointer ? event.clientX : bounds.left, pointer ? event.clientY : bounds.bottom, 220, 320);
    datasetMenu.current.style.left = x + "px";
    datasetMenu.current.style.top = y + "px";
    datasetMenu.current.showPopover();
    datasetMenu.current.querySelector("button")?.focus({ preventScroll: true });
  }

  function openImageMenu(event: ReactMouseEvent<HTMLElement>, image: AnnotatedImage) {
    event.preventDefault(); event.stopPropagation();
    if (blocked || !imageMenu.current) return;
    setMenuImage(image); setFocusedId(image.id);
    setSelectedIds(previous => previous.has(image.id) ? previous : new Set([image.id]));
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = getFixedMenuPoint(event.clientX || bounds.left, event.clientY || bounds.top, 190, 190);
    imageMenu.current.style.left = point.x + "px"; imageMenu.current.style.top = point.y + "px";
    imageMenu.current.showPopover();
    imageMenu.current.querySelector("button")?.focus({ preventScroll: true });
  }

  const headerChrome = headerTools ? createPortal(<div className="training-dataset-header-tools">
    <div className="game-benchmark-tabs" role="tablist" aria-label="训练与数据集">
      <button type="button" id={`${id}-datasets`} aria-controls={`${id}-dataset-panel`} role="tab" aria-selected={view === "datasets"} onClick={() => setView("datasets")}>数据集</button>
      <button type="button" id={`${id}-training`} aria-controls={`${id}-training-panel`} role="tab" aria-selected={view === "training"} disabled={blocked} onClick={() => setView("training")}>训练</button>
    </div>
    {view === "datasets" && <UnityIconButton className="training-dataset-save-icon unity-project-save"
      title={hasUnsavedChanges ? "保存标注" : "当前没有未保存的更改"} disabled={!canSave}
      onClick={() => void confirmSaved()}><UnityActionIcon kind="save" /></UnityIconButton>}
  </div>, headerTools) : null;

  return <section className="training-dataset-page">
    {headerChrome}
    {busy && <p className="training-dataset-busy" role="status">{busy}</p>}
    {error && !renaming && <p className="training-dataset-error" role="alert">{error}</p>}
    <div ref={datasetMenu} id={id + "-dataset-ops"} popover="auto" className="unity-gallery-menu training-dataset-ops-menu" role="menu"
      aria-label="数据集操作" style={{ inset: "auto", margin: 0 }}>
      <p className="training-dataset-ops-label" role="presentation">导入数据集</p>
      <button type="button" role="menuitem" disabled={!desktop || blocked} onClick={() => {
        datasetMenu.current?.hidePopover();
        importInput.current?.click();
      }}>从图片集导入</button>
      {menuReference && <>
        <hr className="training-dataset-ops-divider" />
        <p className="training-dataset-ops-label" role="presentation" title={menuReference.title}>修改数据集</p>
        <button type="button" role="menuitem" onClick={() => {
          datasetMenu.current?.hidePopover();
          void api.revealPath(menuReference.path).catch(error => showAppNotice(String(error), "error"));
        }}>打开所在文件夹</button>
        <button type="button" role="menuitem" disabled={!!busy} onClick={() => {
          datasetMenu.current?.hidePopover();
          setError(""); setRenameTitle(menuReference.title); setRenaming(menuReference);
        }}>重命名</button>
        <button type="button" role="menuitem" disabled={!!busy} onClick={() => {
          datasetMenu.current?.hidePopover(); setDeletingDataset(menuReference);
        }}>删除数据集</button>
      </>}
      {dataset && menuReference?.path === dataset.reference.path && <>
        <hr className="training-dataset-ops-divider" />
        <p className="training-dataset-ops-label" role="presentation">新建数据集</p>
        <button type="button" role="menuitem" disabled={!desktop || blocked}
          data-tooltip="共用图片，单独保存标注；要求位于同一磁盘分区。直接修改图片内容会影响共用副本。"
          onClick={() => { datasetMenu.current?.hidePopover(); duplicate(true); }}>以索引方式新建</button>
        <button type="button" role="menuitem" disabled={!desktop || blocked}
          data-tooltip="完整拷贝图片和标注，适合跨盘或需要独立修改图片的情况"
          onClick={() => { datasetMenu.current?.hidePopover(); duplicate(false); }}>以完全拷贝方式新建</button>
      </>}
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
        <div className="training-dataset-work-row">
          <div className="training-dataset-work-start">
          <button type="button" className="unity-btn training-dataset-list-toggle" aria-controls={id + "-image-list"}
            aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>列表</button>
          <div className="training-dataset-command-primary">
            <button type="button" className="unity-btn training-dataset-picker-trigger" popoverTarget={id + "-catalog"} disabled={blocked}
              onClick={event => { positionWindowPopover(event.currentTarget, datasetPicker.current); loadCatalogCounts(); }}
              onContextMenu={event => { if (dataset) openDatasetMenu(event, dataset.reference); }}>
              <span className="training-dataset-name" title={dataset?.reference.title}>{dataset ? dataset.reference.title : "选择数据集"}</span>
              {dataset && <DatasetCounts images={dataset.reference.count} masks={maskCounts[dataset.reference.path]} />}
              <span aria-hidden="true">▾</span>
            </button>
            <button type="button" className="unity-btn training-dataset-ops-trigger" disabled={blocked}
              data-tooltip="导入、副本、打开文件夹、重命名与删除等数据集操作"
              onClick={event => openDatasetOpsMenu(event)}>数据集操作 ▾</button>
          </div>
          <div ref={datasetPicker} id={id + "-catalog"} popover="auto" className="training-dataset-catalog" aria-label="选择数据集">
            {catalog.map(reference => <button key={reference.path} type="button" className="training-dataset-catalog-item"
              aria-current={reference.path === dataset?.reference.path} onClick={() => openReference(reference)}
              onContextMenu={event => openDatasetMenu(event, reference)}>
              <span className="training-dataset-name" title={reference.title}>{reference.title}</span>
              <DatasetCounts images={reference.count} masks={maskCounts[reference.path]} />
            </button>)}
            <button type="button" className="training-dataset-catalog-item" disabled={!desktop} onClick={openDirectory}>浏览本地目录…</button>
          </div>
          <input ref={element => { importInput.current = element; element?.setAttribute("webkitdirectory", ""); }} type="file" hidden multiple
            aria-label="选择图片集目录" onChange={event => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              if (files.length) run("正在导入图片集…", () => importTrainingDataset(files, files[0].webkitRelativePath.split("/")[0], writer, new AbortController().signal));
            }} />
          </div>
          <div className="training-dataset-work-end">
          <div className="training-dataset-filter-bar" data-disabled={blocked || undefined} role="group" aria-label="图片筛选">
          <div className="training-dataset-filter-cluster">
            <label className="training-dataset-filter-control">
              <span className="training-dataset-filter-prefix" aria-hidden="true">用途</span>
              <select aria-label="用途" disabled={blocked} value={purpose} onChange={event => {
                setPurpose(event.target.value as DatasetPurpose); setFilter("all"); resetSelection();
              }}>{datasetPurposes.map(item => <option key={item} value={item}>{datasetPurposeLabels[item]}</option>)}</select>
            </label>
            <label className="training-dataset-filter-control">
              <span className="training-dataset-filter-prefix" aria-hidden="true">标注</span>
              <select aria-label="标注状态" disabled={blocked} value={filter} onChange={event => {
                setFilter(event.target.value as Filter); resetSelection();
              }}>
                <option value="all">全部</option>
                {verdicts.map(item => <option key={item} value={item}>{datasetVerdictLabels[purpose][item]}</option>)}
              </select>
            </label>
          </div>
          <label className="training-dataset-search-field">
            <span className="training-dataset-search-icon" aria-hidden="true">⌕</span>
            <input type="search" aria-label="搜索文件名" placeholder="搜索文件名" disabled={blocked} value={search}
              onChange={event => { setSearch(event.target.value); resetSelection(); }} />
          </label>
          <div className="training-dataset-filter-actions">
            <button type="button" className="unity-btn training-dataset-advanced-trigger" disabled={blocked}
              aria-expanded={advancedOpen} aria-controls={id + "-advanced-filters"}
              onClick={() => setAdvancedOpen(open => !open)}>
              高级筛选{conditionCount > 0 ? ` · ${conditionCount}` : ""}
              <span className="training-dataset-chevron" aria-hidden="true">{advancedOpen ? "▴" : "▾"}</span>
            </button>
            {conditionCount > 0 && <button type="button" className="unity-btn training-dataset-filter-clear" disabled={blocked}
              onClick={() => {
                setConditions({ ...emptyDatasetFilters }); setFilter("all"); setSearch(""); resetSelection();
              }}>重置高级</button>}
          </div>
        </div>
          </div>
        </div>
        <div id={id + "-advanced-filters"} className="training-dataset-advanced-panel" hidden={!advancedOpen}
          role="region" aria-label="高级筛选">
          <div className="training-dataset-filters">
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
          </div>
        </div>
      </div>
      <div ref={listSplit.workspaceRef} className="training-dataset-workspace" data-list-open={listOpen}
        style={{ ["--training-dataset-list-width" as string]: `${listSplit.width}px` }}>
        <aside className="training-dataset-image-list" style={{ maxInlineSize: listSplit.maxWidth }} id={id + "-image-list"} aria-label="图片列表">
          <header className="training-dataset-list-head">
            <div className="training-dataset-list-head-row training-dataset-list-head-row-pagination">
            <nav className="training-dataset-pagination training-dataset-list-nav" aria-label="数据集分页">
              <select className="unity-btn" aria-label="每页图片数量" disabled={blocked} value={pageSize} onChange={event => {
                setPageSize(Number(event.target.value)); setPage(0); setFocusedId("");
              }}>{pageSizes.map(size => <option value={size} key={size}>每页 {size}</option>)}</select>
              <button type="button" className="unity-btn" disabled={blocked || currentPage === 0} aria-label="上一页"
                onClick={() => navigateImage((currentPage - 1) * pageSize, "list")}>‹</button>
              <label className="training-dataset-page-jump">
                第<input type="text" inputMode="numeric" className="unity-btn training-dataset-page-input" aria-label="页码"
                  disabled={blocked || !images.length} value={pageJump}
                  onChange={event => setPageJump(event.target.value.replace(/\D/g, ""))}
                  onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); jumpToPage(pageJump); } }}
                  onBlur={() => jumpToPage(pageJump)} />/ {pages || 1} 页
              </label>
              <button type="button" className="unity-btn" disabled={blocked || currentPage + 1 >= pages} aria-label="下一页"
                onClick={() => navigateImage((currentPage + 1) * pageSize, "list")}>›</button>
            </nav>
            </div>
            <div className="training-dataset-list-head-row training-dataset-list-head-row-actions">
            <div className="training-dataset-pagination training-dataset-list-batch" aria-label="批量选择">
              <button type="button" className="unity-btn" disabled={blocked || !visible.length} onClick={() => {
                setSelectedIds(new Set(visible.map(image => image.id)));
                if (visible[0] && !visible.some(image => image.id === focusedId)) setFocusedId(visible[0].id);
              }}>选中本页</button>
              <span className="training-dataset-result-count" aria-live="polite">已选 {targets.size} 张</span>
              <button type="button" className="unity-btn" disabled={blocked || !dataset} popoverTarget={id + "-batch"}
                onClick={event => positionWindowPopover(event.currentTarget, batchMenu.current)}>批量打标</button>
              <div ref={batchMenu} id={id + "-batch"} popover="auto" className="training-dataset-batch" aria-label="批量打标">
                {verdicts.map(verdict => <button key={verdict} type="button" className="training-dataset-catalog-item" disabled={blocked || !editable || !targets.size}
                  onClick={() => { batchMenu.current?.hidePopover(); label(verdict); }}>
                  {verdict === "unmarked" ? "清除标注" : `标记${datasetVerdictLabels[purpose][verdict]}`}
                </button>)}
                {purpose === "mosaic" && (["male_external", "female_external"] as const).map(part =>
                  <button key={part} type="button" className="training-dataset-catalog-item" disabled={blocked || !editable || !targets.size}
                    data-tooltip={"将所选图片的全部去码蒙版标记为" + datasetParts[part] + "，跳过无蒙版的图片"}
                    onClick={() => { batchMenu.current?.hidePopover(); labelParts(part); }}>标记为{datasetParts[part]}</button>)}
                {dataset && !editable && <p className="hint">创建标注副本后可打标。</p>}
              </div>
            </div>
            <div className="training-dataset-switch" role="group" aria-label="图片列表展示方式">
              <button type="button" className="unity-btn" aria-pressed={layout === "list"} onClick={() => setLayout("list")}>列表</button>
              <button type="button" className="unity-btn" aria-pressed={layout === "thumbnails"} onClick={() => setLayout("thumbnails")}>缩略图</button>
            </div>
            </div>
          </header>
          <ul ref={list} aria-label="数据集图片" aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home End PageUp PageDown Space"
            className="training-dataset-images" data-layout={layout} role="listbox" aria-multiselectable="true">
            {dataset && visible.map((image, index) => {
              const verdict = datasetVerdict(image.annotation, purpose);
              const boxes = image.annotation.mosaic?.boxes?.length ?? 0;
              const status = purpose === "mosaic" && boxes ? `${boxes} 蒙版` : datasetVerdictLabels[purpose][verdict];
              const active = focused?.id === image.id;
              const selected = selectedIds.has(image.id);
              return <li key={image.id} className="training-dataset-tile" data-active={active} role="option" aria-selected={selected} data-selected={selected}
                onContextMenu={event => openImageMenu(event, image)}>
                <button type="button" className="training-dataset-sample" data-image-id={image.id} tabIndex={active || (!focused && index === 0) ? 0 : -1}
                  aria-current={active ? "true" : undefined} disabled={blocked}
                  data-tooltip="单击选中并预览；Ctrl+单击多选"
                  onClick={event => pickListImage(image, event)} onDoubleClick={() => openListImage(image)}>
                  <span className="training-dataset-thumbnail"><SamplePicture image={image} read={dataset.data.read} /></span>
                  <span className="training-dataset-tile-meta">
                    <strong title={image.name}>{image.name}</strong>
                    <small>{image.width} × {image.height} · {status}</small>
                  </span>
                  <span className="training-dataset-status-dot" data-marked={verdict !== "unmarked"} aria-hidden="true" />
                </button>
              </li>;
            })}
          </ul>
        </aside>
        <button {...listSplit.dividerProps} aria-controls={id + "-image-list"} />
        <div className="training-dataset-detail">
          {focused && dataset ? <TrainingDatasetImage key={dataset.reference.path + ":" + focused.id}
            image={focused} galleryIndex={focusedGalleryIndex} galleryTotal={images.length} read={dataset.data.read} editable={editable && purpose === "mosaic"} busy={blocked}
            readOnlyHint={purpose !== "mosaic" ? "切换到去码用途可编辑部位蒙版" : undefined}
            masks={(focused.annotation.mosaic?.boxes ?? []).map(box => ({ box, part: partFor(dataset, focused.sourceHash, box) ?? "" }))}
            onChange={masks => saveMasks(focused.sourceHash, masks)} onUndo={undoEdit} canUndo={!blocked && !!undoHistory.length}
            onRedo={redoEdit} canRedo={!blocked && !!redoHistory.length}
            onPreview={() => setPreview(focused)} onContextMenu={event => openImageMenu(event, focused)} />
            : <p className="training-dataset-gallery-empty hint">{dataset ? images.length ? "从左侧选择图片预览。" : "没有符合筛选条件的图片。" : "打开已有数据集，或从图片集导入。"}</p>}
        </div>
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
          setDeleting(undefined); setSelectedIds(values => new Set([...values].filter(id => id !== image.id)));
          return next;
        }, false);
      }}>删除</button>
    </GameDialog>}
  </section>;
}
