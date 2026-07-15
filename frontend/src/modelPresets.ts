export type ModelPreset = {
  model: string;
  label: string;
  apiUrl: string;
};

export const MODEL_PRESETS: ModelPreset[] = [
  {
    model: "deepseek-chat",
    label: "DeepSeek Chat",
    apiUrl: "https://api.deepseek.com/v1/chat/completions",
  },
  {
    model: "deepseek-reasoner",
    label: "DeepSeek Reasoner",
    apiUrl: "https://api.deepseek.com/v1/chat/completions",
  },
  {
    model: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    apiUrl: "https://api.deepseek.com/v1/chat/completions",
  },
  {
    model: "deepseek-v3",
    label: "DeepSeek V3",
    apiUrl: "https://api.deepseek.com/v1/chat/completions",
  },
  {
    model: "gpt-4o",
    label: "GPT-4o",
    apiUrl: "https://api.openai.com/v1/chat/completions",
  },
  {
    model: "gpt-4o-mini",
    label: "GPT-4o mini",
    apiUrl: "https://api.openai.com/v1/chat/completions",
  },
  {
    model: "gpt-4-turbo",
    label: "GPT-4 Turbo",
    apiUrl: "https://api.openai.com/v1/chat/completions",
  },
  {
    model: "gpt-3.5-turbo",
    label: "GPT-3.5 Turbo",
    apiUrl: "https://api.openai.com/v1/chat/completions",
  },
  {
    model: "gemini-2.0-flash",
    label: "Gemini 2.0 Flash",
    apiUrl:
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  },
  {
    model: "qwen-plus",
    label: "通义千问 Plus",
    apiUrl:
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  },
  {
    model: "qwen-turbo",
    label: "通义千问 Turbo",
    apiUrl:
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  },
];

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
