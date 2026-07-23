export type ModelPreset = {
  model: string;
  label: string;
  apiUrl: string;
  /** Visual group in settings (DeepSeek / OpenAI / …) */
  group: string;
};

export const MODEL_PRESETS: ModelPreset[] = [
  {
    model: "deepseek-chat",
    label: "DeepSeek Chat",
    apiUrl: "https://api.deepseek.com/v1/chat/completions",
    group: "DeepSeek",
  },
  {
    model: "deepseek-reasoner",
    label: "DeepSeek Reasoner",
    apiUrl: "https://api.deepseek.com/v1/chat/completions",
    group: "DeepSeek",
  },
  {
    model: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    apiUrl: "https://api.deepseek.com/v1/chat/completions",
    group: "DeepSeek",
  },
  {
    model: "deepseek-v3",
    label: "DeepSeek V3",
    apiUrl: "https://api.deepseek.com/v1/chat/completions",
    group: "DeepSeek",
  },
  {
    model: "gpt-4o",
    label: "GPT-4o",
    apiUrl: "https://api.openai.com/v1/chat/completions",
    group: "OpenAI",
  },
  {
    model: "gpt-4o-mini",
    label: "GPT-4o mini",
    apiUrl: "https://api.openai.com/v1/chat/completions",
    group: "OpenAI",
  },
  {
    model: "gpt-4-turbo",
    label: "GPT-4 Turbo",
    apiUrl: "https://api.openai.com/v1/chat/completions",
    group: "OpenAI",
  },
  {
    model: "gpt-3.5-turbo",
    label: "GPT-3.5 Turbo",
    apiUrl: "https://api.openai.com/v1/chat/completions",
    group: "OpenAI",
  },
  {
    model: "gemini-2.0-flash",
    label: "Gemini 2.0 Flash",
    apiUrl:
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    group: "Google",
  },
  {
    model: "qwen-plus",
    label: "通义千问 Plus",
    apiUrl:
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    group: "通义千问",
  },
  {
    model: "qwen-turbo",
    label: "通义千问 Turbo",
    apiUrl:
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    group: "通义千问",
  },
];

export function groupModelPresets(
  presets: ModelPreset[] = MODEL_PRESETS,
): { group: string; models: ModelPreset[] }[] {
  const order: string[] = [];
  const map = new Map<string, ModelPreset[]>();
  for (const p of presets) {
    const g = p.group || "其他";
    if (!map.has(g)) {
      map.set(g, []);
      order.push(g);
    }
    map.get(g)!.push(p);
  }
  return order.map((group) => ({ group, models: map.get(group)! }));
}

export type ModelProfile = {
  apiUrl: string;
  apiKey: string;
};

const PROFILES_KEY = "llmchat-model-profiles";

export function loadModelProfiles(): Record<string, ModelProfile> {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ModelProfile>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveModelProfiles(profiles: Record<string, ModelProfile>) {
  try {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
  } catch {
    // ignore
  }
}

export function resolveModelApi(
  model: string,
  profiles: Record<string, ModelProfile>,
): ModelProfile {
  const saved = profiles[model];
  if (saved) {
    return {
      apiUrl: saved.apiUrl ?? "",
      apiKey: saved.apiKey ?? "",
    };
  }
  const preset = MODEL_PRESETS.find((p) => p.model === model);
  return {
    apiUrl: preset?.apiUrl ?? "",
    apiKey: "",
  };
}
