import type { UnityImage, UnityImageRegion } from "./unityOffline";

function sameImageData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  const leftFields = left as Record<string, unknown>, rightFields = right as Record<string, unknown>;
  const keys = Object.keys(leftFields).filter(key => leftFields[key] !== undefined);
  return keys.length === Object.keys(rightFields).filter(key => rightFields[key] !== undefined).length &&
    keys.every(key => sameImageData(leftFields[key], rightFields[key]));
}

export function reconcileImageEdit(value: UnityImage, previous: UnityImage, saved: UnityImage, threshold: number, fromEditor = true) {
  if (!fromEditor) return sameImageData(value, saved) ? saved : sameImageData(value, previous) ? previous : value;
  const checked = (region: UnityImageRegion) => region.selected && (region.confidence >= threshold || !!region.manualSelected);
  const regions = value.regions === saved.regions ? value.regions : value.regions.map((region, index) => {
    const original = saved.regions[index];
    return original && checked(region) === checked(original) &&
      sameImageData({ ...region, manualSelected: original.manualSelected, error: original.error }, original) ? original : region;
  });
  const selectionManual = value.selected === saved.selected && sameImageData(value.screening, saved.screening)
    ? saved.selectionManual
    : value.selected !== previous.selected ? true : value.selectionManual;
  const next = { ...value, regions, selectionManual };
  const restored = { ...next, completed: saved.completed, error: saved.error };
  if (sameImageData({ ...restored, selected: saved.selected, selectionManual: saved.selectionManual }, saved)) {
    if (next.selected === saved.selected && selectionManual === saved.selectionManual) return saved;
    return sameImageData(restored, previous) ? previous : restored;
  }
  return sameImageData(next, previous) ? previous : next;
}
