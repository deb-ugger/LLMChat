import type { OcrMode, OcrModelStatus } from "../api";
import { OCR_MODE_LABELS, ocrDownloadProgress } from "../ocr/modes";

type Props = {
  options: ReadonlyArray<{ id: OcrMode; description: string; warning?: string }>;
  selected: OcrMode;
  busy: OcrMode | null;
  status: OcrModelStatus | null;
  onChoose: (mode: OcrMode) => Promise<void>;
};

export function OcrModeOptions({ options, selected, busy, status, onChoose }: Props) {
  const download = status?.download;
  const { percent } = ocrDownloadProgress(download);

  return <>
    <div className="literature-ocr-options">
      {options.map(option => {
        const checked = selected === option.id;
        const loading = busy === option.id || (download?.active && download.mode === option.id);
        const installed = status?.modes.find(item => item.id === option.id)?.installed;
        return <button key={option.id} type="button" role="menuitemradio" aria-checked={checked}
          className={`literature-ocr-option${checked ? " is-selected" : ""}`}
          disabled={busy !== null || download?.active === true} onClick={() => void onChoose(option.id)}>
          <span className="literature-ocr-option-mark" aria-hidden>{checked ? "✓" : ""}</span>
          <span className="literature-ocr-option-copy">
            <strong>{OCR_MODE_LABELS[option.id]}</strong>
            <small>{option.description}{option.warning && <><br /><strong>{option.warning}</strong></>}</small>
          </span>
          <span className="literature-ocr-option-state">
            {option.id === "fast" ? "内置" : loading ? `${percent}%` : installed ? "已下载" : "需下载"}
          </span>
        </button>;
      })}
    </div>
    {busy && <div className="literature-ocr-progress" aria-live="polite">
      <div><span>{download?.model || "正在建立下载连接"}</span><strong>{percent}%</strong></div>
      <span className="ocr-download-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span className="ocr-download-progress-fill" style={{ width: `${percent}%` }} />
      </span>
    </div>}
  </>;
}
