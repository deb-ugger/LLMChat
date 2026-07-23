import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Settings, type TranslateProvider } from "../api";
import { toFriendlyError } from "../friendlyError";
import {
  DEFAULT_TEXT_PROMPT,
  parseJsonArray,
  stringifyRules,
  type GlossaryEntry,
  type ReplaceRule,
} from "../textTranslate";
import { PROJECT_FILENAME } from "../transProject";
import { LangCombobox } from "./LangCombobox";
import {
  groupModelPresets,
  loadModelProfiles,
  MODEL_PRESETS,
  resolveModelApi,
  saveModelProfiles,
  type ModelProfile,
} from "../modelPresets";
import {
  getEngineInfo,
  sortedEngines,
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

type Props = {
  settings: Settings;
  onSave: (settings: Settings) => void | Promise<void>;
};

const CUSTOM_MODEL = "__custom__";

type SettingsTab = "general" | "chat" | "literature" | "image" | "text";

type TestResult = {
  ok: boolean;
  message: string;
};

const USAGE_LABELS = [
  "对话模型",
  "文献翻译",
  "图片文字识别",
  "文本翻译工程",
] as const;

type UsageLabel = (typeof USAGE_LABELS)[number];

function modelUsageLabels(s: Settings, model: string): UsageLabel[] {
  const out: UsageLabel[] = [];
  if (s.model === model) out.push("对话模型");
  if (s.translateProvider === "llm" && s.model === model) out.push("文献翻译");
  if (s.ocrTranslateProvider === "llm" && s.model === model) {
    out.push("图片文字识别");
  }
  if (s.textTranslateProvider === "llm" && s.model === model) {
    out.push("文本翻译工程");
  }
  return out;
}

function engineUsageLabels(s: Settings, engineId: string): UsageLabel[] {
  const out: UsageLabel[] = [];
  if (s.translateProvider === engineId) out.push("文献翻译");
  if (s.ocrTranslateProvider === engineId) out.push("图片文字识别");
  if (s.textTranslateProvider === engineId) out.push("文本翻译工程");
  return out;
}

function UsageBadges({ labels }: { labels: UsageLabel[] }) {
  if (labels.length === 0) return null;
  return (
    <>
      {labels.map((label) => (
        <em key={label} className="settings-usage-badge">
          {label}
        </em>
      ))}
    </>
  );
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
    translateMaxLength: s.translateMaxLength ?? 0,
    translateAutoChunk: s.translateAutoChunk ?? true,
    ocrLang: s.ocrLang || "eng",
    ocrAutoTranslate: s.ocrAutoTranslate ?? true,
    ocrTranslateProvider: normalizeProvider(
      s.ocrTranslateProvider || "bing",
    ),
    ocrTranslateSource: ocrLangToTranslateSource(s.ocrLang || "eng"),
    ocrTranslateTarget: s.ocrTranslateTarget || "zh-CN",
    ocrTranslateMaxLength: s.ocrTranslateMaxLength ?? 0,
    ocrTranslateAutoChunk: s.ocrTranslateAutoChunk ?? true,
    textTranslateSource: s.textTranslateSource || "en",
    textTranslateTarget: s.textTranslateTarget || "zh-CN",
    textTranslateProvider: normalizeProvider(
      s.textTranslateProvider || "llm",
    ),
    textTranslatePrompt: s.textTranslatePrompt || DEFAULT_TEXT_PROMPT,
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

function ReplaceTable({
  title,
  hint,
  rows,
  onChange,
  showInfo,
}: {
  title: string;
  hint: string;
  rows: GlossaryEntry[];
  onChange: (rows: GlossaryEntry[]) => void;
  showInfo?: boolean;
}) {
  return (
    <div className="settings-rule-block">
      <div className="settings-rule-head">
        <h3>{title}</h3>
        <button
          type="button"
          className="settings-test-btn"
          onClick={() => onChange([...rows, { src: "", dst: "", info: "" }])}
        >
          添加行
        </button>
      </div>
      <p className="hint">{hint}</p>
      {rows.length === 0 ? (
        <p className="hint">暂无条目</p>
      ) : (
        <div className="settings-rule-table">
          <div
            className={
              showInfo
                ? "settings-rule-row is-head has-info"
                : "settings-rule-row is-head"
            }
          >
            <span>原文</span>
            <span>译文</span>
            {showInfo && <span>备注</span>}
            <span />
          </div>
          {rows.map((row, i) => (
            <div
              key={i}
              className={
                showInfo
                  ? "settings-rule-row has-info"
                  : "settings-rule-row"
              }
            >
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

export function SettingsView({ settings, onSave }: Props) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [form, setForm] = useState<Settings>(() => withDefaults(settings));
  const [profiles, setProfiles] = useState<Record<string, ModelProfile>>(() =>
    loadModelProfiles(),
  );
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; ok: boolean } | null>(
    null,
  );
  const toastTimerRef = useRef<number | null>(null);
  const [customDraft, setCustomDraft] = useState("");
  const [pickingCustom, setPickingCustom] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testingTarget, setTestingTarget] = useState<string | null>(null);
  const [testMsg, setTestMsgState] = useState<{
    llm?: TestResult;
    lit?: TestResult;
    litLlm?: TestResult;
    ocr?: TestResult;
    text?: TestResult;
  }>(() => readSectionTestResults());
  const [cardTestMsg, setCardTestMsgState] = useState<
    Record<string, TestResult>
  >(() => readCardTestResults());
  const [batchProgress, setBatchProgress] = useState<string | null>(null);
  const [generalOpen, setGeneralOpen] = useState({
    proxy: true,
    llm: true,
    engine: true,
  });
  const toggleGeneral = (key: keyof typeof generalOpen) => {
    setGeneralOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  };
  const [expandedEngine, setExpandedEngine] = useState<TranslateProvider | null>(
    null,
  );
  const [panelSnap, setPanelSnap] = useState<{
    kind: "model" | "engine";
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
  const [expandedModel, setExpandedModel] = useState<string | null>(
    settings.model || null,
  );
  const prevModelRef = useRef(form.model);
  const customInputRef = useRef<HTMLInputElement>(null);

  const notify = (message: string, ok = true) => {
    setToast({ message, ok });
    setSaveMsg(message);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      setSaveMsg(null);
      toastTimerRef.current = null;
    }, 2800);
  };

  const isCardTesting = (key: string) =>
    testing === key || testingTarget === key;

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
  };

  const modelConfigured = (model: string) => {
    if (model === form.model) return !!(form.apiKey || "").trim();
    return !!(profiles[model]?.apiKey || "").trim();
  };

  const profilesWithCurrent = () => ({
    ...profiles,
    [form.model]: { apiUrl: form.apiUrl, apiKey: form.apiKey },
  });

  const credsForModel = (model: string) => {
    if (model === form.model) {
      return { apiUrl: form.apiUrl, apiKey: form.apiKey };
    }
    return resolveModelApi(model, profilesWithCurrent());
  };

  useEffect(() => {
    const next = withDefaults(settings);
    setForm(next);
    setProfiles(loadModelProfiles());
    prevModelRef.current = settings.model;
    setPickingCustom(false);
    setCustomDraft("");
    setExpandedModel(null);
    const classic =
      next.translateProvider === "llm" ? "bing" : next.translateProvider;
    setLitClassicProvider(classic);
  }, [settings]);

  const customModels = useMemo(() => {
    const presetIds = new Set(MODEL_PRESETS.map((p) => p.model));
    const fromProfiles = Object.keys(profiles).filter((m) => !presetIds.has(m));
    const extra =
      form.model &&
      !presetIds.has(form.model) &&
      !fromProfiles.includes(form.model)
        ? [form.model]
        : [];
    return [...new Set([...fromProfiles, ...extra])].sort();
  }, [form.model, profiles]);

  const ocrSource = useMemo(
    () => ocrLangToTranslateSource(form.ocrLang),
    [form.ocrLang],
  );
  const litClassicEngines = useMemo(
    () => sortedClassicEngines(form.translateSource, form.translateTarget),
    [form.translateSource, form.translateTarget],
  );
  const catalogEngines = useMemo(() => classicEngines(TRANSLATE_ENGINES), []);
  const textEngines = useMemo(
    () => sortedEngines(form.textTranslateSource, form.textTranslateTarget),
    [form.textTranslateSource, form.textTranslateTarget],
  );
  const ocrEngines = useMemo(
    () => sortedEngines(ocrSource, form.ocrTranslateTarget),
    [ocrSource, form.ocrTranslateTarget],
  );

  const selectedEngine = getEngineInfo(
    form.translateProvider === "llm"
      ? litClassicProvider
      : form.translateProvider,
  );
  const selectedTextEngine = getEngineInfo(form.textTranslateProvider);
  const selectedOcrEngine = getEngineInfo(form.ocrTranslateProvider);
  const litUsesLlm = form.translateProvider === "llm";
  const showChunkOption =
    !litUsesLlm &&
    !!selectedEngine &&
    selectedEngine.supportsChunk;
  const showOcrChunkOption =
    !!selectedOcrEngine &&
    selectedOcrEngine.id !== "llm" &&
    selectedOcrEngine.supportsChunk;

  const glossaryRows = useMemo(
    () => parseJsonArray<GlossaryEntry>(form.textGlossary, []),
    [form.textGlossary],
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
    const nextProfiles = {
      ...profiles,
      [prev]: { apiUrl: baseForm.apiUrl, apiKey: baseForm.apiKey },
    };
    if (!MODEL_PRESETS.some((p) => p.model === name) && !nextProfiles[name]) {
      nextProfiles[name] = {
        apiUrl: baseForm.apiUrl,
        apiKey: baseForm.apiKey,
      };
    }
    const resolved = resolveModelApi(name, nextProfiles);
    setProfiles(nextProfiles);
    saveModelProfiles(nextProfiles);
    prevModelRef.current = name;
    setPickingCustom(false);
    setCustomDraft("");
    const next = {
      ...baseForm,
      model: name,
      apiUrl: resolved.apiUrl,
      apiKey: resolved.apiKey,
    };
    setForm(next);
    return next;
  };

  const onModelCardClick = (model: string) => {
    if (expandedModel === model) {
      setExpandedModel(null);
      setPanelSnap(null);
      return;
    }
    const next = applyModel(model);
    setExpandedModel(model);
    setExpandedEngine(null);
    setPanelSnap({
      kind: "model",
      id: model,
      apiUrl: next.apiUrl,
      apiKey: next.apiKey,
    });
  };

  const commitCustomModel = () => {
    const name = customDraft.trim();
    if (!name) return;
    applyModel(name);
  };

  const setLitLang = (which: "source" | "target", code: string) => {
    const source = which === "source" ? code : form.translateSource;
    const target = which === "target" ? code : form.translateTarget;
    if (form.translateProvider === "llm") {
      setForm({
        ...form,
        translateSource: source,
        translateTarget: target,
      });
      return;
    }
    const best =
      sortedClassicEngines(source, target)[0]?.id ?? form.translateProvider;
    setLitClassicProvider(best);
    setForm({
      ...form,
      translateSource: source,
      translateTarget: target,
      translateProvider: best,
    });
  };

  const setOcrRecognizeLang = (ocrLang: string) => {
    const source = ocrLangToTranslateSource(ocrLang);
    const best =
      sortedEngines(source, form.ocrTranslateTarget)[0]?.id ??
      form.ocrTranslateProvider;
    setForm({
      ...form,
      ocrLang,
      ocrTranslateSource: source,
      ocrTranslateProvider: best,
    });
  };

  const setOcrTarget = (code: string) => {
    const source = ocrLangToTranslateSource(form.ocrLang);
    const best =
      sortedEngines(source, code)[0]?.id ?? form.ocrTranslateProvider;
    setForm({
      ...form,
      ocrTranslateTarget: code,
      ocrTranslateSource: source,
      ocrTranslateProvider: best,
    });
  };

  const save = async (successMsg?: string) => {
    let toSave = form;
    if (pickingCustom && customDraft.trim()) {
      toSave = applyModel(customDraft.trim(), form);
    }
    const syncedSource = ocrLangToTranslateSource(toSave.ocrLang);
    const projectsDir =
      toSave.textProjectsDir.trim() ||
      toSave.textProjectsDirResolved ||
      (toSave.dataDir ? `${toSave.dataDir}\\text-projects` : "");
    toSave = {
      ...toSave,
      ocrTranslateSource: syncedSource,
      textProjectsDir: projectsDir,
    };
    const nextProfiles = {
      ...profiles,
      [toSave.model]: { apiUrl: toSave.apiUrl, apiKey: toSave.apiKey },
    };
    setProfiles(nextProfiles);
    saveModelProfiles(nextProfiles);
    try {
      await onSave(toSave);
      setForm((f) => ({
        ...f,
        ...toSave,
        textProjectsDir:
          toSave.textProjectsDir ||
          f.textProjectsDirResolved ||
          f.textProjectsDir,
      }));
      notify(successMsg || "保存设置成功");
      return toSave;
    } catch (e) {
      notify(e instanceof Error ? e.message : "保存失败", false);
      throw e;
    }
  };

  const savePanel = async () => {
    const snapModel = expandedModel;
    const snapEngine = expandedEngine;
    const apiUrl = form.apiUrl;
    const apiKey = form.apiKey;
    const engineKeysStr = form.translateEngineKeys;
    const addingCustom = pickingCustom || snapModel === CUSTOM_MODEL;
    const customName = customDraft.trim();
    let successMsg = "保存成功";
    if (addingCustom && customName) {
      successMsg = `添加本地模型「${customName}」成功`;
    } else if (snapModel && snapModel !== CUSTOM_MODEL) {
      const label =
        MODEL_PRESETS.find((p) => p.model === snapModel)?.label || snapModel;
      successMsg = `保存模型「${label}」成功`;
    } else if (snapEngine) {
      const label = getEngineInfo(snapEngine)?.label || snapEngine;
      successMsg = `保存引擎「${label}」成功`;
    }
    try {
      await save(successMsg);
      if (snapModel && snapModel !== CUSTOM_MODEL) {
        setPanelSnap({
          kind: "model",
          id: snapModel,
          apiUrl,
          apiKey,
        });
      } else if (addingCustom && customName) {
        setExpandedModel(customName);
        setPickingCustom(false);
        setCustomDraft("");
        setPanelSnap({
          kind: "model",
          id: customName,
          apiUrl,
          apiKey,
        });
      } else if (snapEngine) {
        const keys = parseEngineKeys(engineKeysStr);
        setPanelSnap({
          kind: "engine",
          id: snapEngine,
          engineRow: { ...(keys[snapEngine] || {}) },
        });
      }
    } catch {
      // notify already shown
    }
  };

  const cancelPanel = () => {
    if (!panelSnap) {
      setExpandedEngine(null);
      setExpandedModel(null);
      setPickingCustom(false);
      return;
    }
    if (panelSnap.kind === "model") {
      const nextProfiles = {
        ...profiles,
        [panelSnap.id]: {
          apiUrl: panelSnap.apiUrl || "",
          apiKey: panelSnap.apiKey || "",
        },
      };
      setProfiles(nextProfiles);
      saveModelProfiles(nextProfiles);
      if (form.model === panelSnap.id) {
        setForm({
          ...form,
          apiUrl: panelSnap.apiUrl || "",
          apiKey: panelSnap.apiKey || "",
        });
      }
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
    const presetIds = new Set(MODEL_PRESETS.map((p) => p.model));
    if (presetIds.has(model)) return;

    const nextProfiles = { ...profiles };
    delete nextProfiles[model];

    let nextForm = { ...form };
    if (form.model === model) {
      const fallback =
        MODEL_PRESETS[0]?.model ||
        Object.keys(nextProfiles).find((m) => !presetIds.has(m)) ||
        MODEL_PRESETS[0]?.model ||
        "";
      const resolved = resolveModelApi(fallback, nextProfiles);
      nextForm = {
        ...form,
        model: fallback,
        apiUrl: resolved.apiUrl,
        apiKey: resolved.apiKey,
      };
      prevModelRef.current = fallback;
    }

    setProfiles(nextProfiles);
    saveModelProfiles(nextProfiles);
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
    const list = sortedEngines(source, target);
    const keep = list.some((e) => e.id === form.textTranslateProvider)
      ? form.textTranslateProvider
      : ((list.find((e) => e.id === "llm")?.id ||
          list[0]?.id ||
          "llm") as TranslateProvider);
    setForm({
      ...form,
      textTranslateSource: source,
      textTranslateTarget: target,
      textTranslateProvider: keep,
    });
  };

  const runTest = async (kind: "llm" | "lit" | "litLlm" | "ocr" | "text") => {
    setTesting(kind);
    setBatchProgress(null);
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
        const res = await api.translate("Hello", { signal: ac.signal }, {
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
        if (!nextForm.apiUrl.trim()) {
          throw new Error("请先在「通用」填写 API URL");
        }
        const res = await api.translate("Hello", { signal: ac.signal }, {
          provider: "llm",
          source: nextForm.translateSource,
          target: nextForm.translateTarget,
          maxLength: nextForm.translateMaxLength || 200,
          autoChunk: false,
          apiUrl: nextForm.apiUrl,
          apiKey: nextForm.apiKey,
          model: nextForm.model,
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
        const res = await api.translate("ping", { signal: ac.signal }, {
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
      } else if (kind === "text") {
        const provider = form.textTranslateProvider || "llm";
        if (provider === "llm" && !form.apiUrl.trim()) {
          throw new Error("请先在「通用」填写 API URL");
        }
        const res = await api.translate("Hello", { signal: ac.signal }, {
          provider,
          source: form.textTranslateSource,
          target: form.textTranslateTarget,
          maxLength: 200,
          autoChunk: true,
          ...(provider === "llm"
            ? {
                apiUrl: form.apiUrl,
                apiKey: form.apiKey,
                model: form.model,
                prompt: form.textTranslatePrompt,
              }
            : {}),
        });
        if (!(res.translation || "").trim()) {
          throw new Error("引擎返回空译文");
        }
      } else if (kind === "ocr") {
        const res = await api.translate("Hello", { signal: ac.signal }, {
          provider: form.ocrTranslateProvider,
          source: ocrLangToTranslateSource(form.ocrLang),
          target: form.ocrTranslateTarget,
          maxLength: form.ocrTranslateMaxLength || 200,
          autoChunk: form.ocrTranslateAutoChunk,
          ...(form.ocrTranslateProvider === "llm"
            ? {
                apiUrl: form.apiUrl,
                apiKey: form.apiKey,
                model: form.model,
              }
            : {}),
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
        kind === "llm" || kind === "litLlm"
          ? "llm"
          : kind === "lit"
            ? form.translateProvider !== "llm"
              ? form.translateProvider
              : litClassicProvider
            : kind === "text"
              ? form.textTranslateProvider
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
      setTesting(null);
      setTestingTarget(null);
      setBatchProgress(null);
    }
  };

  const testOneModel = async (model: string) => {
    const key = `model:${model}`;
    setTesting(key);
    setTestingTarget(key);
    setCardTestMsg((m) => {
      const next = { ...m };
      delete next[key];
      return next;
    });
    const t0 = performance.now();
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), 15000);
    try {
      await onSave(form);
      const creds = credsForModel(model);
      if (!creds.apiUrl.trim()) {
        throw new Error("请先填写 API URL");
      }
      const res = await api.translate("ping", { signal: ac.signal }, {
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
      setTesting(null);
      setTestingTarget(null);
    }
  };

  const testAllModels = async () => {
    setTesting("llm-all");
    setTestingTarget(null);
    setTestMsg((m) => ({ ...m, llm: undefined }));
    const models = [
      ...MODEL_PRESETS.map((p) => p.model),
      ...customModels,
    ];
    let ok = 0;
    let fail = 0;
    await onSave(form);
    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      const key = `model:${model}`;
      setTestingTarget(key);
      setBatchProgress(`${i + 1}/${models.length}`);
      const t0 = performance.now();
      const ac = new AbortController();
      const timer = window.setTimeout(() => ac.abort(), 12000);
      try {
        const creds = credsForModel(model);
        if (!creds.apiUrl.trim()) {
          throw new Error("未填写 API URL");
        }
        const res = await api.translate("ping", { signal: ac.signal }, {
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
          [key]: { ok: true, message: `连接正常 · ${ms} ms` },
        }));
        ok += 1;
      } catch (e) {
        const ms = Math.round(performance.now() - t0);
        const msg = ac.signal.aborted
          ? "连接超时"
          : toFriendlyError(e, "失败");
        setCardTestMsg((m) => ({
          ...m,
          [key]: { ok: false, message: `${msg} · ${ms} ms` },
        }));
        fail += 1;
      } finally {
        window.clearTimeout(timer);
      }
    }
    setTestMsg((m) => ({
      ...m,
      llm: {
        ok: fail === 0 && ok > 0,
        message: `全部测试完成：成功 ${ok}，失败 ${fail}`,
      },
    }));
    setTesting(null);
    setTestingTarget(null);
    setBatchProgress(null);
  };

  const testOneEngine = async (engineId: TranslateProvider) => {
    const key = `engine:${engineId}`;
    setTesting(key);
    setTestingTarget(key);
    setCardTestMsg((m) => {
      const next = { ...m };
      delete next[key];
      return next;
    });
    const t0 = performance.now();
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), 15000);
    try {
      await onSave(form);
      const res = await api.translate("Hello", { signal: ac.signal }, {
        provider: engineId,
        source: form.translateSource || "en",
        target: form.translateTarget || "zh-CN",
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
      setTesting(null);
      setTestingTarget(null);
    }
  };

  const testAllEngines = async () => {
    setTesting("engine-all");
    setTestingTarget(null);
    setTestMsg((m) => ({ ...m, lit: undefined }));
    const list = catalogEngines;
    let ok = 0;
    let fail = 0;
    await onSave(form);
    for (let i = 0; i < list.length; i++) {
      const engineId = list[i].id;
      const key = `engine:${engineId}`;
      setTestingTarget(key);
      setBatchProgress(`${i + 1}/${list.length}`);
      const t0 = performance.now();
      const ac = new AbortController();
      const timer = window.setTimeout(() => ac.abort(), 12000);
      try {
        const res = await api.translate("Hello", { signal: ac.signal }, {
          provider: engineId,
          source: form.translateSource || "en",
          target: form.translateTarget || "zh-CN",
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
      } catch (e) {
        const ms = Math.round(performance.now() - t0);
        let msg = ac.signal.aborted
          ? "连接超时"
          : toFriendlyError(e, "失败");
        if (
          engineId === "google" &&
          /timeout|proxy|googleapis|无法连接|超时|代理/i.test(msg) &&
          !/（/.test(msg)
        ) {
          msg = `${msg}（需代理）`;
        }
        setCardTestMsg((m) => ({
          ...m,
          [key]: { ok: false, message: `${msg} · ${ms} ms` },
        }));
        fail += 1;
      } finally {
        window.clearTimeout(timer);
      }
    }
    setTestMsg((m) => ({
      ...m,
      lit: {
        ok: fail === 0 && ok > 0,
        message: `全部测试完成：成功 ${ok}，失败 ${fail}`,
      },
    }));
    setTesting(null);
    setTestingTarget(null);
    setBatchProgress(null);
  };

  const modelGroups = useMemo(() => {
    const groups = groupModelPresets(MODEL_PRESETS);
    if (customModels.length > 0) {
      groups.push({
        group: "本地模型",
        models: customModels.map((m) => ({
          model: m,
          label: m,
          apiUrl: resolveModelApi(m, profilesWithCurrent()).apiUrl,
          group: "本地模型",
        })),
      });
    }
    return groups;
  }, [customModels, form.model, form.apiUrl, form.apiKey, profiles]);

  const tabs: { id: SettingsTab; label: string; priority?: boolean }[] = [
    { id: "general", label: "通用", priority: true },
    { id: "chat", label: "对话模型" },
    { id: "literature", label: "文献" },
    { id: "image", label: "图片" },
    { id: "text", label: "文本" },
  ];

  return (
    <div className="settings-page">
      {toast && (
        <div
          className={
            "settings-toast" + (toast.ok ? " is-ok" : " is-fail")
          }
          role="status"
        >
          {toast.message}
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
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.priority ? <span className="settings-tab-badge">重要</span> : null}
          </button>
        ))}
      </div>

      <div className="settings-tab-body">
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
                  disabled={!!testing}
                  onClick={() => void testAllModels()}
                >
                  {testing === "llm-all"
                    ? `测试中${batchProgress ? ` ${batchProgress}` : ""}`
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
                点击模型卡片可选中并展开填写 API；卡片旁可单独测试。对话、文献大模型翻译与文本翻译共用此处凭证。
              </p>
              <div className="settings-model-groups">
                {modelGroups.map((g) => (
                  <div key={g.group} className="settings-model-group">
                    <div className="settings-model-group-title">{g.group}</div>
                    <div className="settings-engine-catalog">
                      {g.models.map((p) => {
                        const usage = modelUsageLabels(form, p.model);
                        const selected = usage.length > 0;
                        const open = expandedModel === p.model;
                        const configured = modelConfigured(p.model);
                        const testKey = `model:${p.model}`;
                        const cardResult = cardTestMsg[testKey];
                        const busy = isCardTesting(testKey);
                        const isLocal = g.group === "本地模型";
                        return (
                          <div
                            key={p.model}
                            className={
                              "settings-engine-card" +
                              (selected ? " is-selected" : "") +
                              (open ? " is-open" : "")
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
                                  <UsageBadges labels={usage} />
                                </span>
                                <span className="settings-engine-card-hint">
                                  {p.model}
                                </span>
                              </button>
                              <button
                                type="button"
                                className="settings-card-mini-test"
                                disabled={!!testing}
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
                                    value={form.apiUrl}
                                    onChange={(e) =>
                                      setForm({
                                        ...form,
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
                                    value={form.apiKey}
                                    onChange={(e) =>
                                      setForm({
                                        ...form,
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
                                    保存
                                  </button>
                                  <button
                                    type="button"
                                    className="settings-panel-cancel"
                                    onClick={cancelPanel}
                                  >
                                    取消
                                  </button>
                                  {isLocal && (
                                    <button
                                      type="button"
                                      className="settings-panel-delete"
                                      onClick={() =>
                                        void deleteLocalModel(p.model)
                                      }
                                    >
                                      删除
                                    </button>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
                <div className="settings-model-group">
                  <div className="settings-model-group-title">新增本地模型</div>
                  <div className="settings-engine-catalog">
                    <div
                      className={
                        "settings-engine-card" +
                        (pickingCustom || expandedModel === CUSTOM_MODEL
                          ? " is-selected is-open"
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
                          setExpandedEngine(null);
                          setPanelSnap({
                            kind: "model",
                            id: form.model,
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
                              value={form.apiUrl}
                              onChange={(e) =>
                                setForm({ ...form, apiUrl: e.target.value })
                              }
                              placeholder="该模型对应的接口地址"
                              autoComplete="off"
                            />
                          </label>
                          <label className="settings-engine-field">
                            API Key
                            <input
                              type="password"
                              value={form.apiKey}
                              onChange={(e) =>
                                setForm({ ...form, apiKey: e.target.value })
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
                  disabled={!!testing}
                  onClick={() => void testAllEngines()}
                >
                  {testing === "engine-all"
                    ? `测试中${batchProgress ? ` ${batchProgress}` : ""}`
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
                在此配置各在线翻译引擎本身（凭证等）。文献 / 图片 / 文本等模块在各自页选择使用哪个引擎。免
                Key 引擎走上方网络代理。卡片旁可单独测试。
              </p>
              <div className="settings-engine-catalog">
                {catalogEngines.map((e) => {
                  const usage = engineUsageLabels(form, e.id);
                  const selected = usage.length > 0;
                  const open = expandedEngine === e.id;
                  const configured = engineHasCredentials(engineKeys, e.id);
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
                        (selected ? " is-selected" : "") +
                        (open ? " is-open" : "")
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
                            <UsageBadges labels={usage} />
                          </span>
                          <span className="settings-engine-card-hint">
                            {e.hint}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="settings-card-mini-test"
                          disabled={!!testing}
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
            <h2>对话模型</h2>
            <p className="hint">
              此处只选择模型；API URL / Key 请在「通用」中配置。
            </p>
            <label>
              模型
              <select
                value={
                  MODEL_PRESETS.some((p) => p.model === form.model) ||
                  customModels.includes(form.model)
                    ? form.model
                    : customModels[0] || MODEL_PRESETS[0]?.model || form.model
                }
                onChange={(e) => applyModel(e.target.value)}
              >
                <optgroup label="预设模型">
                  {MODEL_PRESETS.map((p) => (
                    <option key={p.model} value={p.model}>
                      {p.label} ({p.model})
                    </option>
                  ))}
                </optgroup>
                {customModels.length > 0 && (
                  <optgroup label="自定义模型">
                    {customModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
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
                在此选择语言与长度；下方分别配置「翻译引擎」或「大模型翻译」。API /
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
                  <input
                    type="number"
                    min={0}
                    max={50000}
                    step={50}
                    value={form.translateMaxLength}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        translateMaxLength: Math.max(
                          0,
                          Number(e.target.value) || 0,
                        ),
                      })
                    }
                  />
                  {showChunkOption ? (
                    <SettingToggle
                      checked={form.translateAutoChunk}
                      onChange={(v) =>
                        setForm({ ...form, translateAutoChunk: v })
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
                    ? `大模型（${form.model || "未选模型"}）`
                    : selectedEngine?.label || form.translateProvider}
                </strong>
              </p>
            </section>

            <section
              className={
                "settings-card" + (!litUsesLlm ? " is-mode-active" : "")
              }
            >
              <div className="settings-card-head">
                <h2>翻译引擎</h2>
                <button
                  type="button"
                  className="settings-test-btn"
                  disabled={testing === "lit"}
                  onClick={() => void runTest("lit")}
                >
                  {testing === "lit" ? "测试中" : "测试连接"}
                </button>
              </div>
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
                  <select
                    className="settings-engine-select"
                    value={
                      form.translateProvider !== "llm"
                        ? form.translateProvider
                        : litClassicProvider
                    }
                    onChange={(e) => {
                      const id = e.target.value as TranslateProvider;
                      setLitClassicProvider(id);
                      setForm({
                        ...form,
                        translateProvider: id,
                      });
                    }}
                  >
                    {litClassicEngines.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  {selectedEngine && (
                    <p className="engine-hint settings-engine-side-hint">
                      {selectedEngine.hint}
                    </p>
                  )}
                </div>
              </div>
            </section>

            <section
              className={
                "settings-card" + (litUsesLlm ? " is-mode-active" : "")
              }
            >
              <div className="settings-card-head">
                <h2>大模型翻译</h2>
                <button
                  type="button"
                  className="settings-test-btn"
                  disabled={testing === "litLlm"}
                  onClick={() => void runTest("litLlm")}
                >
                  {testing === "litLlm" ? "测试中" : "测试连接"}
                </button>
              </div>
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
                使用「通用」中配置的大模型 API，适合长文与术语。点「测试连接」将同时设为文献翻译方式。
              </p>
              <div className="settings-row settings-row-half">
                <label className="settings-half">
                  当前模型
                  <input
                    type="text"
                    value={form.model || ""}
                    readOnly
                    disabled
                  />
                </label>
                <label className="settings-half">
                  API URL
                  <input
                    type="text"
                    value={form.apiUrl || "（未配置）"}
                    readOnly
                    disabled
                  />
                </label>
              </div>
              <button
                type="button"
                className="settings-test-btn"
                style={{ alignSelf: "flex-start" }}
                onClick={() =>
                  setForm({ ...form, translateProvider: "llm" })
                }
              >
                设为文献翻译方式
              </button>
            </section>
          </>
        )}

        {tab === "image" && (
          <section className="settings-card">
            <div className="settings-card-head">
              <h2>图片文字识别</h2>
              <button
                type="button"
                className="settings-test-btn"
                disabled={testing === "ocr"}
                onClick={() => void runTest("ocr")}
              >
                {testing === "ocr" ? "测试中" : "测试连接"}
              </button>
            </div>
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
              此处选择识别语言与引擎；API / 代理请在「通用」配置。
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
              <span className="settings-field-label">翻译引擎</span>
              <div className="settings-engine-row">
                <select
                  className="settings-engine-select"
                  value={form.ocrTranslateProvider}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      ocrTranslateProvider: e.target
                        .value as TranslateProvider,
                    })
                  }
                >
                  {ocrEngines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                {selectedOcrEngine && (
                  <p className="engine-hint settings-engine-side-hint">
                    {selectedOcrEngine.hint}
                  </p>
                )}
              </div>
            </div>
            <div className="settings-field">
              <span className="settings-field-label">
                每次翻译最大长度（字符，0=引擎默认
                {selectedOcrEngine?.defaultMaxChars
                  ? `≈${selectedOcrEngine.defaultMaxChars}`
                  : ""}
                ）
              </span>
              <div className="settings-row settings-row-ocr-opts settings-row-controls">
                <input
                  type="number"
                  min={0}
                  max={50000}
                  step={50}
                  value={form.ocrTranslateMaxLength}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      ocrTranslateMaxLength: Math.max(
                        0,
                        Number(e.target.value) || 0,
                      ),
                    })
                  }
                />
                {showOcrChunkOption && (
                  <SettingToggle
                    checked={form.ocrTranslateAutoChunk}
                    onChange={(v) =>
                      setForm({ ...form, ocrTranslateAutoChunk: v })
                    }
                    label="超过最大长度时自动分段并拼接"
                  />
                )}
                <SettingToggle
                  checked={form.ocrAutoTranslate}
                  onChange={(v) =>
                    setForm({ ...form, ocrAutoTranslate: v })
                  }
                  label="识别后自动翻译并叠字显示"
                />
              </div>
            </div>
            <p className="hint">
              识别语言同时作为翻译源语言；与文献翻译的引擎配置相互独立。
            </p>
          </section>
        )}

        {tab === "text" && (
          <>
            <section className="settings-card">
              <h2>工程保存目录</h2>
              <p className="hint">
                新建/保存工程会写入此目录；每个工程一个子文件夹，内含{" "}
                <code>{PROJECT_FILENAME}</code>。
              </p>
              <label>
                工程根目录（绝对路径）
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
              </label>
            </section>

            <section className="settings-card">
              <div className="settings-card-head">
                <h2>文本翻译</h2>
                <button
                  type="button"
                  className="settings-test-btn"
                  disabled={testing === "text"}
                  onClick={() => void runTest("text")}
                >
                  {testing === "text" ? "测试中" : "测试连接"}
                </button>
              </div>
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
                可选用大模型或在线翻译引擎。API / 代理请在「通用」配置；选大模型时在下方选择具体模型。
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
              <div className="settings-field">
                <span className="settings-field-label">翻译引擎</span>
                <div className="settings-engine-row">
                  <select
                    className="settings-engine-select"
                    value={form.textTranslateProvider}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        textTranslateProvider: e.target
                          .value as TranslateProvider,
                      })
                    }
                  >
                    {textEngines.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  {selectedTextEngine && (
                    <p className="engine-hint settings-engine-side-hint">
                      {selectedTextEngine.hint}
                    </p>
                  )}
                </div>
              </div>
              {form.textTranslateProvider === "llm" && (
                <label>
                  大模型
                  <select
                    value={
                      MODEL_PRESETS.some((p) => p.model === form.model) ||
                      customModels.includes(form.model)
                        ? form.model
                        : customModels[0] ||
                          MODEL_PRESETS[0]?.model ||
                          form.model
                    }
                    onChange={(e) => applyModel(e.target.value)}
                  >
                    <optgroup label="预设模型">
                      {MODEL_PRESETS.map((p) => (
                        <option key={p.model} value={p.model}>
                          {p.label} ({p.model})
                        </option>
                      ))}
                    </optgroup>
                    {customModels.length > 0 && (
                      <optgroup label="自定义模型">
                        {customModels.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </label>
              )}
              <label>
                自定义提示词
                <textarea
                  className="settings-prompt"
                  rows={5}
                  value={form.textTranslatePrompt}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      textTranslatePrompt: e.target.value,
                    })
                  }
                  disabled={form.textTranslateProvider !== "llm"}
                />
              </label>
              <button
                type="button"
                className="settings-test-btn"
                disabled={form.textTranslateProvider !== "llm"}
                onClick={() =>
                  setForm({
                    ...form,
                    textTranslatePrompt: DEFAULT_TEXT_PROMPT,
                  })
                }
              >
                恢复默认提示词
              </button>
              {form.textTranslateProvider !== "llm" && (
                <p className="hint">提示词仅在引擎为「大模型」时生效。</p>
              )}
            </section>

            <ReplaceTable
              title="术语表"
              hint="翻译时注入大模型提示，保证专有名词一致。"
              showInfo
              rows={glossaryRows}
              onChange={(rows) =>
                setForm({
                  ...form,
                  textGlossary: stringifyRules(
                    rows.filter((r) => r.src.trim() || r.dst.trim()),
                  ),
                })
              }
            />
            <ReplaceTable
              title="译前替换"
              hint="翻译前对原文做精确替换（按词长优先）。"
              rows={preRows}
              onChange={(rows) =>
                setForm({
                  ...form,
                  textPreReplace: stringifyRules(
                    rows.filter((r) => r.src.trim() || r.dst.trim()),
                  ),
                })
              }
            />
            <ReplaceTable
              title="译后替换"
              hint="翻译完成后对译文做精确替换。"
              rows={postRows}
              onChange={(rows) =>
                setForm({
                  ...form,
                  textPostReplace: stringifyRules(
                    rows.filter((r) => r.src.trim() || r.dst.trim()),
                  ),
                })
              }
            />
          </>
        )}
      </div>

      <div className="settings-save-row">
        <button className="save-btn" onClick={() => void save()}>
          保存
        </button>
        {saveMsg && <span className="settings-saved">{saveMsg}</span>}
      </div>
    </div>
  );
}
