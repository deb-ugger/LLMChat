import type { MosaicBox } from "./gameMosaic";

export type MosaicScreening = { localZoom: boolean; presenceThreshold: number; boxThreshold: number };
export const defaultMosaicScreening: Readonly<MosaicScreening> = {
  localZoom: false, presenceThreshold: 0.47, boxThreshold: 0.25,
};
export function normalizeMosaicScreening(value?: Partial<MosaicScreening>): MosaicScreening {
  const threshold = (value: number | undefined, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0.05 && value <= 0.95 ? value : fallback;
  return {
    localZoom: value?.localZoom ?? defaultMosaicScreening.localZoom,
    presenceThreshold: threshold(value?.presenceThreshold, defaultMosaicScreening.presenceThreshold),
    boxThreshold: threshold(value?.boxThreshold, defaultMosaicScreening.boxThreshold),
  };
}
export function mosaicBoxOverlap(a: MosaicBox, b: MosaicBox) {
  const area = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return area / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - area);
}
export type MosaicDetection = { box: MosaicBox; score: number };
export function mergeMosaicDetections(...groups: readonly MosaicDetection[][]) {
  const kept: MosaicDetection[] = [];
  for (const item of groups.flat().sort((a, b) => b.score - a.score))
    if (!kept.some(previous => mosaicBoxOverlap(previous.box, item.box) > 0.45)) kept.push(item);
  return kept;
}

/** Only uncertain views receive extra inference; never more than four overlapping crops. */
export function mosaicZoomRegions(bounds: MosaicBox, detections: readonly MosaicDetection[],
  presenceScore: number, settings: MosaicScreening): MosaicBox[] {
  if (!settings.localZoom) return [];
  const [left, top, right, bottom] = bounds, width = right - left, height = bottom - top;
  if (Math.max(width, height) < 320) return [];
  const positive = presenceScore >= settings.presenceThreshold;
  const confident = detections.filter(item => item.score >= settings.boxThreshold);
  const seeds = detections.filter(item => item.score < settings.boxThreshold || !positive);
  const regions: MosaicBox[] = [];
  for (const { box } of seeds) {
    const w = Math.min(width, Math.max(96, Math.ceil((box[2] - box[0]) * 2.5), Math.ceil(width * 0.2)));
    const h = Math.min(height, Math.max(96, Math.ceil((box[3] - box[1]) * 2.5), Math.ceil(height * 0.2)));
    const x = Math.max(left, Math.min(right - w, Math.floor((box[0] + box[2] - w) / 2)));
    const y = Math.max(top, Math.min(bottom - h, Math.floor((box[1] + box[3] - h) / 2)));
    const crop: MosaicBox = [x, y, x + w, y + h];
    if (w * h < width * height * 0.85 && !regions.some(previous => mosaicBoxOverlap(previous, crop) > 0.45))
      regions.push(crop);
    if (regions.length === 4) return regions;
  }
  // No localized cue: cover the foreground with four overlapping views only for a positive/borderline classifier.
  if (!confident.length && !regions.length && presenceScore >= Math.max(0.05, settings.presenceThreshold - 0.15)) {
    const w = Math.ceil(width * 0.6), h = Math.ceil(height * 0.6);
    for (const x of [left, right - w]) for (const y of [top, bottom - h]) regions.push([x, y, x + w, y + h]);
  }
  return regions;
}
