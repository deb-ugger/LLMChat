export const API_BASE =
  import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:17800";

export type ChatMessage = {
  role: string;
  content: string;
};

export type ConversationSummary = {
  id: string;
  title: string;
  createTime?: string;
  messageCount?: number;
};

export type Conversation = ConversationSummary & {
  messages: ChatMessage[];
};

export type TranslateProvider =
  | "mymemory"
  | "google"
  | "bing"
  | "sogou"
  | "baidu"
  | "youdao"
  | "niutrans"
  | "llm"
  | "free";

export type Settings = {
  apiUrl: string;
  apiKey: string;
  model: string;
  messagePageSize: number;
  port?: number;
  translateProvider: TranslateProvider;
  translateSource: string;
  translateTarget: string;
  /** Max chars per translate request; 0 = use engine default */
  translateMaxLength: number;
  /** When over limit: auto split+join (only for length-limited engines) */
  translateAutoChunk: boolean;
  /** OCR language(s) for Tesseract, e.g. eng / chi_sim / eng+chi_sim */
  ocrLang: string;
  /** After OCR, auto call translate */
  ocrAutoTranslate: boolean;
  ocrTranslateProvider: TranslateProvider;
  ocrTranslateSource: string;
  ocrTranslateTarget: string;
  ocrTranslateMaxLength: number;
  ocrTranslateAutoChunk: boolean;
};

export type TranslateResponse = {
  ok: boolean;
  source: string;
  translation: string;
  provider: string;
  code?: string;
};

export type TranslateOptions = {
  source?: string;
  target?: string;
  provider?: TranslateProvider | string;
  maxLength?: number;
  autoChunk?: boolean;
  /** LLM overrides for connection test / per-request */
  apiUrl?: string;
  apiKey?: string;
  model?: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    const err = new Error(
      "翻译超时或网络异常，请检查网络状况后重试。",
    ) as Error & { code?: string };
    err.code = "NETWORK_TIMEOUT";
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    let msg = (data as { error?: string }).error ?? `HTTP ${res.status}`;
    const low = msg.toLowerCase();
    if (
      low.includes("used all available free translations") ||
      low.includes("mymemory warning")
    ) {
      msg =
        "MyMemory 今日免费额度已用尽，请更换翻译引擎（谷歌/Bing/大模型）";
    }
    const err = new Error(msg) as Error & { code?: string };
    err.code = (data as { code?: string }).code;
    throw err;
  }
  return data as T;
}

export const api = {
  health: () => request<{ ok: boolean }>("/api/health"),
  getSettings: () => request<Settings>("/api/settings"),
  saveSettings: (settings: Settings) =>
    request<{ ok: boolean }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  listConversations: () =>
    request<{ items: ConversationSummary[]; currentId: string }>(
      "/api/conversations",
    ),
  createConversation: () =>
    request<Conversation>("/api/conversations", { method: "POST" }),
  getConversation: (id: string) =>
    request<Conversation>(`/api/conversations/${id}`),
  deleteConversation: (id: string) =>
    request<{ ok: boolean; current: Conversation }>(
      `/api/conversations/${id}`,
      { method: "DELETE" },
    ),
  renameConversation: (id: string, title: string) =>
    request<Conversation>(`/api/conversations/${id}`, {
      method: "PUT",
      body: JSON.stringify({ title }),
    }),
  chat: (conversationId: string, content: string) =>
    request<{
      ok: boolean;
      reply: string;
      conversation: Conversation;
    }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ conversationId, content }),
    }),
  translate: (text: string, init?: RequestInit, opts?: TranslateOptions) =>
    request<TranslateResponse>("/api/translate", {
      method: "POST",
      body: JSON.stringify({ text, ...opts }),
      ...init,
    }),
};

export type DictionaryPhonetic = {
  text?: string;
  audio?: string;
};

export type DictionaryMeaning = {
  partOfSpeech: string;
  definitions: { definition: string; example?: string }[];
  synonyms?: string[];
};

export type DictionaryEntry = {
  word: string;
  phonetics: DictionaryPhonetic[];
  meanings: DictionaryMeaning[];
};

export async function lookupDictionary(
  word: string,
): Promise<DictionaryEntry | null> {
  const q = word.trim().toLowerCase();
  if (!q) return null;
  const res = await fetch(
    `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(q)}`,
  );
  if (!res.ok) return null;
  const data = (await res.json()) as DictionaryEntry[];
  return data[0] ?? null;
}
