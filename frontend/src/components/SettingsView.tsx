import { useEffect, useState } from "react";
import type { Settings } from "../api";

const MODEL_OPTIONS = [
  "deepseek-chat",
  "deepseek-reasoner",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "gpt-3.5-turbo",
  "gemini-2.0-flash",
  "qwen-plus",
  "qwen-turbo",
];

type Props = {
  settings: Settings;
  onSave: (settings: Settings) => void;
};

export function SettingsView({ settings, onSave }: Props) {
  const [form, setForm] = useState<Settings>(settings);

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  return (
    <div className="settings-page">
      <h1>设置</h1>

      <section className="settings-card">
        <h2>对话显示</h2>
        <label>
          每次加载消息数
          <input
            type="number"
            min={10}
            max={500}
            step={10}
            value={form.messagePageSize}
            onChange={(e) =>
              setForm({
                ...form,
                messagePageSize: Number(e.target.value) || 30,
              })
            }
          />
        </label>
        <p className="hint">
          切换对话时默认显示最新 N 条消息；滚到顶部后可加载更早记录。
        </p>
      </section>

      <section className="settings-card">
        <h2>模型与 API</h2>
        <label>
          API URL
          <input
            value={form.apiUrl}
            onChange={(e) => setForm({ ...form, apiUrl: e.target.value })}
            placeholder="https://api.openai.com/v1/chat/completions"
          />
        </label>
        <label>
          API Key
          <input
            type="password"
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            placeholder="sk-..."
          />
        </label>
        <label>
          模型
          <input
            list="model-list"
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
          />
          <datalist id="model-list">
            {MODEL_OPTIONS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
      </section>

      <button className="save-btn" onClick={() => onSave(form)}>
        保存
      </button>
    </div>
  );
}
