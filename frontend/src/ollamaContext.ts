const storageKey = "llmchat-ollama-context-length";
export const maxOllamaContext = 1048576;

export function validOllamaContext(value: number) {
  return value === 0 || Number.isInteger(value) && value >= 1024 && value <= maxOllamaContext;
}

export function loadOllamaContext() {
  const value = Number(localStorage.getItem(storageKey) || 0);
  return validOllamaContext(value) ? value : 0;
}

export function saveOllamaContext(value: number) {
  if (!validOllamaContext(value)) throw new Error(`上下文长度请填 0 或 1024–${maxOllamaContext} 之间的整数`);
  localStorage.setItem(storageKey, String(value));
}

export function ollamaRequestContext(apiUrl?: string) {
  if (!apiUrl) return {};
  try {
    const url = new URL(apiUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/v1/chat/completions" || url.search || url.hash) return {};
    const configured = localStorage.getItem("llmchat-ollama-url");
    const defaultAddress = url.protocol === "http:" && url.port === "11434" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (!defaultAddress && (!configured || new URL(configured).href !== url.href)) return {};
    return { ollamaNative: true, ollamaContextLength: loadOllamaContext() };
  } catch { return {}; }
}
