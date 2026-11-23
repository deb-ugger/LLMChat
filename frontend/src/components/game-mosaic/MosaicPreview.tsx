import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { mosaicModelLabels, type MosaicBox, type MosaicModel } from "../../gameMosaic";
import { GameImagePreviewFrame } from "../GameImageBrowserLayout";
import { GameImageViewer, useImageBlobUrl, type GameImageView, type GameImageViews } from "../GameImageViewer";
import type { MosaicPreviewProps, ResultVersion } from "./mosaicWorkbenchTypes";

function MosaicOriginalCanvas({ width, editing, onBackground, children }: {
  width: number; editing: boolean; onBackground: () => void; children: ReactNode;
}) {
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const surface = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const pan = useRef<{ pointer: number; x: number; y: number } | null>(null);

  const containPan = useCallback((zoom: number, x: number, y: number) => {
    const area = surface.current;
    const image = stage.current;
    if (!area || !image) return { zoom, x: 0, y: 0 };
    const maxX = Math.max(0, (image.offsetWidth * zoom - area.clientWidth) / 2);
    const maxY = Math.max(0, (image.offsetHeight * zoom - area.clientHeight) / 2);
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
        return next === current.zoom ? current : containPan(next, current.x, current.y);
      });
    };
    const observer = new ResizeObserver(() => {
      setView(current => current.x || current.y ? containPan(current.zoom, current.x, current.y) : current);
    });
    observer.observe(area);
    area.addEventListener("wheel", onWheel, { passive: false });
    return () => { observer.disconnect(); area.removeEventListener("wheel", onWheel); };
  }, [containPan]);

  return <div ref={surface} className="game-mosaic-image-area" style={{ "--mosaic-original-width": width + "px" } as CSSProperties}>
    <div ref={stage} className={"unity-image-stage game-mosaic-stage" + (!editing && view.zoom > 1 ? " is-pannable" : "")}
      style={{ translate: view.x + "px " + view.y + "px", scale: view.zoom, "--mosaic-preview-zoom": view.zoom } as CSSProperties}
      onPointerDown={event => {
        if (editing || event.button !== 0 || !event.isPrimary || (event.target as Element).closest("svg")) return;
        onBackground();
        if (view.zoom <= 1) return;
        const scale = event.currentTarget.currentCSSZoom;
        pan.current = { pointer: event.pointerId, x: event.clientX / scale - view.x, y: event.clientY / scale - view.y };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const start = pan.current;
        if (start?.pointer !== event.pointerId) return;
        const scale = event.currentTarget.currentCSSZoom;
        setView(containPan(view.zoom, event.clientX / scale - start.x, event.clientY / scale - start.y));
      }}
      onLostPointerCapture={event => { if (pan.current?.pointer === event.pointerId) pan.current = null; }}>
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

function MosaicResultVersion({ version, letter, imageName, disabledReason, onApprove, onOpen }: {
  version: ResultVersion; letter?: string; imageName: string;
  disabledReason?: string; onApprove: (blob: Blob) => void; onOpen?: () => void;
}) {
  const url = useImageBlobUrl(version.blob);
  const modelName = mosaicModelLabels[version.id];
  return <div className="game-mosaic-result-version">
    <GameImagePreviewFrame keyboardPane aria-label={modelName + " 去码结果"} onDoubleClick={url ? onOpen : undefined} caption={<>
      <span>{letter && `${letter} · `}{modelName}</span>
      {version.seconds != null && <small>{version.seconds.toFixed(1)} 秒</small>}
    </>} fallback={<p className="hint">正在读取图片…</p>}>
      {url && <div className="unity-image-stage">
        <img src={url} alt={`${imageName} · ${modelName} 去码结果`} draggable={false} />
      </div>}
    </GameImagePreviewFrame>
    <button type="button" className="unity-btn" aria-label={`采用 ${modelName} 候选`}
      disabled={!!disabledReason} title={disabledReason} data-tooltip={disabledReason}
      onClick={() => onApprove(version.blob)}>采用此版</button>
  </div>;
}

export function MosaicPreview({ active, activeResult, visibleCount, paneVisible, activeSaved, candidate, source, approved,
  preferredResult, setPreferredResult, masks, actionsDisabled, busyReason, redrawReason, testTitle, model,
  getViewerNeighbors, onViewerImage, onRedraw, onApprove, header, notice, footer }: MosaicPreviewProps) {
  const { tool, draft, transformed, resizeTarget, activeBoxes, selection, hasSelection } = masks;
  const editing = tool !== null;
  const canSelectMask = !actionsDisabled && tool !== "add";
  const previews = useRef<HTMLDivElement>(null);
  const [previewAreaWidth, setPreviewAreaWidth] = useState(0);
  const [viewer, setViewer] = useState<{ showResult: boolean; version?: "saved" | MosaicModel } | null>(null);

  const result = active && candidate?.revision === active.sourceHash ? candidate : undefined;
  const versions: ResultVersion[] = (["turbo", "2511"] as const).flatMap(id => {
    const blob = result?.values[id];
    return blob ? [{ id, blob, seconds: result?.seconds[id] }] : [];
  });
  const preferredVersion = versions.find(version => version.id === preferredResult) ?? versions[0];
  const showSaved = activeSaved && (preferredResult === "saved" || !preferredVersion);
  const comparing = versions.length === 2 && !showSaved;
  // Leave room for three 560px images, their frames and the two gaps between them.
  const sideBySide = comparing && previewAreaWidth >= 3 * 560 + 62 * document.documentElement.currentCSSZoom;
  const original = source && source.id === active?.id && source.revision === active.sourceHash ? source : undefined;
  const confirmed = approved && approved.id === active?.id && approved.revision === active.sourceHash ? approved : undefined;
  const originalUrl = useImageBlobUrl(original?.blob);
  const savedUrl = useImageBlobUrl(showSaved ? confirmed?.blob : undefined);
  const openPreview = (id: "original" | "saved" | MosaicModel) => {
    if (editing || !active) return;
    setViewer(id === "original" ? { showResult: false } : { showResult: true, version: id });
  };

  function previewViews(image: NonNullable<typeof active>, version?: "saved" | MosaicModel): GameImageViews {
    const dimensions = { width: image.width, height: image.height };
    const makeView = (label: string, blob?: Blob, error?: string): GameImageView => ({
      ...dimensions, label, ...(blob ? { src: blob } : {
        render: () => <GameImagePreviewFrame caption={label} fallback={error
          ? <p className="game-mosaic-error" role="alert">{error}</p>
          : <p className="hint">正在读取图片…</p>} />,
      }),
    });
    const originalView = makeView("原图", original?.blob, original?.error);
    const saved = activeSaved && (version === "saved" || !version && showSaved);
    const best = versions.find(item => item.id === version) ?? preferredVersion;
    if (saved) return [originalView, makeView("已采用去码图", confirmed?.blob, confirmed?.error)];
    return best ? [originalView, makeView("去码结果 · " + mosaicModelLabels[best.id], best.blob)] : [originalView];
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

  useLayoutEffect(() => {
    const element = previews.current;
    if (!element) return;
    const updateWidth = () => setPreviewAreaWidth(element.getBoundingClientRect().width);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);
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
        className={`unity-image-previews${sideBySide ? " is-mosaic-comparison" : ""}`}
        style={{ "--mosaic-image-aspect": active.width / active.height } as CSSProperties}>
        <div className="unity-image-actions game-mosaic-results-bar">
          <strong>去码结果</strong>
          {activeSaved && preferredVersion && <button type="button" className="unity-btn" onClick={() => {
            setPreferredResult(showSaved ? preferredVersion.id : "saved");
          }}>{showSaved ? "查看候选" : "查看已采用去码图"}</button>}
          <button type="button" className="unity-btn is-secondary" disabled={!!redrawReason} title={testTitle} data-tooltip={redrawReason}
            onClick={() => onRedraw(["turbo", "2511"])}>两种模型各生成一版</button>
          {comparing && !sideBySide && <div className="game-mosaic-version-picker" role="group" aria-label="切换去码候选"
            onKeyDown={event => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const index = event.key === "ArrowLeft" ? 0 : 1;
              setPreferredResult(versions[index].id);
              event.currentTarget.querySelectorAll("button")[index].focus();
            }}>
            {versions.map((version, index) => <button key={version.id} type="button" className="unity-btn"
              aria-label={`${index === 0 ? "A" : "B"} · ${mosaicModelLabels[version.id]}`}
              aria-pressed={version.id === preferredVersion.id} onClick={() => setPreferredResult(version.id)}>
              {index === 0 ? "A" : "B"}
            </button>)}
          </div>}
        </div>
        <GameImagePreviewFrame keyboardPane caption={<>
          <span>原图</span>
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
          onKeyDown={onImageToolKey} onDoubleClick={!editing && originalUrl ? () => openPreview("original") : undefined}>
          <div className="game-mosaic-original-viewport">
            {originalUrl ? <MosaicOriginalCanvas key={active.id} width={active.width} editing={editing}
              onBackground={() => masks.selectBox(undefined, false)}>
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
        {showSaved ? <GameImagePreviewFrame keyboardPane caption="已采用去码图" aria-label="已采用去码图" onDoubleClick={!editing && savedUrl ? () => openPreview("saved") : undefined} fallback={confirmed?.error
          ? <p className="game-mosaic-error" role="alert">{confirmed.error}</p> : <p className="hint">正在读取图片…</p>}>
          {savedUrl && <div className="unity-image-stage">
            <img src={savedUrl} alt={`${active.name} 已采用去码图`} draggable={false} />
          </div>}
        </GameImagePreviewFrame> : preferredVersion ? (sideBySide ? versions : [preferredVersion]).map(version =>
          <MosaicResultVersion key={version.id} version={version}
            letter={comparing ? version.id === "turbo" ? "A" : "B" : undefined}
            imageName={active.name} disabledReason={busyReason} onApprove={onApprove}
            onOpen={editing ? undefined : () => openPreview(version.id)} />
        ) : <GameImagePreviewFrame keyboardPane aria-label="去码结果" fallback={<p className="hint">尚未生成去码结果</p>} />}
      </div>
      {footer}
    </section>}
  </>;
}
