import type { OcrMode, OcrModelStatus } from "../api";
import { OCR_MODE_OPTIONS } from "../ocr/modes";

type Props = {
  context: "literature" | "image";
  selectedMode: string;
  status: OcrModelStatus | null;
  busy: OcrMode | `remove-${Exclude<OcrMode, "fast">}` | null;
  error: string | null;
  onRetry: () => void;
  onChoose: (mode: OcrMode) => void;
  onUninstall: (mode: Exclude<OcrMode, "fast">) => void;
};

function formatModelBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MiB";
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MiB`;
}

export function OcrModeTable({ context, selectedMode, status: ocrModelStatus, busy: ocrModelBusy, error, onRetry, onChoose, onUninstall }: Props) {
    const progress = ocrModelStatus?.download;
    const progressTotal = Math.max(0, progress?.totalBytes ?? 0);
    const progressDone = Math.max(0, progress?.downloadedBytes ?? 0);
    const progressPercent = progressTotal
      ? Math.min(100, Math.round((progressDone / progressTotal) * 100))
      : 0;
    const modeDisabled =
      ocrModelBusy !== null || ocrModelStatus?.download?.active === true;
    const visibleOptions = OCR_MODE_OPTIONS.filter(
      (option) => context === "image" || option.id !== "manga",
    );

    return (
      <div className="ocr-mode-settings">
        <div className="ocr-mode-table-heading">
          <div>
            <h3 className="ocr-mode-title">识别模式</h3>
            <p className="hint">
              {context === "literature"
                ? "用于扫描页文字识别。检测模型可由多个模式共用。"
                : "检测模型可由多个模式共用。"}
            </p>
          </div>
        </div>
        {error && <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap", padding: "10px 12px", marginBottom: 12, border: "1px solid color-mix(in srgb, var(--danger) 25%, var(--border))", borderRadius: 8, background: "var(--danger-soft)", color: "var(--danger)", fontSize: 13, lineHeight: 1.65 }}>
          <span style={{ flex: "1 1 300px" }}>{error}</span>
          <button type="button" onClick={onRetry}>刷新状态</button>
        </div>}
        <div className="ocr-mode-table-wrap">
          <table className="ocr-mode-table">
            <thead>
              <tr>
                <th>模式</th>
                <th>状态</th>
                <th>前置检测模型</th>
                <th>文字识别模型</th>
                <th>作用与适用场景</th>
                <th>空间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody role="radiogroup" aria-label="识别模式">
              {visibleOptions.map((option) => {
                const statusItem = ocrModelStatus?.modes.find(
                  (item) => item.id === option.id,
                );
                const selected = selectedMode === option.id;
                const downloading =
                  ocrModelBusy === option.id ||
                  (progress?.active === true && progress.mode === option.id);
                const removing = ocrModelBusy === `remove-${option.id}`;
                const installed = option.id === "fast" || statusItem?.installed === true;
                const prerequisiteInstalled =
                  option.id === "fast" ||
                  statusItem?.prerequisiteInstalled === true;
                const recognitionInstalled =
                  option.id === "fast" ||
                  statusItem?.recognitionInstalled === true;
                const installationState = installed
                  ? option.id === "fast"
                    ? { label: "内置可用", tone: "ready" }
                    : { label: "已安装", tone: "ready" }
                  : !statusItem
                    ? { label: "状态读取中", tone: "pending" }
                    : { label: "", tone: "missing" };
                const missingModelLabels = statusItem && !installed
                  ? [
                      !prerequisiteInstalled ? "缺少前置检测模型" : null,
                      !recognitionInstalled ? "缺少文字识别模型" : null,
                    ].filter((label): label is string => Boolean(label))
                  : [];
                const spaceText =
                  option.id === "fast"
                    ? `无需下载 · 内置 ${formatModelBytes(statusItem?.sizeBytes ?? 0)}`
                    : downloading
                      ? `正在下载 ${progressPercent}%`
                      : installed
                        ? `无需下载 · 已占用 ${formatModelBytes(
                            statusItem?.cachedBytes || statusItem?.sizeBytes || 0,
                          )}`
                        : statusItem
                          ? `还需 ${formatModelBytes(statusItem.downloadBytes)}`
                          : "状态读取中";
                return (
                  <tr
                    key={option.id}
                    className={`${installed ? "is-installed" : ""}${modeDisabled ? " is-disabled" : ""}`.trim() || undefined}
                  >
                    <td>
                      <button
                        type="button"
                        role="radio"
                        className={`ocr-mode-select${selected ? " is-selected" : ""}`}
                        aria-checked={selected}
                        disabled={modeDisabled}
                        onClick={() => void onChoose(option.id)}
                      >
                        <span className="ocr-mode-select-mark" aria-hidden />
                        <strong>{option.title}</strong>
                      </button>
                    </td>
                    <td className="ocr-mode-status-cell">
                      {missingModelLabels.length ? (
                        <span className="ocr-mode-status-list">
                          {missingModelLabels.map((label) => (
                            <span key={label} className="ocr-mode-status is-missing">
                              {label}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className={`ocr-mode-status is-${installationState.tone}`}>
                          {installationState.tone === "ready" ? "✓ " : ""}
                          {installationState.label}
                        </span>
                      )}
                    </td>
                    <td className="ocr-mode-model-cell">
                      <code>{option.detectionModel}</code>
                      <span className="ocr-model-file-meta">
                        <span className={`ocr-model-file-status ${prerequisiteInstalled ? "is-ready" : "is-missing"}`}>
                          {prerequisiteInstalled ? "✓ 已下载" : "未下载"}
                        </span>
                        <span className="ocr-model-file-size">
                          {statusItem
                            ? formatModelBytes(statusItem.prerequisiteSizeBytes)
                            : "读取中"}
                        </span>
                      </span>
                    </td>
                    <td className="ocr-mode-model-cell">
                      <code>{option.recognitionModel}</code>
                      <span className="ocr-model-file-meta">
                        <span className={`ocr-model-file-status ${recognitionInstalled ? "is-ready" : "is-missing"}`}>
                          {recognitionInstalled ? "✓ 已下载" : "未下载"}
                        </span>
                        <span className="ocr-model-file-size">
                          {statusItem
                            ? formatModelBytes(statusItem.recognitionSizeBytes)
                            : "读取中"}
                        </span>
                      </span>
                    </td>
                    <td className="ocr-mode-purpose">
                      <span>{option.description}</span>
                      {option.warning ? (
                        <>
                          <br />
                          <strong>{option.warning}</strong>
                        </>
                      ) : null}
                    </td>
                    <td className="ocr-mode-space">
                      <strong>{spaceText}</strong>
                      {downloading ? (
                        <span className="ocr-download-progress" aria-live="polite">
                          <span className="ocr-download-progress-head">
                            <span>{progress?.model || "正在建立下载连接"}</span>
                            <strong>{progressPercent}%</strong>
                          </span>
                          <span
                            className="ocr-download-progress-track"
                            role="progressbar"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={progressPercent}
                          >
                            <span
                              className="ocr-download-progress-fill"
                              style={{ width: `${progressPercent}%` }}
                            />
                          </span>
                          <span className="ocr-download-progress-bytes">
                            {formatModelBytes(progressDone)} / {formatModelBytes(progressTotal)}
                          </span>
                        </span>
                      ) : null}
                    </td>
                    <td className="ocr-mode-action">
                      {option.id === "fast" ? (
                        <span>软件内置</span>
                      ) : installed ? (
                        <button
                          type="button"
                          className="ocr-mode-uninstall"
                          disabled={modeDisabled}
                          onClick={() =>
                            onUninstall(option.id as Exclude<OcrMode, "fast">)
                          }
                        >
                          <svg viewBox="0 0 24 24" aria-hidden>
                            <path
                              fill="currentColor"
                              d="M9 3h6l1 2h4v2H4V5h4l1-2zm-2 6h10l-.7 11H7.7L7 9zm3 2v7h2v-7h-2zm4 0v7h2v-7h-2z"
                            />
                          </svg>
                          {removing ? "正在卸载…" : "卸载"}
                        </button>
                      ) : (
                        <span>选择后下载</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="ocr-model-cache-row">
          <span className="hint">
            扩展模型实际缓存：{formatModelBytes(ocrModelStatus?.cachedBytes ?? 0)}
            {ocrModelStatus?.cacheDir ? ` · ${ocrModelStatus.cacheDir}` : ""}
          </span>
        </div>
      </div>
    );
}
