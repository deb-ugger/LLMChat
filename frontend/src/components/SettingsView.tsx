import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Settings, type TranslateProvider } from "../api";
import { toFriendlyError } from "../friendlyError";
import { LangCombobox } from "./LangCombobox";
import {
  loadModelProfiles,
  MODEL_PRESETS,
  resolveModelApi,
  saveModelProfiles,
  type ModelProfile,
} from "../modelPresets";
import {
  getEngineInfo,
  sortedEngines,
} from "../translateEngines";

type Props = {
  settings: Settings;
  onSave: (settings: Settings) => void | Promise<void>;
};

const CUSTOM_MODEL = "__custom__";

type TestResult = {
  ok: boolean;
  message: string;
};

/** Map Tesseract OCR lang to translate source code. */
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

export function SettingsView({ settings, onSave }: Props) {
  const [form, setForm] = useState<Settings>(() => withDefaults(settings));
  const [profiles, setProfiles] = useState<Record<string, ModelProfile>>(() =>
    loadModelProfiles(),
  );
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [customDraft, setCustomDraft] = useState("");
  const [pickingCustom, setPickingCustom] = useState(false);
  const [testing, setTesting] = useState<
    null | "llm" | "lit" | "ocr"
  >(null);
  const [testMsg, setTestMsg] = useState<{
    llm?: TestResult;
    lit?: TestResult;
    ocr?: TestResult;
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
  const ocrEngines = useMemo(
    () => sortedEngines(ocrSource, form.ocrTranslateTarget),
    [ocrSource, form.ocrTranslateTarget],
  );

  const selectedEngine = getEngineInfo(form.translateProvider);
  const selectedOcrEngine = getEngineInfo(form.ocrTranslateProvider);
  const showChunkOption =
    !!selectedEngine &&
    selectedEngine.id !== "llm" &&
    selectedEngine.supportsChunk;
  const showOcrChunkOption =
    !!selectedOcrEngine &&
    selectedOcrEngine.id !== "llm" &&
    selectedOcrEngine.supportsChunk;

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
    toSave = { ...toSave, ocrTranslateSource: syncedSource };
    const nextProfiles = {
      ...profiles,
      [toSave.model]: { apiUrl: toSave.apiUrl, apiKey: toSave.apiKey },
    };
    setProfiles(nextProfiles);
    saveModelProfiles(nextProfiles);
    setSaveMsg(null);
    try {
      await onSave(toSave);
      setSaveMsg("已保存");
      window.setTimeout(() => setSaveMsg(null), 2500);
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "保存失败");
    }
  };

  const runTest = async (kind: "llm" | "lit" | "ocr") => {
    setTesting(kind);
    setTestMsg((m) => ({ ...m, [kind]: undefined }));
    const t0 = performance.now();
    const ac = new AbortController();
    // 前端总等待上限（后端 WinHTTP 单请求约 8s）
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
        msg = toFriendlyError(
          `${msg} [Google]`,
          "谷歌翻译不可用，国内常需系统代理",
        );
      }
      setTestMsg((m) => ({
        ...m,
        [kind]: {
          ok: false,
          message: `${msg} · ${ms} ms`,
        },
      }));
    } finally {
      window.clearTimeout(timer);
      setTesting(null);
    }
  };

  return (
    <div className="settings-page">
      <section className="settings-card">
        <h2>网络代理</h2>
        <p className="hint settings-engine-rank-hint">
          浏览器能上网不代表本软件走同一通道。若出现「无法解析域名」或国内引擎全挂，请先试「直连」；要用谷歌且 Clash
          已开启时，选「自定义」并填本地端口（常见 127.0.0.1:7890）。
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
          <h2>对话模型与 API</h2>
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
              testMsg.llm.ok ? "settings-test-ok" : "settings-test-fail"
            }
          >
            {testMsg.llm.message}
          </p>
        )}
        <div className="settings-row settings-row-half">
          <label className="settings-half">
            模型
            <select
              value={modelSelectValue}
              onChange={(e) => {
                const v = e.target.value;
                if (v === CUSTOM_MODEL) {
                  setPickingCustom(true);
                  setCustomDraft("");
                  window.setTimeout(() => customInputRef.current?.focus(), 0);
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
              <option value={CUSTOM_MODEL}>自定义模型…</option>
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
              placeholder="输入新模型 ID，回车或失焦后加入列表"
            />
          </label>
        </div>
        <label>
          API URL
          <input
            value={form.apiUrl}
            onChange={(e) => setForm({ ...form, apiUrl: e.target.value })}
            placeholder="切换模型会加载该模型预设或已保存的 API"
          />
        </label>
        <label>
          API Key
          <input
            type="password"
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            placeholder="各模型独立保存；无预设则为空"
          />
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
          选择「自定义模型…」并输入模型名后，会生成新选项并保留在列表中；各模型的
          API 配置独立保存。
        </p>
      </section>

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
              testMsg.lit.ok ? "settings-test-ok" : "settings-test-fail"
            }
          >
            {testMsg.lit.message}
          </p>
        )}
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
        <p className="hint settings-engine-rank-hint">
          引擎按当前源/目标语言匹配度排序。谷歌翻译在国内常需系统代理；无代理建议用
          Bing/有道。本软件会跟随 Windows 系统代理设置。
        </p>

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
                  translateMaxLength: Math.max(0, Number(e.target.value) || 0),
                })
              }
            />
            {showChunkOption ? (
              <SettingToggle
                checked={form.translateAutoChunk}
                onChange={(v) => setForm({ ...form, translateAutoChunk: v })}
                label="超过最大长度时自动分段并拼接"
              />
            ) : (
              <div />
            )}
          </div>
        </div>
        {showChunkOption && !form.translateAutoChunk && (
          <p className="hint">
            未开启自动拼接时，超长文本会在译文区提示，需在此调整最大长度或开启拼接。
          </p>
        )}
      </section>

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
              testMsg.ocr.ok ? "settings-test-ok" : "settings-test-fail"
            }
          >
            {testMsg.ocr.message}
          </p>
        )}
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
                  ocrTranslateProvider: e.target.value as TranslateProvider,
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
        <p className="hint settings-engine-rank-hint">
          引擎按识别/目标语言匹配度排序。谷歌翻译在国内常需系统代理；无代理建议用
          Bing/有道。本软件会跟随 Windows 系统代理设置。
        </p>

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
              onChange={(v) => setForm({ ...form, ocrAutoTranslate: v })}
              label="识别后自动翻译并叠字显示"
            />
          </div>
        </div>
        <p className="hint">
          识别语言同时作为翻译源语言；与文献翻译的引擎配置相互独立。
        </p>
      </section>

      <div className="settings-save-row">
        <button className="save-btn" onClick={() => void save()}>
          保存
        </button>
        {saveMsg && <span className="settings-saved">{saveMsg}</span>}
      </div>
    </div>
  );
}
