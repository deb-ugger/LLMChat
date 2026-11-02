import { useEffect, useState } from "react";
import { protectText, protectionRegex, textProtectionPresets, type TextProtection } from "../textTranslationTools";
import type { TransEntry } from "../textTranslate";

export function TextProtectionOptions({ value, format, entries, disabled, onChange }: {
  value?: TextProtection; format: string; entries: TransEntry[]; disabled: boolean; onChange: (value: TextProtection) => void;
}) {
  const [rules, setRules] = useState((value?.rules || []).join("\n"));
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ source: string; fragments: string[] }[] | null>(null);
  useEffect(() => { setRules((value?.rules || []).join("\n")); setPreview(null); }, [value]);
  const apply = (mode: TextProtection["mode"]) => {
    const next = { mode, rules: rules.split("\n").filter(rule => rule.trim()) };
    try { protectionRegex(format, next); setError(""); setPreview(null); onChange(next); }
    catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); }
  };
  return <details className="settings-rule-block"><summary>文本保护</summary>
    <div className="settings-row"><label>保护方式 <select disabled={disabled} value={value?.mode ?? "smart"} onChange={event => apply(event.target.value as TextProtection["mode"])}>
      <option value="smart">按格式自动保护</option><option value="custom">自定义规则</option><option value="off">关闭代码保护</option>
    </select></label><select aria-label="保护规则预设" disabled={disabled} value="" onChange={event => {
      const selected = textProtectionPresets[event.target.value];
      if (selected) { setRules(selected.join("\n")); onChange({ mode: "custom", rules: selected }); setError(""); }
    }}><option value="">载入规则预设</option>{Object.keys(textProtectionPresets).map(name => <option key={name}>{name}</option>)}</select><button type="button" disabled={disabled} onClick={() => {
      try {
        const result: { source: string; fragments: string[] }[] = [];
        for (const entry of entries) { const item = protectText(entry.src, format, value); if (item.fragments.length) result.push({ source: entry.src, fragments: item.fragments }); if (result.length === 10) break; }
        setPreview(result); setError("");
      } catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); }
    }}>预览命中</button></div>
    {value?.mode === "custom" && <><textarea aria-label="文本保护正则规则，每行一条" disabled={disabled} value={rules} rows={3} placeholder="每行一条正则表达式" onChange={event => setRules(event.target.value)} /><button type="button" disabled={disabled} onClick={() => apply("custom")}>应用规则</button></>}
    <p className="hint">换行和制表符始终保留。预览最多显示前 10 条命中；自定义规则请先检查是否误选普通文本。</p>
    {error && <p role="alert" className="boot-error">{error}</p>}
    {preview && <ul>{preview.length ? preview.map((row, index) => <li key={index}><div>{row.source}</div><code>{JSON.stringify(row.fragments)}</code></li>) : <li>没有命中保护片段</li>}</ul>}
  </details>;
}
