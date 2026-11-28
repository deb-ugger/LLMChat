import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { mosaicModelLabels, type MosaicBox, type MosaicModel } from "../../gameMosaic";
import { getFixedMenuPoint } from "../../viewportLayout";
import { showAppNotice } from "../AppNotice";
import { ImageCanvas } from "../ImageCanvas";
import { ImageMaskToolbar, MaskResizeControls, runImageToolShortcut } from "../ImageMaskTools";
import { GameImagePreviewFrame } from "../GameImageBrowserLayout";
import { GameImageViewer, useImageBlobUrl, type GameImageView, type GameImageViews } from "../GameImageViewer";
import { UnityDescriptionSelect } from "../UnityDescriptionSelect";
import type { MosaicPreviewProps, ResultVersion } from "./mosaicWorkbenchTypes";

const redrawModels = Object.keys(mosaicModelLabels) as MosaicModel[];
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

async function clipboardPng(blob: Blob): Promise<Blob> {
  const header = new Uint8Array(await blob.slice(0, pngSignature.length).arrayBuffer());
  if (pngSignature.every((byte, index) => header[index] === byte)) {
    return blob.type === "image/png" ? blob : blob.slice(0, blob.size, "image/png");
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    bitmap.close();
  }
}

function MosaicResultImage({ src, alt }: { src: string; alt: string }) {
  return <div className="game-mosaic-preview-viewport">
    <ImageCanvas className="game-mosaic-image-area" stageClassName="unity-image-stage game-mosaic-stage">
      <img src={src} alt={alt} draggable={false} />
    </ImageCanvas>
  </div>;
}

function MosaicContourCrop({ source, version, box, index }: {
  source: Blob; version: ResultVersion; box: MosaicBox; index: number;
}) {
  const originalCanvas = useRef<HTMLCanvasElement>(null);
  const resultCanvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState("");
  const [cropAspect, setCropAspect] = useState(1);
  useEffect(() => {
    let disposed = false;
    setError("");
    void (async () => {
      const original = await createImageBitmap(source);
      try {
        const result = await createImageBitmap(version.blob);
        try {
          if (disposed) return;
          const left = Math.max(0, box[0] - 48);
          const top = Math.max(0, box[1] - 48);
          const width = Math.min(original.width, box[2] + 48) - left;
          const height = Math.min(original.height, box[3] + 48) - top;
          for (const [canvas, image] of [[originalCanvas.current, original], [resultCanvas.current, result]] as const) {
            if (!canvas) continue;
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d")!;
            context.drawImage(image, left, top, width, height, 0, 0, width, height);
            context.strokeStyle = "#e5484d";
            context.lineWidth = 1;
            context.strokeRect(box[0] - left, box[1] - top, box[2] - box[0], box[3] - box[1]);
          }
          setCropAspect(width / height);
        } finally { result.close(); }
      } finally { original.close(); }
    })().catch(error => { if (!disposed) setError("裁剪预览失败 · " + String(error)); });
    return () => { disposed = true; };
  }, [source, version, box]);
  return <div className="game-mosaic-contour-content" aria-label={`区域 ${index + 1} 第一段裁剪对比`}
    style={{ "--contour-crop-aspect": cropAspect } as CSSProperties}>
    <div className="game-mosaic-contour-pair">
      <GameImagePreviewFrame keyboardPane className="game-mosaic-contour-cell" caption="原图裁剪" aria-label="原图裁剪查看">
        <ImageCanvas className="game-mosaic-contour-viewport" stageClassName="game-mosaic-contour-stage">
          <canvas ref={originalCanvas} aria-label="原图裁剪" />
        </ImageCanvas>
      </GameImagePreviewFrame>
      <GameImagePreviewFrame keyboardPane className="game-mosaic-contour-cell" caption="第一段结果" aria-label="第一段结果查看">
        <ImageCanvas className="game-mosaic-contour-viewport" stageClassName="game-mosaic-contour-stage">
          <canvas ref={resultCanvas} aria-label="第一段结果" />
        </ImageCanvas>
      </GameImagePreviewFrame>
    </div>
    {error && <p className="game-mosaic-error" role="alert">{error}</p>}
  </div>;
}

function MosaicContourCompare({ source, version, maskIndex }: { source: Blob; version: ResultVersion; maskIndex: number }) {
  const [open, setOpen] = useState(true);
  const [index, setIndex] = useState(maskIndex >= 0 && maskIndex < version.boxes.length ? maskIndex : 0);
  const contentId = useId();
  useEffect(() => {
    if (maskIndex >= 0 && maskIndex < version.boxes.length) setIndex(maskIndex);
  }, [maskIndex, version.boxes.length]);
  const current = Math.min(index, version.boxes.length - 1);
  return <section className="game-mosaic-contour-compare" data-open={open} aria-label="第一段裁剪对比">
    <header className="game-mosaic-contour-toolbar">
      <button type="button" className="game-mosaic-contour-toggle" aria-expanded={open} aria-controls={contentId}
        aria-label={(open ? "收起" : "展开") + "第一段裁剪对比"} onClick={() => setOpen(!open)}>第一段裁剪对比</button>
      <span className="game-mosaic-contour-sep" aria-hidden="true">·</span>
      <div className="game-mosaic-contour-regions" role="group" aria-label={`当前区域 ${current + 1}，共 ${version.boxes.length} 个`}>
        {version.boxes.map((_, region) => <button key={region} type="button" aria-label={`区域 ${region + 1}`}
          aria-pressed={region === current} onClick={() => { setIndex(region); setOpen(true); }}>{region + 1}</button>)}
      </div>
      <span className="game-mosaic-contour-sep" aria-hidden="true">·</span>
      <span className="game-mosaic-contour-hint">对照红框内轮廓与遮挡</span>
    </header>
    {open && <div id={contentId} className="game-mosaic-contour-body">
      <MosaicContourCrop key={current} source={source} version={version} box={version.boxes[current]} index={current} />
    </div>}
  </section>;
}

function MosaicResultVersion({ version, imageName, disabledReason, replacing, asReference, onApprove, onOpen, onContextMenu }: {
  version: ResultVersion; imageName: string;
  disabledReason?: string; replacing: boolean; asReference: boolean; onApprove: (blob: Blob) => void; onOpen?: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const url = useImageBlobUrl(version.blob);
  const modelName = mosaicModelLabels[version.model];
  const adoptLabel = asReference ? "采用为本组参考" : replacing ? "替换已采用图" : "采用此版";
  return <div className="game-mosaic-result-version">
    <GameImagePreviewFrame keyboardPane className="game-mosaic-result-frame" caption="去码结果" aria-label={modelName + " 去码结果"} onDoubleClick={url ? onOpen : undefined}
      onContextMenu={url ? onContextMenu : undefined} fallback={<p className="hint">正在读取图片…</p>}>
      {url && <MosaicResultImage src={url} alt={`${imageName} · ${modelName} 去码结果`} />}
    </GameImagePreviewFrame>
    <button type="button" className="unity-btn unity-btn-primary game-mosaic-result-adopt" aria-label={adoptLabel + " · " + modelName}
      disabled={!!disabledReason} title={disabledReason} data-tooltip={disabledReason}
      onClick={() => onApprove(version.blob)}>{adoptLabel}</button>
  </div>;
}

export function MosaicPreview({ active, activeResult, visibleCount, paneVisible, activeSaved, candidate, source, approved,
  preferredResult, setPreferredResult, masks, actionsDisabled, busyReason, redrawReason, testTitle, model,
  getViewerNeighbors, onViewerImage, onRedraw, onOpenComfy, onApprove, referenceCandidate, header, detailActions, notice, footer }: MosaicPreviewProps) {
  const { tool, draft, transformed, resizeTarget, activeBoxes, selection, hasSelection } = masks;
  const editing = tool !== null;
  const canSelectMask = !actionsDisabled && tool !== "add";
  const deselectMask = () => masks.selectBox(undefined, false);
  const previews = useRef<HTMLDivElement>(null);
  const redrawMenuId = useId();
  const redrawMenu = useRef<HTMLDivElement>(null);
  const maskMenuId = useId();
  const copyMenu = useRef<HTMLDivElement>(null);
  const copySource = useRef<Blob | null>(null);
  const [viewer, setViewer] = useState<{ showResult: boolean; version?: string } | null>(null);
  const [openingComfy, setOpeningComfy] = useState(false);

  const result = active && candidate?.revision === active.sourceHash ? candidate : undefined;
  const versions = result?.versions ?? [];
  const preferredVersion = versions.find(version => version.id === preferredResult) ?? versions.at(-1);
  const showSaved = activeSaved && (preferredResult === "saved" || !preferredVersion);
  const versionPicker = preferredVersion && versions.length + Number(activeSaved) > 1 && <UnityDescriptionSelect
    label="切换去码结果" value={showSaved ? "saved" : preferredVersion.id} menuWidth={250}
    triggerContent={showSaved ? "已采用去码图 ▾" : `候选 ${versions.indexOf(preferredVersion) + 1} ▾`}
    choices={[
      ...(activeSaved ? [{ value: "saved", label: "已采用去码图" }] : []),
      ...versions.map((version, index) => ({ value: version.id, label: `候选 ${index + 1} · ${mosaicModelLabels[version.model]}` })),
    ]}
    onChange={setPreferredResult} />;
  const resultInfo = showSaved ? (versionPicker ? undefined : "已采用去码图")
    : preferredVersion && `${mosaicModelLabels[preferredVersion.model]} · ${preferredVersion.seconds.toFixed(1)} 秒`;
  const original = source && source.id === active?.id && source.revision === active.sourceHash ? source : undefined;
  const confirmed = approved && approved.id === active?.id && approved.revision === active.sourceHash ? approved : undefined;
  const originalUrl = useImageBlobUrl(original?.blob);
  const savedUrl = useImageBlobUrl(showSaved ? confirmed?.blob : undefined);
  const contourCompare = !showSaved && preferredVersion?.model === "illustrious-line-refine" && original?.blob && preferredVersion.boxes.length > 0
    ? <MosaicContourCompare key={active?.id + ":" + preferredVersion.id} source={original.blob} version={preferredVersion}
      maskIndex={activeBoxes.findIndex(box => selection.has(box))} /> : undefined;
  const openPreview = (id: string) => {
    if (editing || !active) return;
    setViewer(id === "original" ? { showResult: false } : { showResult: true, version: id });
  };

  function openCopyMenu(event: ReactMouseEvent<HTMLElement>, blob?: Blob) {
    const menu = copyMenu.current;
    if (!blob || !menu || (event.target instanceof Element && event.target.closest("button"))) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const atPointer = event.clientX !== 0 || event.clientY !== 0;
    const { x, y } = getFixedMenuPoint(atPointer ? event.clientX : bounds.left,
      atPointer ? event.clientY : bounds.top, 166, 55);
    menu.style.left = x + "px";
    menu.style.top = y + "px";
    copySource.current = blob;
    menu.showPopover();
    menu.querySelector("button")?.focus({ preventScroll: true });
  }

  async function copyPreviewImage() {
    const blob = copySource.current;
    copyMenu.current?.hidePopover();
    if (!blob) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": clipboardPng(blob) })]);
      showAppNotice("已复制图片");
    } catch (error) {
      showAppNotice("复制图片失败：" + (error instanceof Error ? error.message : String(error)), "error");
    }
  }

  function previewViews(image: NonNullable<typeof active>, version?: string): GameImageViews {
    const dimensions = { width: image.width, height: image.height };
    const makeView = (label: string, blob?: Blob, error?: string): GameImageView => ({
      ...dimensions, label, src: blob, error,
    });
    const originalView = makeView("原图", original?.blob, original?.error);
    const saved = activeSaved && (version === "saved" || !version && showSaved);
    const best = versions.find(item => item.id === version) ?? preferredVersion;
    if (saved) return [originalView, makeView("已采用去码图", confirmed?.blob, confirmed?.error)];
    return best ? [originalView, makeView("去码结果 · " + mosaicModelLabels[best.model], best.blob)] : [originalView];
  }

  const { previous: previousImage, next: nextImage } = viewer ? getViewerNeighbors() : {};
  function moveViewer(image: NonNullable<typeof active>, showResult: boolean) {
    setViewer({ showResult });
    onViewerImage(image);
  }

  function closeViewer() {
    setViewer(null);
    previews.current?.querySelector<HTMLElement>(".game-mosaic-original-frame")?.focus({ preventScroll: true });
  }

  useEffect(() => { if (!paneVisible) setViewer(null); }, [paneVisible]);

  const imageTools = active && activeResult ? [
    { id: "redraw", label: "重绘当前图", key: "r", shortcut: "R", disabled: !!redrawReason, reason: redrawReason,
      icon: "m7 4 13 8-13 8V4Z", run: () => onRedraw([model]) },
    { id: "draw", label: "添加蒙版", key: "b", shortcut: "B", disabled: actionsDisabled || !originalUrl, pressed: tool === "add",
      icon: "M9 4H4v5m11-5h5v5m0 6v5h-5m-6 0H4v-5m5-3h6m-3-3v6", run: () => masks.toggleTool("add") },
    { id: "select", label: "框选蒙版", key: "v", shortcut: "V", disabled: actionsDisabled || !originalUrl, pressed: tool === "select",
      icon: "M9 4H4v5m11-5h5v5m0 6v5h-5m-6 0H4v-5M12 4h.01M4 12h.01M20 12h.01M12 20h.01", run: () => masks.toggleTool("select") },
    { id: "remove", label: "删除最后一框", key: "d", shortcut: "D", disabled: actionsDisabled || !activeResult.boxes.length,
      icon: "M5 5h14v14H5zM9 12h6", run: masks.deleteLast },
    { id: "clear", label: hasSelection ? "清空选中蒙版" : "清空蒙版", key: "delete", modifier: hasSelection ? undefined : "shift",
      shortcut: hasSelection ? "Delete" : "Shift+Delete", disabled: actionsDisabled || !activeResult.boxes.length,
      icon: "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6", run: masks.clear },
    { id: "copy", label: "复制蒙版到组内空白图", key: "c", shortcut: "C", disabled: actionsDisabled || !activeResult.boxes.length || !masks.canCopy,
      icon: "M8 8h12v12H8zM16 4H4v12", run: masks.copy },
    { id: "undo", label: "撤销蒙版编辑", key: "z", modifier: "command", shortcut: "Ctrl+Z",
      disabled: actionsDisabled || !masks.canUndo, icon: "m8 5-4 4 4 4M4 9h10a5 5 0 0 1 0 10h-3", run: masks.undo },
  ] : [];

  function onImageToolKey(event: ReactKeyboardEvent<HTMLElement>) {
    runImageToolShortcut(event, imageTools, hasSelection);
  }

  const imageToolbar = imageTools.length > 0 && <ImageMaskToolbar tools={imageTools} hasSelection={hasSelection} />;

  return <>
    {paneVisible && active && viewer && <GameImageViewer key={active.id} title={active.name}
      views={previewViews(active, viewer.version)} initialIndex={viewer.showResult ? 1 : 0} resultLabel="去码结果"
      onPrevious={previousImage ? showResult => moveViewer(previousImage, showResult) : undefined}
      onNext={nextImage ? showResult => moveViewer(nextImage, showResult) : undefined}
      onClose={closeViewer} />}
    {!active && <div className="unity-offline-empty">{visibleCount ? "从左侧列表选择图片预览" : "没有符合筛选条件的图片。"}</div>}
    {active && activeResult && <section className="unity-image-detail" aria-label="去码预览">
      <div className="game-mosaic-detail-header">
        <div className="game-mosaic-detail-row">{header}</div>
        <div className="game-mosaic-detail-row">
          <div key={active.id} className="game-mosaic-redraw-split" data-output-handled role="group" aria-label="重绘当前图">
            <button type="button" className="unity-btn unity-btn-primary" disabled={!!redrawReason}
              data-tooltip={[model === "illustrious-line-refine" ? "生成轮廓候选，检查裁剪后采用" : "使用左侧选定的 " + mosaicModelLabels[model] + " 重绘并保存当前图片", redrawReason || testTitle].filter(Boolean).join("\n")}
              onClick={() => onRedraw([model])}>重绘</button>
            <button type="button" className="unity-btn unity-btn-primary" aria-label="选择重绘工作流"
              disabled={!!redrawReason} data-tooltip={redrawReason} popoverTarget={redrawMenuId}>▾</button>
            {!redrawReason && <div id={redrawMenuId} ref={redrawMenu} popover="auto" role="group" aria-label="重绘工作流"
              className="unity-description-menu game-mosaic-detail-menu">
              {redrawModels.map(workflow => <button key={workflow} type="button" className="unity-description-option" onClick={() => {
                redrawMenu.current?.hidePopover();
                onRedraw([workflow]);
              }}>{mosaicModelLabels[workflow]}</button>)}
            </div>}
          </div>
          <button type="button" className="unity-btn is-secondary" disabled={actionsDisabled || !original?.blob || openingComfy}
            data-tooltip="在 ComfyUI 打开当前图片、蒙版和画风参考，并更新该模型在「LLMChat - 去码」中的共享工作流"
            onClick={() => {
              if (!original?.blob) return;
              setOpeningComfy(true);
              void onOpenComfy(original.blob).finally(() => setOpeningComfy(false));
            }}>{openingComfy ? "正在同步到 ComfyUI…" : "同步到 ComfyUI"}</button>
          {detailActions}
        </div>
        <div className="game-mosaic-detail-row game-mosaic-detail-meta">
          <span data-tooltip="拖动图片可平移。编辑蒙版时，按住空格拖动或用鼠标中键拖动。">原图</span>
          {!!activeBoxes.length && <>
            <button type="button" className="unity-btn" disabled={!canSelectMask} popoverTarget={maskMenuId} onKeyDown={onImageToolKey}>
              蒙版 {Math.max(0, activeBoxes.findIndex(box => selection.has(box))) + 1} ▾
            </button>
            <div key={active.id} id={maskMenuId} popover="auto" role="group" aria-label="蒙版列表"
              className="unity-description-menu game-mosaic-detail-menu" onKeyDown={onImageToolKey}>
              {activeBoxes.map((box, index) => <button key={index} type="button"
                className="unity-description-option" aria-pressed={selection.has(box)} disabled={!canSelectMask}
                data-tooltip={"蒙版 " + (index + 1) + " · " + Math.round(box[0]) + ", " + Math.round(box[1])}
                onClick={event => {
                  const extend = event.ctrlKey || event.metaKey;
                  masks.selectBox(box, extend);
                  if (!extend) event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
                }}>
                <strong>蒙版 {index + 1}</strong>
              </button>)}
            </div>
          </>}
          {resultInfo && <span className="game-mosaic-result-info" data-tooltip={resultInfo}>{resultInfo}</span>}
          {versionPicker}
        </div>
      </div>
      {notice}
      <div ref={previews} data-image-preview-dragging={draft || transformed ? "" : undefined}
        className={"unity-image-previews" + (contourCompare ? " has-contour-compare" : "")}
        style={{ "--mosaic-image-aspect": active.width / active.height } as CSSProperties}>
        <GameImagePreviewFrame keyboardPane className="game-mosaic-original-frame" caption={contourCompare ? "原图" : undefined} aria-label="原图编辑区"
          onContextMenu={originalUrl ? event => openCopyMenu(event, original?.blob) : undefined}
          onClick={event => {
            if (!(event.target as Element).closest(".game-mosaic-image-area, button")) deselectMask();
          }}
          onKeyDown={onImageToolKey} onDoubleClick={!editing && originalUrl ? () => openPreview("original") : undefined}>
          <div className="game-mosaic-preview-viewport game-mosaic-original-viewport">
            {originalUrl ? <ImageCanvas key={active.id} editing={editing} className="game-mosaic-image-area" stageClassName="unity-image-stage game-mosaic-stage"
              style={{ "--mosaic-image-width": active.width + "px" } as CSSProperties}
              onBackground={deselectMask}>
              <img src={originalUrl} alt={`${active.name} 原图`} draggable={false} />
              <svg viewBox={`0 0 ${active.width} ${active.height}`} className={editing ? "is-editing" : undefined}
                aria-label="去码蒙版" onPointerDown={masks.onPointerDown} onPointerMove={masks.onPointerMove}
                onPointerUp={masks.onPointerUp} onPointerCancel={masks.onPointerCancel} onLostPointerCapture={masks.onPointerCancel}>
                {activeBoxes.map((box, index) => {
                  const [left, top, right, bottom] = transformed?.get(box) ?? box;
                  const selected = selection.has(box);
                  return <rect key={index} x={left} y={top} width={right - left} height={bottom - top}
                    className={`game-mosaic-mask${selected ? " is-selected" : ""}${canSelectMask ? " is-clickable" : ""}`}
                    data-mosaic-box={index} vectorEffect="non-scaling-stroke"
                    role={canSelectMask ? "button" : undefined} tabIndex={canSelectMask ? 0 : undefined}
                    aria-label={canSelectMask ? `蒙版 ${index + 1}` : undefined} aria-pressed={canSelectMask ? selected : undefined}
                    onKeyDown={event => {
                      if (!canSelectMask || (event.key !== "Enter" && event.key !== " ")) return;
                      event.preventDefault();
                      masks.selectBox(box, event.ctrlKey || event.metaKey);
                    }} />;
                })}
                {draft && <rect x={draft[0]} y={draft[1]} width={draft[2] - draft[0]} height={draft[3] - draft[1]}
                  className={tool === "select" ? "game-mosaic-mask-selection" : "game-mosaic-mask"} vectorEffect="non-scaling-stroke" />}
                {canSelectMask && resizeTarget && <MaskResizeControls box={transformed?.get(resizeTarget) ?? resizeTarget} />}
              </svg>
            </ImageCanvas> : original?.error
              ? <p className="game-mosaic-error" role="alert">{original.error}</p>
              : <p className="hint">正在读取图片…</p>}
            {imageToolbar}
          </div>
        </GameImagePreviewFrame>
        {showSaved ? <GameImagePreviewFrame keyboardPane className="game-mosaic-result-frame" aria-label="已采用去码图"
          onDoubleClick={!editing && savedUrl ? () => openPreview("saved") : undefined}
          onContextMenu={savedUrl ? event => openCopyMenu(event, confirmed?.blob) : undefined} fallback={confirmed?.error
          ? <p className="game-mosaic-error" role="alert">{confirmed.error}</p> : <p className="hint">正在读取图片…</p>}>
          {savedUrl && <MosaicResultImage key={active.id} src={savedUrl} alt={`${active.name} 已采用去码图`} />}
        </GameImagePreviewFrame> : preferredVersion ? (
          <MosaicResultVersion key={preferredVersion.id} version={preferredVersion}
            imageName={active.name} replacing={activeSaved} asReference={preferredVersion.blob === referenceCandidate}
            disabledReason={busyReason} onApprove={onApprove}
            onContextMenu={event => openCopyMenu(event, preferredVersion.blob)}
            onOpen={editing ? undefined : () => openPreview(preferredVersion.id)} />
        ) : <GameImagePreviewFrame keyboardPane aria-label="去码结果" fallback={<p className="hint">尚未生成去码结果</p>} />}
        {contourCompare}
      </div>
      <div key={active.id} ref={copyMenu} className="unity-gallery-menu" popover="auto" role="menu"
        aria-label="预览图片操作" style={{ inset: "auto", margin: 0 }}>
        <button type="button" role="menuitem" onClick={() => void copyPreviewImage()}>复制图片</button>
      </div>
      {footer}
    </section>}
  </>;
}
