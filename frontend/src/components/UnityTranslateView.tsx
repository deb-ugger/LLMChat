import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { toFriendlyError } from "../friendlyError";

type Endpoint = { id: string; label: string; needsKey: boolean };

type DetectInfo = {
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
};

const LANG_OPTIONS = [
  { id: "zh-CN", label: "简体中文" },
  { id: "zh-TW", label: "繁体中文" },
  { id: "en", label: "英语" },
  { id: "ja", label: "日语" },
  { id: "ko", label: "韩语" },
];

const FROM_OPTIONS = [
  { id: "ja", label: "日语" },
  { id: "en", label: "英语" },
  { id: "ko", label: "韩语" },
  { id: "zh-CN", label: "简体中文" },
  { id: "auto", label: "自动检测（部分引擎）" },
];

export function UnityTranslateView() {
  const [gamePath, setGamePath] = useState("");
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [endpoint, setEndpoint] = useState("GoogleTranslate");
  const [fallback, setFallback] = useState("");
  const [language, setLanguage] = useState("zh-CN");
  const [fromLanguage, setFromLanguage] = useState("ja");
  const [detect, setDetect] = useState<DetectInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [resultNote, setResultNote] = useState<string | null>(null);

  useEffect(() => {
    void api
      .unityEndpoints()
      .then((res) => {
        setEndpoints(res.endpoints || []);
      })
      .catch(() => {
        setEndpoints([
          { id: "GoogleTranslate", label: "Google 翻译（免 Key）", needsKey: false },
          { id: "BingTranslate", label: "Bing 翻译（免 Key）", needsKey: false },
        ]);
      });
  }, []);

  const runDetect = async (path: string) => {
    const p = path.trim();
    if (!p) {
      setError("请先选择游戏目录或主程序");
      return;
    }
    setBusy(true);
    setError(null);
    setResultNote(null);
    try {
      const info = await api.unityDetect(p);
      setDetect(info);
      if (!info.ok) setError(info.error || "检测失败");
    } catch (e) {
      setDetect(null);
      setError(toFriendlyError(e, "检测失败"));
    } finally {
      setBusy(false);
    }
  };

  const browseGame = async (mode: "dir" | "exe") => {
    try {
      const selected =
        mode === "dir"
          ? await openDialog({
              directory: true,
              multiple: false,
              title: "选择 Unity 游戏目录",
            })
          : await openDialog({
              directory: false,
              multiple: false,
              title: "选择 Unity 游戏主程序",
              filters: [{ name: "游戏程序", extensions: ["exe"] }],
            });
      if (typeof selected !== "string" || !selected) return;
      setGamePath(selected);
      setDetect(null);
      setResultNote(null);
      setSteps([]);
      setError(null);
      await runDetect(selected);
    } catch (e) {
      setError(toFriendlyError(e, "无法打开选择对话框"));
    }
  };

  const onDetect = async () => {
    await runDetect(gamePath);
  };

  const openGameFolder = async () => {
    const path = detect?.gameDir || gamePath.trim();
    if (!path) return;
    try {
      await api.revealPath(path);
    } catch (e) {
      setError(toFriendlyError(e, "无法打开游戏目录"));
    }
  };

  const onInstall = async () => {
    if (!gamePath.trim()) {
      setError("请先选择游戏目录");
      return;
    }
    if (
      !window.confirm(
        "将下载并安装开源组件 XUnity.AutoTranslator 到该游戏目录，并写入翻译配置。是否继续？",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setResultNote(null);
    setSteps(["准备安装"]);
    try {
      const res = await api.unityInstall({
        path: gamePath.trim(),
        language,
        fromLanguage,
        endpoint,
        fallbackEndpoint: fallback,
        runSetup: true,
      });
      setSteps(res.steps || []);
      if (!res.ok) {
        setError(res.error || "安装失败");
        return;
      }
      setResultNote(
        `安装成功（${res.installMethod} / v${res.version}）。配置：${res.configPath}`,
      );
      const info = await api.unityDetect(gamePath.trim());
      setDetect(info);
    } catch (e) {
      setError(toFriendlyError(e, "安装失败"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="unity-page">
      <div className="unity-card">
        <h2>Unity 在线翻译</h2>
        <p className="hint">
          基于开源项目{" "}
          <a
            href="https://github.com/bbepis/XUnity.AutoTranslator"
            target="_blank"
            rel="noreferrer"
          >
            XUnity.AutoTranslator
          </a>
          ：自动下载引擎包、放入游戏目录并写好配置。Mono 游戏走 ReiPatcher；已有
          BepInEx 则安装对应插件。IL2CPP 需先自行安装 BepInEx 6。
        </p>

        <label>
          游戏目录 / 主程序
          <div className="settings-path-row">
            <input
              type="text"
              value={gamePath}
              placeholder="选择游戏目录，或选择游戏 .exe"
              onChange={(e) => {
                setGamePath(e.target.value);
                setDetect(null);
                setResultNote(null);
              }}
            />
            <button
              type="button"
              className="settings-path-browse"
              disabled={busy}
              onClick={() => void browseGame("dir")}
            >
              选目录
            </button>
            <button
              type="button"
              className="settings-path-browse"
              disabled={busy}
              onClick={() => void browseGame("exe")}
            >
              选程序
            </button>
          </div>
        </label>

        <div className="unity-actions">
          <button
            type="button"
            className="pdf-tool-btn"
            disabled={busy || !gamePath.trim()}
            onClick={() => void onDetect()}
          >
            检测游戏
          </button>
          <button
            type="button"
            className="pdf-tool-btn"
            disabled={busy || !gamePath.trim()}
            onClick={() => void onInstall()}
          >
            {busy ? "处理中" : "安装并配置"}
          </button>
          <button
            type="button"
            className="pdf-tool-btn"
            disabled={busy || !(detect?.gameDir || gamePath.trim())}
            onClick={() => void openGameFolder()}
          >
            打开游戏目录
          </button>
        </div>

        {detect?.ok && detect.isIl2Cpp && !detect.hasBepInEx && (
          <p className="boot-error">
            当前为 IL2CPP 游戏，需先安装 BepInEx 6（IL2CPP），再点「安装并配置」。
          </p>
        )}

        {detect?.ok && (
          <div className="unity-detect">
            <div>
              <strong>目录</strong> {detect.gameDir}
            </div>
            <div>
              <strong>主程序</strong> {detect.gameExe || "（未识别）"}
            </div>
            <div>
              <strong>运行时</strong> {detect.runtime}
              {detect.isIl2Cpp ? "（IL2CPP）" : "（Mono）"}
            </div>
            <div>
              <strong>BepInEx</strong> {detect.hasBepInEx ? "已安装" : "未安装"}
            </div>
            <div>
              <strong>AutoTranslator</strong>{" "}
              {detect.hasAutoTranslator ? "已存在" : "未安装"}
            </div>
            <div>
              <strong>安装方式</strong> {detect.installMethod}
            </div>
          </div>
        )}

        <div className="settings-row-half">
          <label className="settings-half">
            游戏原文语言
            <select
              value={fromLanguage}
              onChange={(e) => setFromLanguage(e.target.value)}
            >
              {FROM_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-half">
            翻译目标语言
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              {LANG_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="settings-row-half">
          <label className="settings-half">
            翻译引擎 Endpoint
            <select
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            >
              {endpoints.map((o) => (
                <option key={o.id || "__empty"} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-half">
            备用 Endpoint（可选）
            <select
              value={fallback}
              onChange={(e) => setFallback(e.target.value)}
            >
              <option value="">无</option>
              {endpoints
                .filter((o) => o.id)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
            </select>
          </label>
        </div>

        <p className="hint">
          主要配置项：Endpoint / FallbackEndpoint / Language / FromLanguage。安装后可在游戏中按
          Alt+0 打开面板切换。需 Key 的引擎请按 XUnity 文档在对应 ini 段填写密钥。
        </p>

        {error && <p className="boot-error">{error}</p>}
        {resultNote && <p className="unity-ok">{resultNote}</p>}
        {steps.length > 0 && (
          <ol className="unity-steps">
            {steps.map((s, i) => (
              <li key={`${i}-${s}`}>{s}</li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
