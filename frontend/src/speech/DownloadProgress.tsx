import { SPEECH_MODEL_FILES, type SpeechDownload } from "./models";

export function DownloadProgress({ download }: { download: SpeechDownload | null }) {
  if (!download) return null;
  const percent = download.totalBytes ? Math.min(100, download.loadedBytes / download.totalBytes * 100) : undefined;
  const speed = download.bytesPerSecond >= 1048576
    ? `${(download.bytesPerSecond / 1048576).toFixed(1)} MiB/s`
    : `${(download.bytesPerSecond / 1024).toFixed(1)} KiB/s`;
  return <div className="speech-progress speech-download-progress" role="status">
    <div className="speech-download-meta"><strong>模型下载</strong><span>已完成 {download.completedFiles} / {SPEECH_MODEL_FILES.length} 个文件</span><strong>{speed}</strong></div>
    <div className="speech-download-file">{download.file}</div>
    <progress aria-label="当前文件下载进度" value={percent} max="100" />
    <div className="speech-download-meta"><span>{(download.loadedBytes / 1048576).toFixed(1)}{download.totalBytes ? ` / ${(download.totalBytes / 1048576).toFixed(1)}` : ""} MiB</span><span>{percent === undefined ? "正在获取文件" : `${percent.toFixed(1)}%`}</span></div>
  </div>;
}
