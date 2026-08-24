import type { UnityIniSection } from "./api";

export function setIniValue(
  sections: UnityIniSection[],
  section: string,
  key: string,
  value: string,
): UnityIniSection[] {
  const next = sections.map((item) => ({
    ...item,
    keys: item.keys.map((row) => ({ ...row })),
  }));
  let target = next.find(
    (item) => item.name.toLowerCase() === section.toLowerCase(),
  );
  if (!target) {
    target = { name: section, keys: [] };
    next.push(target);
  }
  const row = target.keys.find(
    (item) => item.key.toLowerCase() === key.toLowerCase(),
  );
  if (row) row.value = value;
  else target.keys.push({ key, value });
  return next;
}

export function isBoolIniValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "false";
}
