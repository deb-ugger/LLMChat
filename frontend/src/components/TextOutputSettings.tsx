import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, type StorageStatus } from "../api";
import { toFriendlyError } from "../friendlyError";
import { OutputDirectoryField } from "./OutputDirectoryField";

export function TextOutputSettings() {
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void api.getStorage(false).then(setStorage).catch(cause => setError(toFriendlyError(cause))); }, []);
  const current = storage?.entries.find(entry => entry.id === "projects")?.path || "";
  const path = storage?.pending?.projects || current;
  const change = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "工程保存目录", defaultPath: path || undefined });
      if (typeof selected !== "string") return;
      setBusy(true);
      const latest = await api.getStorage(false);
      const paths = latest.pending ?? Object.fromEntries(latest.entries.map(entry => [entry.id, entry.path]));
      setStorage(await api.saveStoragePaths({ ...paths, projects: selected }, false));
      setError("");
    } catch (cause) { setError(toFriendlyError(cause)); }
    finally { setBusy(false); }
  };
  return <section className="settings-card">
    <h2>保存路径</h2>
    <label>工程保存目录<div className="settings-directory-picker"><input value={path} readOnly title={path} /><button className="pdf-tool-btn" type="button" disabled={busy || !storage} onClick={() => void change()}>选择</button></div></label>
    <p className="hint">工程目录变更将在下次启动时迁移并生效，原位置保留备份。</p>
    {path !== current && <p className="hint">当前：<code>{current}</code></p>}
    <OutputDirectoryField module="text" label="译文导出目录" />
    {error && <p className="settings-test-fail" role="alert">{error}</p>}
  </section>;
}
