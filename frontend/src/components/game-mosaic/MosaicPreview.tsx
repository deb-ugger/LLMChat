import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { mosaicModelLabels, type MosaicBox } from "../../gameMosaic";
import { GameImagePreviewFrame } from "../GameImageBrowserLayout";
import { GameImageViewer, useImageBlobUrl, type GameImageView, type GameImageViews } from "../GameImageViewer";
import type { MosaicPreviewProps, ResultVersion } from "./mosaicWorkbenchTypes";

function MosaicOriginalCanvas({ width, editing, onBackground, children }: {
  width: number; editing: boolean; onBackground: () => void; children: ReactNode;
}) {
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [panReady, setPanReady] = useState(false);
  const [panning, setPanning] = useState(false);
  const spaceHeld = useRef(false);
  const surface = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const pan = useRef<{ pointer: number; clientX: number; clientY: number; x: number; y: number; clearOnClick: boolean } | null>(null);

  const containPan = useCallback((zoom: number, x: number, y: number) => {
    const image = stage.current;
    if (!image) return { zoom, x: 0, y: 0 };
    // Allow every image edge to reach the center of the editing area.
    const maxX = image.offsetWidth * zoom / 2;
    const maxY = image.offsetHeight * zoom / 2;
    return { zoom, x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
  }, []);

  useEffect(() => {
    const area = surface.current;
    if (!area) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.deltaY) return;
      event.preventDefault();
      setView(current => {
        const next = Math.max(1, Math.min(8, current.zoom * Math.exp(-event.deltaY * .002)));
        return next === current.zoom ? current : containPan(next, current.x * next / current.zoom, current.y * next / current.zoom);
      });
    };
    const observer = new ResizeObserver(() => {
      setView(current => current.x || current.y ? containPan(current.zoom, current.x, current.y) : current);
    });
    observer.observe(area);
    area.addEventListener("wheel", onWheel, { passive: false });
    return () => { observer.disconnect(); area.removeEventListener("wheel", onWheel); };
  }, [containPan]);

  useEffect(() => {
    const onSpaceDown = (event: KeyboardEvent) => {
      const area = surface.current;
      if (event.code !== "Space" || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || !area?.matches(":hover")) return;
      if (event.target instanceof Element && (event.target.closest("input, textarea, select, [contenteditable]") ||
          (event.target.closest("button, a, [role='button']") && !area.closest("figure")?.contains(event.target)))) return;
      event.preventDefault();
      event.stopPropagation();
      spaceHeld.current = true;
      setPanReady(true);
    };
    const endSpace = () => {
      spaceHeld.current = false;
      setPanReady(false);
    };
    const onSpaceUp = (event: KeyboardEvent) => {
      if (event.code !== "Space" || !spaceHeld.current) return;
      event.preventDefault();
      event.stopPropagation();
      endSpace();
    };
    window.addEventListener("keydown", onSpaceDown, true);
    window.addEventListener("keyup", onSpaceUp, true);
    window.addEventListener("blur", endSpace);
    return () => {
      window.removeEventListener("keydown", onSpaceDown, true);
      window.removeEventListener("keyup", onSpaceUp, true);
      window.removeEventListener("blur", endSpace);
    };
  }, []);

  const endPan = (pointer: number) => {
    if (pan.current?.pointer !== pointer) return;
    pan.current = null;
    setPanning(false);
  };

  return <div ref={surface} className={"game-mosaic-image-area" + (panning ? " is-panning" : panReady ? " is-pan-ready" : "")}
    style={{ "--mosaic-original-width": width + "px" } as CSSProperties}
    onPointerDownCapture={event => {
      if (!event.isPrimary || pan.current) return;
      const target = event.target as Element;
      const moveOnly = event.button === 1 || (event.button === 0 && spaceHeld.current);
      const background = !stage.current?.contains(target);
      if (!moveOnly && (event.button !== 0 || (!background && (editing || target.closest("svg"))))) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.closest("figure")?.focus({ preventScroll: true });
      pan.current = { pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY,
        x: view.x, y: view.y, clearOnClick: !moveOnly };
      event.currentTarget.setPointerCapture(event.pointerId);
      setPanning(true);
    }}
    onPointerMove={event => {
      const start = pan.current;
      if (start?.pointer !== event.pointerId) return;
      const scale = event.currentTarget.currentCSSZoom;
      setView(current => containPan(current.zoom, start.x + (event.clientX - start.clientX) / scale,
        start.y + (event.clientY - start.clientY) / scale));
    }}
    onPointerUp={event => {
      const start = pan.current;
      if (start?.pointer !== event.pointerId) return;
      endPan(event.pointerId);
      if (start.clearOnClick && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 4) onBackground();
    }}
    onPointerCancel={event => endPan(event.pointerId)}
    onLostPointerCapture={event => endPan(event.pointerId)}>
    <div ref={stage} className="unity-image-stage game-mosaic-stage"
      style={{ translate: view.x + "px " + view.y + "px", scale: view.zoom, "--mosaic-preview-zoom": view.zoom } as CSSProperties}>
      {children}
    </div>
  </div>;
}

function MaskResizeControls({ box }: { box: MosaicBox }) {
  const [left, top, right, bottom] = box;
  const sides = [
    ["n", left, top, right, top], ["s", left, bottom, right, bottom],
    ["w", left, top, left, bottom], ["e", right, top, right, bottom],
  ] as const;
  const corners = [
    ["nw", left, top], ["ne", right, top], ["sw", left, bottom], ["se", right, bottom],
  ] as const;
  return <g aria-hidden="true">
    {sides.map(([edge, x1, y1, x2, y2]) => <line key={edge} data-mosaic-resize={edge}
      className="game-mosaic-resize-edge" x1={x1} y1={y1} x2={x2} y2={y2} vectorEffect="non-scaling-stroke" />)}
    {corners.map(([edge, x, y]) => <line key={edge} data-mosaic-resize={edge}
      className="game-mosaic-resize-corner" x1={x} y1={y} x2={x + .01} y2={y} vectorEffect="non-scaling-stroke" />)}
  </g>;
}

function MosaicResultVersion({ version, selector, imageName, disabledReason, replacing, asReference, onApprove, onOpen }: {
  version: ResultVersion; selector?: ReactNode; imageName: string;
  disabledReason?: string; replacing: boolean; asReference: boolean; onApprove: (blob: Blob) => void; onOpen?: () => void;
}) {
  const url = useImageBlobUrl(version.blob);
  const modelName = mosaicModelLabels[version.model];
  const adoptLabel = asReference ? "采用为本组参考" : replacing ? "替换已采用图" : "采用此版";
  return <div className="game-mosaic-result-version">
    <GameImagePreviewFrame keyboardPane aria-label={modelName + " 去码结果"} onDoubleClick={url ? onOpen : undefined} caption={<>
      <span>{modelName}</span>
      <span className="game-mosaic-result-tools"><small>{version.seconds.toFixed(1)} 秒</small>{selector}</span>
    </>} fallback={<p className="hint">正在读取图片…</p>}>
      {url && <div className="unity-image-stage">
        <img src={url} alt={`${imageName} · ${modelName} 去码结果`} draggable={false} />
      </div>}
    </GameImagePreviewFrame>
    <button type="button" className="unity-btn" aria-label={adoptLabel + " · " + modelName}
      disabled={!!disabledReason} title={disabledReason} data-tooltip={disabledReason}
      onClick={() => onApprove(version.blob)}>{adoptLabel}</button>
  </div>;
}

export function MosaicPreview({ active, activeResult, visibleCount, paneVisible, activeSaved, candidate, source, approved,
  preferredResult, setPreferredResult, masks, actionsDisabled, busyReason, redrawReason, testTitle, model,
  getViewerNeighbors, onViewerImage, onRedraw, onOpenComfy, onApprove, referenceCandidate, header, resultActions, notice, footer }: MosaicPreviewProps) {
  const { tool, draft, transformed, resizeTarget, activeBoxes, selection, hasSelection } = masks;
  const editing = tool !== null;
  const canSelectMask = !actionsDisabled && tool !== "add";
  const deselectMask = () => masks.selectBox(undefined, false);
  const previews = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<{ showResult: boolean; version?: string } | null>(null);
  const [openingComfy, setOpeningComfy] = useState(false);

  const result = active && candidate?.revision === active.sourceHash ? candidate : undefined;
  const versions = result?.versions ?? [];
  const preferredVersion = versions.find(version => version.id === preferredResult) ?? versions.at(-1);
  const showSaved = activeSaved && (preferredResult === "saved" || !preferredVersion);
  const versionPicker = versions.length + Number(activeSaved) > 1 && <select aria-label="切换去码结果"
    value={showSaved ? "saved" : preferredVersion?.id} onChange={event => setPreferredResult(event.currentTarget.value)}>
    {activeSaved && <option value="saved">已采用去码图</option>}
    {versions.map((version, index) => <option key={version.id} value={version.id}>
      候选 {index + 1} · {mosaicModelLabels[version.model]}
    </option>)}
  </select>;
  const original = source && source.id === active?.id && source.revision === active.sourceHash ? source : undefined;
  const confirmed = approved && approved.id === active?.id && approved.revision === active.sourceHash ? approved : undefined;
  const originalUrl = useImageBlobUrl(original?.blob);
  const savedUrl = useImageBlobUrl(showSaved ? confirmed?.blob : undefined);
  const openPreview = (id: string) => {
    if (editing || !active) return;
    setViewer(id === "original" ? { showResult: false } : { showResult: true, version: id });
  };

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
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.repeat ||
        (event.target as Element).closest("input, textarea, select, [contenteditable]")) return;
    const modifier = event.ctrlKey || event.metaKey ? "command" : event.shiftKey ? "shift" : undefined;
    if (modifier === "command" && event.shiftKey) return;
    const action = imageTools.find(item => item.key === event.key.toLowerCase() && (item.modifier === modifier ||
      (item.id === "clear" && hasSelection && modifier === "shift")));
    if (!action || action.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    action.run();
  }

  const imageToolbar = imageTools.length > 0 && <div className="game-mosaic-image-tools" role="group" aria-label="原图蒙版工具"
    onDoubleClick={event => event.stopPropagation()}>
    {imageTools.map(tool => <button key={tool.id} type="button" className="game-mosaic-image-tool" data-tool={tool.id}
      aria-label={tool.label} aria-pressed={tool.pressed}
      aria-keyshortcuts={tool.modifier === "command" ? "Control+Z Meta+Z" : tool.id === "clear" && hasSelection ? "Delete Shift+Delete" : tool.shortcut}
      data-tooltip={[tool.label + " · " + tool.shortcut, tool.reason].filter(Boolean).join("\n")} disabled={tool.disabled} onClick={tool.run}>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={tool.icon} /></svg>
    </button>)}
  </div>;

  return <>
    {paneVisible && active && viewer && <GameImageViewer key={active.id} title={active.name}
      views={previewViews(active, viewer.version)} initialIndex={viewer.showResult ? 1 : 0} resultLabel="去码结果"
      onPrevious={previousImage ? showResult => moveViewer(previousImage, showResult) : undefined}
      onNext={nextImage ? showResult => moveViewer(nextImage, showResult) : undefined}
      onClose={closeViewer} />}
    {!active && <div className="unity-offline-empty">{visibleCount ? "从左侧列表选择图片预览" : "没有符合筛选条件的图片。"}</div>}
    {active && activeResult && <section className="unity-image-detail" aria-label="去码预览">
      {header}
      {notice}
      <div ref={previews} data-image-preview-dragging={draft || transformed ? "" : undefined}
        className="unity-image-previews"
        style={{ "--mosaic-image-aspect": active.width / active.height } as CSSProperties}>
        <div className="unity-image-actions game-mosaic-results-bar">
          <strong>去码结果</strong>
          {activeSaved && <button type="button" className="unity-btn" disabled={!!redrawReason} data-tooltip={redrawReason}
            onClick={() => onRedraw([model])}>重新绘制</button>}
          <button type="button" className="unity-btn is-secondary" disabled={!!redrawReason}
            data-tooltip={["使用左侧选定的 " + mosaicModelLabels[model] + " 为当前图生成一版候选", redrawReason || testTitle].filter(Boolean).join("\n")}
            onClick={() => onRedraw([model])}>根据当前工作流生成</button>
          <button type="button" className="unity-btn is-secondary" disabled={actionsDisabled || !original?.blob || openingComfy}
            data-tooltip="在 AI 风格重绘的 ComfyUI 编辑器中打开当前原图和工作流"
            onClick={() => {
              if (!original?.blob) return;
              setOpeningComfy(true);
              void onOpenComfy(original.blob).finally(() => setOpeningComfy(false));
            }}>{openingComfy ? "正在移入 ComfyUI…" : "移动到 ComfyUI"}</button>
          {resultActions}
        </div>
        <GameImagePreviewFrame keyboardPane caption={<>
          <span data-tooltip="拖动图片可平移。编辑蒙版时，按住空格拖动或用鼠标中键拖动。">原图</span>
          {!!activeBoxes.length && <div className="game-mosaic-mask-tabs" role="group" aria-label="蒙版列表">
            {activeBoxes.map((box, index) => <button key={index} type="button"
              aria-label={"蒙版 " + (index + 1)} aria-pressed={selection.has(box)} disabled={!canSelectMask}
              data-tooltip={"蒙版 " + (index + 1) + " · " + Math.round(box[0]) + ", " + Math.round(box[1])}
              onDoubleClick={event => event.stopPropagation()}
              onClick={event => masks.selectBox(box, event.ctrlKey || event.metaKey)}>
              蒙版 {index + 1}
            </button>)}
          </div>}
        </>} className="game-mosaic-original-frame" aria-label="原图编辑区"
          onClick={event => {
            if (!(event.target as Element).closest(".game-mosaic-image-area, button")) deselectMask();
          }}
          onKeyDown={onImageToolKey} onDoubleClick={!editing && originalUrl ? () => openPreview("original") : undefined}>
          <div className="game-mosaic-original-viewport">
            {originalUrl ? <MosaicOriginalCanvas key={active.id} width={active.width} editing={editing}
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
            </MosaicOriginalCanvas> : original?.error
              ? <p className="game-mosaic-error" role="alert">{original.error}</p>
              : <p className="hint">正在读取图片…</p>}
            {imageToolbar}
          </div>
        </GameImagePreviewFrame>
        {showSaved ? <GameImagePreviewFrame keyboardPane caption={<><span>已采用去码图</span><span className="game-mosaic-result-tools">{versionPicker}</span></>} aria-label="已采用去码图" onDoubleClick={!editing && savedUrl ? () => openPreview("saved") : undefined} fallback={confirmed?.error
          ? <p className="game-mosaic-error" role="alert">{confirmed.error}</p> : <p className="hint">正在读取图片…</p>}>
          {savedUrl && <div className="unity-image-stage">
            <img src={savedUrl} alt={`${active.name} 已采用去码图`} draggable={false} />
          </div>}
        </GameImagePreviewFrame> : preferredVersion ? (
          <MosaicResultVersion key={preferredVersion.id} version={preferredVersion} selector={versionPicker}
            imageName={active.name} replacing={activeSaved} asReference={preferredVersion.blob === referenceCandidate}
            disabledReason={busyReason} onApprove={onApprove}
            onOpen={editing ? undefined : () => openPreview(preferredVersion.id)} />
        ) : <GameImagePreviewFrame keyboardPane aria-label="去码结果" fallback={<p className="hint">尚未生成去码结果</p>} />}
      </div>
      {footer}
    </section>}
  </>;
}
