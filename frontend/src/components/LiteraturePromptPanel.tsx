import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_LIT_PROMPT_GENERAL,
  GENERAL_PROMPT_ID,
  TOKEN_HINT_CUSTOM,
  newLiteraturePromptId,
  type LiteraturePromptEntry,
} from "../literaturePrompt";

type Props = {
  catalog: LiteraturePromptEntry[];
  activeId: string;
  disabled?: boolean;
  /** Persist selection + catalog updates (explicit save / add / delete / select). */
  onCommit: (next: {
    catalog: LiteraturePromptEntry[];
    activeId: string;
  }) => void | Promise<void>;
};

type Mode = { type: "edit"; id: string } | { type: "create" };

export function LiteraturePromptPanel({
  catalog,
  activeId,
  disabled = false,
  onCommit,
}: Props) {
  const [mode, setMode] = useState<Mode>({ type: "edit", id: activeId });
  const [tagDraft, setTagDraft] = useState("");
  const [promptDraft, setPromptDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const editing = mode.type === "edit"
    ? catalog.find((c) => c.id === mode.id)
    : undefined;
  const isGeneral =
    mode.type === "edit" && editing?.id === GENERAL_PROMPT_ID;

  useEffect(() => {
    if (mode.type === "create") return;
    const entry = catalog.find((c) => c.id === mode.id);
    if (entry) {
      setTagDraft(entry.tag);
      // Always show the locked Chinese description for 通用
      setPromptDraft(
        entry.id === GENERAL_PROMPT_ID
          ? DEFAULT_LIT_PROMPT_GENERAL
          : entry.prompt,
      );
    } else if (catalog[0]) {
      setMode({ type: "edit", id: catalog[0].id });
    }
  }, [catalog, mode]);

  useEffect(() => {
    if (mode.type === "create") return;
    if (catalog.some((c) => c.id === activeId) && mode.id !== activeId) {
      setMode({ type: "edit", id: activeId });
    }
  }, [activeId, catalog, mode]);

  const dirty = useMemo(() => {
    if (mode.type === "create") {
      return tagDraft.trim().length > 0 || promptDraft.trim().length > 0;
    }
    if (!editing || editing.id === GENERAL_PROMPT_ID) return false;
    return (
      tagDraft.trim() !== editing.tag || promptDraft !== editing.prompt
    );
  }, [mode, tagDraft, promptDraft, editing]);

  const run = async (fn: () => void | Promise<void>) => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const selectEntry = (id: string) => {
    void run(async () => {
      setMode({ type: "edit", id });
      const entry = catalog.find((c) => c.id === id);
      if (entry) {
        setTagDraft(entry.tag);
        setPromptDraft(
          entry.id === GENERAL_PROMPT_ID
            ? DEFAULT_LIT_PROMPT_GENERAL
            : entry.prompt,
        );
      }
      if (id !== activeId) {
        await onCommit({ catalog, activeId: id });
      }
    });
  };

  const startCreate = () => {
    setMode({ type: "create" });
    setTagDraft("");
    setPromptDraft("");
  };

  const saveEdit = () => {
    if (mode.type !== "edit" || !editing) return;
    if (editing.id === GENERAL_PROMPT_ID) return;
    const tag = tagDraft.trim();
    if (!tag) {
      window.alert("请填写标题（tag）");
      return;
    }
    if (
      catalog.some(
        (c) =>
          c.id !== editing.id &&
          c.tag.toLowerCase() === tag.toLowerCase(),
      )
    ) {
      window.alert("已存在同名标题");
      return;
    }
    void run(async () => {
      const nextCatalog = catalog.map((c) =>
        c.id === editing.id
          ? { ...c, tag, prompt: promptDraft }
          : c,
      );
      await onCommit({
        catalog: nextCatalog,
        activeId: editing.id,
      });
    });
  };

  const addEntry = () => {
    const tag = tagDraft.trim();
    if (!tag) {
      window.alert("请填写标题（tag）");
      return;
    }
    if (catalog.some((c) => c.tag.toLowerCase() === tag.toLowerCase())) {
      window.alert("已存在同名标题");
      return;
    }
    const prompt = promptDraft.trim();
    if (!prompt) {
      window.alert("请填写提示词内容");
      return;
    }
    void run(async () => {
      const id = newLiteraturePromptId();
      const nextCatalog = [...catalog, { id, tag, prompt }];
      setMode({ type: "edit", id });
      setTagDraft(tag);
      setPromptDraft(prompt);
      await onCommit({ catalog: nextCatalog, activeId: id });
    });
  };

  const deleteEntry = () => {
    if (mode.type !== "edit" || !editing) return;
    if (editing.id === GENERAL_PROMPT_ID) return;
    if (
      !window.confirm(
        `确定删除提示词「${editing.tag}」？删除后不可恢复。`,
      )
    ) {
      return;
    }
    void run(async () => {
      const nextCatalog = catalog.filter((c) => c.id !== editing.id);
      const nextActive =
        activeId === editing.id ? GENERAL_PROMPT_ID : activeId;
      setMode({ type: "edit", id: nextActive });
      const next = nextCatalog.find((c) => c.id === nextActive);
      setTagDraft(next?.tag || "通用");
      setPromptDraft(
        next?.id === GENERAL_PROMPT_ID || !next
          ? DEFAULT_LIT_PROMPT_GENERAL
          : next.prompt,
      );
      await onCommit({ catalog: nextCatalog, activeId: nextActive });
    });
  };

  const isCreate = mode.type === "create";
  const canDelete =
    !isCreate && editing != null && editing.id !== GENERAL_PROMPT_ID;
  const tagEditable = isCreate || (editing != null && editing.id !== GENERAL_PROMPT_ID);
  const promptEditable = isCreate || (editing != null && editing.id !== GENERAL_PROMPT_ID);

  return (
    <div className={"lit-prompt-panel" + (disabled ? " is-disabled" : "")}>
      <div className="lit-prompt-panel-tags" role="listbox">
        {catalog.map((item) => {
          const selected =
            !isCreate && mode.type === "edit" && mode.id === item.id;
          const active = item.id === activeId;
          return (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={selected}
              className={
                "lit-prompt-tag-btn" +
                (selected ? " is-selected" : "") +
                (active ? " is-active" : "")
              }
              disabled={disabled || busy}
              onClick={() => selectEntry(item.id)}
            >
              {item.tag}
              {active ? <em>使用中</em> : null}
            </button>
          );
        })}
        <button
          type="button"
          className={
            "lit-prompt-tag-btn is-add" + (isCreate ? " is-selected" : "")
          }
          disabled={disabled || busy}
          onClick={startCreate}
        >
          + 自定义
        </button>
      </div>

      <div className="lit-prompt-panel-editor">
        <label className="lit-prompt-field">
          标题（tag）
          <input
            value={tagDraft}
            disabled={disabled || busy || !tagEditable}
            placeholder="例如：技术书籍"
            onChange={(e) => setTagDraft(e.target.value)}
          />
        </label>
        <label className="lit-prompt-field">
          提示词内容
          <textarea
            className="settings-prompt"
            rows={6}
            value={
              isGeneral ? DEFAULT_LIT_PROMPT_GENERAL : promptDraft
            }
            disabled={disabled || busy || !promptEditable}
            placeholder="系统提示词"
            onChange={(e) => setPromptDraft(e.target.value)}
          />
        </label>
        {isGeneral ? (
          <p className="hint lit-prompt-token-hint">
            「通用」不可编辑；翻译时不发送自定义 prompt，使用后端内置英文默认，token 最低。
          </p>
        ) : (
          <p className="hint lit-prompt-token-hint">{TOKEN_HINT_CUSTOM}</p>
        )}
        <div className="lit-prompt-panel-actions">
          {isCreate ? (
            <button
              type="button"
              className="settings-test-btn lit-prompt-primary"
              disabled={disabled || busy || !tagDraft.trim() || !promptDraft.trim()}
              onClick={addEntry}
            >
              新增
            </button>
          ) : isGeneral ? null : (
            <button
              type="button"
              className="settings-test-btn lit-prompt-primary"
              disabled={disabled || busy || !dirty}
              onClick={saveEdit}
            >
              保存
            </button>
          )}
          {canDelete ? (
            <button
              type="button"
              className="settings-panel-delete"
              disabled={disabled || busy}
              onClick={deleteEntry}
            >
              删除
            </button>
          ) : null}
          {dirty && !isCreate ? (
            <span className="hint">有未保存的修改</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
