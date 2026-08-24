import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { api, type UnityIniSection } from "../api";
import { toFriendlyError } from "../friendlyError";
import { isBoolIniValue, setIniValue } from "../unityIni";
import {
  advancedUnityConfigSections,
  CONFIG_ENGINE_NEEDS_CREDS,
  engineConfigSections,
  engineSectionConfigured,
  fieldMeta,
  sectionMeta,
} from "../unityConfigMeta";
import {
  loadUnityConfigDraft,
  mergeUnityDraftInto,
  saveUnityConfigDraft,
} from "../unityConfigDraft";
import { lastUnityGameDir } from "../unityLastGame";

export type UnitySettingsPanelHandle = {
  save: () => Promise<void>;
};

export type UnitySettingsTarget = {
  hasGame: boolean;
  gameDir: string;
};

type Props = {
  active: boolean;
  notify: (message: string, ok?: boolean) => void;
  onTargetChange?: (target: UnitySettingsTarget) => void;
  onDirtyChange?: (dirty: boolean) => void;
};

function isSecretField(key: string) {
  const k = key.toLowerCase();
  return (
    k.includes("key") ||
    k.includes("secret") ||
    k.includes("token") ||
    k === "appsecret"
  );
}

export const UnitySettingsPanel = forwardRef<UnitySettingsPanelHandle, Props>(
  function UnitySettingsPanel(
    { active, notify, onTargetChange, onDirtyChange },
    ref,
  ) {
    const [gameDir, setGameDir] = useState(() => lastUnityGameDir());
    const [sections, setSections] = useState<UnityIniSection[]>([]);
    const [configPath, setConfigPath] = useState("");
    const [configExists, setConfigExists] = useState(false);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [expandedEngine, setExpandedEngine] = useState<string | null>(null);
    const [openAdvanced, setOpenAdvanced] = useState<Record<string, boolean>>(
      {},
    );
    const notifyRef = useRef(notify);
    const onTargetChangeRef = useRef(onTargetChange);
    const onDirtyChangeRef = useRef(onDirtyChange);
    const savedSectionsRef = useRef<UnityIniSection[]>([]);
    const loadingRef = useRef(false);
    notifyRef.current = notify;
    onTargetChangeRef.current = onTargetChange;
    onDirtyChangeRef.current = onDirtyChange;

    const setDirty = useCallback((dirty: boolean) => {
      onDirtyChangeRef.current?.(dirty);
    }, []);

    const acceptLoadedSections = useCallback(
      (next: UnityIniSection[]) => {
        savedSectionsRef.current = next;
        setSections(next);
        setDirty(false);
      },
      [setDirty],
    );

    const load = useCallback(async () => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      const dir = lastUnityGameDir();
      setGameDir(dir);
      onTargetChangeRef.current?.({ hasGame: !!dir, gameDir: dir });
      setLoading(true);
      setLoadError(null);
      try {
        const res = await api.unityGetConfig(dir || "");
        if (!res.ok) {
          const draft = loadUnityConfigDraft();
          if (draft?.length) {
            acceptLoadedSections(draft);
            setConfigPath("");
            setConfigExists(false);
            setLoadError(res.error || "读取游戏配置失败，已回退到通用模板");
            notifyRef.current(
              res.error || "读取游戏配置失败，已回退到通用模板",
              false,
            );
          } else {
            setLoadError(res.error || "读取配置失败");
            notifyRef.current(res.error || "读取配置失败", false);
          }
          return;
        }
        let next = res.sections || [];
        const draft = loadUnityConfigDraft();
        // No game, or game has no Config.ini yet → overlay shared draft keys.
        if (draft && (!dir || !res.exists)) {
          next = mergeUnityDraftInto(next, draft);
        }
        setConfigPath(res.path || "");
        setConfigExists(!!res.exists);
        acceptLoadedSections(next);
      } catch (e) {
        const msg = toFriendlyError(e, "读取配置失败");
        const draft = loadUnityConfigDraft();
        if (draft?.length) {
          acceptLoadedSections(draft);
          setConfigPath("");
          setConfigExists(false);
          setLoadError(`${msg}；已回退到通用模板`);
        } else {
          acceptLoadedSections([]);
          setLoadError(msg);
        }
        notifyRef.current(msg, false);
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    }, [acceptLoadedSections]);

    useEffect(() => {
      if (!active) return;
      void load();
    }, [active, load]);

    useImperativeHandle(
      ref,
      () => ({
        save: async () => {
          const dir = lastUnityGameDir();
          saveUnityConfigDraft(sections);
          if (!dir) {
            savedSectionsRef.current = sections;
            setDirty(false);
            notifyRef.current(
              "已保存为通用 AutoTranslator 模板（各游戏格式相同）",
            );
            return;
          }
          const res = await api.unitySaveConfig({
            path: dir,
            sections,
          });
          if (!res.ok) {
            notifyRef.current(res.error || "保存失败", false);
            throw new Error(res.error || "save failed");
          }
          setConfigPath(res.path || configPath);
          setConfigExists(true);
          savedSectionsRef.current = sections;
          setDirty(false);
          notifyRef.current("已写入当前游戏 Config.ini，并更新通用模板");
        },
      }),
      [sections, configPath, setDirty],
    );

    const engines = engineConfigSections(sections);
    const advanced = advancedUnityConfigSections(sections);

    const updateKey = (section: string, key: string, value: string) => {
      const next = setIniValue(sections, section, key, value);
      setSections(next);
      setDirty(
        JSON.stringify(next) !== JSON.stringify(savedSectionsRef.current),
      );
    };

    return (
      <>
        <div className="settings-priority-banner">
          <strong>Unity</strong>
          <span>
            AutoTranslator 各游戏 Config.ini
            格式相同。可先配置通用模板；选中游戏后保存会写入该游戏目录。
          </span>
        </div>

        <section className="settings-card">
          <div className="settings-card-head">
            <h2>{gameDir ? "当前游戏" : "通用模板"}</h2>
          </div>
          {gameDir ? (
            <>
              <p className="hint settings-unity-game-path">
                <code>{gameDir}</code>
              </p>
              {configPath ? (
                <p className="hint">
                  配置文件
                  {configExists ? "" : "（尚未生成，保存后写入）"}：
                  <code>{configPath}</code>
                </p>
              ) : null}
            </>
          ) : (
            <p className="hint">
              尚未选中游戏。当前编辑的是通用模板，保存后会记住；之后在 Unity
              页选中游戏再保存即可写入该游戏。
            </p>
          )}
          {loading ? <p className="hint">正在读取配置…</p> : null}
          {loadError && !loading ? (
            <p className="hint settings-unity-load-error">{loadError}</p>
          ) : null}
        </section>

        <section className="settings-card">
          <div className="settings-card-head">
            <h2>翻译引擎参数</h2>
          </div>
          <p className="hint">
            对应游戏内各引擎分区（Key / Url
            等）。卡片样式与「通用」中的在线引擎配置一致；展开后填写，底部统一保存。
          </p>
          <div className="settings-engine-catalog">
            {engines.map((sec) => {
              const meta = sectionMeta(sec.name);
              const open = expandedEngine === sec.name;
              const needsCreds = CONFIG_ENGINE_NEEDS_CREDS.has(sec.name);
              const configured = engineSectionConfigured(sec);
              return (
                <div
                  key={sec.name}
                  className={
                    "settings-engine-card" + (open ? " is-open" : "")
                  }
                >
                  <div className="settings-engine-card-top">
                    <button
                      type="button"
                      className="settings-engine-card-btn"
                      onClick={() =>
                        setExpandedEngine(open ? null : sec.name)
                      }
                    >
                      <span className="settings-engine-card-title">
                        {needsCreds ? (
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
                            可选参数
                          </em>
                        )}
                        <strong>{meta.label}</strong>
                      </span>
                      <span className="settings-engine-card-hint">
                        [{sec.name}] {meta.help}
                      </span>
                    </button>
                  </div>
                  {open ? (
                    <div className="settings-engine-panel">
                      {sec.keys.map((row) => {
                        const fm = fieldMeta(row.key);
                        const boolish = isBoolIniValue(row.value);
                        return (
                          <label
                            key={`${sec.name}.${row.key}`}
                            className="settings-engine-field"
                          >
                            {fm.label}
                            <code className="settings-unity-inline-key">
                              {row.key}
                            </code>
                            {boolish ? (
                              <select
                                value={
                                  row.value.trim().toLowerCase() === "true"
                                    ? "True"
                                    : "False"
                                }
                                onChange={(ev) =>
                                  updateKey(sec.name, row.key, ev.target.value)
                                }
                              >
                                <option value="True">开</option>
                                <option value="False">关</option>
                              </select>
                            ) : (
                              <input
                                type={
                                  isSecretField(row.key) ? "password" : "text"
                                }
                                value={row.value}
                                spellCheck={false}
                                placeholder={fm.help}
                                autoComplete="off"
                                onChange={(ev) =>
                                  updateKey(sec.name, row.key, ev.target.value)
                                }
                              />
                            )}
                          </label>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        {advanced.map((sec) => {
          const meta = sectionMeta(sec.name);
          const open = openAdvanced[sec.name] === true;
          return (
            <section
              key={sec.name}
              className={
                "settings-card settings-fold" + (open ? "" : " is-collapsed")
              }
            >
              <div className="settings-card-head settings-fold-head">
                <button
                  type="button"
                  className="settings-fold-toggle"
                  aria-expanded={open}
                  onClick={() =>
                    setOpenAdvanced((prev) => ({
                      ...prev,
                      [sec.name]: !open,
                    }))
                  }
                >
                  <span className="settings-fold-chevron" aria-hidden>
                    {open ? "▾" : "▸"}
                  </span>
                  <h2>{meta.label}</h2>
                  <span className="settings-unity-sec-key">[{sec.name}]</span>
                </button>
              </div>
              {open ? (
                <div className="settings-fold-body">
                  <p className="hint">{meta.help}</p>
                  <div className="settings-unity-fields">
                    {sec.keys.map((row) => {
                      const fm = fieldMeta(row.key);
                      const boolish = isBoolIniValue(row.value);
                      return (
                        <label
                          key={`${sec.name}.${row.key}`}
                          className="settings-unity-field"
                        >
                          <span className="settings-unity-field-label">
                            {fm.label}
                            <code>{row.key}</code>
                          </span>
                          {boolish ? (
                            <select
                              value={
                                row.value.trim().toLowerCase() === "true"
                                  ? "True"
                                  : "False"
                              }
                              onChange={(ev) =>
                                updateKey(sec.name, row.key, ev.target.value)
                              }
                            >
                              <option value="True">开</option>
                              <option value="False">关</option>
                            </select>
                          ) : (
                            <input
                              type="text"
                              value={row.value}
                              spellCheck={false}
                              onChange={(ev) =>
                                updateKey(sec.name, row.key, ev.target.value)
                              }
                            />
                          )}
                          {fm.help ? (
                            <span className="settings-unity-field-help">
                              {fm.help}
                            </span>
                          ) : null}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </section>
          );
        })}
      </>
    );
  },
);
