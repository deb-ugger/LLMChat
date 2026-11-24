// 界面主题：只影响样式，不参与后端配置。
export type ThemeId = "paper" | "mist" | "forest" | "ink";

export type ThemeOption = {
  id: ThemeId;
  label: string;
  hint: string;
  /** 预览色块：底色、面板色、强调色、侧栏色 */
  swatch: [string, string, string];
  rail: string;
  dark?: boolean;
};

export const THEMES: ThemeOption[] = [
  { id: "paper", label: "校样台", hint: "暖纸底、墨色主调", swatch: ["#f2efe7", "#fbf9f4", "#1b1a16"], rail: "#17150f" },
  { id: "mist", label: "雾青", hint: "中性灰绿、沉静", swatch: ["#eceeed", "#f7f8f7", "#18564c"], rail: "#10201c" },
  { id: "forest", label: "松墨", hint: "原来的墨绿米白", swatch: ["#f7f8f4", "#ffffff", "#0b7365"], rail: "#142e28" },
  { id: "ink", label: "墨夜", hint: "深色界面", swatch: ["#121310", "#1a1b17", "#e9e5d9"], rail: "#0b0c09", dark: true },
];

const STORAGE_KEY = "llmchat-theme";
const CHANGE_EVENT = "llmchat-theme-change";

function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEMES.some(theme => theme.id === value);
}

export function getTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isThemeId(saved)) return saved;
  } catch {
    // 隐私模式等场景下 localStorage 可能不可用，退回默认主题。
  }
  return "paper";
}

export function applyTheme(id: ThemeId): void {
  const root = document.documentElement;
  root.dataset.theme = id;
  root.style.colorScheme = id === "ink" ? "dark" : "light";
}

function updateTheme(id: ThemeId): void {
  if (document.documentElement.dataset.theme === id) return;
  applyTheme(id);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: id }));
}

function syncTheme(event: StorageEvent): void {
  if (event.key === STORAGE_KEY && isThemeId(event.newValue)) updateTheme(event.newValue);
}

export function setTheme(id: ThemeId): void {
  updateTheme(id);
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // 存不下也不影响本次会话的显示。
  }
}

export function onThemeChange(listener: (id: ThemeId) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (isThemeId(detail)) listener(detail);
  };
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

export function initTheme(): void {
  applyTheme(getTheme());
  window.addEventListener("storage", syncTheme);
}
