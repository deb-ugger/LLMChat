import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { mapMosaicBoxes, type MosaicBox } from "../../gameMosaic";
import { removeContainedMosaicBoxes } from "../../gameMosaicStatus";
import type { UnityImage } from "../../unityOffline";
import { resultFor } from "./mosaicBatchRunner";
import type { MaskEdit, MaskUndoItem, MosaicMaskOptions } from "./mosaicWorkbenchTypes";

type MaskTool = "add" | "select";
type Point = [number, number];
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

export function useMosaicMasks({ gamePath, active, activeResult, members, usable, rows, getRows, candidates,
  hasStorage, blocked, actionsDisabled, commit }: MosaicMaskOptions) {
  const [maskUndo, setMaskUndo] = useState<MaskUndoItem[][]>([]);
  const [tool, setTool] = useState<MaskTool | null>(null);
  const [draft, setDraft] = useState<MosaicBox>();
  const [selection, setSelection] = useState(emptySelection);
  const anchor = useRef<{ pointerId: number; point: Point } | null>(null);
  const clearUndo = useCallback(() => { setMaskUndo([]); }, []);
  useLayoutEffect(clearUndo, [clearUndo, gamePath, active?.id, active?.sourceHash]);

  const cancelDrag = useCallback(() => {
    anchor.current = null;
    setDraft(undefined);
  }, []);
  const resetDrawing = useCallback(() => {
    cancelDrag();
    setTool(null);
    setSelection(emptySelection);
  }, [cancelDrag]);
  useLayoutEffect(resetDrawing, [resetDrawing, gamePath, active?.id, active?.sourceHash]);

  const activeBoxes = activeResult?.boxes ?? [];
  const hasSelection = activeBoxes.some(box => selection.has(box));
  const maskCopyTargets = active ? members.filter(image => image.id !== active.id &&
    !resultFor(rows, image).boxes.length && Math.abs(image.width / image.height / (active.width / active.height) - 1) <= 0.04) : [];

  function editMasks(edits: readonly MaskEdit[]) {
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
    if (undo.some(({ id }) => id === active?.id)) setSelection(emptySelection);
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
    if (anchor.current?.pointerId === event.pointerId) cancelDrag();
  }

  return {
    tool, draft, activeBoxes, selection, hasSelection, clearUndo, resetDrawing,
    canUndo: maskUndo.length > 0, canCopy: maskCopyTargets.length > 0, toggleTool,
    deleteLast: () => { if (active && activeResult) editMask(active, activeResult.boxes.slice(0, -1)); },
    clear,
    copy: () => {
      if (!active || !activeResult) return;
      editMasks(maskCopyTargets.map(image => ({ image, boxes: mapMosaicBoxes(activeResult.boxes, active, image) })));
    },
    undo: undoMaskEdit,
    onPointerDown: (event: PointerEvent<SVGSVGElement>) => {
      if (!active || !tool || actionsDisabled || event.button !== 0 || !event.isPrimary) return;
      anchor.current = { pointerId: event.pointerId, point: position(event, active) };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<SVGSVGElement>) => {
      const start = anchor.current;
      if (active && start?.pointerId === event.pointerId) setDraft(bounds(start.point, position(event, active)));
    },
    onPointerUp: (event: PointerEvent<SVGSVGElement>) => {
      const start = anchor.current;
      if (start?.pointerId !== event.pointerId) return;
      cancelDrag();
      if (!active || !tool || actionsDisabled || blocked()) return;
      const area = bounds(start.point, position(event, active));
      const boxes = resultFor(getRows(), active).boxes;
      if (tool === "select") {
        setSelection(new Set(boxes.filter(box => overlaps(box, area))));
      } else {
        const [left, top, right, bottom] = area;
        const box: MosaicBox = [Math.round(left), Math.round(top), Math.round(right), Math.round(bottom)];
        if (box[2] - box[0] >= 4 && box[3] - box[1] >= 4) editMask(active, [...boxes, box]);
      }
    },
    onPointerCancel: cancelPointer,
  };
}
