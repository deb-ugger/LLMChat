import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { mapMosaicBoxes, type MosaicBox } from "../../gameMosaic";
import { removeContainedMosaicBoxes } from "../../gameMosaicStatus";
import type { UnityImage } from "../../unityOffline";
import { resultFor } from "./mosaicBatchRunner";
import type { MaskEdit, MaskUndoItem, MosaicMaskOptions } from "./mosaicWorkbenchTypes";

type MaskTool = "add" | "select";
type Point = [number, number];
type ResizeEdge = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";
type MaskGesture = { pointerId: number; point: Point } & (
  { kind: "resize"; box: MosaicBox; edge: ResizeEdge } |
  { kind: "add" } |
  { kind: "select" | "pick"; box?: MosaicBox; client: Point; additive: boolean }
);
const emptySelection: ReadonlySet<MosaicBox> = new Set();

function position(event: PointerEvent<SVGSVGElement>, image: UnityImage): Point {
  const box = event.currentTarget.getBoundingClientRect();
  return [Math.max(0, Math.min(image.width, (event.clientX - box.left) * image.width / box.width)),
    Math.max(0, Math.min(image.height, (event.clientY - box.top) * image.height / box.height))];
}

function bounds(a: Point, b: Point): MosaicBox {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

function overlaps(box: MosaicBox, area: MosaicBox) {
  return Math.min(box[2], area[2]) > Math.max(box[0], area[0]) &&
    Math.min(box[3], area[3]) > Math.max(box[1], area[1]);
}

function resizedBox(box: MosaicBox, edge: ResizeEdge, start: Point, end: Point, image: UnityImage): MosaicBox {
  const [left, top, right, bottom] = box;
  const dx = Math.round(end[0] - start[0]), dy = Math.round(end[1] - start[1]);
  const minWidth = Math.min(4, right - left), minHeight = Math.min(4, bottom - top);
  return [
    edge.includes("w") ? Math.max(0, Math.min(right - minWidth, left + dx)) : left,
    edge.includes("n") ? Math.max(0, Math.min(bottom - minHeight, top + dy)) : top,
    edge.includes("e") ? Math.min(image.width, Math.max(left + minWidth, right + dx)) : right,
    edge.includes("s") ? Math.min(image.height, Math.max(top + minHeight, bottom + dy)) : bottom,
  ];
}

export function useMosaicMasks({ gamePath, active, activeResult, members, usable, rows, getRows, candidates,
  hasStorage, blocked, actionsDisabled, commit }: MosaicMaskOptions) {
  const [maskUndo, setMaskUndo] = useState<MaskUndoItem[][]>([]);
  const [tool, setTool] = useState<MaskTool | null>(null);
  const [draft, setDraft] = useState<MosaicBox>();
  const [selection, setSelection] = useState(emptySelection);
  const gesture = useRef<MaskGesture | null>(null);
  const clearUndo = useCallback(() => { setMaskUndo([]); }, []);
  useLayoutEffect(clearUndo, [clearUndo, gamePath, active?.id, active?.sourceHash]);

  const cancelDrag = useCallback(() => {
    gesture.current = null;
    setDraft(undefined);
  }, []);
  const resetDrawing = useCallback(() => {
    cancelDrag();
    setTool(null);
    setSelection(emptySelection);
  }, [cancelDrag]);
  useLayoutEffect(resetDrawing, [resetDrawing, gamePath, active?.id, active?.sourceHash]);

  const activeBoxes = activeResult?.boxes ?? [];
  const selected = activeBoxes.filter(box => selection.has(box));
  const hasSelection = selected.length > 0;
  const resizeTarget = selected.length === 1 && tool !== "add" ? selected[0] : undefined;
  const resizing = gesture.current?.kind === "resize" && draft
    ? { original: gesture.current.box, box: draft } : undefined;
  const maskCopyTargets = active ? members.filter(image => image.id !== active.id &&
    !resultFor(rows, image).boxes.length && Math.abs(image.width / image.height / (active.width / active.height) - 1) <= 0.04) : [];

  function editMasks(edits: readonly MaskEdit[], keepSelected?: MosaicBox) {
    if (blocked() || !edits.length) return;
    const current = getRows();
    const next = { ...current };
    const undo: MaskUndoItem[] = [];
    for (const { image, boxes: draftBoxes } of edits) {
      const row = resultFor(current, image);
      const boxes = removeContainedMosaicBoxes(draftBoxes);
      if (boxes.length === row.boxes.length && boxes.every((box, index) => box.every((value, edge) => value === row.boxes[index][edge]))) continue;
      next[image.id] = { ...row, boxes, manualBoxes: true, review: undefined, redrawError: undefined,
        saved: hasStorage ? row.saved : false, reference: false, checked: boxes.length > 0 };
      const previousCandidate = candidates[image.id];
      undo.push({ id: image.id, source: image.sourceHash,
        mask: { boxes: row.boxes, manualBoxes: row.manualBoxes, review: row.review, redrawError: row.redrawError,
          saved: row.saved, reference: row.reference, checked: row.checked },
        candidate: previousCandidate?.revision === image.sourceHash ? previousCandidate : undefined });
    }
    if (!undo.length) return;
    if (!commit({ rows: next, candidates: undo.map(({ id }) => ({ id })) })) return;
    if (active && undo.some(({ id }) => id === active.id))
      setSelection(keepSelected && next[active.id].boxes.includes(keepSelected) ? new Set([keepSelected]) : emptySelection);
    setMaskUndo(previous => [...previous, undo]);
  }

  function editMask(image: UnityImage, boxes: MosaicBox[]) {
    editMasks([{ image, boxes }]);
  }

  function undoMaskEdit() {
    const edits = maskUndo.at(-1);
    if (blocked() || !edits) return;
    const current = getRows();
    const next = { ...current };
    const liveSources = new Map(usable.map(image => [image.id, image.sourceHash]));
    const matching = edits.filter(edit => liveSources.get(edit.id) === edit.source && current[edit.id]?.source === edit.source);
    for (const { id, mask } of matching) next[id] = { ...current[id], ...mask };
    if (!commit({ rows: matching.length ? next : undefined, candidates: matching })) return;
    cancelDrag();
    setSelection(emptySelection);
    setMaskUndo(previous => previous.slice(0, -1));
  }

  function toggleTool(next: MaskTool) {
    cancelDrag();
    setTool(current => current === next ? null : next);
    setSelection(emptySelection);
  }

  function clear() {
    if (!active) return;
    const boxes = resultFor(getRows(), active).boxes;
    editMask(active, hasSelection ? boxes.filter(box => !selection.has(box)) : []);
  }

  function cancelPointer(event: PointerEvent<SVGSVGElement>) {
    if (gesture.current?.pointerId === event.pointerId) cancelDrag();
  }

  function selectBox(box: MosaicBox | undefined, additive: boolean) {
    if (actionsDisabled || tool === "add" || blocked()) return;
    if (!additive) { setSelection(box ? new Set([box]) : emptySelection); return; }
    if (!box) return;
    setSelection(current => {
      const next = new Set(current);
      if (next.has(box)) next.delete(box); else next.add(box);
      return next;
    });
  }

  return {
    tool, draft: resizing ? undefined : draft, resizing, resizeTarget, activeBoxes, selection, hasSelection,
    selectBox, clearUndo, resetDrawing,
    canUndo: maskUndo.length > 0, canCopy: maskCopyTargets.length > 0, toggleTool,
    deleteLast: () => { if (active && activeResult) editMask(active, activeResult.boxes.slice(0, -1)); },
    clear,
    copy: () => {
      if (!active || !activeResult) return;
      editMasks(maskCopyTargets.map(image => ({ image, boxes: mapMosaicBoxes(activeResult.boxes, active, image) })));
    },
    undo: undoMaskEdit,
    onPointerDown: (event: PointerEvent<SVGSVGElement>) => {
      if (!active || actionsDisabled || event.button !== 0 || !event.isPrimary || gesture.current) return;
      const target = event.target as Element;
      const edge = target.getAttribute("data-mosaic-resize") as ResizeEdge | null;
      const index = target.getAttribute("data-mosaic-box");
      const box = index !== null ? activeBoxes[Number(index)] : undefined;
      const start = { pointerId: event.pointerId, point: position(event, active) };
      if (edge && resizeTarget) {
        gesture.current = { ...start, kind: "resize", edge, box: resizeTarget };
      } else if (tool === "add") {
        gesture.current = { ...start, kind: "add" };
      } else if (tool === "select" || box) {
        gesture.current = { ...start, kind: tool === "select" ? "select" : "pick", box,
          client: [event.clientX, event.clientY], additive: event.ctrlKey || event.metaKey };
      } else return;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<SVGSVGElement>) => {
      const start = gesture.current;
      if (!active || start?.pointerId !== event.pointerId || start.kind === "pick") return;
      const end = position(event, active);
      setDraft(start.kind === "resize" ? resizedBox(start.box, start.edge, start.point, end, active) : bounds(start.point, end));
    },
    onPointerUp: (event: PointerEvent<SVGSVGElement>) => {
      const start = gesture.current;
      if (start?.pointerId !== event.pointerId) return;
      cancelDrag();
      if (!active || actionsDisabled || blocked()) return;
      const end = position(event, active);
      const boxes = resultFor(getRows(), active).boxes;
      if (start.kind === "resize") {
        if (!boxes.includes(start.box)) return;
        const box = resizedBox(start.box, start.edge, start.point, end, active);
        editMasks([{ image: active, boxes: boxes.map(item => item === start.box ? box : item) }], box);
      } else if (start.kind === "add") {
        const [left, top, right, bottom] = bounds(start.point, end);
        const box: MosaicBox = [Math.round(left), Math.round(top), Math.round(right), Math.round(bottom)];
        if (box[2] - box[0] >= 4 && box[3] - box[1] >= 4) editMask(active, [...boxes, box]);
      } else if (Math.hypot(event.clientX - start.client[0], event.clientY - start.client[1]) < 4) {
        selectBox(start.box, start.additive);
      } else if (start.kind === "select") {
        const area = bounds(start.point, end);
        setSelection(new Set(boxes.filter(box => overlaps(box, area))));
      }
    },
    onPointerCancel: cancelPointer,
  };
}
