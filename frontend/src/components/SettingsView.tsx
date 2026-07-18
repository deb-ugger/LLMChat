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
  loadModelProfiles,
  MODEL_PRESETS,
  resolveModelApi,
  saveModelProfiles,
  type ModelProfile,
} from "../modelPresets";
import { getEngineInfo, sortedEngines, TRANSLATE_ENGINES } from "../translateEngines";

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
  const [customDraft, setCustomDraft] = useState("");
  const [pickingCustom, setPickingCustom] = useState(false);
  const [testing, setTesting] = useState<
    null | "llm" | "lit" | "ocr" | "text"
  >(null);
  const [testMsg, setTestMsg] = useState<{
    llm?: TestResult;
    lit?: TestResult;
    ocr?: TestResult;
    text?: TestResult;
  }>({});
  const prevModelRef = useRef(form.model);
  const customInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const next = withDefaults(settings);
    setForm(next);
    prevModelRef.current = settings.model;
    const presetIds = new Set(MODEL_PRESETS.map((p) => p.model));
    const knownCustom = Object.keys(loadModelProfiles()).filter(
      (m) => !presetIds.has(m),
    );
    const isKnown =
      presetIds.has(next.model) || knownCustom.includes(next.model);
    setPickingCustom(!isKnown);
    setCustomDraft(isKnown ? "" : next.model);
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

  const modelSelectValue = useMemo(() => {
    if (pickingCustom) return CUSTOM_MODEL;
    if (MODEL_PRESETS.some((p) => p.model === form.model)) return form.model;
    if (customModels.includes(form.model)) return form.model;
    return CUSTOM_MODEL;
  }, [customModels, form.model, pickingCustom]);

  const ocrSource = useMemo(
    () => ocrLangToTranslateSource(form.ocrLang),
    [form.ocrLang],
  );
  const engines = useMemo(
    () => sortedEngines(form.translateSource, form.translateTarget),
    [form.translateSource, form.translateTarget],
  );
  const textEngines = useMemo(
    () => sortedEngines(form.textTranslateSource, form.textTranslateTarget),
    [form.textTranslateSource, form.textTranslateTarget],
  );
  const ocrEngines = useMemo(
    () => sortedEngines(ocrSource, form.ocrTranslateTarget),
    [ocrSource, form.ocrTranslateTarget],
  );

  const selectedEngine = getEngineInfo(form.translateProvider);
  const selectedTextEngine = getEngineInfo(form.textTranslateProvider);
  const selectedOcrEngine = getEngineInfo(form.ocrTranslateProvider);
  const showChunkOption =
    !!selectedEngine &&
    selectedEngine.id !== "llm" &&
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

  const commitCustomModel = () => {
    const name = customDraft.trim();
    if (!name) return;
    applyModel(name);
  };

  const setLitLang = (which: "source" | "target", code: string) => {
    const source = which === "source" ? code : form.translateSource;
    const target = which === "target" ? code : form.translateTarget;
    const best = sortedEngines(source, target)[0]?.id ?? form.translateProvider;
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

  const save = async () => {
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
    setSaveMsg(null);
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
      setSaveMsg("已保存");
      window.setTimeout(() => setSaveMsg(null), 2500);
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "保存失败");
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

  const runTest = async (kind: "llm" | "lit" | "ocr" | "text") => {
    setTesting(kind);
    setTestMsg((m) => ({ ...m, [kind]: undefined }));
    const t0 = performance.now();
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), 15000);
    try {
      if (kind === "llm") {
        if (!form.apiUrl.trim()) {
          throw new Error("请先填写 API URL");
        }
        await api.translate("ping", { signal: ac.signal }, {
          provider: "llm",
          source: "en",
          target: "zh-CN",
          apiUrl: form.apiUrl,
          apiKey: form.apiKey,
          model: form.model,
          maxLength: 32,
          autoChunk: false,
        });
      } else if (kind === "lit") {
        await api.translate("Hello", { signal: ac.signal }, {
          provider: form.translateProvider,
          source: form.translateSource,
          target: form.translateTarget,
          maxLength: form.translateMaxLength || 200,
          autoChunk: form.translateAutoChunk,
          ...(form.translateProvider === "llm"
            ? {
                apiUrl: form.apiUrl,
                apiKey: form.apiKey,
                model: form.model,
              }
            : {}),
        });
      } else if (kind === "text") {
        const provider = form.textTranslateProvider || "llm";
        if (provider === "llm" && !form.apiUrl.trim()) {
          throw new Error("请先在「通用」填写 API URL");
        }
        await api.translate("Hello", { signal: ac.signal }, {
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
      } else {
        await api.translate("Hello", { signal: ac.signal }, {
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
        kind === "llm"
          ? "llm"
          : kind === "lit"
            ? form.translateProvider
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
    }
  };

  const tabs: { id: SettingsTab; label: string; priority?: boolean }[] = [
    { id: "general", label: "通用", priority: true },
    { id: "chat", label: "对话模型" },
    { id: "literature", label: "文献" },
    { id: "image", label: "图片" },
    { id: "text", label: "文本" },
  ];

  return (
    <div className="settings-page">
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
            <section className="settings-card">
              <h2>网络代理</h2>
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
            </section>

            <section className="settings-card">
              <div className="settings-card-head">
                <h2>大模型 API</h2>
                <button
                  type="button"
                  className="settings-test-btn"
                  disabled={testing === "llm"}
                  onClick={() => void runTest("llm")}
                >
                  {testing === "llm" ? "测试中…" : "测试连接"}
                </button>
              </div>
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
                在此配置 API；「对话模型」页只选择具体模型。「文本」翻译也使用此处凭证。
              </p>
              <div className="settings-row settings-row-half">
                <label className="settings-half">
                  当前编辑模型
                  <select
                    value={modelSelectValue}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === CUSTOM_MODEL) {
                        setPickingCustom(true);
                        setCustomDraft("");
                        window.setTimeout(
                          () => customInputRef.current?.focus(),
                          0,
                        );
                        return;
                      }
                      setPickingCustom(false);
                      setCustomDraft("");
                      applyModel(v);
                    }}
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
                    <option value={CUSTOM_MODEL}>新增自定义模型…</option>
                  </select>
                </label>
                <label className="settings-half">
                  自定义模型名
                  <input
                    ref={customInputRef}
                    value={
                      pickingCustom || modelSelectValue === CUSTOM_MODEL
                        ? customDraft
                        : customModels.includes(form.model)
                          ? form.model
                          : ""
                    }
                    onChange={(e) => {
                      setPickingCustom(true);
                      setCustomDraft(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitCustomModel();
                      }
                    }}
                    onBlur={() => {
                      if (customDraft.trim()) commitCustomModel();
                    }}
                    placeholder="输入新模型 ID，回车保存到列表"
                  />
                </label>
              </div>
              <label>
                API URL
                <input
                  value={form.apiUrl}
                  onChange={(e) =>
                    setForm({ ...form, apiUrl: e.target.value })
                  }
                  placeholder="该模型对应的接口地址"
                />
              </label>
              <label>
                API Key
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={(e) =>
                    setForm({ ...form, apiKey: e.target.value })
                  }
                  placeholder="各模型独立保存"
                />
              </label>
            </section>

            <section className="settings-card">
              <div className="settings-card-head">
                <h2>翻译引擎</h2>
                <button
                  type="button"
                  className="settings-test-btn"
                  disabled={testing === "lit"}
                  onClick={() => void runTest("lit")}
                >
                  {testing === "lit" ? "测试中…" : "测试当前引擎"}
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
                多数引擎免 Key，走上方网络代理。文献/图片页只需选择具体引擎；若选「大模型」则使用本页大模型
                API。
              </p>
              <div className="settings-engine-catalog">
                {TRANSLATE_ENGINES.filter((e) => e.id !== "free").map((e) => (
                  <div key={e.id} className="settings-engine-item">
                    <strong>{e.label}</strong>
                    <span>{e.hint}</span>
                  </div>
                ))}
              </div>
              <div className="settings-field" style={{ marginTop: 12 }}>
                <span className="settings-field-label">测试用引擎（文献默认）</span>
                <select
                  className="settings-engine-select"
                  value={form.translateProvider}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      translateProvider: e.target.value as TranslateProvider,
                    })
                  }
                >
                  {engines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
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
          <section className="settings-card">
            <div className="settings-card-head">
              <h2>文献翻译</h2>
              <button
                type="button"
                className="settings-test-btn"
                disabled={testing === "lit"}
                onClick={() => void runTest("lit")}
              >
                {testing === "lit" ? "测试中…" : "测试连接"}
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
              此处选择语言与引擎；API / 代理请在「通用」配置。
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
              <span className="settings-field-label">翻译引擎</span>
              <div className="settings-engine-row">
                <select
                  className="settings-engine-select"
                  value={form.translateProvider}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      translateProvider: e.target.value as TranslateProvider,
                    })
                  }
                >
                  {engines.map((p) => (
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
            <div className="settings-field">
              <span className="settings-field-label">
                每次翻译最大长度（字符，0=引擎默认
                {selectedEngine?.defaultMaxChars
                  ? `≈${selectedEngine.defaultMaxChars}`
                  : ""}
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
          </section>
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
                {testing === "ocr" ? "测试中…" : "测试连接"}
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
                  {testing === "text" ? "测试中…" : "测试连接"}
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
