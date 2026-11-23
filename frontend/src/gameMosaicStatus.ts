import type { MosaicBox } from "./gameMosaic";

export const mosaicStatusLabels = {
  failed: "处理失败",
  pending: "待筛选",
  review: "待复核",
  candidate: "疑似有码",
  refinedCandidate: "复筛确认有码",
  confirmed: "已采用去码图",
  included: "已纳入补丁",
  clear: "未发现",
} as const;

export type MosaicStatus = keyof typeof mosaicStatusLabels;
export const mosaicManualStatuses = ["pending", "review", "candidate", "refinedCandidate", "clear"] as const;
export type MosaicManualStatus = typeof mosaicManualStatuses[number];

export function removeContainedMosaicBoxes(boxes: MosaicBox[]): MosaicBox[] {
  if (boxes.length < 2) return boxes;
  const unique = boxes.filter((box, index) => !boxes.some((other, otherIndex) =>
    otherIndex !== index &&
    other[0] <= box[0] && other[1] <= box[1] && other[2] >= box[2] && other[3] >= box[3] &&
    (otherIndex < index || other.some((value, edge) => value !== box[edge]))));
  return unique.length === boxes.length ? boxes : unique;
}

export type MosaicScreeningSnapshot = {
  boxes: MosaicBox[];
  scanned?: boolean;
  detector?: string;
  reason?: string;
  review?: string;
};

export type MosaicInitialScreeningSnapshot = MosaicScreeningSnapshot & { checked: boolean };

export type MosaicScreeningState = MosaicScreeningSnapshot & {
  beforeRefine?: MosaicInitialScreeningSnapshot;
  refined?: string;
  refineError?: string;
  redrawError?: string;
  refineQuickExcluded?: boolean;
  refineMovement?: { to: MosaicStatus };
  manualBoxes?: boolean;
};

export function mosaicInitialScreening(row: MosaicScreeningState): MosaicScreeningSnapshot {
  return row.beforeRefine ?? row;
}

export function mosaicProcessingError(row?: MosaicScreeningState) {
  if (!row) return undefined;
  if (row.refineError) return "复筛失败 · " + row.refineError.replace(/^Error:\s*/, "");
  if (row.reason) return "初筛失败 · " + row.reason.replace(/^Error:\s*/, "");
  if (row.redrawError) return "重绘失败 · " + row.redrawError.replace(/^Error:\s*/, "");
}

export function mosaicScreeningStatus(row?: MosaicScreeningState): MosaicStatus {
  if (!row) return "pending";
  if (row.reason || row.refineError || row.redrawError) return "failed";
  if (row.review) return "review";
  if (!row.boxes.length) return row.scanned || row.refined ? "clear" : "pending";
  const previous = row.refineMovement?.to;
  if (row.refined && !row.refineQuickExcluded &&
      (previous ? previous === "candidate" || previous === "refinedCandidate" : !row.manualBoxes)) {
    return "refinedCandidate";
  }
  return "candidate";
}
