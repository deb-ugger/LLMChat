import { maximumModelConcurrency } from "../gameModelPerformance";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";

export function OllamaServiceControl({ apiUrl, directory, notify, active=true }: { apiUrl: string; directory: string; notify: (text: string, ok?: boolean) => void; active?:boolean }) {
  const [running, setRunning] = useState<boolean | null>(null), [statusError, setStatusError] = useState("");
  const [mode, setMode] = useState<"start" | "stop" | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [proxyEnabled, setProxyEnabled] = useState(false), [proxyUrl, setProxyUrl] = useState("");
  const dialog = useRef<HTMLDialogElement>(null), title = useId();
  const endpoint = () => { const url = new URL(apiUrl); return { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) }; };
  useEffect(() => {
    if(!active)return;
    let alive = true, checking = false;
    setRunning(null); setStatusError("");
    const check = async () => {
      if (checking || document.hidden) return; checking = true;
      try { const result = await invoke<boolean>("ollama_service_status", endpoint()); if (alive) { setRunning(result); setStatusError(""); } }
      catch (error) { if (alive) { setRunning(null); setStatusError(String(error)); } }
      finally { checking = false; }
    };
    void check(); const timer = window.setInterval(() => void check(), 5000);
    document.addEventListener("visibilitychange", check);
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", check); };
  }, [apiUrl,active]);
  useEffect(() => { if (mode) { dialog.current?.showModal(); return () => dialog.current?.close(); } }, [mode]);
  const open = () => {
    setError(""); setProxyEnabled(localStorage.getItem("llmchat-ollama-proxy-enabled") === "true");
    setProxyUrl(localStorage.getItem("llmchat-ollama-proxy-url") || "http://127.0.0.1:7890");
    setMode(running ? "stop" : "start");
  };
  const execute = async (action: "start"|"stop"|"restart") => {
    setBusy(true); setError("");
    try {
      if (action !== "stop") {
        if (proxyEnabled) { const url = new URL(proxyUrl.trim()); if (!["http:", "https:"].includes(url.protocol)) throw new Error("代理地址需为 HTTP 或 HTTPS 地址"); }
        if(action === "restart")await invoke("ollama_service_stop",endpoint());
        await invoke("ollama_service_start", { ...endpoint(), parallel: maximumModelConcurrency(), models: directory.trim(), proxyEnabled, proxyUrl: proxyUrl.trim() });
        localStorage.setItem("llmchat-ollama-proxy-enabled", String(proxyEnabled)); localStorage.setItem("llmchat-ollama-proxy-url", proxyUrl.trim());
        setRunning(true); notify(action === "restart" ? "Ollama 服务已重启，代理配置已应用" : "Ollama 服务已开启，代理配置已保存");
      } else { await invoke("ollama_service_stop", endpoint()); setRunning(false); notify("Ollama 服务已关闭"); }
      setStatusError(""); setMode(null);
    } catch (error) { setError(String(error instanceof Error ? error.message : error)); }
    finally { setBusy(false); }
  };
  return <>
    <button type="button" className={`ollama-service-status ${running ? "is-running" : "is-stopped"}`} disabled={busy}
      data-tooltip={statusError || (running ? "配置代理或关闭 Ollama 服务" : "配置代理并开启 Ollama 服务")} onClick={open} aria-label={running === null ? statusError || "正在检测 Ollama 服务" : running ? "关闭 Ollama 服务" : "开启 Ollama 服务"}>
      <span className="ollama-service-state">{running === null ? statusError ? "服务状态未知" : "正在检测服务" : running ? "服务已开启" : "服务未开启"}</span>
      {running !== null && <span className="ollama-service-action">{running ? "关闭服务" : "点击开启服务"}</span>}
    </button>
    {mode && createPortal(<dialog className="ocr-confirm-dialog ollama-service-dialog" ref={dialog} aria-labelledby={title} onCancel={event => { event.preventDefault(); if (!busy) setMode(null); }}>
      <div className="ocr-confirm-copy"><h3 id={title}>{mode === "start" ? "开启 Ollama 服务" : "关闭 Ollama 服务"}</h3>
        <p>{mode === "start" ? "在后台启动本机 Ollama，已运行的服务会直接复用。" : "关闭后，正在使用此服务的翻译、识别和终端请求都会中断。是否继续？"}</p>
      </div>
      {<div className="ollama-service-proxy">
        <label><input type="checkbox" checked={proxyEnabled} disabled={busy} onChange={event => setProxyEnabled(event.target.checked)} />启用代理</label>
        <label className="settings-engine-field">代理地址（HTTP / HTTPS）<input value={proxyUrl} disabled={busy} onChange={event => setProxyUrl(event.target.value)} placeholder="http://127.0.0.1:7890" /></label>
        <p>本机连接保持直连。修改代理后需重启服务，正在运行的请求会中断。</p>
      </div>}
      {error && <p className="ollama-service-error" role="alert">{error}</p>}
      <div className="ocr-confirm-actions"><button type="button" className="settings-panel-save" disabled={busy} onClick={() => void execute(mode === "start" ? "start" : "restart")}>{busy ? "正在处理…" : mode === "start" ? "开启服务" : "保存并重启"}</button>
        {mode === "stop" && <button type="button" className="settings-panel-delete" disabled={busy} onClick={()=>void execute("stop")}>关闭服务</button>}
        <button type="button" className="ocr-confirm-cancel" autoFocus disabled={busy} onClick={() => setMode(null)}>取消</button></div>
    </dialog>, document.body)}
  </>;
}
