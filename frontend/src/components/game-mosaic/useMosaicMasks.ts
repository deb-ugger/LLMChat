import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { mapMosaicBoxes, type MosaicBox } from "../../gameMosaic";
import type { UnityImage } from "../../unityOffline";
import { resultFor } from "./mosaicBatchRunner";
import type { MaskEdit, MaskUndoItem, MosaicMaskOptions } from "./mosaicWorkbenchTypes";

function position(event: PointerEvent<SVGSVGElement>, image: UnityImage): [number, number] {
  const box = event.currentTarget.getBoundingClientRect();
  return [Math.max(0, Math.min(image.width, Math.round((event.clientX - box.left) * image.width / box.width))),
    Math.max(0, Math.min(image.height, Math.round((event.clientY - box.top) * image.height / box.height)))];
}

function bounds(a: [number, number], b: [number, number]): MosaicBox {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

export function useMosaicMasks({ gamePath, active, activeResult, members, usable, rows, getRows, candidates,
  hasStorage, blocked, actionsDisabled, commit }: MosaicMaskOptions) {
  const [maskUndo, setMaskUndo] = useState<MaskUndoItem[][]>([]);
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<MosaicBox>();
  const anchor = useRef<[number, number] | null>(null);
  const clearUndo = useCallback(() => { setMaskUndo([]); }, []);
  useLayoutEffect(clearUndo, [clearUndo, gamePath, active?.id, active?.sourceHash]);

  const resetDrawing = useCallback(() => {
    anchor.current = null;
    setDrawing(false); setDraft(undefined);
  }, []);
  const activeBoxes = [...(activeResult?.boxes || []), ...(draft ? [draft] : [])];
  const maskCopyTargets = active ? members.filter(image => image.id !== active.id &&
    !resultFor(rows, image).boxes.length && Math.abs(image.width / image.height / (active.width / active.height) - 1) <= 0.04) : [];

  function editMasks(edits: readonly MaskEdit[]) {
    if (blocked() || !edits.length) return;
    const current = getRows();
    const next = { ...current };
    const undo = edits.map(({ image, boxes }): MaskUndoItem => {
      const row = resultFor(current, image);
      next[image.id] = { ...row, boxes, manualBoxes: true, review: undefined, redrawError: undefined,
        saved: hasStorage ? row.saved : false, reference: false, checked: boxes.length > 0 };
      const previousCandidate = candidates[image.id];
      return { id: image.id, source: image.sourceHash,
        mask: { boxes: row.boxes, manualBoxes: row.manualBoxes, review: row.review, redrawError: row.redrawError,
          saved: row.saved, reference: row.reference, checked: row.checked },
        candidate: previousCandidate?.revision === image.sourceHash ? previousCandidate : undefined };
    });
    if (!commit({ rows: next, candidates: undo.map(({ id }) => ({ id })) })) return;
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
    anchor.current = null;
    setDraft(undefined);
    setMaskUndo(previous => previous.slice(0, -1));
  }

  return {
    drawing, activeBoxes, clearUndo, resetDrawing, canUndo: maskUndo.length > 0, canCopy: maskCopyTargets.length > 0,
    toggleDrawing: () => setDrawing(value => !value),
    deleteLast: () => { if (active && activeResult) editMask(active, activeResult.boxes.slice(0, -1)); },
    clear: () => { if (active) editMask(active, []); },
    copy: () => {
      if (!active || !activeResult) return;
      editMasks(maskCopyTargets.map(image => ({ image, boxes: mapMosaicBoxes(activeResult.boxes, active, image) })));
    },
    undo: undoMaskEdit,
    onPointerDown: (event: PointerEvent<SVGSVGElement>) => {
      if (!active || !drawing || actionsDisabled || event.button !== 0) return;
      anchor.current = position(event, active); event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<SVGSVGElement>) => {
      if (active && anchor.current) setDraft(bounds(anchor.current, position(event, active)));
    },
    onPointerUp: (event: PointerEvent<SVGSVGElement>) => {
      if (!active || !activeResult || !anchor.current) return;
      const box = bounds(anchor.current, position(event, active));
      anchor.current = null; setDraft(undefined);
      if (!actionsDisabled && box[2] - box[0] >= 4 && box[3] - box[1] >= 4) editMask(active, [...activeResult.boxes, box]);
    },
    onPointerCancel: () => { anchor.current = null; setDraft(undefined); },
  };
}
