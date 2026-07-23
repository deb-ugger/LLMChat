import { toFriendlyError } from "./friendlyError";

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
  /** auto | direct | custom */
  proxyMode: "auto" | "direct" | "custom" | string;
  /** e.g. 127.0.0.1:7890 */
  httpProxy: string;
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
  /** Text-translate workbench */
  textTranslateSource: string;
  textTranslateTarget: string;
  textTranslateProvider: TranslateProvider;
  textTranslatePrompt: string;
  /** JSON string: [{src,dst,info?}] */
  textGlossary: string;
  /** JSON string: [{src,dst}] */
  textPreReplace: string;
  textPostReplace: string;
  /** Empty = <dataDir>/text-projects */
  textProjectsDir: string;
  /** Resolved absolute path from backend */
  textProjectsDirResolved?: string;
  dataDir?: string;
  /**
   * JSON: per-engine credentials
   * {"baidu":{"appId":"...","secret":"..."},"niutrans":{"apiKey":"..."}}
   */
  translateEngineKeys: string;
};

export type TranslateResponse = {
  ok: boolean;
  source: string;
  translation: string;
  provider: string;
  code?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
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
  /** Custom system prompt (LLM) */
  prompt?: string;
  /** Glossary JSON string or array (LLM) */
  glossary?: string | { src: string; dst: string; info?: string }[];
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
      toFriendlyError(e, "网络异常或连接超时，请检查网络后重试"),
    ) as Error & { code?: string };
    err.code = "NETWORK_TIMEOUT";
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const raw =
      (data as { error?: string }).error ?? `HTTP ${res.status}`;
    const err = new Error(toFriendlyError(raw)) as Error & {
      code?: string;
    };
    err.code = (data as { code?: string }).code;
    throw err;
  }
  return data as T;
}

export type TextProjectListItem = {
  folder: string;
  name: string;
  path: string;
  folderPath: string;
  updatedAt?: string;
};

export type TextProjectSaveResult = {
  ok: boolean;
  folder: string;
  folderPath: string;
  path: string;
  root: string;
};

export const api = {
  health: () => request<{ ok: boolean }>("/api/health"),
  getSettings: () => request<Settings>("/api/settings"),
  saveSettings: (settings: Settings) =>
    request<{
      ok: boolean;
      textProjectsDirResolved?: string;
      dataDir?: string;
    }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  listTextProjects: () =>
    request<{ ok: boolean; root: string; items: TextProjectListItem[] }>(
      "/api/text-projects",
    ),
  loadTextProject: (opts: { folder?: string; path?: string }) => {
    const q = opts.folder
      ? `folder=${encodeURIComponent(opts.folder)}`
      : `path=${encodeURIComponent(opts.path || "")}`;
    return request<{
      ok: boolean;
      project: unknown;
      folder: string;
      folderPath: string;
      path: string;
    }>(`/api/text-projects/load?${q}`);
  },
  saveTextProject: (body: {
    project: unknown;
    folder?: string;
    overwrite?: boolean;
    sourceFileName?: string;
    sourceContent?: string;
  }) =>
    request<TextProjectSaveResult>("/api/text-projects/save", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  writeTextProjectFile: (body: {
    folder: string;
    fileName: string;
    content: string;
  }) =>
    request<{ ok: boolean; path: string; folderPath: string }>(
      "/api/text-projects/write-file",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
  exportFileToPath: (body: { path: string; content: string }) =>
    request<{ ok: boolean; path: string }>("/api/export-file", {
      method: "POST",
      body: JSON.stringify(body),
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
