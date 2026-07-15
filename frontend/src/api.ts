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

export type Settings = {
  apiUrl: string;
  apiKey: string;
  model: string;
  messagePageSize: number;
  port?: number;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
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
  chat: (conversationId: string, content: string) =>
    request<{
      ok: boolean;
      reply: string;
      conversation: Conversation;
    }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ conversationId, content }),
    }),
};
