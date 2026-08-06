/** Literature (PDF) LLM system-prompt catalog by tag. */

export type LiteraturePromptEntry = {
  id: string;
  tag: string;
  prompt: string;
};

export const GENERAL_PROMPT_ID = "general";

/**
 * Display-only Chinese description of the backend built-in English default.
 * When active id is general, the frontend must NOT send `prompt` — backend uses:
 *   "You are a precise bilingual translator. Translate the user text from {src} to {dst}.
 *    Output only the translation text with no quotes, notes, or explanations."
 */
export const DEFAULT_LIT_PROMPT_GENERAL =
  "【内置，不可修改】你是一名严谨的双语翻译。"
  + "请将用户文本从源语言翻译为目标语言。"
  + "只输出译文，不要加引号、注释或解释。"
  + "\n\n（实际请求不发送本段文字，走后端英文默认提示，以节省 token。）";

export const TOKEN_HINT_CUSTOM =
  "自定义提示词会作为 system 消息发送，并额外附带语种约束，通常比「通用」多消耗一些 prompt token。";

export const DEFAULT_LIT_PROMPT_ACADEMIC =
  "你是一名学术文献翻译。请将论文或研究报告翻译为目标语言，"
  + "术语准确、语体正式。"
  + "作者名、公式、章节编号、图表引用等在合适时应保持原样。"
  + "保留论证逻辑与限定表述，不要擅自简化或删减。"
  + "不要添加评论，只输出译文。";

export const DEFAULT_LIT_PROMPT_TECHNICAL =
  "你是一名技术书籍翻译。请将工程或编程类文本清晰、准确地翻译为目标语言。"
  + "代码、命令、路径、API 名称、标识符以及代码块/标记必须原样保留。"
  + "技术术语前后一致，优先使用领域通用译法，避免随意意译。"
  + "不要添加解释，只输出译文。";

export function defaultLiteraturePromptCatalog(): LiteraturePromptEntry[] {
  return [
    {
      id: GENERAL_PROMPT_ID,
      tag: "通用",
      prompt: DEFAULT_LIT_PROMPT_GENERAL,
    },
    {
      id: "academic",
      tag: "学术文献",
      prompt: DEFAULT_LIT_PROMPT_ACADEMIC,
    },
    {
      id: "technical",
      tag: "技术书籍",
      prompt: DEFAULT_LIT_PROMPT_TECHNICAL,
    },
  ];
}

export function parseLiteraturePromptCatalog(
  raw: string | undefined | null,
): LiteraturePromptEntry[] {
  if (!raw || !raw.trim() || raw.trim() === "[]") {
    return defaultLiteraturePromptCatalog();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return defaultLiteraturePromptCatalog();
    const items: LiteraturePromptEntry[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const id = String(r.id || "").trim();
      const tag = String(r.tag || r.label || "").trim();
      const prompt = String(r.prompt || "");
      if (!id || !tag) continue;
      items.push({ id, tag, prompt });
    }
    if (items.length === 0) return defaultLiteraturePromptCatalog();
    const withGeneral = !items.some((i) => i.id === GENERAL_PROMPT_ID)
      ? [
          {
            id: GENERAL_PROMPT_ID,
            tag: "通用",
            prompt: DEFAULT_LIT_PROMPT_GENERAL,
          },
          ...items,
        ]
      : items.map((i) =>
          i.id === GENERAL_PROMPT_ID
            ? { ...i, tag: "通用", prompt: DEFAULT_LIT_PROMPT_GENERAL }
            : i,
        );
    return withGeneral;
  } catch {
    return defaultLiteraturePromptCatalog();
  }
}

/** Migrate legacy kind/prompt fields into catalog + active id. */
export function resolveLiteraturePromptState(opts: {
  catalogRaw?: string | null;
  activeIdRaw?: string | null;
  legacyKind?: string | null;
  legacyPrompt?: string | null;
}): { catalog: LiteraturePromptEntry[]; activeId: string; prompt: string } {
  let catalog = parseLiteraturePromptCatalog(opts.catalogRaw);
  let activeId = String(
    opts.activeIdRaw || opts.legacyKind || GENERAL_PROMPT_ID,
  ).trim();

  // Legacy: custom kind with free text → ensure a custom entry exists
  if (
    opts.legacyKind === "custom" &&
    (opts.legacyPrompt || "").trim() &&
    !opts.catalogRaw?.trim()
  ) {
    const customId = "custom-migrated";
    if (!catalog.some((c) => c.id === customId)) {
      catalog = [
        ...catalog,
        {
          id: customId,
          tag: "自定义",
          prompt: (opts.legacyPrompt || "").trim(),
        },
      ];
    }
    activeId = customId;
  }

  if (!catalog.some((c) => c.id === activeId)) {
    activeId = GENERAL_PROMPT_ID;
  }
  const active =
    catalog.find((c) => c.id === activeId) ||
    catalog.find((c) => c.id === GENERAL_PROMPT_ID)!;
  return {
    catalog,
    activeId: active.id,
    prompt: active.prompt || DEFAULT_LIT_PROMPT_GENERAL,
  };
}

export function stringifyLiteraturePromptCatalog(
  catalog: LiteraturePromptEntry[],
): string {
  return JSON.stringify(catalog);
}

export function newLiteraturePromptId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

export function findLiteraturePrompt(
  catalog: LiteraturePromptEntry[],
  id: string,
): LiteraturePromptEntry | undefined {
  return catalog.find((c) => c.id === id);
}

/** @deprecated kept for transitional imports */
export type LiteraturePromptKind = string;
