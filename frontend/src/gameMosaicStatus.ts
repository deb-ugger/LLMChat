import type { MosaicBox } from "./gameMosaic";

export const mosaicStatusLabels = {
  failed: "处理失败",
  retrying: "重试队列",
  pending: "待筛选",
  review: "待复核",
  candidate: "疑似有码",
  refinedCandidate: "复筛确认有码",
  confirmed: "已采用去码图",
  included: "已纳入补丁",
  clear: "未发现",
} as const;

export type MosaicStatus = keyof typeof mosaicStatusLabels;
export type MosaicScreeningSnapshot = {
  boxes: MosaicBox[];
  scanned?: boolean;
  reason?: string;
  review?: string;
};

export type MosaicScreeningState = MosaicScreeningSnapshot & {
  refined?: string;
  refineError?: string;
  redrawError?: string;
  refineQuickExcluded?: boolean;
  refineMovement?: { to: MosaicStatus };
  manualBoxes?: boolean;
};

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
  if (!row.boxes.length) return row.scanned ? "clear" : "pending";
  const previous = row.refineMovement?.to;
  if (row.refined && !row.refineQuickExcluded &&
      (previous ? previous === "candidate" || previous === "refinedCandidate" : !row.manualBoxes)) {
    return "refinedCandidate";
  }
  return "candidate";
}
