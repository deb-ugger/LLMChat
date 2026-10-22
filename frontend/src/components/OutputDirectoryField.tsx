import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getOutputDirectory, setOutputDirectory, type OutputModule } from "../outputFiles";
import { toFriendlyError } from "../friendlyError";

export function OutputDirectoryField({ module, label }: { module: OutputModule; label: string }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void getOutputDirectory(module).then(setPath).catch(cause => setError(toFriendlyError(cause)));
  }, [module]);
  const choose = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: label, defaultPath: path || undefined });
      if (typeof selected === "string") {
        setOutputDirectory(module, selected);
        setPath(selected);
        setError("");
      }
    } catch (cause) { setError(toFriendlyError(cause)); }
  };
  return <div className="settings-output-directory">
    <label>{label}<div className="settings-directory-picker"><input value={path} readOnly title={path} /><button className="pdf-tool-btn" type="button" onClick={() => void choose()}>选择</button></div></label>
    {error && <p className="settings-test-fail" role="alert">{error}</p>}
  </div>;
}
