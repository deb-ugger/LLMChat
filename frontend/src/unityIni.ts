import type { UnityIniSection } from "./api";

export function setIniValue(
  sections: UnityIniSection[],
  section: string,
  key: string,
  value: string,
): UnityIniSection[] {
  const sectionName = section.toLowerCase();
  const sectionIndex = sections.findIndex(item => item.name.toLowerCase() === sectionName);
  if (sectionIndex < 0) return [...sections, { name: section, keys: [{ key, value }] }];

  const target = sections[sectionIndex];
  const keyName = key.toLowerCase();
  const keyIndex = target.keys.findIndex(item => item.key.toLowerCase() === keyName);
  if (keyIndex >= 0 && target.keys[keyIndex].value === value) return sections;

  const keys = target.keys.slice();
  if (keyIndex < 0) keys.push({ key, value });
  else keys[keyIndex] = { ...keys[keyIndex], value };
  const result = sections.slice();
  result[sectionIndex] = { ...target, keys };
  return result;
}

export function isBoolIniValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "false";
}
