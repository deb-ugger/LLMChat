import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type FocusEvent, type ReactNode } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, type Settings, type TranslateOptions, type TranslateProvider } from "../api";
import { toFriendlyError } from "../friendlyError";
import {
  DEFAULT_MTOOL_PROMPT,
  DEFAULT_SUBTITLE_PROMPT,
  DEFAULT_SUBTITLE_RETIME_TRANSLATE_PROMPT,
  DEFAULT_TEXT_PROMPT,
  parseJsonArray,
  stringifyRules,
  type GlossaryEntry,
  type ReplaceRule,
} from "../textTranslate";
import {
  DEFAULT_LIT_PROMPT_GENERAL,
  GENERAL_PROMPT_ID,
  resolveLiteraturePromptState,
  stringifyLiteraturePromptCatalog,
} from "../literaturePrompt";
import { LiteraturePromptPanel } from "./LiteraturePromptPanel";
import { PROJECT_FILENAME } from "../transProject";
import { LangCombobox } from "./LangCombobox";
import {
  UnitySettingsPanel,
  type UnitySettingsPanelHandle,
  type UnitySettingsTarget,
} from "./UnitySettingsPanel";
import {
  PricingPanel,
  type PricingPanelHandle,
} from "./PricingPanel";
import {
  defaultApiUrlForVendor,
  effectivePresets,
  groupModelPresets,
  loadLocalModelProfiles,
  loadVendorProfiles,
  resolveModelApi,
  saveLocalModelProfiles,
  saveVendorProfiles,
  setVendorModelsOverrideCache,
  resolveFeatureLlm,
  vendorOfModel,
  labelForModelId,
  type ModelPreset,
  type ModelProfile,
  type VendorModelEntry,
  type VendorModelsOverride,
  type VendorProfile,
} from "../modelPresets";
import {
  engineConfigStatusLabel,
  getEngineInfo,
  sortedClassicEngines,
  classicEngines,
  TRANSLATE_ENGINES,
  parseEngineKeys,
  stringifyEngineKeys,
  engineHasCredentials,
  type EngineKeysMap,
} from "../translateEngines";
import {
  readCardTestResults,
  readSectionTestResults,
  writeCardTestResults,
  writeSectionTestResults,
} from "../settingsTestSession";

/** Settings connection tests always attribute usage to settings_test. */
function settingsTranslate(
  text: string,
  init?: RequestInit,
  opts?: TranslateOptions,
): ReturnType<typeof api.translate> {
  return api.translate(text, init, { feature: "settings_test", ...opts });
}

type FeaturePage = "chat" | "literature" | "image" | "text" | "unity";

type SettingsTab =
  | "general"
  | "chat"
  | "literature"
  | "image"
  | "text"
  | "unity"
  | "pricing";

type Props = {
  settings: Settings;
  onSave: (settings: Settings) => void | Promise<void>;
  onNavigate?: (page: FeaturePage) => void;
  initialTab?: SettingsTab;
};

const CUSTOM_MODEL = "__custom__";

const TAB_LABELS: Record<SettingsTab, string> = {
  general: "通用",
  chat: "对话",
  literature: "文献翻译",
  image: "图片文字识别",
  text: "翻译工程",
  unity: "Unity",
  pricing: "计费",
};

const TAB_NAV: Partial<
  Record<SettingsTab, { page: FeaturePage; label: string }>
> = {
  chat: { page: "chat", label: "前往对话" },
  literature: { page: "literature", label: "前往文献翻译" },
  image: { page: "image", label: "前往图片识别" },
  text: { page: "text", label: "前往翻译工程" },
  unity: { page: "unity", label: "前往 Unity 翻译" },
};

const TAB_FIELDS: Record<SettingsTab, (keyof Settings)[]> = {
  general: [
    "proxyMode",
    "httpProxy",
    "apiUrl",
    "apiKey",
    "model",
    "translateEngineKeys",
  ],
  chat: ["model", "apiUrl", "apiKey", "messagePageSize"],
  literature: [
    "translateProvider",
    "translateSource",
    "translateTarget",
    "translateModel",
    "translatePromptId",
    "translatePromptCatalog",
    "translatePromptKind",
    "translatePrompt",
    "translateMaxLength",
    "translateAutoChunk",
    "translateContextParagraphs",
    "translateGlossary",
  ],
  image: [
    "ocrLang",
    "ocrAutoTranslate",
    "ocrTranslateProvider",
    "ocrTranslateSource",
    "ocrTranslateTarget",
    "ocrTranslateModel",
    "ocrTranslateMaxLength",
    "ocrTranslateAutoChunk",
  ],
  text: [
    "textTranslateSource",
    "textTranslateTarget",
    "textTranslateProvider",
    "textTranslateModel",
    "textTranslatePrompt",
    "textPromptMtool",
    "textPromptSubtitle",
    "textPromptSubtitleRetime",
    "textGlossary",
    "textPreReplace",
    "textPostReplace",
    "textProjectsDir",
  ],
  unity: [],
  pricing: [],
};

type TestResult = {
  ok: boolean;
  message: string;
};

const USAGE_META = [
  { id: "chat", label: "对话模型", className: "is-chat" },
  { id: "lit", label: "文献翻译", className: "is-lit" },
  { id: "ocr", label: "图片文字识别", className: "is-ocr" },
  { id: "text", label: "文本翻译工程", className: "is-text" },
] as const;

type UsageId = (typeof USAGE_META)[number]["id"];

function featureModelId(s: Settings, which: "lit" | "ocr" | "text"): string {
  if (which === "lit") return (s.translateModel || s.model || "").trim();
  if (which === "ocr") return (s.ocrTranslateModel || s.model || "").trim();
  return (s.textTranslateModel || s.model || "").trim();
}

function modelUsageIds(s: Settings, model: string): UsageId[] {
  const out: UsageId[] = [];
  if (s.model === model) out.push("chat");
  if (s.translateProvider === "llm" && featureModelId(s, "lit") === model) {
    out.push("lit");
  }
  if (s.ocrTranslateProvider === "llm" && featureModelId(s, "ocr") === model) {
    out.push("ocr");
  }
  if (s.textTranslateProvider === "llm" && featureModelId(s, "text") === model) {
    out.push("text");
  }
  return out;
}

function engineUsageIds(s: Settings, engineId: string): UsageId[] {
  const out: UsageId[] = [];
  if (s.translateProvider === engineId) out.push("lit");
  if (s.ocrTranslateProvider === engineId) out.push("ocr");
  if (s.textTranslateProvider === engineId) out.push("text");
  return out;
}

function UsageBadges({ ids }: { ids: UsageId[] }) {
  if (ids.length === 0) return null;
  return (
    <span className="settings-usage-row" aria-label="当前用途">
      {ids.map((id) => {
        const meta = USAGE_META.find((m) => m.id === id)!;
        return (
          <em
            key={id}
            className={`settings-usage-badge ${meta.className}`}
          >
            {meta.label}
          </em>
        );
      })}
    </span>
  );
}

function renderToastMessage(message: string): ReactNode {
  const parts = message.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return <span key={i}>{part}</span>;
  });
}

function ocrLangToTranslateSource(ocrLang: string): string {
  switch (ocrLang) {
    case "chi_sim":
      return "zh-CN";
    case "chi_tra":
      return "zh-TW";
    case "jpn":
      return "ja";
    case "kor":
      return "ko";
    case "eng+chi_sim":
      return "en";
    case "eng":
    default:
      return "en";
  }
}

function normalizeProvider(p: string): TranslateProvider {
  if (p === "llm") return "llm";
  if (p === "free") return "mymemory";
  if (p === "blind") return "bing";
  return (p || "bing") as TranslateProvider;
}

function withDefaults(s: Settings): Settings {
  return {
    ...s,
    proxyMode: s.proxyMode || "direct",
    httpProxy: s.httpProxy || "",
    translateProvider: normalizeProvider(s.translateProvider),
    translateModel: s.translateModel || s.model || "",
    ...(() => {
      const lit = resolveLiteraturePromptState({
        catalogRaw: s.translatePromptCatalog,
        activeIdRaw: s.translatePromptId,
        legacyKind: s.translatePromptKind,
        legacyPrompt: s.translatePrompt,
      });
      return {
        translatePromptId: lit.activeId,
        translatePromptCatalog: stringifyLiteraturePromptCatalog(lit.catalog),
        translatePromptKind: lit.activeId,
        translatePrompt: lit.prompt,
      };
    })(),
    translateMaxLength: s.translateMaxLength ?? 0,
    translateAutoChunk: s.translateAutoChunk ?? true,
    translateContextParagraphs: s.translateContextParagraphs ?? 0,
    translateGlossary: s.translateGlossary || "[]",
    ocrLang: s.ocrLang || "eng",
    ocrAutoTranslate: s.ocrAutoTranslate ?? true,
    ocrTranslateProvider: normalizeProvider(
      s.ocrTranslateProvider || "bing",
    ),
    ocrTranslateSource: ocrLangToTranslateSource(s.ocrLang || "eng"),
    ocrTranslateTarget: s.ocrTranslateTarget || "zh-CN",
    ocrTranslateModel: s.ocrTranslateModel || s.model || "",
    ocrTranslateMaxLength: s.ocrTranslateMaxLength ?? 0,
    ocrTranslateAutoChunk: s.ocrTranslateAutoChunk ?? true,
    textTranslateSource: s.textTranslateSource || "en",
    textTranslateTarget: s.textTranslateTarget || "zh-CN",
    textTranslateProvider: normalizeProvider(
      s.textTranslateProvider || "llm",
    ),
    textTranslateModel: s.textTranslateModel || s.model || "",
    textTranslatePrompt: s.textTranslatePrompt || DEFAULT_TEXT_PROMPT,
    textPromptMtool: s.textPromptMtool || DEFAULT_MTOOL_PROMPT,
    textPromptSubtitle: s.textPromptSubtitle || DEFAULT_SUBTITLE_PROMPT,
    textPromptSubtitleRetime:
      s.textPromptSubtitleRetime || DEFAULT_SUBTITLE_RETIME_TRANSLATE_PROMPT,
    textGlossary: s.textGlossary || "[]",
    textPreReplace: s.textPreReplace || "[]",
    textPostReplace: s.textPostReplace || "[]",
    textProjectsDir:
      s.textProjectsDir ||
      s.textProjectsDirResolved ||
      (s.dataDir ? `${s.dataDir}\\text-projects` : ""),
    textProjectsDirResolved: s.textProjectsDirResolved,
    dataDir: s.dataDir,
    translateEngineKeys: s.translateEngineKeys || "{}",
  };
}

function SettingToggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`settings-toggle${checked ? " is-on" : ""}`}
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    >
      <span className="settings-toggle-track" aria-hidden>
        <span className="settings-toggle-thumb" />
      </span>
      <span className="settings-toggle-label">{label}</span>
    </button>
  );
}

/** Allows clearing 0 while editing; empty → 0 and strip leading zeros on blur. */
function MaxLengthInput({
  value,
  onCommit,
  min = 0,
  max = 50000,
}: {
  value: number;
  onCommit: (n: number) => void;
  min?: number;
  max?: number;
}) {
  const [draft, setDraft] = useState(() => String(value));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(String(value));
  }, [value]);

  const normalize = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return min;
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) return min;
    return Math.min(max, Math.max(min, parsed));
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      value={draft}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onChange={(e) => {
        const next = e.target.value;
        if (next === "" || /^\d+$/.test(next)) setDraft(next);
      }}
      onBlur={() => {
        focusedRef.current = false;
        const n = normalize(draft);
        setDraft(String(n));
        onCommit(n);
      }}
    />
  );
}

function ModeSectionHead({
  title,
  enabled,
  testing,
  onTest,
}: {
  title: string;
  enabled: boolean;
  testing: boolean;
  onTest: () => void;
}) {
  return (
    <div className="settings-card-head settings-mode-head">
      <div className="settings-mode-title">
        <h3 className="settings-mode-subhead">{title}</h3>
        <span
          className={
            "settings-mode-badge" + (enabled ? " is-on" : "")
          }
        >
          {enabled ? "已选中" : "点击选用"}
        </span>
      </div>
      <div className="settings-mode-actions">
        <button
          type="button"
          className="settings-test-btn"
          disabled={testing}
          onClick={(e) => {
            e.stopPropagation();
            onTest();
          }}
        >
          {testing ? "测试中" : "测试连接"}
        </button>
      </div>
    </div>
  );
}

function ModePanel({
  enabled,
  onSelect,
  children,
}: {
  enabled: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={
        "settings-mode-panel" + (enabled ? " is-active" : " is-idle")
      }
      role="button"
      tabIndex={0}
      aria-pressed={enabled}
      onClick={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest("select, textarea, input, button, a, label, .status-select"))
          return;
        if (!enabled) onSelect();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const t = e.target as HTMLElement;
        if (t.closest("select, textarea, input, button, a, label, .status-select"))
          return;
        if (!enabled) {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      {children}
    </div>
  );
}

function sortByConfigured<T>(
  items: T[],
  isConfigured: (item: T) => boolean,
): T[] {
  return [...items].sort((a, b) => {
    const ca = isConfigured(a) ? 1 : 0;
    const cb = isConfigured(b) ? 1 : 0;
    return cb - ca;
  });
}

type ConfigStatusKind = "ok" | "warn" | "free";

type StatusSelectOption = {
  value: string;
  title: string;
  subtitle?: string;
  status: ConfigStatusKind;
  statusText: string;
};

type StatusSelectGroup = {
  label: string;
  options: StatusSelectOption[];
};

function statusBadgeClass(status: ConfigStatusKind): string {
  return `settings-engine-badge is-${status}`;
}

function engineStatusMeta(
  keys: EngineKeysMap,
  id: string,
): { status: ConfigStatusKind; statusText: string } {
  const statusText = engineConfigStatusLabel(keys, id);
  if (statusText === "无需配置") return { status: "free", statusText };
  if (statusText === "已配置") return { status: "ok", statusText };
  return { status: "warn", statusText };
}

function StatusSelect({
  label,
  value,
  groups,
  onChange,
  className,
}: {
  label?: string;
  value: string;
  groups: StatusSelectGroup[];
  onChange: (value: string) => void;
  className?: string;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const flat = useMemo(
    () => groups.flatMap((g) => g.options),
    [groups],
  );
  const selected = flat.find((o) => o.value === value) || flat[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div
      className={"status-select" + (className ? ` ${className}` : "")}
      ref={rootRef}
    >
      {label ? <span className="status-select-label">{label}</span> : null}
      <button
        type="button"
        className={"status-select-trigger" + (open ? " is-open" : "")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {selected ? (
          <>
            <em className={statusBadgeClass(selected.status)}>
              {selected.statusText}
            </em>
            <span className="status-select-trigger-text">
              <strong>{selected.title}</strong>
              {selected.subtitle ? (
                <span className="status-select-sub">{selected.subtitle}</span>
              ) : null}
            </span>
          </>
        ) : (
          <span className="status-select-trigger-text">请选择</span>
        )}
        <span className="status-select-caret" aria-hidden />
      </button>
      {open && (
        <div id={listId} className="status-select-menu" role="listbox">
          {groups.map((g) => (
            <div key={g.label} className="status-select-group">
              <div className="status-select-group-label">{g.label}</div>
              {g.options.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={opt.value === value}
                  className={
                    "status-select-option" +
                    (opt.value === value ? " is-active" : "")
                  }
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(opt.value);
                    setOpen(false);
                  }}
                >
                  <em className={statusBadgeClass(opt.status)}>
                    {opt.statusText}
                  </em>
                  <span className="status-select-option-text">
                    <strong>{opt.title}</strong>
                    {opt.subtitle ? (
                      <span className="status-select-sub">{opt.subtitle}</span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const LOCAL_VENDOR = "本地模型";

function FeatureModelSelect({
  value,
  customModels,
  isConfigured,
  onChange,
  presets,
}: {
  value: string;
  customModels: string[];
  isConfigured: (model: string) => boolean;
  onChange: (model: string) => void;
  presets: ModelPreset[];
}) {
  const vendorList = useMemo(() => {
    const groups = groupModelPresets(presets).map((g) => g.group);
    if (customModels.length > 0) groups.push(LOCAL_VENDOR);
    return groups;
  }, [customModels, presets]);

  const derivedVendor = useMemo(() => {
    const v = vendorOfModel(value, presets);
    if (v) return v;
    if (customModels.includes(value)) return LOCAL_VENDOR;
    return vendorList[0] || LOCAL_VENDOR;
  }, [value, customModels, vendorList, presets]);

  const [vendor, setVendor] = useState(derivedVendor);
  useEffect(() => {
    setVendor(derivedVendor);
  }, [derivedVendor]);

  const isVendorConfigured = (group: string) => {
    if (group === LOCAL_VENDOR) {
      return customModels.some((m) => isConfigured(m));
    }
    return presets
      .filter((p) => p.group === group)
      .some((p) => isConfigured(p.model));
  };

  const modelsForVendor = useMemo(() => {
    if (vendor === LOCAL_VENDOR) {
      return sortByConfigured(customModels, (m) => isConfigured(m)).map(
        (m) => ({ model: m, label: m }),
      );
    }
    return sortByConfigured(
      presets.filter((p) => p.group === vendor),
      (p) => isConfigured(p.model),
    ).map((p) => ({ model: p.model, label: p.label }));
  }, [vendor, customModels, isConfigured, presets]);

  const selectedModel = useMemo(() => {
    if (modelsForVendor.some((m) => m.model === value)) return value;
    return modelsForVendor[0]?.model || value;
  }, [modelsForVendor, value]);

  const vendorGroups = useMemo((): StatusSelectGroup[] => {
    const options = sortByConfigured(vendorList, (g) =>
      isVendorConfigured(g),
    ).map((g) => {
      const count =
        g === LOCAL_VENDOR
          ? customModels.length
          : presets.filter((p) => p.group === g).length;
      const ok = isVendorConfigured(g);
      return {
        value: g,
        title: g,
        subtitle: `${count} 个模型`,
        status: (ok ? "ok" : "warn") as ConfigStatusKind,
        statusText: ok ? "已配置" : "未配置",
      };
    });
    return [{ label: "厂商（已配置优先）", options }];
  }, [vendorList, customModels, isConfigured, presets]);

  const modelGroups = useMemo((): StatusSelectGroup[] => {
    const options = modelsForVendor.map((m) => ({
      value: m.model,
      title: m.label,
      subtitle: m.model,
      status: (isConfigured(m.model) ? "ok" : "warn") as ConfigStatusKind,
      statusText: isConfigured(m.model) ? "已配置" : "未配置",
    }));
    return [
      {
        label: vendor === LOCAL_VENDOR ? "本地模型" : `${vendor} 模型`,
        options,
      },
    ];
  }, [modelsForVendor, vendor, isConfigured]);

  const pickVendor = (nextVendor: string) => {
    setVendor(nextVendor);
    const models =
      nextVendor === LOCAL_VENDOR
        ? sortByConfigured(customModels, (m) => isConfigured(m))
        : sortByConfigured(
            presets.filter((p) => p.group === nextVendor),
            (p) => isConfigured(p.model),
          ).map((p) => p.model);
    if (models[0]) onChange(models[0]);
  };

  return (
    <div className="feature-model-select-row">
      <StatusSelect
        label="厂商"
        className="feature-model-select-half"
        value={vendor}
        groups={vendorGroups}
        onChange={pickVendor}
      />
      <StatusSelect
        label="模型"
        className="feature-model-select-half"
        value={selectedModel}
        groups={modelGroups}
        onChange={onChange}
      />
    </div>
  );
}

function ReplaceTable({
  title,
  hint,
  rows,
  onChange,
  showInfo,
  showEnabled,
}: {
  title: string;
  hint: string;
  rows: GlossaryEntry[];
  onChange: (rows: GlossaryEntry[]) => void;
  showInfo?: boolean;
  showEnabled?: boolean;
}) {
  const rowClass = [
    showEnabled ? "has-enabled" : "",
    showInfo ? "has-info" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="settings-rule-block">
      <div className="settings-rule-head">
        <h3>{title}</h3>
        <button
          type="button"
          className="settings-test-btn"
          onClick={() =>
            onChange([
              ...rows,
              {
                src: "",
                dst: "",
                info: "",
                enabled: true,
              },
            ])
          }
        >
          添加行
        </button>
      </div>
      <p className="hint">{hint}</p>
      {rows.length === 0 ? (
        <p className="hint">暂无条目</p>
      ) : (
        <div className="settings-rule-table">
          <div className={`settings-rule-row is-head ${rowClass}`.trim()}>
            {showEnabled && <span>启用</span>}
            <span>原文</span>
            <span>译文</span>
            {showInfo && <span>备注</span>}
            <span />
          </div>
          {rows.map((row, i) => (
            <div
              key={i}
              className={`settings-rule-row ${rowClass}${
                showEnabled && row.enabled === false ? " is-disabled" : ""
              }`.trim()}
            >
              {showEnabled && (
                <input
                  type="checkbox"
                  className="settings-rule-enable"
                  checked={row.enabled !== false}
                  title={row.enabled === false ? "启用此术语" : "停用此术语"}
                  aria-label="启用此术语"
                  onChange={(e) => {
                    const next = [...rows];
                    next[i] = { ...next[i], enabled: e.target.checked };
                    onChange(next);
                  }}
                />
              )}
              <input
                value={row.src}
                placeholder="原文"
                onChange={(e) => {
                  const next = [...rows];
                  next[i] = { ...next[i], src: e.target.value };
                  onChange(next);
                }}
              />
              <input
                value={row.dst}
                placeholder="译文"
                onChange={(e) => {
                  const next = [...rows];
                  next[i] = { ...next[i], dst: e.target.value };
                  onChange(next);
                }}
              />
              {showInfo && (
                <input
                  value={row.info ?? ""}
                  placeholder="可选"
                  onChange={(e) => {
                    const next = [...rows];
                    next[i] = { ...next[i], info: e.target.value };
                    onChange(next);
                  }}
                />
              )}
              <button
                type="button"
                className="settings-rule-del"
                title="删除"
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
              >
                删
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SettingsView({
  settings,
  onSave,
  onNavigate,
  initialTab,
}: Props) {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? "general");
  const unityPanelRef = useRef<UnitySettingsPanelHandle>(null);
  const pricingPanelRef = useRef<PricingPanelHandle>(null);
  const [pricingDirty, setPricingDirty] = useState(false);
  const [unityTarget, setUnityTarget] = useState<UnitySettingsTarget>({
    hasGame: false,
    gameDir: "",
  });
  const [form, setForm] = useState<Settings>(() => withDefaults(settings));
  const [profiles, setProfiles] = useState<Record<string, ModelProfile>>(() =>
    loadLocalModelProfiles(),
  );
  const [vendorProfiles, setVendorProfiles] = useState<
    Record<string, VendorProfile>
  >(() => loadVendorProfiles());
  const [vendorModelsOverride, setVendorModelsOverride] =
    useState<VendorModelsOverride>({});
  const [addModelDraft, setAddModelDraft] = useState({
    model: "",
    label: "",
  });
  const activePresets = useMemo(
    () => effectivePresets(vendorModelsOverride),
    [vendorModelsOverride],
  );
  const [toast, setToast] = useState<{ message: string; ok: boolean } | null>(
    null,
  );
  const toastTimerRef = useRef<number | null>(null);
  const [customDraft, setCustomDraft] = useState("");
  const [pickingCustom, setPickingCustom] = useState(false);
  /** Concurrent in-flight test/refresh keys (multi-test allowed). */
  const [testingKeys, setTestingKeys] = useState<string[]>([]);
  const testingKeysRef = useRef<Set<string>>(new Set());
  const [testMsg, setTestMsgState] = useState<{
    llm?: TestResult;
    lit?: TestResult;
    litLlm?: TestResult;
    ocr?: TestResult;
    ocrLlm?: TestResult;
    text?: TestResult;
    textLlm?: TestResult;
  }>(() => readSectionTestResults());
  const [cardTestMsg, setCardTestMsgState] = useState<
    Record<string, TestResult>
  >(() => readCardTestResults());
  const [batchProgress, setBatchProgress] = useState<Record<string, string>>(
    {},
  );
  const [generalOpen, setGeneralOpen] = useState({
    proxy: true,
    llm: true,
    engine: true,
  });
  const toggleGeneral = (key: keyof typeof generalOpen) => {
    setGeneralOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  };
  type PromptTab =
    | "plain"
    | "mtool"
    | "subtitle"
    | "subtitleRetime";
  const [promptTab, setPromptTab] = useState<PromptTab>("plain");
  const [expandedEngine, setExpandedEngine] = useState<TranslateProvider | null>(
    null,
  );
  const [panelSnap, setPanelSnap] = useState<{
    kind: "vendor" | "model" | "engine";
    id: string;
    apiUrl?: string;
    apiKey?: string;
    engineRow?: Partial<
      Record<"appId" | "secret" | "apiKey" | "note", string>
    >;
  } | null>(null);
  const [litClassicProvider, setLitClassicProvider] = useState<TranslateProvider>(
    () => {
      const p = normalizeProvider(settings.translateProvider);
      return p === "llm" ? "bing" : p;
    },
  );
  const [ocrClassicProvider, setOcrClassicProvider] = useState<TranslateProvider>(
    () => {
      const p = normalizeProvider(settings.ocrTranslateProvider || "bing");
      return p === "llm" ? "bing" : p;
    },
  );
  const [textClassicProvider, setTextClassicProvider] =
    useState<TranslateProvider>(() => {
      const p = normalizeProvider(settings.textTranslateProvider || "llm");
      return p === "llm" ? "bing" : p;
    });
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  const [expandedVendor, setExpandedVendor] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState({ apiUrl: "", apiKey: "" });
  const [saving, setSaving] = useState(false);
  const prevModelRef = useRef(form.model);
  const customInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef(form);
  const persistLockRef = useRef(false);
  const settingsRef = useRef(settings);
  formRef.current = form;
  settingsRef.current = settings;

  const notify = (message: string, ok = true) => {
    setToast({ message, ok });
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 2800);
  };

  const isTesting = (key: string) =>
    testingKeysRef.current.has(key) || testingKeys.includes(key);

  /** Start a concurrent test slot; returns false if already running. */
  const beginTest = (key: string): boolean => {
    if (testingKeysRef.current.has(key)) return false;
    testingKeysRef.current.add(key);
    setTestingKeys([...testingKeysRef.current]);
    return true;
  };

  const endTest = (key: string) => {
    if (!testingKeysRef.current.has(key)) return;
    testingKeysRef.current.delete(key);
    setTestingKeys([...testingKeysRef.current]);
  };

  const isCardTesting = (key: string) => isTesting(key);

  const setTestMsg: typeof setTestMsgState = (updater) => {
    setTestMsgState((prev) => {
      const next =
        typeof updater === "function"
          ? (
              updater as (
                p: typeof prev,
              ) => typeof prev
            )(prev)
          : updater;
      writeSectionTestResults(next);
      return next;
    });
  };

  const setCardTestMsg: typeof setCardTestMsgState = (updater) => {
    setCardTestMsgState((prev) => {
      const next =
        typeof updater === "function"
          ? (
              updater as (
                p: Record<string, TestResult>,
              ) => Record<string, TestResult>
            )(prev)
          : updater;
      writeCardTestResults(next);
      return next;
    });
  };

  const engineKeys = useMemo(
    () => parseEngineKeys(form.translateEngineKeys),
    [form.translateEngineKeys],
  );

  const setEngineKeyField = (
    engineId: string,
    field: "appId" | "secret" | "apiKey" | "note",
    value: string,
  ) => {
    const next: EngineKeysMap = {
      ...engineKeys,
      [engineId]: { ...(engineKeys[engineId] || {}), [field]: value },
    };
    setForm({ ...form, translateEngineKeys: stringifyEngineKeys(next) });
  };

  const onEngineCardClick = (id: TranslateProvider) => {
    setExpandedEngine((cur) => {
      if (cur === id) {
        setPanelSnap(null);
        return null;
      }
      const keys = parseEngineKeys(form.translateEngineKeys);
      setPanelSnap({
        kind: "engine",
        id,
        engineRow: { ...(keys[id] || {}) },
      });
      return id;
    });
    setExpandedModel(null);
    setExpandedVendor(null);
  };

  const vendorsWithCurrent = (): Record<string, VendorProfile> => {
    const next = { ...vendorProfiles };
    const chatVendor = vendorOfModel(form.model, activePresets);
    if (chatVendor) {
      next[chatVendor] = { apiUrl: form.apiUrl, apiKey: form.apiKey };
    }
    return next;
  };

  const localsWithCurrent = (): Record<string, ModelProfile> => {
    const next = { ...profiles };
    if (!vendorOfModel(form.model, activePresets) && form.model) {
      next[form.model] = { apiUrl: form.apiUrl, apiKey: form.apiKey };
    }
    return next;
  };

  const profilesWithCurrent = () => localsWithCurrent();

  const vendorConfigured = (group: string) => {
    const v = vendorsWithCurrent()[group];
    return !!(v?.apiKey || "").trim();
  };

  const modelConfigured = (model: string) => {
    const vendor = vendorOfModel(model, activePresets);
    if (vendor) return vendorConfigured(vendor);
    if (model === form.model) return !!(form.apiKey || "").trim();
    return !!(profiles[model]?.apiKey || "").trim();
  };

  const credsForModel = (model: string) => {
    if (model === form.model) {
      return { apiUrl: form.apiUrl, apiKey: form.apiKey };
    }
    return resolveModelApi(
      model,
      localsWithCurrent(),
      vendorsWithCurrent(),
      activePresets,
    );
  };

  const credsForVendor = (group: string) => {
    if (vendorOfModel(form.model, activePresets) === group) {
      return { apiUrl: form.apiUrl, apiKey: form.apiKey };
    }
    const v = vendorProfiles[group];
    return {
      apiUrl: (v?.apiUrl || "").trim() || defaultApiUrlForVendor(group),
      apiKey: v?.apiKey ?? "",
    };
  };

  const reloadVendorModels = async () => {
    try {
      const res = await api.getVendorModels();
      const vendors = res.vendors || {};
      setVendorModelsOverride(vendors);
      setVendorModelsOverrideCache(vendors);
    } catch {
      // keep built-in presets when backend unavailable
    }
  };

  useEffect(() => {
    void reloadVendorModels();
  }, []);

  useEffect(() => {
    if (persistLockRef.current) return;
    const next = withDefaults(settings);
    setForm(next);
    formRef.current = next;
    setProfiles(loadLocalModelProfiles());
    let vendors = loadVendorProfiles();
    const chatVendor = vendorOfModel(next.model, activePresets);
    if (chatVendor && (next.apiKey || "").trim()) {
      vendors = {
        ...vendors,
        [chatVendor]: {
          apiUrl: (next.apiUrl || "").trim() || defaultApiUrlForVendor(chatVendor),
          apiKey: next.apiKey,
        },
      };
      saveVendorProfiles(vendors);
    }
    setVendorProfiles(vendors);
    prevModelRef.current = settings.model;
    setPickingCustom(false);
    setCustomDraft("");
    setExpandedModel(null);
    setExpandedVendor(null);
    const classic =
      next.translateProvider === "llm" ? "bing" : next.translateProvider;
    setLitClassicProvider(classic);
    const ocrClassic =
      next.ocrTranslateProvider === "llm" ? "bing" : next.ocrTranslateProvider;
    setOcrClassicProvider(ocrClassic);
    const textClassic =
      next.textTranslateProvider === "llm"
        ? "bing"
        : next.textTranslateProvider;
    setTextClassicProvider(textClassic);
  }, [settings]);

  const prepareForm = (base: Settings): Settings => {
    const syncedSource = ocrLangToTranslateSource(base.ocrLang);
    const projectsDir =
      base.textProjectsDir.trim() ||
      base.textProjectsDirResolved ||
      (base.dataDir ? `${base.dataDir}\\text-projects` : "");
    return {
      ...base,
      ocrTranslateSource: syncedSource,
      textProjectsDir: projectsDir,
    };
  };

  const mergeTabIntoSettings = (prepared: Settings, which: SettingsTab) => {
    const merged: Settings = { ...withDefaults(settingsRef.current) };
    for (const key of TAB_FIELDS[which]) {
      (merged as Record<string, unknown>)[key] = (
        prepared as Record<string, unknown>
      )[key];
    }
    if (which === "image") {
      merged.ocrTranslateSource = prepared.ocrTranslateSource;
    }
    if (which === "text") {
      merged.textProjectsDir = prepared.textProjectsDir;
      merged.textProjectsDirResolved = prepared.textProjectsDirResolved;
    }
    merged.dataDir = prepared.dataDir ?? merged.dataDir;
    return merged;
  };

  const tabIsDirty = (which: SettingsTab, snapshot: Settings) => {
    if (which === "unity" || which === "pricing") return false;
    const base = withDefaults(settingsRef.current);
    const prepared = prepareForm(snapshot);
    return TAB_FIELDS[which].some((key) => {
      const a = (prepared as Record<string, unknown>)[key];
      const b = (base as Record<string, unknown>)[key];
      return String(a ?? "") !== String(b ?? "");
    });
  };

  const persistTab = async (
    nextForm: Settings,
    which: SettingsTab,
    successMsg?: string | null,
  ) => {
    const prepared = prepareForm(nextForm);
    const toSave = mergeTabIntoSettings(prepared, which);
    if (which === "general" || which === "chat") {
      const chatVendor = vendorOfModel(prepared.model, activePresets);
      if (chatVendor) {
        const nextVendors = {
          ...vendorProfiles,
          [chatVendor]: {
            apiUrl: prepared.apiUrl,
            apiKey: prepared.apiKey,
          },
        };
        setVendorProfiles(nextVendors);
        saveVendorProfiles(nextVendors);
      } else if (prepared.model) {
        const nextProfiles = {
          ...profiles,
          [prepared.model]: {
            apiUrl: prepared.apiUrl,
            apiKey: prepared.apiKey,
          },
        };
        setProfiles(nextProfiles);
        saveLocalModelProfiles(nextProfiles);
      }
    }
    persistLockRef.current = true;
    setSaving(true);
    try {
      await onSave(toSave);
      settingsRef.current = toSave;
      const kept = {
        ...prepared,
        textProjectsDir:
          toSave.textProjectsDir ||
          prepared.textProjectsDirResolved ||
          prepared.textProjectsDir,
        textProjectsDirResolved:
          toSave.textProjectsDirResolved || prepared.textProjectsDirResolved,
        dataDir: toSave.dataDir || prepared.dataDir,
      };
      // Keep other tabs' local edits; sync saved tab + resolved paths.
      setForm((prev) => {
        const next = { ...prev };
        for (const key of TAB_FIELDS[which]) {
          (next as Record<string, unknown>)[key] = (
            kept as Record<string, unknown>
          )[key];
        }
        next.textProjectsDir = kept.textProjectsDir;
        next.textProjectsDirResolved = kept.textProjectsDirResolved;
        next.dataDir = kept.dataDir;
        formRef.current = next;
        return next;
      });
      if (successMsg) notify(successMsg);
      return toSave;
    } catch (e) {
      notify(e instanceof Error ? e.message : "保存失败", false);
      throw e;
    } finally {
      setSaving(false);
      window.setTimeout(() => {
        persistLockRef.current = false;
      }, 0);
    }
  };

  const saveCurrentPage = async () => {
    if (tab === "unity") {
      setSaving(true);
      try {
        await unityPanelRef.current?.save();
      } finally {
        setSaving(false);
      }
      return;
    }
    if (tab === "pricing") {
      setSaving(true);
      try {
        await pricingPanelRef.current?.save();
      } catch (e) {
        notify(toFriendlyError(e, "保存价目表失败"), false);
      } finally {
        setSaving(false);
      }
      return;
    }
    await persistTab(
      formRef.current,
      tab,
      `已保存「${TAB_LABELS[tab]}」设置`,
    );
  };

  const discardPricingChanges = async () => {
    if (!pricingPanelRef.current?.isDirty()) {
      notify("当前没有未保存的修改");
      return;
    }
    if (!window.confirm("确定取消修改？未保存的价目表改动将丢失。")) return;
    setSaving(true);
    try {
      await pricingPanelRef.current.discard();
    } catch (e) {
      notify(toFriendlyError(e, "取消修改失败"), false);
    } finally {
      setSaving(false);
    }
  };

  const autoSaveTab = (
    nextForm: Settings,
    which: SettingsTab = tab,
    successMsg: string | null = "已自动保存",
  ) => {
    formRef.current = nextForm;
    if (persistLockRef.current) return;
    if (!tabIsDirty(which, nextForm)) return;
    void persistTab(nextForm, which, successMsg);
  };

  const commitForm = (
    next: Settings,
    autoSave = true,
    successMsg?: string | null,
  ) => {
    formRef.current = next;
    setForm(next);
    if (autoSave) {
      autoSaveTab(
        next,
        tab,
        successMsg === undefined ? "已自动保存" : successMsg,
      );
    }
  };

  const selectTab = (next: SettingsTab) => {
    if (next === tab) return;
    const current = formRef.current;
    if (tabIsDirty(tab, current)) {
      void (async () => {
        try {
          await persistTab(current, tab, null);
          setTab(next);
        } catch {
          /* keep current tab on failure */
        }
      })();
      return;
    }
    setTab(next);
  };

  const onSettingsAutoSave = (
    e: ChangeEvent<HTMLElement> | FocusEvent<HTMLElement>,
  ) => {
    const el = e.target as HTMLElement;
    if (el.closest(".settings-engine-panel")) return;
    if (e.type === "change") {
      if (el.tagName !== "SELECT") return;
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          autoSaveTab(formRef.current, tab);
        });
      });
      return;
    }
    if (e.type === "blur") {
      if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return;
      const input = el as HTMLInputElement;
      if (input.type === "checkbox" || input.type === "radio") return;
      window.requestAnimationFrame(() => {
        autoSaveTab(formRef.current, tab);
      });
    }
  };

  const customModels = useMemo(() => {
    const presetIds = new Set(activePresets.map((p) => p.model));
    const fromProfiles = Object.keys(profiles).filter((m) => !presetIds.has(m));
    const extra =
      form.model &&
      !presetIds.has(form.model) &&
      !fromProfiles.includes(form.model)
        ? [form.model]
        : [];
    return [...new Set([...fromProfiles, ...extra])].sort();
  }, [form.model, profiles, activePresets]);

  const ocrSource = useMemo(
    () => ocrLangToTranslateSource(form.ocrLang),
    [form.ocrLang],
  );
  const litClassicEngines = useMemo(
    () =>
      sortedClassicEngines(
        form.translateSource,
        form.translateTarget,
        engineKeys,
      ),
    [form.translateSource, form.translateTarget, engineKeys],
  );
  const catalogEngines = useMemo(() => classicEngines(TRANSLATE_ENGINES), []);
  const textClassicEngines = useMemo(
    () =>
      sortedClassicEngines(
        form.textTranslateSource,
        form.textTranslateTarget,
        engineKeys,
      ),
    [form.textTranslateSource, form.textTranslateTarget, engineKeys],
  );
  const ocrClassicEngines = useMemo(
    () =>
      sortedClassicEngines(ocrSource, form.ocrTranslateTarget, engineKeys),
    [ocrSource, form.ocrTranslateTarget, engineKeys],
  );

  const selectedEngine = getEngineInfo(
    form.translateProvider === "llm"
      ? litClassicProvider
      : form.translateProvider,
  );
  const selectedTextEngine = getEngineInfo(
    form.textTranslateProvider === "llm"
      ? textClassicProvider
      : form.textTranslateProvider,
  );
  const selectedOcrEngine = getEngineInfo(
    form.ocrTranslateProvider === "llm"
      ? ocrClassicProvider
      : form.ocrTranslateProvider,
  );
  const litUsesLlm = form.translateProvider === "llm";
  const ocrUsesLlm = form.ocrTranslateProvider === "llm";
  const textUsesLlm = form.textTranslateProvider === "llm";
  const showChunkOption =
    !litUsesLlm &&
    !!selectedEngine &&
    selectedEngine.supportsChunk;
  const showOcrChunkOption =
    !ocrUsesLlm &&
    !!selectedOcrEngine &&
    selectedOcrEngine.supportsChunk;

  const glossaryRows = useMemo(
    () => parseJsonArray<GlossaryEntry>(form.textGlossary, []),
    [form.textGlossary],
  );
  const litGlossaryRows = useMemo(
    () => parseJsonArray<GlossaryEntry>(form.translateGlossary, []),
    [form.translateGlossary],
  );
  const preRows = useMemo(
    () => parseJsonArray<ReplaceRule>(form.textPreReplace, []),
    [form.textPreReplace],
  );
  const postRows = useMemo(
    () => parseJsonArray<ReplaceRule>(form.textPostReplace, []),
    [form.textPostReplace],
  );

  const applyModel = (model: string, baseForm: Settings = form) => {
    const name = model.trim();
    if (!name) return baseForm;
    const prev = prevModelRef.current;
    const prevVendor = vendorOfModel(prev, activePresets);
    let nextVendors = { ...vendorProfiles };
    let nextLocals = { ...profiles };
    if (prevVendor) {
      nextVendors[prevVendor] = {
        apiUrl: baseForm.apiUrl,
        apiKey: baseForm.apiKey,
      };
    } else if (prev) {
      nextLocals[prev] = {
        apiUrl: baseForm.apiUrl,
        apiKey: baseForm.apiKey,
      };
    }
    if (!activePresets.some((p) => p.model === name) && !nextLocals[name]) {
      nextLocals[name] = {
        apiUrl: baseForm.apiUrl,
        apiKey: baseForm.apiKey,
      };
    }
    const resolved = resolveModelApi(name, nextLocals, nextVendors, activePresets);
    setVendorProfiles(nextVendors);
    saveVendorProfiles(nextVendors);
    setProfiles(nextLocals);
    saveLocalModelProfiles(nextLocals);
    prevModelRef.current = name;
    setPickingCustom(false);
    setCustomDraft("");
    const next = {
      ...baseForm,
      model: name,
      apiUrl: resolved.apiUrl,
      apiKey: resolved.apiKey,
    };
    formRef.current = next;
    setForm(next);
    return next;
  };

  const onVendorCardClick = (group: string) => {
    if (expandedVendor === group) {
      setExpandedVendor(null);
      setPanelSnap(null);
      return;
    }
    const creds = credsForVendor(group);
    setModelDraft({ apiUrl: creds.apiUrl, apiKey: creds.apiKey });
    setAddModelDraft({ model: "", label: "" });
    setExpandedVendor(group);
    setExpandedModel(null);
    setExpandedEngine(null);
    setPickingCustom(false);
    setPanelSnap({
      kind: "vendor",
      id: group,
      apiUrl: creds.apiUrl,
      apiKey: creds.apiKey,
    });
  };

  const onModelCardClick = (model: string) => {
    if (expandedModel === model) {
      setExpandedModel(null);
      setPanelSnap(null);
      return;
    }
    const creds = credsForModel(model);
    setModelDraft({ apiUrl: creds.apiUrl, apiKey: creds.apiKey });
    setExpandedModel(model);
    setExpandedVendor(null);
    setExpandedEngine(null);
    setPickingCustom(false);
    setPanelSnap({
      kind: "model",
      id: model,
      apiUrl: creds.apiUrl,
      apiKey: creds.apiKey,
    });
  };

  const commitCustomModel = () => {
    const name = customDraft.trim();
    if (!name) return;
    const nextProfiles = {
      ...profiles,
      [name]: {
        apiUrl: modelDraft.apiUrl || form.apiUrl,
        apiKey: modelDraft.apiKey || form.apiKey,
      },
    };
    setProfiles(nextProfiles);
    saveLocalModelProfiles(nextProfiles);
    setExpandedModel(name);
    setExpandedVendor(null);
    setPickingCustom(false);
    setCustomDraft("");
    setPanelSnap({
      kind: "model",
      id: name,
      apiUrl: nextProfiles[name].apiUrl,
      apiKey: nextProfiles[name].apiKey,
    });
    setModelDraft({
      apiUrl: nextProfiles[name].apiUrl,
      apiKey: nextProfiles[name].apiKey,
    });
  };

  const setLitLang = (which: "source" | "target", code: string) => {
    const source = which === "source" ? code : form.translateSource;
    const target = which === "target" ? code : form.translateTarget;
    if (form.translateProvider === "llm") {
      commitForm({
        ...form,
        translateSource: source,
        translateTarget: target,
      });
      return;
    }
    const best =
      sortedClassicEngines(source, target, engineKeys)[0]?.id ??
      form.translateProvider;
    setLitClassicProvider(best);
    commitForm({
      ...form,
      translateSource: source,
      translateTarget: target,
      translateProvider: best,
    });
  };

  const setOcrRecognizeLang = (ocrLang: string) => {
    const source = ocrLangToTranslateSource(ocrLang);
    if (form.ocrTranslateProvider === "llm") {
      commitForm({
        ...form,
        ocrLang,
        ocrTranslateSource: source,
      });
      return;
    }
    const best =
      sortedClassicEngines(source, form.ocrTranslateTarget, engineKeys)[0]?.id ??
      form.ocrTranslateProvider;
    setOcrClassicProvider(best);
    commitForm({
      ...form,
      ocrLang,
      ocrTranslateSource: source,
      ocrTranslateProvider: best,
    });
  };

  const setOcrTarget = (code: string) => {
    const source = ocrLangToTranslateSource(form.ocrLang);
    if (form.ocrTranslateProvider === "llm") {
      commitForm({
        ...form,
        ocrTranslateTarget: code,
        ocrTranslateSource: source,
      });
      return;
    }
    const best =
      sortedClassicEngines(source, code, engineKeys)[0]?.id ??
      form.ocrTranslateProvider;
    setOcrClassicProvider(best);
    commitForm({
      ...form,
      ocrTranslateTarget: code,
      ocrTranslateSource: source,
      ocrTranslateProvider: best,
    });
  };

  const savePanel = async () => {
    const snapModel = expandedModel;
    const snapVendor = expandedVendor;
    const snapEngine = expandedEngine;
    const addingCustom = pickingCustom || snapModel === CUSTOM_MODEL;
    const customName = customDraft.trim();
    let successMsg = "保存成功";
    let nextForm = form;
    let nextProfiles = { ...profiles };
    let nextVendors = { ...vendorProfiles };

    if (addingCustom && customName) {
      successMsg = `添加本地模型「${customName}」成功`;
      nextProfiles = {
        ...nextProfiles,
        [customName]: {
          apiUrl: modelDraft.apiUrl,
          apiKey: modelDraft.apiKey,
        },
      };
    } else if (snapVendor) {
      successMsg = `保存厂商「${snapVendor}」成功`;
      nextVendors = {
        ...nextVendors,
        [snapVendor]: {
          apiUrl: modelDraft.apiUrl,
          apiKey: modelDraft.apiKey,
        },
      };
      if (vendorOfModel(form.model, activePresets) === snapVendor) {
        nextForm = {
          ...form,
          apiUrl: modelDraft.apiUrl,
          apiKey: modelDraft.apiKey,
        };
      }
    } else if (snapModel && snapModel !== CUSTOM_MODEL) {
      const label =
        activePresets.find((p) => p.model === snapModel)?.label || snapModel;
      successMsg = `保存模型「${label}」成功`;
      nextProfiles = {
        ...nextProfiles,
        [snapModel]: {
          apiUrl: modelDraft.apiUrl,
          apiKey: modelDraft.apiKey,
        },
      };
      if (form.model === snapModel) {
        nextForm = {
          ...form,
          apiUrl: modelDraft.apiUrl,
          apiKey: modelDraft.apiKey,
        };
      }
    } else if (snapEngine) {
      const label = getEngineInfo(snapEngine)?.label || snapEngine;
      successMsg = `保存引擎「${label}」成功`;
    }

    setProfiles(nextProfiles);
    saveLocalModelProfiles(nextProfiles);
    setVendorProfiles(nextVendors);
    saveVendorProfiles(nextVendors);
    setForm(nextForm);

    try {
      const toSave = {
        ...nextForm,
        ocrTranslateSource: ocrLangToTranslateSource(nextForm.ocrLang),
      };
      await onSave(toSave);
      notify(successMsg);
      if (addingCustom && customName) {
        setExpandedModel(customName);
        setPickingCustom(false);
        setCustomDraft("");
        setPanelSnap({
          kind: "model",
          id: customName,
          apiUrl: modelDraft.apiUrl,
          apiKey: modelDraft.apiKey,
        });
      } else if (snapVendor) {
        setPanelSnap({
          kind: "vendor",
          id: snapVendor,
          apiUrl: modelDraft.apiUrl,
          apiKey: modelDraft.apiKey,
        });
      } else if (snapModel && snapModel !== CUSTOM_MODEL) {
        setPanelSnap({
          kind: "model",
          id: snapModel,
          apiUrl: modelDraft.apiUrl,
          apiKey: modelDraft.apiKey,
        });
      } else if (snapEngine) {
        const keys = parseEngineKeys(toSave.translateEngineKeys);
        setPanelSnap({
          kind: "engine",
          id: snapEngine,
          engineRow: { ...(keys[snapEngine] || {}) },
        });
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : "保存失败", false);
    }
  };

  const cancelPanel = () => {
    if (!panelSnap) {
      setExpandedEngine(null);
      setExpandedModel(null);
      setExpandedVendor(null);
      setPickingCustom(false);
      return;
    }
    if (panelSnap.kind === "vendor") {
      const nextVendors = {
        ...vendorProfiles,
        [panelSnap.id]: {
          apiUrl: panelSnap.apiUrl || "",
          apiKey: panelSnap.apiKey || "",
        },
      };
      setVendorProfiles(nextVendors);
      saveVendorProfiles(nextVendors);
      if (vendorOfModel(form.model, activePresets) === panelSnap.id) {
        setForm({
          ...form,
          apiUrl: panelSnap.apiUrl || "",
          apiKey: panelSnap.apiKey || "",
        });
      }
      setModelDraft({
        apiUrl: panelSnap.apiUrl || "",
        apiKey: panelSnap.apiKey || "",
      });
      setExpandedVendor(null);
    } else if (panelSnap.kind === "model") {
      const nextProfiles = {
        ...profiles,
        [panelSnap.id]: {
          apiUrl: panelSnap.apiUrl || "",
          apiKey: panelSnap.apiKey || "",
        },
      };
      setProfiles(nextProfiles);
      saveLocalModelProfiles(nextProfiles);
      if (form.model === panelSnap.id) {
        setForm({
          ...form,
          apiUrl: panelSnap.apiUrl || "",
          apiKey: panelSnap.apiKey || "",
        });
      }
      setModelDraft({
        apiUrl: panelSnap.apiUrl || "",
        apiKey: panelSnap.apiKey || "",
      });
      setExpandedModel(null);
    } else {
      const keys = parseEngineKeys(form.translateEngineKeys);
      const next: EngineKeysMap = { ...keys };
      if (panelSnap.engineRow && Object.keys(panelSnap.engineRow).length > 0) {
        next[panelSnap.id] = { ...panelSnap.engineRow };
      } else {
        delete next[panelSnap.id];
      }
      setForm({
        ...form,
        translateEngineKeys: stringifyEngineKeys(next),
      });
      setExpandedEngine(null);
    }
    setPanelSnap(null);
    setPickingCustom(false);
  };

  const deleteLocalModel = async (model: string) => {
    const presetIds = new Set(activePresets.map((p) => p.model));
    if (presetIds.has(model)) return;

    const nextProfiles = { ...profiles };
    delete nextProfiles[model];

    let nextForm = { ...form };
    if (form.model === model) {
      const fallback =
        activePresets[0]?.model ||
        Object.keys(nextProfiles).find((m) => !presetIds.has(m)) ||
        activePresets[0]?.model ||
        "";
      const resolved = resolveModelApi(
        fallback,
        nextProfiles,
        vendorProfiles,
        activePresets,
      );
      nextForm = {
        ...form,
        model: fallback,
        apiUrl: resolved.apiUrl,
        apiKey: resolved.apiKey,
      };
      prevModelRef.current = fallback;
    }

    setProfiles(nextProfiles);
    saveLocalModelProfiles(nextProfiles);
    setForm(nextForm);
    setExpandedModel(null);
    setPanelSnap(null);
    setPickingCustom(false);
    setCustomDraft("");
    setCardTestMsg((m) => {
      const next = { ...m };
      delete next[`model:${model}`];
      return next;
    });

    try {
      await onSave(nextForm);
      notify(`删除本地模型「${model}」成功`);
    } catch (e) {
      notify(e instanceof Error ? e.message : "删除失败", false);
    }
  };

  const setTextLang = (field: "source" | "target", code: string) => {
    const source = field === "source" ? code : form.textTranslateSource;
    const target = field === "target" ? code : form.textTranslateTarget;
    if (form.textTranslateProvider === "llm") {
      commitForm({
        ...form,
        textTranslateSource: source,
        textTranslateTarget: target,
      });
      return;
    }
    const best =
      sortedClassicEngines(source, target, engineKeys)[0]?.id ??
      form.textTranslateProvider;
    setTextClassicProvider(best);
    commitForm({
      ...form,
      textTranslateSource: source,
      textTranslateTarget: target,
      textTranslateProvider: best,
    });
  };

  const runTest = async (
    kind: "llm" | "lit" | "litLlm" | "ocr" | "ocrLlm" | "text" | "textLlm",
  ) => {
    if (!beginTest(kind)) return;
    setTestMsg((m) => ({ ...m, [kind]: undefined }));
    const t0 = performance.now();
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), 15000);
    try {
      let nextForm = form;
      if (kind === "lit") {
        const classic =
          form.translateProvider !== "llm"
            ? form.translateProvider
            : litClassicProvider;
        nextForm = { ...form, translateProvider: classic };
        setLitClassicProvider(classic);
        setForm(nextForm);
        await onSave(nextForm);
        const res = await settingsTranslate("Hello", { signal: ac.signal }, {
          provider: classic,
          source: nextForm.translateSource,
          target: nextForm.translateTarget,
          maxLength: nextForm.translateMaxLength || 200,
          autoChunk: nextForm.translateAutoChunk,
        });
        if (!(res.translation || "").trim()) {
          throw new Error("引擎返回空译文，请换引擎或检查网络/代理");
        }
      } else if (kind === "litLlm") {
        nextForm = { ...form, translateProvider: "llm" };
        setForm(nextForm);
        await onSave(nextForm);
        const llm = resolveFeatureLlm(
          nextForm,
          nextForm.translateModel,
          profilesWithCurrent(),
          vendorsWithCurrent(),
          activePresets,
        );
        if (!llm.apiUrl.trim()) {
          throw new Error("请先在「通用」为所选模型填写 API URL");
        }
        const res = await settingsTranslate("Hello", { signal: ac.signal }, {
          provider: "llm",
          source: nextForm.translateSource,
          target: nextForm.translateTarget,
          maxLength: nextForm.translateMaxLength || 200,
          autoChunk: false,
          apiUrl: llm.apiUrl,
          apiKey: llm.apiKey,
          model: llm.model,
          ...(nextForm.translatePromptId !== GENERAL_PROMPT_ID &&
          (nextForm.translatePrompt || "").trim() &&
          !String(nextForm.translatePrompt).includes("【内置，不可修改】")
            ? { prompt: nextForm.translatePrompt }
            : {}),
        });
        if (!(res.translation || "").trim()) {
          throw new Error("引擎返回空译文");
        }
      } else if (kind === "ocr") {
        const classic =
          form.ocrTranslateProvider !== "llm"
            ? form.ocrTranslateProvider
            : ocrClassicProvider;
        nextForm = { ...form, ocrTranslateProvider: classic };
        setOcrClassicProvider(classic);
        setForm(nextForm);
        await onSave(nextForm);
        const res = await settingsTranslate("Hello", { signal: ac.signal }, {
          provider: classic,
          source: ocrLangToTranslateSource(nextForm.ocrLang),
          target: nextForm.ocrTranslateTarget,
          maxLength: nextForm.ocrTranslateMaxLength || 200,
          autoChunk: nextForm.ocrTranslateAutoChunk,
        });
        if (!(res.translation || "").trim()) {
          throw new Error("引擎返回空译文");
        }
      } else if (kind === "ocrLlm") {
        nextForm = { ...form, ocrTranslateProvider: "llm" };
        setForm(nextForm);
        await onSave(nextForm);
        const llm = resolveFeatureLlm(
          nextForm,
          nextForm.ocrTranslateModel,
          profilesWithCurrent(),
          vendorsWithCurrent(),
          activePresets,
        );
        if (!llm.apiUrl.trim()) {
          throw new Error("请先在「通用」为所选模型填写 API URL");
        }
        const res = await settingsTranslate("Hello", { signal: ac.signal }, {
          provider: "llm",
          source: ocrLangToTranslateSource(nextForm.ocrLang),
          target: nextForm.ocrTranslateTarget,
          maxLength: nextForm.ocrTranslateMaxLength || 200,
          autoChunk: false,
          apiUrl: llm.apiUrl,
          apiKey: llm.apiKey,
          model: llm.model,
        });
        if (!(res.translation || "").trim()) {
          throw new Error("引擎返回空译文");
        }
      } else if (kind === "text") {
        const classic =
          form.textTranslateProvider !== "llm"
            ? form.textTranslateProvider
            : textClassicProvider;
        nextForm = { ...form, textTranslateProvider: classic };
        setTextClassicProvider(classic);
        setForm(nextForm);
        await onSave(nextForm);
        const res = await settingsTranslate("Hello", { signal: ac.signal }, {
          provider: classic,
          source: nextForm.textTranslateSource,
          target: nextForm.textTranslateTarget,
          maxLength: 200,
          autoChunk: true,
        });
        if (!(res.translation || "").trim()) {
          throw new Error("引擎返回空译文");
        }
      } else if (kind === "textLlm") {
        nextForm = { ...form, textTranslateProvider: "llm" };
        setForm(nextForm);
        await onSave(nextForm);
        const llm = resolveFeatureLlm(
          nextForm,
          nextForm.textTranslateModel,
          profilesWithCurrent(),
          vendorsWithCurrent(),
          activePresets,
        );
        if (!llm.apiUrl.trim()) {
          throw new Error("请先在「通用」为所选模型填写 API URL");
        }
        const res = await settingsTranslate("Hello", { signal: ac.signal }, {
          provider: "llm",
          source: nextForm.textTranslateSource,
          target: nextForm.textTranslateTarget,
          maxLength: 200,
          autoChunk: true,
          apiUrl: llm.apiUrl,
          apiKey: llm.apiKey,
          model: llm.model,
          prompt: nextForm.textTranslatePrompt,
        });
        if (!(res.translation || "").trim()) {
          throw new Error("引擎返回空译文");
        }
      } else {
        await onSave(form);
      }

      if (kind === "llm") {
        if (!form.apiUrl.trim()) {
          throw new Error("请先填写 API URL");
        }
        const res = await settingsTranslate("ping", { signal: ac.signal }, {
          provider: "llm",
          source: "en",
          target: "zh-CN",
          apiUrl: form.apiUrl,
          apiKey: form.apiKey,
          model: form.model,
          maxLength: 32,
          autoChunk: false,
        });
        if (!(res.translation || "").trim()) {
          throw new Error("引擎返回空译文");
        }
      }
      const ms = Math.round(performance.now() - t0);
      setTestMsg((m) => ({
        ...m,
        [kind]: { ok: true, message: `连接正常 · 延迟 ${ms} ms` },
      }));
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      const aborted = ac.signal.aborted;
      const provider =
        kind === "llm" ||
        kind === "litLlm" ||
        kind === "ocrLlm" ||
        kind === "textLlm"
          ? "llm"
          : kind === "lit"
            ? form.translateProvider !== "llm"
              ? form.translateProvider
              : litClassicProvider
            : kind === "ocr"
              ? form.ocrTranslateProvider !== "llm"
                ? form.ocrTranslateProvider
                : ocrClassicProvider
              : kind === "text"
                ? form.textTranslateProvider !== "llm"
                  ? form.textTranslateProvider
                  : textClassicProvider
                : form.ocrTranslateProvider;
      let msg = toFriendlyError(e, "Test failed（测试失败）");
      if (aborted) {
        msg =
          provider === "google"
            ? "Timed out after 15s（连接超时；谷歌翻译在国内通常需要系统代理，建议改用 Bing/有道）"
            : "Timed out after 15s（连接超时，请检查网络或稍后重试）";
      } else if (
        provider === "google" &&
        /timeout|proxy|googleapis|无法连接|超时|代理/i.test(msg) &&
        !/（/.test(msg)
      ) {
        msg = `${msg}（谷歌翻译在国内通常需要系统代理）`;
      }
      setTestMsg((m) => ({
        ...m,
        [kind]: { ok: false, message: `${msg} · ${ms} ms` },
      }));
    } finally {
      window.clearTimeout(timer);
      endTest(kind);
    }
  };

  const testOneVendor = async (group: string) => {
    const models = activePresets.filter((p) => p.group === group);
    const model =
      models.find((m) => m.model === form.model)?.model ||
      models[0]?.model ||
      "";
    if (!model) return;
    const key = `vendor:${group}`;
    if (!beginTest(key)) return;
    setCardTestMsg((m) => {
      const next = { ...m };
      delete next[key];
      return next;
    });
    const t0 = performance.now();
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), 15000);
    try {
      await onSave(formRef.current);
      const creds = credsForVendor(group);
      if (!creds.apiUrl.trim()) {
        throw new Error("请先填写 API URL");
      }
      const res = await settingsTranslate("ping", { signal: ac.signal }, {
        provider: "llm",
        source: "en",
        target: "zh-CN",
        apiUrl: creds.apiUrl,
        apiKey: creds.apiKey,
        model,
        maxLength: 32,
        autoChunk: false,
      });
      if (!(res.translation || "").trim()) {
        throw new Error("引擎返回空译文");
      }
      const ms = Math.round(performance.now() - t0);
      setCardTestMsg((m) => ({
        ...m,
        [key]: { ok: true, message: `连接正常 · ${ms} ms` },
      }));
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      const msg = ac.signal.aborted
        ? "连接超时"
        : toFriendlyError(e, "测试失败");
      setCardTestMsg((m) => ({
        ...m,
        [key]: { ok: false, message: `${msg} · ${ms} ms` },
      }));
    } finally {
      window.clearTimeout(timer);
      endTest(key);
    }
  };

  const testOneModel = async (model: string) => {
    const key = `model:${model}`;
    if (!beginTest(key)) return;
    setCardTestMsg((m) => {
      const next = { ...m };
      delete next[key];
      return next;
    });
    const t0 = performance.now();
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), 15000);
    try {
      await onSave(formRef.current);
      const creds = credsForModel(model);
      if (!creds.apiUrl.trim()) {
        throw new Error("请先填写 API URL");
      }
      const res = await settingsTranslate("ping", { signal: ac.signal }, {
        provider: "llm",
        source: "en",
        target: "zh-CN",
        apiUrl: creds.apiUrl,
        apiKey: creds.apiKey,
        model,
        maxLength: 32,
        autoChunk: false,
      });
      if (!(res.translation || "").trim()) {
        throw new Error("引擎返回空译文");
      }
      const ms = Math.round(performance.now() - t0);
      setCardTestMsg((m) => ({
        ...m,
        [key]: { ok: true, message: `连接正常 · ${ms} ms` },
      }));
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      const msg = ac.signal.aborted
        ? "连接超时"
        : toFriendlyError(e, "测试失败");
      setCardTestMsg((m) => ({
        ...m,
        [key]: { ok: false, message: `${msg} · ${ms} ms` },
      }));
    } finally {
      window.clearTimeout(timer);
      endTest(key);
    }
  };

  const testAllModels = async () => {
    if (!beginTest("llm-all")) return;
    setTestMsg((m) => ({ ...m, llm: undefined }));
    const vendorGroups = groupModelPresets(activePresets).map((g) => g.group);
    const targets: { key: string; kind: "vendor" | "model"; id: string }[] = [
      ...vendorGroups.map((g) => ({
        key: `vendor:${g}`,
        kind: "vendor" as const,
        id: g,
      })),
      ...customModels.map((m) => ({
        key: `model:${m}`,
        kind: "model" as const,
        id: m,
      })),
    ];
    await onSave(formRef.current);
    const total = targets.length;
    let done = 0;
    let ok = 0;
    let fail = 0;
    setBatchProgress((p) => ({ ...p, "llm-all": `0/${total}` }));

    await Promise.all(
      targets.map(async (t) => {
        if (!beginTest(t.key)) {
          done += 1;
          setBatchProgress((p) => ({
            ...p,
            "llm-all": `${done}/${total}`,
          }));
          return;
        }
        setCardTestMsg((m) => {
          const next = { ...m };
          delete next[t.key];
          return next;
        });
        const t0 = performance.now();
        const ac = new AbortController();
        const timer = window.setTimeout(() => ac.abort(), 12000);
        try {
          let model = t.id;
          let creds = { apiUrl: "", apiKey: "" };
          if (t.kind === "vendor") {
            const models = activePresets.filter((p) => p.group === t.id);
            model =
              models.find((m) => m.model === formRef.current.model)?.model ||
              models[0]?.model ||
              "";
            creds = credsForVendor(t.id);
          } else {
            creds = credsForModel(t.id);
          }
          if (!model || !creds.apiUrl.trim()) {
            throw new Error("未填写 API URL");
          }
          const res = await settingsTranslate("ping", { signal: ac.signal }, {
            provider: "llm",
            source: "en",
            target: "zh-CN",
            apiUrl: creds.apiUrl,
            apiKey: creds.apiKey,
            model,
            maxLength: 32,
            autoChunk: false,
          });
          if (!(res.translation || "").trim()) {
            throw new Error("空译文");
          }
          const ms = Math.round(performance.now() - t0);
          setCardTestMsg((m) => ({
            ...m,
            [t.key]: { ok: true, message: `连接正常 · ${ms} ms` },
          }));
          ok += 1;
        } catch (e) {
          const ms = Math.round(performance.now() - t0);
          const msg = ac.signal.aborted
            ? "连接超时"
            : toFriendlyError(e, "失败");
          setCardTestMsg((m) => ({
            ...m,
            [t.key]: { ok: false, message: `${msg} · ${ms} ms` },
          }));
          fail += 1;
        } finally {
          window.clearTimeout(timer);
          endTest(t.key);
          done += 1;
          setBatchProgress((p) => ({
            ...p,
            "llm-all": `${done}/${total}`,
          }));
        }
      }),
    );

    setTestMsg((m) => ({
      ...m,
      llm: {
        ok: fail === 0 && ok > 0,
        message: `全部测试完成：成功 ${ok}，失败 ${fail}`,
      },
    }));
    setBatchProgress((p) => {
      const next = { ...p };
      delete next["llm-all"];
      return next;
    });
    endTest("llm-all");
  };

  const testOneEngine = async (engineId: TranslateProvider) => {
    const key = `engine:${engineId}`;
    if (!beginTest(key)) return;
    setCardTestMsg((m) => {
      const next = { ...m };
      delete next[key];
      return next;
    });
    const t0 = performance.now();
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), 15000);
    try {
      await onSave(formRef.current);
      const res = await settingsTranslate("Hello", { signal: ac.signal }, {
        provider: engineId,
        source: formRef.current.translateSource || "en",
        target: formRef.current.translateTarget || "zh-CN",
        maxLength: 200,
        autoChunk: true,
      });
      if (!(res.translation || "").trim()) {
        throw new Error("引擎返回空译文");
      }
      const ms = Math.round(performance.now() - t0);
      setCardTestMsg((m) => ({
        ...m,
        [key]: { ok: true, message: `连接正常 · ${ms} ms` },
      }));
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      let msg = ac.signal.aborted
        ? "连接超时"
        : toFriendlyError(e, "测试失败");
      if (
        engineId === "google" &&
        /timeout|proxy|googleapis|无法连接|超时|代理/i.test(msg) &&
        !/（/.test(msg)
      ) {
        msg = `${msg}（谷歌翻译在国内通常需要系统代理）`;
      }
      setCardTestMsg((m) => ({
        ...m,
        [key]: { ok: false, message: `${msg} · ${ms} ms` },
      }));
    } finally {
      window.clearTimeout(timer);
      endTest(key);
    }
  };

  const testAllEngines = async () => {
    if (!beginTest("engine-all")) return;
    setTestMsg((m) => ({ ...m, lit: undefined }));
    const list = catalogEngines;
    await onSave(formRef.current);
    const total = list.length;
    let done = 0;
    let ok = 0;
    let fail = 0;
    setBatchProgress((p) => ({ ...p, "engine-all": `0/${total}` }));

    await Promise.all(
      list.map(async (e) => {
        const key = `engine:${e.id}`;
        if (!beginTest(key)) {
          done += 1;
          setBatchProgress((p) => ({
            ...p,
            "engine-all": `${done}/${total}`,
          }));
          return;
        }
        setCardTestMsg((m) => {
          const next = { ...m };
          delete next[key];
          return next;
        });
        const t0 = performance.now();
        const ac = new AbortController();
        const timer = window.setTimeout(() => ac.abort(), 12000);
        try {
          const res = await settingsTranslate("Hello", { signal: ac.signal }, {
            provider: e.id,
            source: formRef.current.translateSource || "en",
            target: formRef.current.translateTarget || "zh-CN",
            maxLength: 200,
            autoChunk: true,
          });
          if (!(res.translation || "").trim()) {
            throw new Error("空译文");
          }
          const ms = Math.round(performance.now() - t0);
          setCardTestMsg((m) => ({
            ...m,
            [key]: { ok: true, message: `连接正常 · ${ms} ms` },
          }));
          ok += 1;
        } catch (err) {
          const ms = Math.round(performance.now() - t0);
          let msg = ac.signal.aborted
            ? "连接超时"
            : toFriendlyError(err, "失败");
          if (
            e.id === "google" &&
            /timeout|proxy|googleapis|无法连接|超时|代理/i.test(msg) &&
            !/（/.test(msg)
          ) {
            msg = `${msg}（谷歌翻译在国内通常需要系统代理）`;
          }
          setCardTestMsg((m) => ({
            ...m,
            [key]: { ok: false, message: `${msg} · ${ms} ms` },
          }));
          fail += 1;
        } finally {
          window.clearTimeout(timer);
          endTest(key);
          done += 1;
          setBatchProgress((p) => ({
            ...p,
            "engine-all": `${done}/${total}`,
          }));
        }
      }),
    );

    setTestMsg((m) => ({
      ...m,
      lit: {
        ok: fail === 0 && ok > 0,
        message: `全部测试完成：成功 ${ok}，失败 ${fail}`,
      },
    }));
    setBatchProgress((p) => {
      const next = { ...p };
      delete next["engine-all"];
      return next;
    });
    endTest("engine-all");
  };

  const modelGroups = useMemo(() => {
    const groups = groupModelPresets(activePresets);
    if (customModels.length > 0) {
      groups.push({
        group: "本地模型",
        models: customModels.map((m) => ({
          model: m,
          label: m,
          apiUrl: resolveModelApi(
            m,
            localsWithCurrent(),
            vendorsWithCurrent(),
          ).apiUrl,
          group: "本地模型",
        })),
      });
    }
    return groups;
  }, [customModels, form.model, form.apiUrl, form.apiKey, profiles, vendorProfiles, activePresets]);

  const modelsForVendorGroup = (group: string): VendorModelEntry[] => {
    const over = vendorModelsOverride[group];
    if (over && over.length > 0) {
      return over.map((m) => ({
        ...m,
        // Legacy rows without source are treated as API (not deletable)
        source: m.source === "manual" ? "manual" : "api",
      }));
    }
    return activePresets
      .filter((p) => p.group === group)
      .map((p) => ({ model: p.model, label: p.label, source: "api" as const }));
  };

  const refreshVendorModelList = async (group: string) => {
    const key = `vendor-refresh:${group}`;
    if (!beginTest(key)) return;
    try {
      const creds =
        expandedVendor === group ? modelDraft : credsForVendor(group);
      if (!creds.apiUrl.trim()) throw new Error("请先填写 API URL");
      if (!creds.apiKey.trim()) throw new Error("请先填写 API Key");
      const res = await api.refreshVendorModels(group, {
        apiUrl: creds.apiUrl,
        apiKey: creds.apiKey,
        proxyMode: form.proxyMode,
        httpProxy: form.httpProxy,
      });
      setVendorModelsOverride((prev) => {
        const mapped = (res.models || []).map((m) => ({
          model: m.model,
          label: labelForModelId(m.model, group) || m.label || m.model,
          source: (m.source === "manual" ? "manual" : "api") as
            | "api"
            | "manual",
        }));
        const next = { ...prev, [group]: mapped };
        setVendorModelsOverrideCache(next);
        return next;
      });
      notify(`已更新「${group}」模型列表（${res.count ?? res.models?.length ?? 0} 个）`);
    } catch (e) {
      notify(
        (e instanceof Error ? e.message : "更新失败") +
          "。可在下方手动添加模型。",
        false,
      );
    } finally {
      endTest(key);
    }
  };

  const persistVendorModelList = async (
    group: string,
    models: VendorModelEntry[],
    successMsg?: string,
  ) => {
    try {
      const res = await api.putVendorModels(group, models);
      setVendorModelsOverride((prev) => {
        const next = {
          ...prev,
          [group]: (res.models || models).map((m) => ({
            model: m.model,
            label: m.label || m.model,
            source: (m.source === "manual" ? "manual" : m.source === "api" ? "api" : (models.find((x) => x.model === m.model)?.source || "manual")) as
              | "api"
              | "manual",
          })),
        };
        setVendorModelsOverrideCache(next);
        return next;
      });
      notify(successMsg || `已保存「${group}」模型列表`);
    } catch (e) {
      notify(e instanceof Error ? e.message : "保存模型列表失败", false);
    }
  };

  const removeVendorModel = (group: string, entry: VendorModelEntry) => {
    if (entry.source !== "manual") {
      notify("官方更新的模型不能删除", false);
      return;
    }
    const label = entry.label && entry.label !== entry.model
      ? `${entry.label}（${entry.model}）`
      : entry.model;
    if (!window.confirm(`确定删除手动添加的模型「${label}」？`)) return;
    const next = modelsForVendorGroup(group).filter(
      (m) => m.model !== entry.model,
    );
    void persistVendorModelList(group, next, `已删除模型「${entry.model}」`);
  };

  const addVendorModel = (group: string) => {
    const id = addModelDraft.model.trim();
    if (!id) {
      notify("请填写模型 ID", false);
      return;
    }
    const list = modelsForVendorGroup(group);
    if (list.some((m) => m.model === id)) {
      notify("该模型已存在", false);
      return;
    }
    const next = [
      ...list,
      {
        model: id,
        label: addModelDraft.label.trim() || id,
        source: "manual" as const,
      },
    ];
    setAddModelDraft({ model: "", label: "" });
    void persistVendorModelList(group, next, `已添加模型「${id}」`);
  };

  const tabs: { id: SettingsTab; label: string; priority?: boolean }[] = [
    { id: "general", label: "通用", priority: true },
    { id: "chat", label: "对话" },
    { id: "literature", label: "文献翻译" },
    { id: "image", label: "图片文字识别" },
    { id: "text", label: "翻译工程" },
    { id: "unity", label: "Unity" },
    { id: "pricing", label: "计费" },
  ];

  useEffect(() => {
    if (initialTab && initialTab !== tab) {
      setTab(initialTab);
    }
    // Only react to external open requests
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab]);

  return (
    <div className="settings-page">
      {toast && (
        <div
          className={
            "settings-toast" + (toast.ok ? " is-ok" : " is-fail")
          }
          role="status"
        >
          {renderToastMessage(toast.message)}
        </div>
      )}
      <div className="settings-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={[
              "settings-tab",
              tab === t.id ? "active" : "",
              t.priority ? "is-priority" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => selectTab(t.id)}
          >
            {t.label}
            {t.priority ? <span className="settings-tab-badge">重要</span> : null}
          </button>
        ))}
      </div>

      <div
        className="settings-tab-body"
        onChange={onSettingsAutoSave}
        onBlur={onSettingsAutoSave}
      >
        {tab === "general" && (
          <>
            <div className="settings-priority-banner">
              <strong>通用</strong>
              <span>
                代理与大模型 API 是全软件共用配置，请优先在此完成连接测试。
              </span>
            </div>
            <section
              className={
                "settings-card settings-fold" +
                (generalOpen.proxy ? "" : " is-collapsed")
              }
            >
              <div className="settings-card-head settings-fold-head">
                <button
                  type="button"
                  className="settings-fold-toggle"
                  aria-expanded={generalOpen.proxy}
                  onClick={() => toggleGeneral("proxy")}
                >
                  <span className="settings-fold-chevron" aria-hidden>
                    {generalOpen.proxy ? "▾" : "▸"}
                  </span>
                  <h2>网络代理</h2>
                </button>
              </div>
              {generalOpen.proxy && (
                <div className="settings-fold-body">
              <p className="hint settings-engine-rank-hint">
                浏览器能上网不代表本软件走同一通道。若出现「无法解析域名」或国内引擎全挂，请先试「直连」；要用谷歌且
                Clash 已开启时，选「自定义」并填本地端口（常见
                127.0.0.1:7890）。
              </p>
              <div className="settings-row settings-row-half">
                <label className="settings-half">
                  代理模式
                  <select
                    value={form.proxyMode || "direct"}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        proxyMode: e.target.value,
                      })
                    }
                  >
                    <option value="direct">直连（推荐先试）</option>
                    <option value="auto">跟随系统代理 / PAC</option>
                    <option value="custom">自定义代理</option>
                  </select>
                </label>
                <label className="settings-half">
                  自定义代理地址
                  <input
                    type="text"
                    placeholder="127.0.0.1:7890"
                    value={form.httpProxy || ""}
                    disabled={(form.proxyMode || "direct") !== "custom"}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        httpProxy: e.target.value,
                      })
                    }
                  />
                </label>
              </div>
                </div>
              )}
            </section>

            <section
              className={
                "settings-card settings-fold" +
                (generalOpen.llm ? "" : " is-collapsed")
              }
            >
              <div className="settings-card-head settings-fold-head">
                <button
                  type="button"
                  className="settings-fold-toggle"
                  aria-expanded={generalOpen.llm}
                  onClick={() => toggleGeneral("llm")}
                >
                  <span className="settings-fold-chevron" aria-hidden>
                    {generalOpen.llm ? "▾" : "▸"}
                  </span>
                  <h2>大模型 API</h2>
                </button>
                <button
                  type="button"
                  className="settings-test-btn"
                  disabled={isTesting("llm-all")}
                  onClick={() => void testAllModels()}
                >
                  {isTesting("llm-all")
                    ? `测试中${batchProgress["llm-all"] ? ` ${batchProgress["llm-all"]}` : ""}`
                    : "测试全部大模型"}
                </button>
              </div>
              {generalOpen.llm && (
                <div className="settings-fold-body">
              {testMsg.llm && (
                <p
                  className={
                    testMsg.llm.ok
                      ? "settings-test-ok"
                      : "settings-test-fail"
                  }
                >
                  {testMsg.llm.message}
                </p>
              )}
              <p className="hint">
                按厂商填写一份 API URL / Key，该厂商下所有模型共用。点开卡片可查看可用模型；对话 / 文献 / 图片 / 文本页再选择具体模型。
              </p>
              <div className="settings-model-groups">
                <div className="settings-engine-catalog settings-vendor-catalog">
                  {modelGroups
                    .filter((g) => g.group !== "本地模型")
                    .map((g) => {
                      const open = expandedVendor === g.group;
                      const configured = vendorConfigured(g.group);
                      const usage = [
                        ...new Set(
                          g.models.flatMap((m) =>
                            modelUsageIds(form, m.model),
                          ),
                        ),
                      ];
                      const testKey = `vendor:${g.group}`;
                      const cardResult = cardTestMsg[testKey];
                      const busy = isCardTesting(testKey);
                      return (
                        <div
                          key={g.group}
                          className={
                            "settings-engine-card" +
                            (open ? " is-open is-span-full" : "") +
                            (usage.length > 0 ? " is-in-use" : "")
                          }
                        >
                          <div className="settings-engine-card-top">
                            <button
                              type="button"
                              className="settings-engine-card-btn"
                              onClick={() => onVendorCardClick(g.group)}
                            >
                              <span className="settings-engine-card-title">
                                <em
                                  className={
                                    configured
                                      ? "settings-engine-badge is-ok"
                                      : "settings-engine-badge is-warn"
                                  }
                                >
                                  {configured ? "已配置" : "未配置"}
                                </em>
                                <strong>{g.group}</strong>
                              </span>
                              <span className="settings-engine-card-hint">
                                {modelsForVendorGroup(g.group).length} 个模型 ·
                                URL / Key 共用一份
                              </span>
                              <UsageBadges ids={usage} />
                            </button>
                            <button
                              type="button"
                              className="settings-card-mini-test is-refresh"
                              disabled={isTesting(`vendor-refresh:${g.group}`)}
                              onClick={(ev) => {
                                ev.stopPropagation();
                                void refreshVendorModelList(g.group);
                              }}
                            >
                              {isTesting(`vendor-refresh:${g.group}`)
                                ? "更新中"
                                : "更新模型列表"}
                            </button>
                            <button
                              type="button"
                              className="settings-card-mini-test is-test"
                              disabled={busy}
                              onClick={(ev) => {
                                ev.stopPropagation();
                                void testOneVendor(g.group);
                              }}
                            >
                              {busy ? "测试中" : "测试连接"}
                            </button>
                          </div>
                          {cardResult && (
                            <p
                              className={
                                cardResult.ok
                                  ? "settings-card-test-ok"
                                  : "settings-card-test-fail"
                              }
                            >
                              {cardResult.message}
                            </p>
                          )}
                          {open && (
                            <div className="settings-engine-panel">
                              <label className="settings-engine-field">
                                API URL
                                <input
                                  value={modelDraft.apiUrl}
                                  onChange={(e) =>
                                    setModelDraft({
                                      ...modelDraft,
                                      apiUrl: e.target.value,
                                    })
                                  }
                                  placeholder="该厂商共用接口地址"
                                  autoComplete="off"
                                />
                              </label>
                              <label className="settings-engine-field">
                                API Key
                                <input
                                  type="password"
                                  value={modelDraft.apiKey}
                                  onChange={(e) =>
                                    setModelDraft({
                                      ...modelDraft,
                                      apiKey: e.target.value,
                                    })
                                  }
                                  placeholder="该厂商共用密钥"
                                  autoComplete="off"
                                />
                              </label>
                              <div className="settings-vendor-models">
                                <div className="settings-vendor-models-title">
                                  可用模型
                                </div>
                                <ul className="settings-vendor-models-list">
                                  {modelsForVendorGroup(g.group).map((m) => {
                                    const canDelete = m.source === "manual";
                                    return (
                                      <li
                                        key={m.model}
                                        className={
                                          canDelete
                                            ? "is-manual"
                                            : "is-api"
                                        }
                                      >
                                        <div className="settings-vendor-model-meta">
                                          <strong>
                                            {m.label && m.label !== m.model
                                              ? m.label
                                              : m.model}
                                          </strong>
                                          {m.label && m.label !== m.model ? (
                                            <span>{m.model}</span>
                                          ) : null}
                                          {!canDelete ? (
                                            <em className="settings-vendor-model-tag">
                                              官方
                                            </em>
                                          ) : (
                                            <em className="settings-vendor-model-tag is-manual">
                                              手动
                                            </em>
                                          )}
                                        </div>
                                        {canDelete ? (
                                          <button
                                            type="button"
                                            className="settings-panel-delete"
                                            onClick={() =>
                                              removeVendorModel(g.group, m)
                                            }
                                          >
                                            删除
                                          </button>
                                        ) : null}
                                      </li>
                                    );
                                  })}
                                </ul>
                                <div className="settings-vendor-add-row">
                                  <input
                                    value={
                                      expandedVendor === g.group
                                        ? addModelDraft.model
                                        : ""
                                    }
                                    onChange={(e) =>
                                      setAddModelDraft({
                                        ...addModelDraft,
                                        model: e.target.value,
                                      })
                                    }
                                    placeholder="模型 ID，如 deepseek-v4-flash"
                                    autoComplete="off"
                                  />
                                  <input
                                    value={
                                      expandedVendor === g.group
                                        ? addModelDraft.label
                                        : ""
                                    }
                                    onChange={(e) =>
                                      setAddModelDraft({
                                        ...addModelDraft,
                                        label: e.target.value,
                                      })
                                    }
                                    placeholder="显示名（可选）"
                                    autoComplete="off"
                                  />
                                  <button
                                    type="button"
                                    className="settings-panel-save"
                                    onClick={() => addVendorModel(g.group)}
                                  >
                                    添加
                                  </button>
                                </div>
                                <p className="hint">
                                  「更新模型列表」拉取的官方模型不可删除；仅手动添加的模型可删（需确认）。再次更新时会保留手动模型。
                                </p>
                              </div>
                              <div className="settings-engine-panel-actions">
                                <button
                                  type="button"
                                  className="settings-panel-save"
                                  onClick={() => void savePanel()}
                                >
                                  保存凭证
                                </button>
                                <button
                                  type="button"
                                  className="settings-panel-cancel"
                                  onClick={cancelPanel}
                                >
                                  取消
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
                {modelGroups
                  .filter((g) => g.group === "本地模型")
                  .map((g) => (
                    <div key={g.group} className="settings-model-group is-flat">
                      <div className="settings-model-group-title">
                        {g.group}
                      </div>
                      <div className="settings-engine-catalog settings-vendor-catalog">
                        {g.models.map((p) => {
                          const open = expandedModel === p.model;
                          const configured = modelConfigured(p.model);
                          const usage = modelUsageIds(form, p.model);
                          const testKey = `model:${p.model}`;
                          const cardResult = cardTestMsg[testKey];
                          const busy = isCardTesting(testKey);
                          return (
                            <div
                              key={p.model}
                              className={
                                "settings-engine-card" +
                                (open ? " is-open is-span-full" : "") +
                                (usage.length > 0 ? " is-in-use" : "")
                              }
                            >
                              <div className="settings-engine-card-top">
                                <button
                                  type="button"
                                  className="settings-engine-card-btn"
                                  onClick={() => onModelCardClick(p.model)}
                                >
                                  <span className="settings-engine-card-title">
                                    <em
                                      className={
                                        configured
                                          ? "settings-engine-badge is-ok"
                                          : "settings-engine-badge is-warn"
                                      }
                                    >
                                      {configured ? "已配置" : "未配置"}
                                    </em>
                                    <strong>{p.label}</strong>
                                  </span>
                                  <span className="settings-engine-card-hint">
                                    {p.model}
                                  </span>
                                  <UsageBadges ids={usage} />
                                </button>
                                <button
                                  type="button"
                                  className="settings-card-mini-test is-test"
                                  disabled={busy}
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    void testOneModel(p.model);
                                  }}
                                >
                                  {busy ? "测试中" : "测试连接"}
                                </button>
                              </div>
                              {cardResult && (
                                <p
                                  className={
                                    cardResult.ok
                                      ? "settings-card-test-ok"
                                      : "settings-card-test-fail"
                                  }
                                >
                                  {cardResult.message}
                                </p>
                              )}
                              {open && (
                                <div className="settings-engine-panel">
                                  <label className="settings-engine-field">
                                    API URL
                                    <input
                                      value={modelDraft.apiUrl}
                                      onChange={(e) =>
                                        setModelDraft({
                                          ...modelDraft,
                                          apiUrl: e.target.value,
                                        })
                                      }
                                      placeholder="该模型对应的接口地址"
                                      autoComplete="off"
                                    />
                                  </label>
                                  <label className="settings-engine-field">
                                    API Key
                                    <input
                                      type="password"
                                      value={modelDraft.apiKey}
                                      onChange={(e) =>
                                        setModelDraft({
                                          ...modelDraft,
                                          apiKey: e.target.value,
                                        })
                                      }
                                      placeholder="本地模型独立保存"
                                      autoComplete="off"
                                    />
                                  </label>
                                  <div className="settings-engine-panel-actions">
                                    <button
                                      type="button"
                                      className="settings-panel-save"
                                      onClick={() => void savePanel()}
                                    >
                                      保存
                                    </button>
                                    <button
                                      type="button"
                                      className="settings-panel-cancel"
                                      onClick={cancelPanel}
                                    >
                                      取消
                                    </button>
                                    <button
                                      type="button"
                                      className="settings-panel-delete"
                                      onClick={() =>
                                        void deleteLocalModel(p.model)
                                      }
                                    >
                                      删除
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                <div className="settings-model-group is-flat">
                  <div className="settings-model-group-title">新增本地模型</div>
                  <div className="settings-engine-catalog">
                    <div
                      className={
                        "settings-engine-card" +
                        (pickingCustom || expandedModel === CUSTOM_MODEL
                          ? " is-open"
                          : "")
                      }
                    >
                      <button
                        type="button"
                        className="settings-engine-card-btn"
                        onClick={() => {
                          const open =
                            pickingCustom || expandedModel === CUSTOM_MODEL;
                          if (open) {
                            setPickingCustom(false);
                            setExpandedModel(null);
                            setPanelSnap(null);
                            setCustomDraft("");
                            return;
                          }
                          setPickingCustom(true);
                          setExpandedModel(CUSTOM_MODEL);
                          setExpandedVendor(null);
                          setExpandedEngine(null);
                          setModelDraft({
                            apiUrl: form.apiUrl,
                            apiKey: form.apiKey,
                          });
                          setPanelSnap({
                            kind: "model",
                            id: CUSTOM_MODEL,
                            apiUrl: form.apiUrl,
                            apiKey: form.apiKey,
                          });
                          window.setTimeout(
                            () => customInputRef.current?.focus(),
                            0,
                          );
                        }}
                      >
                        <span className="settings-engine-card-title">
                          <strong>新增自定义模型</strong>
                        </span>
                        <span className="settings-engine-card-hint">
                          输入模型 ID 并填写 API URL / Key
                        </span>
                      </button>
                      {(pickingCustom || expandedModel === CUSTOM_MODEL) && (
                        <div className="settings-engine-panel">
                          <label className="settings-engine-field">
                            自定义模型名
                            <input
                              ref={customInputRef}
                              value={customDraft}
                              onChange={(e) => {
                                setPickingCustom(true);
                                setCustomDraft(e.target.value);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  commitCustomModel();
                                  if (customDraft.trim()) {
                                    setExpandedModel(customDraft.trim());
                                  }
                                }
                              }}
                              onBlur={() => {
                                if (customDraft.trim()) {
                                  commitCustomModel();
                                  setExpandedModel(customDraft.trim());
                                }
                              }}
                              placeholder="输入新模型 ID，回车保存"
                              autoComplete="off"
                            />
                          </label>
                          <label className="settings-engine-field">
                            API URL
                            <input
                              value={modelDraft.apiUrl}
                              onChange={(e) =>
                                setModelDraft({
                                  ...modelDraft,
                                  apiUrl: e.target.value,
                                })
                              }
                              placeholder="该模型对应的接口地址"
                              autoComplete="off"
                            />
                          </label>
                          <label className="settings-engine-field">
                            API Key
                            <input
                              type="password"
                              value={modelDraft.apiKey}
                              onChange={(e) =>
                                setModelDraft({
                                  ...modelDraft,
                                  apiKey: e.target.value,
                                })
                              }
                              placeholder="各模型独立保存"
                              autoComplete="off"
                            />
                          </label>
                          <div className="settings-engine-panel-actions">
                            <button
                              type="button"
                              className="settings-panel-save"
                              onClick={() => void savePanel()}
                            >
                              添加
                            </button>
                            <button
                              type="button"
                              className="settings-panel-cancel"
                              onClick={cancelPanel}
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
                </div>
              )}
            </section>

            <section
              className={
                "settings-card settings-fold" +
                (generalOpen.engine ? "" : " is-collapsed")
              }
            >
              <div className="settings-card-head settings-fold-head">
                <button
                  type="button"
                  className="settings-fold-toggle"
                  aria-expanded={generalOpen.engine}
                  onClick={() => toggleGeneral("engine")}
                >
                  <span className="settings-fold-chevron" aria-hidden>
                    {generalOpen.engine ? "▾" : "▸"}
                  </span>
                  <h2>翻译引擎</h2>
                </button>
                <button
                  type="button"
                  className="settings-test-btn"
                  disabled={isTesting("engine-all")}
                  onClick={() => void testAllEngines()}
                >
                  {isTesting("engine-all")
                    ? `测试中${batchProgress["engine-all"] ? ` ${batchProgress["engine-all"]}` : ""}`
                    : "测试全部引擎"}
                </button>
              </div>
              {generalOpen.engine && (
                <div className="settings-fold-body">
              {testMsg.lit && tab === "general" && (
                <p
                  className={
                    testMsg.lit.ok
                      ? "settings-test-ok"
                      : "settings-test-fail"
                  }
                >
                  {testMsg.lit.message}
                </p>
              )}
              <p className="hint">
                仅用于配置各在线翻译引擎凭证。彩色标签显示当前被哪些功能选用；文献 / 图片 / 文本在各自页选择引擎。免
                Key 引擎走上方网络代理。
              </p>
              <div className="settings-engine-catalog">
                {catalogEngines.map((e) => {
                  const open = expandedEngine === e.id;
                  const configured = engineHasCredentials(engineKeys, e.id);
                  const usage = engineUsageIds(form, e.id);
                  const testKey = `engine:${e.id}`;
                  const cardResult = cardTestMsg[testKey];
                  const busy = isCardTesting(testKey);
                  const needsKey = e.credentialFields?.some(
                    (f) => f.key !== "note",
                  );
                  return (
                    <div
                      key={e.id}
                      className={
                        "settings-engine-card" +
                        (open ? " is-open" : "") +
                        (usage.length > 0 ? " is-in-use" : "")
                      }
                    >
                      <div className="settings-engine-card-top">
                        <button
                          type="button"
                          className="settings-engine-card-btn"
                          onClick={() => onEngineCardClick(e.id)}
                        >
                          <span className="settings-engine-card-title">
                            {needsKey ? (
                              <em
                                className={
                                  configured
                                    ? "settings-engine-badge is-ok"
                                    : "settings-engine-badge is-warn"
                                }
                              >
                                {configured ? "已配置" : "未配置"}
                              </em>
                            ) : (
                              <em className="settings-engine-badge is-free">
                                无需配置
                              </em>
                            )}
                            <strong>{e.label}</strong>
                          </span>
                          <span className="settings-engine-card-hint">
                            {e.hint}
                          </span>
                          <UsageBadges ids={usage} />
                        </button>
                        <button
                          type="button"
                          className="settings-card-mini-test"
                          disabled={busy}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            void testOneEngine(e.id);
                          }}
                        >
                          {busy ? "测试中" : "测试连接"}
                        </button>
                      </div>
                      {cardResult && (
                        <p
                          className={
                            cardResult.ok
                              ? "settings-card-test-ok"
                              : "settings-card-test-fail"
                          }
                        >
                          {cardResult.message}
                        </p>
                      )}
                      {open && (
                        <div className="settings-engine-panel">
                          {(e.credentialFields || []).map((field) => (
                            <label
                              key={field.key}
                              className="settings-engine-field"
                            >
                              {field.label}
                              <input
                                type={field.password ? "password" : "text"}
                                value={engineKeys[e.id]?.[field.key] || ""}
                                placeholder={field.placeholder || ""}
                                onChange={(ev) =>
                                  setEngineKeyField(
                                    e.id,
                                    field.key,
                                    ev.target.value,
                                  )
                                }
                                autoComplete="off"
                              />
                            </label>
                          ))}
                          {e.id === "google" && (
                            <p className="hint">
                              若直连超时，请到上方「网络代理」填写 Clash 等本地端口。
                            </p>
                          )}
                          <div className="settings-engine-panel-actions">
                            <button
                              type="button"
                              className="settings-panel-save"
                              onClick={() => void savePanel()}
                            >
                              保存
                            </button>
                            <button
                              type="button"
                              className="settings-panel-cancel"
                              onClick={cancelPanel}
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
                </div>
              )}
            </section>
          </>
        )}

        {tab === "chat" && (
          <section className="settings-card">
            <div className="settings-card-head">
              <h2>对话</h2>
              <button
                type="button"
                className="settings-test-btn"
                disabled={isTesting("llm")}
                onClick={() => void runTest("llm")}
              >
                {isTesting("llm") ? "测试中" : "测试连接"}
              </button>
            </div>
            <p className="hint">
              先选厂商，再选模型；API URL / Key 请在「通用」中按厂商配置。
            </p>
            {testMsg.llm && (
              <p
                className={
                  testMsg.llm.ok
                    ? "settings-test-ok"
                    : "settings-test-fail"
                }
              >
                {testMsg.llm.message}
              </p>
            )}
            <FeatureModelSelect
              value={
                activePresets.some((p) => p.model === form.model) ||
                customModels.includes(form.model)
                  ? form.model
                  : customModels[0] || activePresets[0]?.model || form.model
              }
              customModels={customModels}
              isConfigured={modelConfigured}
              presets={activePresets}
              onChange={(model) => {
                const next = applyModel(model);
                autoSaveTab(next);
              }}
            />
            <label>
              每次加载消息数
              <input
                type="number"
                min={10}
                max={500}
                step={10}
                value={form.messagePageSize}
                onChange={(e) =>
                  setForm({
                    ...form,
                    messagePageSize: Number(e.target.value) || 30,
                  })
                }
              />
            </label>
            <p className="hint">
              当前 API：{form.apiUrl || "（未配置）"}
            </p>
          </section>
        )}

        {tab === "literature" && (
          <>
            <section className="settings-card">
              <h2>文献翻译</h2>
              <p className="hint">
                在此选择语言与长度；下方点击区块选用「翻译引擎」或「大模型翻译」。API /
                代理请在「通用」配置。
              </p>
              <div className="settings-row settings-row-half">
                <div className="settings-half">
                  <LangCombobox
                    label="源语言"
                    value={form.translateSource}
                    onChange={(code) => setLitLang("source", code)}
                  />
                </div>
                <div className="settings-half">
                  <LangCombobox
                    label="目标语言"
                    value={form.translateTarget}
                    onChange={(code) => setLitLang("target", code)}
                  />
                </div>
              </div>
              <div className="settings-field">
                <span className="settings-field-label">
                  每次翻译最大长度（字符，0=
                  {litUsesLlm
                    ? "不限制"
                    : selectedEngine?.defaultMaxChars
                      ? `引擎默认≈${selectedEngine.defaultMaxChars}`
                      : "引擎默认"}
                  ）
                </span>
                <div className="settings-row settings-row-controls">
                  <MaxLengthInput
                    value={form.translateMaxLength}
                    onCommit={(n) => {
                      const next = { ...form, translateMaxLength: n };
                      formRef.current = next;
                      setForm(next);
                    }}
                  />
                  {showChunkOption ? (
                    <SettingToggle
                      checked={form.translateAutoChunk}
                      onChange={(v) =>
                        commitForm({ ...form, translateAutoChunk: v })
                      }
                      label="超过最大长度时自动分段并拼接"
                    />
                  ) : (
                    <div />
                  )}
                </div>
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                当前文献翻译方式：
                <strong>
                  {litUsesLlm
                    ? `大模型（${form.translateModel || form.model || "未选模型"}）`
                    : selectedEngine?.label || form.translateProvider}
                </strong>
              </p>
            </section>

            <section className="settings-card">
              <div className="settings-mode-choice">
                <div className="settings-mode-choice-head">
                  <h2>翻译方式</h2>
                  <p className="hint">
                    二选一：点击下方选项切换。凭证在「通用」配置，此处选择具体引擎或模型。
                  </p>
                </div>

              <ModePanel
                enabled={!litUsesLlm}
                onSelect={() => {
                  const classic =
                    form.translateProvider !== "llm"
                      ? form.translateProvider
                      : litClassicProvider;
                  setLitClassicProvider(classic);
                  commitForm(
                    { ...form, translateProvider: classic },
                    true,
                    "**文献翻译** 翻译方式已切换为 **翻译引擎**",
                  );
                }}
              >
                <ModeSectionHead
                  title="翻译引擎"
                  enabled={!litUsesLlm}
                  testing={isTesting("lit")}
                  onTest={() => void runTest("lit")}
                />
                {testMsg.lit && (
                  <p
                    className={
                      testMsg.lit.ok
                        ? "settings-test-ok"
                        : "settings-test-fail"
                    }
                  >
                    {testMsg.lit.message}
                  </p>
                )}
                <p className="hint">
                  使用在线翻译引擎。引擎凭证请在「通用 → 翻译引擎」中配置。
                </p>
                <div className="settings-field">
                  <span className="settings-field-label">选择引擎</span>
                  <div className="settings-engine-row">
                    <StatusSelect
                      className="settings-engine-status-select"
                      value={
                        form.translateProvider !== "llm"
                          ? form.translateProvider
                          : litClassicProvider
                      }
                      groups={[
                        {
                          label: "翻译引擎（可用优先）",
                          options: litClassicEngines.map((p) => {
                            const meta = engineStatusMeta(engineKeys, p.id);
                            return {
                              value: p.id,
                              title: p.label,
                              status: meta.status,
                              statusText: meta.statusText,
                            };
                          }),
                        },
                      ]}
                      onChange={(id) => {
                        const nextId = id as TranslateProvider;
                        setLitClassicProvider(nextId);
                        const next = { ...form, translateProvider: nextId };
                        formRef.current = next;
                        setForm(next);
                        autoSaveTab(next);
                      }}
                    />
                    {selectedEngine && (
                      <p className="engine-hint settings-engine-side-hint">
                        {selectedEngine.hint}
                      </p>
                    )}
                  </div>
                </div>
              </ModePanel>

              <ModePanel
                enabled={litUsesLlm}
                onSelect={() =>
                  commitForm(
                    { ...form, translateProvider: "llm" },
                    true,
                    "**文献翻译** 翻译方式已切换为 **大模型**",
                  )
                }
              >
                <ModeSectionHead
                  title="大模型翻译"
                  enabled={litUsesLlm}
                  testing={isTesting("litLlm")}
                  onTest={() => void runTest("litLlm")}
                />
                {testMsg.litLlm && (
                  <p
                    className={
                      testMsg.litLlm.ok
                        ? "settings-test-ok"
                        : "settings-test-fail"
                    }
                  >
                    {testMsg.litLlm.message}
                  </p>
                )}
                <p className="hint">
                  使用「通用」中已配置的厂商凭证。先选厂商，再选文献翻译所用模型。
                </p>
                <FeatureModelSelect
                  value={form.translateModel || form.model}
                  customModels={customModels}
                  isConfigured={modelConfigured}
                  presets={activePresets}
                  onChange={(model) => {
                    const next = {
                      ...form,
                      translateModel: model,
                      translateProvider: "llm" as const,
                    };
                    formRef.current = next;
                    setForm(next);
                    autoSaveTab(next);
                  }}
                />
                {litUsesLlm ? (
                  <div
                    className="settings-mode-llm-extra"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="settings-field">
                      <span className="settings-field-label">
                        上下文段落数（0=关闭）
                      </span>
                      <p className="hint">
                        将本次阅读中已翻译的前 N
                        段原文与译文一并发送，便于术语与文风衔接。切换文档后会清空历史。
                      </p>
                      <div className="settings-row settings-row-controls">
                        <MaxLengthInput
                          value={form.translateContextParagraphs}
                          min={0}
                          max={20}
                          onCommit={(n) => {
                            const next = {
                              ...form,
                              translateContextParagraphs: n,
                            };
                            formRef.current = next;
                            setForm(next);
                          }}
                        />
                      </div>
                    </div>
                    <ReplaceTable
                      title="文献术语表"
                      hint="注入大模型提示词，保证整篇文档专有名词译法一致。与「文本翻译」术语表相互独立。"
                      showInfo
                      showEnabled
                      rows={litGlossaryRows}
                      onChange={(rows) => {
                        const next = {
                          ...form,
                          translateGlossary: stringifyRules(rows),
                        };
                        formRef.current = next;
                        setForm(next);
                        if (rows.length !== litGlossaryRows.length) {
                          autoSaveTab(next);
                        }
                      }}
                    />
                    <div className="settings-rule-block">
                      <div className="settings-rule-head">
                        <h3>文献翻译提示词</h3>
                      </div>
                      <p className="hint">
                        选择类型即可切换；修改内容后需点「保存」，自定义需填写标题后点「新增」。文献页工具栏「提示词」按钮可同样管理。
                      </p>
                      <LiteraturePromptPanel
                        catalog={
                          resolveLiteraturePromptState({
                            catalogRaw: form.translatePromptCatalog,
                            activeIdRaw: form.translatePromptId,
                            legacyKind: form.translatePromptKind,
                            legacyPrompt: form.translatePrompt,
                          }).catalog
                        }
                        activeId={
                          resolveLiteraturePromptState({
                            catalogRaw: form.translatePromptCatalog,
                            activeIdRaw: form.translatePromptId,
                            legacyKind: form.translatePromptKind,
                            legacyPrompt: form.translatePrompt,
                          }).activeId
                        }
                        onCommit={({ catalog, activeId }) => {
                          const prompt =
                            catalog.find((c) => c.id === activeId)?.prompt ||
                            DEFAULT_LIT_PROMPT_GENERAL;
                          commitForm(
                            {
                              ...form,
                              translatePromptCatalog:
                                stringifyLiteraturePromptCatalog(catalog),
                              translatePromptId: activeId,
                              translatePromptKind: activeId,
                              translatePrompt: prompt,
                            },
                            true,
                            null,
                          );
                        }}
                      />
                    </div>
                  </div>
                ) : null}
              </ModePanel>
              </div>
            </section>
          </>
        )}

        {tab === "image" && (
          <>
            <section className="settings-card">
              <h2>图片文字识别</h2>
              <p className="hint">
                在此选择识别语言与长度；下方点击区块选用「翻译引擎」或「大模型翻译」。API /
                代理请在「通用」配置。
              </p>
              <div className="settings-row settings-row-half">
                <label className="settings-half">
                  OCR 识别语言
                  <select
                    value={form.ocrLang}
                    onChange={(e) => setOcrRecognizeLang(e.target.value)}
                  >
                    <option value="eng">英语 (eng)</option>
                    <option value="chi_sim">简体中文 (chi_sim)</option>
                    <option value="chi_tra">繁体中文 (chi_tra)</option>
                    <option value="eng+chi_sim">英语 + 简体中文</option>
                    <option value="jpn">日语 (jpn)</option>
                    <option value="kor">韩语 (kor)</option>
                  </select>
                </label>
                <div className="settings-half">
                  <LangCombobox
                    label="目标语言"
                    value={form.ocrTranslateTarget}
                    onChange={setOcrTarget}
                  />
                </div>
              </div>
              <div className="settings-field">
                <span className="settings-field-label">
                  每次翻译最大长度（字符，0=
                  {ocrUsesLlm
                    ? "不限制"
                    : selectedOcrEngine?.defaultMaxChars
                      ? `引擎默认≈${selectedOcrEngine.defaultMaxChars}`
                      : "引擎默认"}
                  ）
                </span>
                <div className="settings-row settings-row-ocr-opts settings-row-controls">
                  <MaxLengthInput
                    value={form.ocrTranslateMaxLength}
                    onCommit={(n) => {
                      const next = { ...form, ocrTranslateMaxLength: n };
                      formRef.current = next;
                      setForm(next);
                    }}
                  />
                  {showOcrChunkOption ? (
                    <SettingToggle
                      checked={form.ocrTranslateAutoChunk}
                      onChange={(v) =>
                        commitForm({ ...form, ocrTranslateAutoChunk: v })
                      }
                      label="超过最大长度时自动分段并拼接"
                    />
                  ) : (
                    <div />
                  )}
                  <SettingToggle
                    checked={form.ocrAutoTranslate}
                    onChange={(v) =>
                      commitForm({ ...form, ocrAutoTranslate: v })
                    }
                    label="识别后自动翻译并叠字显示"
                  />
                </div>
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                当前图片翻译方式：
                <strong>
                  {ocrUsesLlm
                    ? `大模型（${form.ocrTranslateModel || form.model || "未选模型"}）`
                    : selectedOcrEngine?.label || form.ocrTranslateProvider}
                </strong>
              </p>
              <p className="hint">
                识别语言同时作为翻译源语言；与文献翻译的引擎配置相互独立。
              </p>
            </section>

            <section className="settings-card">
              <div className="settings-mode-choice">
                <div className="settings-mode-choice-head">
                  <h2>翻译方式</h2>
                  <p className="hint">
                    二选一：点击下方选项切换。凭证在「通用」配置，此处选择具体引擎或模型。
                  </p>
                </div>

              <ModePanel
                enabled={!ocrUsesLlm}
                onSelect={() => {
                  const classic =
                    form.ocrTranslateProvider !== "llm"
                      ? form.ocrTranslateProvider
                      : ocrClassicProvider;
                  setOcrClassicProvider(classic);
                  commitForm(
                    { ...form, ocrTranslateProvider: classic },
                    true,
                    "**图片识别** 翻译方式已切换为 **翻译引擎**",
                  );
                }}
              >
                <ModeSectionHead
                  title="翻译引擎"
                  enabled={!ocrUsesLlm}
                  testing={isTesting("ocr")}
                  onTest={() => void runTest("ocr")}
                />
                {testMsg.ocr && (
                  <p
                    className={
                      testMsg.ocr.ok
                        ? "settings-test-ok"
                        : "settings-test-fail"
                    }
                  >
                    {testMsg.ocr.message}
                  </p>
                )}
                <p className="hint">
                  使用在线翻译引擎。引擎凭证请在「通用 → 翻译引擎」中配置。
                </p>
                <div className="settings-field">
                  <span className="settings-field-label">选择引擎</span>
                  <div className="settings-engine-row">
                    <StatusSelect
                      className="settings-engine-status-select"
                      value={
                        form.ocrTranslateProvider !== "llm"
                          ? form.ocrTranslateProvider
                          : ocrClassicProvider
                      }
                      groups={[
                        {
                          label: "翻译引擎（可用优先）",
                          options: ocrClassicEngines.map((p) => {
                            const meta = engineStatusMeta(engineKeys, p.id);
                            return {
                              value: p.id,
                              title: p.label,
                              status: meta.status,
                              statusText: meta.statusText,
                            };
                          }),
                        },
                      ]}
                      onChange={(id) => {
                        const nextId = id as TranslateProvider;
                        setOcrClassicProvider(nextId);
                        const next = { ...form, ocrTranslateProvider: nextId };
                        formRef.current = next;
                        setForm(next);
                        autoSaveTab(next);
                      }}
                    />
                    {selectedOcrEngine && (
                      <p className="engine-hint settings-engine-side-hint">
                        {selectedOcrEngine.hint}
                      </p>
                    )}
                  </div>
                </div>
              </ModePanel>

              <ModePanel
                enabled={ocrUsesLlm}
                onSelect={() =>
                  commitForm(
                    { ...form, ocrTranslateProvider: "llm" },
                    true,
                    "**图片识别** 翻译方式已切换为 **大模型**",
                  )
                }
              >
                <ModeSectionHead
                  title="大模型翻译"
                  enabled={ocrUsesLlm}
                  testing={isTesting("ocrLlm")}
                  onTest={() => void runTest("ocrLlm")}
                />
                {testMsg.ocrLlm && (
                  <p
                    className={
                      testMsg.ocrLlm.ok
                        ? "settings-test-ok"
                        : "settings-test-fail"
                    }
                  >
                    {testMsg.ocrLlm.message}
                  </p>
                )}
                <p className="hint">
                  使用「通用」中已配置的厂商凭证。先选厂商，再选图片翻译所用模型。
                </p>
                <FeatureModelSelect
                  value={form.ocrTranslateModel || form.model}
                  customModels={customModels}
                  isConfigured={modelConfigured}
                  presets={activePresets}
                  onChange={(model) => {
                    const next = {
                      ...form,
                      ocrTranslateModel: model,
                      ocrTranslateProvider: "llm" as const,
                    };
                    formRef.current = next;
                    setForm(next);
                    autoSaveTab(next);
                  }}
                />
              </ModePanel>
              </div>
            </section>
          </>
        )}

        {tab === "text" && (
          <>
            <section className="settings-card">
              <h2>保存路径</h2>
              <p className="hint">
                新建/保存工程会写入此目录；「打开工程列表」也扫描此目录。每个工程一个子文件夹，内含{" "}
                <code>{PROJECT_FILENAME}</code>。
              </p>
              <label>
                工程根目录（绝对路径）
                <div className="settings-path-row">
                  <input
                    type="text"
                    value={
                      form.textProjectsDir ||
                      form.textProjectsDirResolved ||
                      (form.dataDir
                        ? `${form.dataDir}\\text-projects`
                        : "")
                    }
                    onChange={(e) =>
                      setForm({ ...form, textProjectsDir: e.target.value })
                    }
                  />
                  <button
                    type="button"
                    className="settings-path-browse"
                    onClick={() => {
                      void (async () => {
                        const current =
                          formRef.current.textProjectsDir.trim() ||
                          formRef.current.textProjectsDirResolved ||
                          (formRef.current.dataDir
                            ? `${formRef.current.dataDir}\\text-projects`
                            : undefined);
                        try {
                          const selected = await openDialog({
                            directory: true,
                            multiple: false,
                            title: "选择工程保存路径",
                            defaultPath: current || undefined,
                          });
                          if (typeof selected !== "string" || !selected) return;
                          commitForm(
                            {
                              ...formRef.current,
                              textProjectsDir: selected,
                            },
                            true,
                            "保存路径已更新",
                          );
                        } catch (e) {
                          window.alert(
                            toFriendlyError(e, "无法打开目录选择对话框"),
                          );
                        }
                      })();
                    }}
                  >
                    浏览
                  </button>
                </div>
              </label>
            </section>

            <section className="settings-card">
              <h2>文本翻译</h2>
              <p className="hint">
                在此选择语言；下方点击区块选用「翻译引擎」或「大模型翻译」。API /
                代理请在「通用」配置。
              </p>
              <div className="settings-row settings-row-half">
                <div className="settings-half">
                  <LangCombobox
                    label="源语言"
                    value={form.textTranslateSource}
                    onChange={(code) => setTextLang("source", code)}
                  />
                </div>
                <div className="settings-half">
                  <LangCombobox
                    label="目标语言"
                    value={form.textTranslateTarget}
                    onChange={(code) => setTextLang("target", code)}
                  />
                </div>
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                当前文本翻译方式：
                <strong>
                  {textUsesLlm
                    ? `大模型（${form.textTranslateModel || form.model || "未选模型"}）`
                    : selectedTextEngine?.label || form.textTranslateProvider}
                </strong>
              </p>
            </section>

            <section className="settings-card">
              <div className="settings-mode-choice">
                <div className="settings-mode-choice-head">
                  <h2>翻译方式</h2>
                  <p className="hint">
                    二选一：点击下方选项切换。凭证在「通用」配置，此处选择具体引擎或模型。
                  </p>
                </div>

              <ModePanel
                enabled={!textUsesLlm}
                onSelect={() => {
                  const classic =
                    form.textTranslateProvider !== "llm"
                      ? form.textTranslateProvider
                      : textClassicProvider;
                  setTextClassicProvider(classic);
                  commitForm(
                    { ...form, textTranslateProvider: classic },
                    true,
                    "**文本翻译** 翻译方式已切换为 **翻译引擎**",
                  );
                }}
              >
                <ModeSectionHead
                  title="翻译引擎"
                  enabled={!textUsesLlm}
                  testing={isTesting("text")}
                  onTest={() => void runTest("text")}
                />
                {testMsg.text && (
                  <p
                    className={
                      testMsg.text.ok
                        ? "settings-test-ok"
                        : "settings-test-fail"
                    }
                  >
                    {testMsg.text.message}
                  </p>
                )}
                <p className="hint">
                  使用在线翻译引擎。引擎凭证请在「通用 → 翻译引擎」中配置。
                </p>
                <div className="settings-field">
                  <span className="settings-field-label">选择引擎</span>
                  <div className="settings-engine-row">
                    <StatusSelect
                      className="settings-engine-status-select"
                      value={
                        form.textTranslateProvider !== "llm"
                          ? form.textTranslateProvider
                          : textClassicProvider
                      }
                      groups={[
                        {
                          label: "翻译引擎（可用优先）",
                          options: textClassicEngines.map((p) => {
                            const meta = engineStatusMeta(engineKeys, p.id);
                            return {
                              value: p.id,
                              title: p.label,
                              status: meta.status,
                              statusText: meta.statusText,
                            };
                          }),
                        },
                      ]}
                      onChange={(id) => {
                        const nextId = id as TranslateProvider;
                        setTextClassicProvider(nextId);
                        const next = { ...form, textTranslateProvider: nextId };
                        formRef.current = next;
                        setForm(next);
                        autoSaveTab(next);
                      }}
                    />
                    {selectedTextEngine && (
                      <p className="engine-hint settings-engine-side-hint">
                        {selectedTextEngine.hint}
                      </p>
                    )}
                  </div>
                </div>
              </ModePanel>

              <ModePanel
                enabled={textUsesLlm}
                onSelect={() =>
                  commitForm(
                    { ...form, textTranslateProvider: "llm" },
                    true,
                    "**文本翻译** 翻译方式已切换为 **大模型**",
                  )
                }
              >
                <ModeSectionHead
                  title="大模型翻译"
                  enabled={textUsesLlm}
                  testing={isTesting("textLlm")}
                  onTest={() => void runTest("textLlm")}
                />
                {testMsg.textLlm && (
                  <p
                    className={
                      testMsg.textLlm.ok
                        ? "settings-test-ok"
                        : "settings-test-fail"
                    }
                  >
                    {testMsg.textLlm.message}
                  </p>
                )}
                <p className="hint">
                  使用「通用」中已配置的厂商凭证。先选厂商，再选文本翻译所用模型。各场景提示词请在下方「翻译提示词」中配置。
                </p>
                <FeatureModelSelect
                  value={form.textTranslateModel || form.model}
                  customModels={customModels}
                  isConfigured={modelConfigured}
                  presets={activePresets}
                  onChange={(model) => {
                    const next = {
                      ...form,
                      textTranslateModel: model,
                      textTranslateProvider: "llm" as const,
                    };
                    formRef.current = next;
                    setForm(next);
                    autoSaveTab(next);
                  }}
                />
              </ModePanel>
              </div>
            </section>

            <section className="settings-card">
              <h2>翻译提示词</h2>
              <p className="hint">
                按导入场景分别配置系统提示词。新建工程时会写入对应场景；字幕开启「重组时间轴」后使用重组专用提示词。
              </p>
              {(() => {
                const promptItems = [
                  {
                    id: "plain" as const,
                    key: "textTranslatePrompt" as const,
                    title: "纯文本",
                    hint: "用于 .txt 等普通文本分段翻译。",
                    fallback: DEFAULT_TEXT_PROMPT,
                  },
                  {
                    id: "mtool" as const,
                    key: "textPromptMtool" as const,
                    title: "MTool",
                    hint: "用于 JSON 字串表；请强调占位符与转义符原样保留。",
                    fallback: DEFAULT_MTOOL_PROMPT,
                  },
                  {
                    id: "subtitle" as const,
                    key: "textPromptSubtitle" as const,
                    title: "字幕（不重组）",
                    hint: "用于 SRT/ASS 按原时间轴翻译（可能含 ASR 碎句/多行并译）。",
                    fallback: DEFAULT_SUBTITLE_PROMPT,
                  },
                  {
                    id: "subtitleRetime" as const,
                    key: "textPromptSubtitleRetime" as const,
                    title: "字幕（重组后）",
                    hint: "用于已完成时间轴重组、每行已是完整句子后的字幕翻译。",
                    fallback: DEFAULT_SUBTITLE_RETIME_TRANSLATE_PROMPT,
                  },
                ];
                const active =
                  promptItems.find((item) => item.id === promptTab) ||
                  promptItems[0];
                return (
                  <>
                    <div className="settings-subtabs" role="tablist">
                      {promptItems.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          role="tab"
                          aria-selected={promptTab === item.id}
                          className={
                            "settings-subtab" +
                            (promptTab === item.id ? " active" : "")
                          }
                          onClick={() => setPromptTab(item.id)}
                        >
                          {item.title}
                        </button>
                      ))}
                    </div>
                    <div className="settings-subtab-panel" role="tabpanel">
                      <div className="settings-subtab-panel-head">
                        <p className="hint">{active.hint}</p>
                        <button
                          type="button"
                          className="settings-test-btn"
                          onClick={() =>
                            commitForm({
                              ...form,
                              [active.key]: active.fallback,
                            })
                          }
                        >
                          恢复默认
                        </button>
                      </div>
                      <textarea
                        className="settings-prompt"
                        rows={7}
                        value={form[active.key]}
                        onChange={(e) => {
                          const next = {
                            ...form,
                            [active.key]: e.target.value,
                          };
                          formRef.current = next;
                          setForm(next);
                        }}
                      />
                    </div>
                  </>
                );
              })()}
            </section>

            <ReplaceTable
              title="术语表"
              hint="翻译时注入大模型提示，保证专有名词一致。"
              showInfo
              rows={glossaryRows}
              onChange={(rows) => {
                const next = {
                  ...form,
                  textGlossary: stringifyRules(
                    rows.filter((r) => r.src.trim() || r.dst.trim()),
                  ),
                };
                formRef.current = next;
                setForm(next);
                if (rows.length !== glossaryRows.length) autoSaveTab(next);
              }}
            />
            <ReplaceTable
              title="译前替换"
              hint="翻译前对原文做精确替换（按词长优先）。"
              rows={preRows}
              onChange={(rows) => {
                const next = {
                  ...form,
                  textPreReplace: stringifyRules(
                    rows.filter((r) => r.src.trim() || r.dst.trim()),
                  ),
                };
                formRef.current = next;
                setForm(next);
                if (rows.length !== preRows.length) autoSaveTab(next);
              }}
            />
            <ReplaceTable
              title="译后替换"
              hint="翻译完成后对译文做精确替换。"
              rows={postRows}
              onChange={(rows) => {
                const next = {
                  ...form,
                  textPostReplace: stringifyRules(
                    rows.filter((r) => r.src.trim() || r.dst.trim()),
                  ),
                };
                formRef.current = next;
                setForm(next);
                if (rows.length !== postRows.length) autoSaveTab(next);
              }}
            />
          </>
        )}
        {tab === "unity" && (
          <UnitySettingsPanel
            ref={unityPanelRef}
            active={tab === "unity"}
            notify={notify}
            onTargetChange={setUnityTarget}
          />
        )}
        {tab === "pricing" && (
          <PricingPanel
            ref={pricingPanelRef}
            active={tab === "pricing"}
            notify={notify}
            onDirtyChange={setPricingDirty}
          />
        )}
      </div>

      <div className="settings-save-bar">
        <div className="settings-save-bar-text">
          <strong>保存当前页</strong>
          <span>
            {tab === "unity"
              ? unityTarget.hasGame
                ? "写入当前游戏 Config.ini，并同步更新通用模板。"
                : "当前无选中游戏：保存为通用 AutoTranslator 模板（各游戏格式相同）。"
              : tab === "pricing"
                ? "保存模型单价与日期区间到 pricing.json；统计页按事件日期估算费用。"
                : `仅保存「${TAB_LABELS[tab]}」；下拉即时保存，输入框失焦后自动保存。`}
          </span>
        </div>
        <div className="settings-save-bar-actions">
          {TAB_NAV[tab] && onNavigate ? (
            <button
              type="button"
              className="settings-goto-page"
              onClick={() => onNavigate(TAB_NAV[tab]!.page)}
            >
              {TAB_NAV[tab]!.label}
            </button>
          ) : null}
          {tab === "pricing" && pricingDirty ? (
            <button
              type="button"
              className={
                "settings-discard-current" + (saving ? " is-saving" : "")
              }
              disabled={saving}
              onClick={() => void discardPricingChanges()}
            >
              取消修改
            </button>
          ) : null}
          <button
            type="button"
            className={
              "settings-save-current" + (saving ? " is-saving" : "")
            }
            disabled={
              saving || (tab === "pricing" && !pricingDirty)
            }
            title={
              tab === "pricing" && !pricingDirty
                ? "价目表无修改，无需保存"
                : undefined
            }
            onClick={() => void saveCurrentPage()}
          >
            {saving
              ? "保存中…"
              : tab === "unity"
                ? unityTarget.hasGame
                  ? "保存到当前游戏"
                  : "保存通用模板"
                : tab === "pricing"
                  ? "保存价目表"
                  : `保存「${TAB_LABELS[tab]}」设置`}
          </button>
        </div>
      </div>
    </div>
  );
}
