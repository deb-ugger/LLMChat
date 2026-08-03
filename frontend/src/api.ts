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
  /** LLM model for literature when provider=llm; empty falls back to model */
  translateModel: string;
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
  /** LLM model for OCR when provider=llm; empty falls back to model */
  ocrTranslateModel: string;
  ocrTranslateMaxLength: number;
  ocrTranslateAutoChunk: boolean;
  /** Text-translate workbench */
  textTranslateSource: string;
  textTranslateTarget: string;
  textTranslateProvider: TranslateProvider;
  /** LLM model for text when provider=llm; empty falls back to model */
  textTranslateModel: string;
  /** Plain-text scenario system prompt */
  textTranslatePrompt: string;
  /** MTool / JSON string-table prompt */
  textPromptMtool: string;
  /** Subtitle translate without timeline retime */
  textPromptSubtitle: string;
  /** Subtitle translate after (or with) timeline retime */
  textPromptSubtitleRetime: string;
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

export type UnityGameInfo = {
  isUnity: boolean;
  isIl2Cpp: boolean;
  hasAutoTranslator: boolean;
  hasBepInEx: boolean;
  gameDir: string;
  gameExe: string;
  runtime: string;
  installMethod: string;
  arch?: string;
  plugins?: string[];
  autoTranslatorVersion?: string;
  loaderName?: string;
  loaderVersion?: string;
};

export type UnityIniKey = {
  key: string;
  value: string;
  comment?: string;
};

export type UnityIniSection = {
  name: string;
  keys: UnityIniKey[];
};

export type UnitySelfCheckCheck = {
  id: string;
  level: string;
  title: string;
  detail: string;
};

export type UnitySelfCheckResult = {
  ok: boolean;
  error?: string;
  verdict?: string;
  verdictLabel?: string;
  summary?: string;
  gameArch?: string;
  loaderArch?: string;
  runtime?: string;
  checks?: UnitySelfCheckCheck[];
  suggestions?: string[];
  hasLog?: boolean;
  logPath?: string;
  logSnippet?: string;
  /** Legacy backend shape (issues/notes) when rich fields absent */
  issues?: string[];
  notes?: string[];
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
  revealPath: (path: string) =>
    request<{ ok: boolean }>("/api/reveal-path", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
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
  unityEndpoints: () =>
    request<{
      ok: boolean;
      endpoints: { id: string; label: string; needsKey: boolean }[];
    }>("/api/unity/endpoints"),
  unityPickPath: (defaultPath?: string) =>
    request<{
      ok: boolean;
      path?: string;
      cancelled?: boolean;
      error?: string;
    }>("/api/unity/pick-path", {
      method: "POST",
      body: JSON.stringify({ defaultPath: defaultPath ?? "" }),
    }),
  unityDetect: (path: string) =>
    request<{
      ok: boolean;
      error?: string;
      isUnity: boolean;
      isIl2Cpp: boolean;
      hasAutoTranslator: boolean;
      hasBepInEx: boolean;
      gameDir: string;
      gameExe: string;
      runtime: string;
      installMethod: string;
      arch?: string;
      scanRoot?: string;
      count?: number;
      games?: UnityGameInfo[];
    }>("/api/unity/detect", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  unityDetectStream: async (
    path: string,
    handlers: {
      onStart?: (path: string) => void;
      onGame?: (game: UnityGameInfo) => void;
      onDone?: (info: {
        ok: boolean;
        error?: string;
        scanRoot?: string;
        count?: number;
      }) => void;
    },
    init?: RequestInit | AbortSignal,
  ) => {
    const fetchInit: RequestInit =
      init instanceof AbortSignal ? { signal: init } : (init ?? {});
    const res = await fetch(`${API_BASE}/api/unity/detect-stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(fetchInit.headers ?? {}),
      },
      body: JSON.stringify({ path }),
      ...fetchInit,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `HTTP ${res.status}`);
    }
    if (!res.body) throw new Error("无流式响应体");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj: {
          type?: string;
          path?: string;
          game?: UnityGameInfo;
          ok?: boolean;
          error?: string;
          scanRoot?: string;
          count?: number;
        };
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (obj.type === "start") handlers.onStart?.(obj.path || path);
        else if (obj.type === "game" && obj.game) handlers.onGame?.(obj.game);
        else if (obj.type === "done")
          handlers.onDone?.({
            ok: !!obj.ok,
            error: obj.error,
            scanRoot: obj.scanRoot,
            count: obj.count,
          });
      }
    }
  },
  unityLaunch: (path: string) =>
    request<{
      ok: boolean;
      error?: string;
      gameDir: string;
      gameExe: string;
    }>("/api/unity/launch", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  /** ReiPatcher Patch and Run (requires translator plugin installed). */
  unityLaunchPatch: (path: string) =>
    request<{
      ok: boolean;
      error?: string;
      gameDir: string;
      gameExe: string;
    }>("/api/unity/launch-patch", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  unityInstall: (body: {
    path: string;
    language?: string;
    fromLanguage?: string;
    endpoint?: string;
    fallbackEndpoint?: string;
    runSetup?: boolean;
    configIni?: string;
  }) =>
    request<{
      ok: boolean;
      error?: string;
      gameDir: string;
      package: string;
      version: string;
      configPath: string;
      installMethod: string;
      steps: string[];
    }>("/api/unity/install", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  unityGetConfig: (path: string) =>
    request<{
      ok: boolean;
      error?: string;
      exists?: boolean;
      path?: string;
      installMethod?: string;
      sections?: UnityIniSection[];
    }>(`/api/unity/config?path=${encodeURIComponent(path)}`),
  unitySaveConfig: (body: { path: string; sections: UnityIniSection[] }) =>
    request<{
      ok: boolean;
      error?: string;
      exists?: boolean;
      path?: string;
      installMethod?: string;
    }>("/api/unity/config", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  unityFixFont: (body: { path: string; language?: string }) =>
    request<{
      ok: boolean;
      error?: string;
      gameDir: string;
      package: string;
      version: string;
      configPath: string;
      installMethod: string;
      steps: string[];
    }>("/api/unity/fix-font", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  unityUninstall: (path: string) =>
    request<{
      ok: boolean;
      error?: string;
      gameDir: string;
      installMethod: string;
      steps: string[];
      removed: string[];
    }>("/api/unity/uninstall", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  unityInstallLoader: (path: string) =>
    request<{
      ok: boolean;
      error?: string;
      gameDir: string;
      package: string;
      version: string;
      installMethod: string;
      steps: string[];
    }>("/api/unity/install-loader", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  unityUninstallLoader: (path: string) =>
    request<{
      ok: boolean;
      error?: string;
      gameDir: string;
      installMethod: string;
      steps: string[];
      removed: string[];
    }>("/api/unity/uninstall-loader", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  unitySelfCheck: (path: string) =>
    request<UnitySelfCheckResult>("/api/unity/self-check", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  unityAppendOutputLog: (text: string) =>
    request<{ ok: boolean; logPath?: string; error?: string }>(
      "/api/unity/output-log",
      {
        method: "POST",
        body: JSON.stringify({ text }),
      },
    ),
  unityReadOutputLog: (lines = 200) =>
    request<{
      ok: boolean;
      logPath?: string;
      exists?: boolean;
      text?: string;
      error?: string;
    }>(`/api/unity/output-log?lines=${encodeURIComponent(String(lines))}`),
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
