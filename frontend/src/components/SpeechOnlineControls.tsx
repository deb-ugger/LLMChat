import { useEffect, useState } from "react";
import { api } from "../api";
import { currentEffectivePresets, loadLocalModelProfiles } from "../modelPresets";
import { getSpeechPreferences, setSpeechConnection, setSpeechPreferences, SPEECH_ONLINE_PROVIDERS, useSpeechModels } from "../speech/models";
import type { SpeechJobOptions, SpeechOnlineProvider } from "../speech/native";

export function SpeechOnlineRunControls({ options }: { options?: SpeechJobOptions } = {}) {
  const { preferences: pref } = useSpeechModels(false);
  const mode = options ? options.processing?.mode ?? "local" : pref.mode;
  const provider = options?.processing?.provider ?? pref.onlineProvider;
  const model = options ? options.processing?.model ?? "" : pref.onlineModel;
  return <div className="speech-processing-options">
    <label>识别方式<select value={mode} onChange={event => setSpeechPreferences({ mode: event.target.value as "local" | "online" })}><option value="local">本地识别</option><option value="online">在线识别</option></select></label>
    {mode === "online" && <>
      <label>在线服务<select value={provider} onChange={event => {
        const provider = event.target.value as SpeechOnlineProvider;
        setSpeechPreferences({ onlineProvider: provider, onlineModel: SPEECH_ONLINE_PROVIDERS[provider].model });
      }}>{Object.entries(SPEECH_ONLINE_PROVIDERS).map(([id, provider]) => <option key={id} value={id}>{provider.label}</option>)}</select></label>
      <label>音频模型<input value={model} onChange={event => setSpeechPreferences({ onlineModel: event.target.value })} placeholder={SPEECH_ONLINE_PROVIDERS[provider].model || "支持 input_audio 的模型 ID"} /></label>
      <p className="hint">在线识别上传音频，时间戳由模型估计，可能产生费用。</p>
    </>}
  </div>;
}

export function SpeechProofreadControls({ options }: { options?: SpeechJobOptions }) {
  const { preferences: pref } = useSpeechModels(false);
  const readOnly = !!options;
  const proofread = options ? !!options.processing?.proofread : pref.proofread;
  const proofreadModel = options ? options.processing?.proofreadModel ?? "" : pref.proofreadModel;
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (readOnly) return;
    let disposed = false;
    void api.getSettings().then(settings => {
      if (disposed) return;
      setModels([...new Set([settings.model, ...currentEffectivePresets().map(model => model.model), ...Object.keys(loadLocalModelProfiles())])].filter(Boolean));
      if (!getSpeechPreferences().proofreadModel) setSpeechPreferences({ proofreadModel: settings.model });
    }).catch(cause => { if (!disposed) setError(cause.message); });
    return () => { disposed = true; };
  }, [readOnly]);
  return <div className="speech-option-group speech-processing-options speech-proofread-controls" role="group" aria-label="校对设置">
    <label className="speech-preview-option"><input type="checkbox" checked={proofread} onChange={event => setSpeechPreferences({ proofread: event.target.checked })} />大模型校对</label>
    <label>校对模型<input list="speech-proofread-models" disabled={!proofread} value={proofread ? proofreadModel : "未开启大模型校对"} title={proofread ? proofreadModel : "未开启大模型校对"} onChange={event => setSpeechPreferences({ proofreadModel: event.target.value })} placeholder="通用中已配置的模型 ID" /><datalist id="speech-proofread-models">{models.map(model => <option key={model} value={model} />)}</datalist></label>
    {proofread && <p className="hint">校对上传字幕，可能产生费用。</p>}
    {!readOnly && error && <p className="speech-error">{error}</p>}
  </div>;
}

export function SpeechOnlineSettings() {
  const models = useSpeechModels(false);
  const [provider, setProvider] = useState<SpeechOnlineProvider>("google");
  const connection = models.connections[provider];
  return <>
    <h2 className="speech-processing-title">在线识别接口</h2>
    <div className="speech-processing-options">
      <label>服务<select value={provider} onChange={event => setProvider(event.target.value as SpeechOnlineProvider)}>{Object.entries(SPEECH_ONLINE_PROVIDERS).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}</select></label>
      {provider !== "custom" && <label className="speech-preview-option"><input type="checkbox" checked={connection.useGeneral} onChange={event => setSpeechConnection(provider, { useGeneral: event.target.checked })} />使用通用中该厂商的凭证</label>}
      {(!connection.useGeneral || provider === "custom") && <>
        <label>API URL<input value={connection.apiUrl} onChange={event => setSpeechConnection(provider, { apiUrl: event.target.value })} placeholder="https://…/chat/completions" spellCheck={false} /></label>
        <label>API Key<input type="password" autoComplete="off" value={connection.apiKey} onChange={event => setSpeechConnection(provider, { apiKey: event.target.value })} /></label>
      </>}
      <p className="hint">自定义接口须支持 Chat Completions 的 WAV 音频输入和非流式文本输出。校对模型凭证在「通用」配置。</p>
    </div>
  </>;
}
