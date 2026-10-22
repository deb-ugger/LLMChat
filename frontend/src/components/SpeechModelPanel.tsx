import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { SPEECH_MODELS, type SpeechModel, type ChineseScript } from "../speech/transcription";
import { useSpeechModels, selectSpeechModel, downloadSpeechModel, cancelSpeechModelDownload, uninstallSpeechModel, refreshSpeechModels, SPEECH_MODEL_FILES, setSpeechPreferences } from "../speech/models";
import { DownloadProgress } from "../speech/DownloadProgress";
import { speechNative } from "../speech/native";
import { SpeechOnlineSettings } from "./SpeechOnlineControls";

export function SpeechModelPanel() {
  const models = useSpeechModels();
  const [confirm, setConfirm] = useState<SpeechModel | null>(null);
  const [error, setError] = useState("");
  const blocked = !!models.inUse || !!models.download;
  useEffect(() => {
    if (!models.preferences.outputRoot) void speechNative.environment()
      .then(environment => setSpeechPreferences({ outputRoot: environment.outputRoot }))
      .catch(cause => setError(cause.message));
  }, []);
  const pickOutput = async () => {
    try {
      const root = await open({ directory: true, multiple: false, title: "语音转文字输出目录", defaultPath: models.preferences.outputRoot || undefined });
      if (typeof root === "string") setSpeechPreferences({ outputRoot: root });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <section className="settings-card speech-model-panel">
    <h2>语音识别模型</h2>
    <div className="speech-model-table-wrap"><table className="speech-model-table"><thead><tr><th>模型</th><th>状态</th><th>作用与适用场景</th><th>空间</th><th>操作</th></tr></thead><tbody>
      {SPEECH_MODELS.map(model => {
        const status = models.rows?.find(row => row.model === model.id);
        const downloading = models.download?.model === model.id;
        return <tr key={model.id} className={status?.installed ? "is-installed" : ""}>
          <td><label><input type="radio" name="speech-model" checked={models.selected === model.id} disabled={blocked} onChange={() => selectSpeechModel(model.id)} />{model.label}</label></td>
          <td><span className={`speech-model-status ${status?.installed ? "is-installed" : ""}`}>{downloading ? "下载中" : !status ? "检查中" : status.installed ? "已下载" : status.files ? `部分下载 ${status.files}/${SPEECH_MODEL_FILES.length}` : "未下载"}</span>{models.inUse === model.id && <small>正在识别</small>}</td>
          <td>{model.description}</td>
          <td>{status?.bytes ? `已缓存 ${(status.bytes / 1048576).toFixed(1)} MiB` : `约 ${model.sizeMiB} MiB`}</td>
          <td><div className="speech-model-actions">{downloading ? <button onClick={cancelSpeechModelDownload}>停止下载</button> : !status?.installed ? <button disabled={blocked} onClick={() => { setError(""); void downloadSpeechModel(model.id).catch(cause => setError(cause.message)); }}>{status?.files ? "继续下载" : "下载"}</button> : null}
            {!!status?.files && <button className="danger" disabled={blocked} onClick={() => setConfirm(model.id)}>卸载</button>}</div></td>
        </tr>;
      })}
    </tbody></table></div>
    <DownloadProgress download={models.download} />
    {(error || models.error) && <p className="speech-error" role="alert">{error || models.error}</p>}
    <button className="pdf-tool-btn" disabled={!!models.download} onClick={() => void refreshSpeechModels()}>刷新下载状态</button>
    <SpeechOnlineSettings />
    <h2 className="speech-processing-title">任务设置</h2>
    <div className="speech-processing-options">
      <label>最多同时处理文件数<select value={models.preferences.concurrency} onChange={event => setSpeechPreferences({ concurrency: Number(event.target.value) })}>{[1, 2, 3, 4].map(count => <option key={count} value={count}>{count} 个</option>)}</select></label>
      <label>中文简繁转换<select value={models.preferences.chineseScript} onChange={event => setSpeechPreferences({ chineseScript: event.target.value as ChineseScript })}><option value="simplified">转为简体</option><option value="traditional">转为繁体</option><option value="original">不转换</option></select></label>
      <label>输出目录<div className="speech-output-picker"><input value={models.preferences.outputRoot} readOnly title={models.preferences.outputRoot} /><button onClick={() => void pickOutput()}>选择</button></div></label>
    </div>
    {confirm && <div className="ocr-confirm-backdrop"><div className="ocr-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="speech-uninstall-title"><div className="ocr-confirm-copy"><h3 id="speech-uninstall-title">卸载语音模型？</h3><p>将删除 {SPEECH_MODELS.find(model => model.id === confirm)?.label} 的下载缓存，再次使用时需要重新下载。</p></div><div className="ocr-confirm-actions"><button onClick={() => setConfirm(null)}>取消</button><button className="danger" onClick={() => { const model = confirm; setConfirm(null); void uninstallSpeechModel(model).catch(cause => setError(cause.message)); }}>确认卸载</button></div></div></div>}
  </section>;
}
