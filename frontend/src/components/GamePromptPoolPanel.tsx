import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { GAME_CONTEXT_COUNT_MAX, GAME_CONTEXT_MAX, loadGameContextLengths, saveGameContextLengths } from "../gameTranslationContext";
import { GAME_PROMPT_GROUPS, GAME_PROMPT_SCENES, saveGamePromptCatalog, useGamePromptCatalog, type GamePrompt, type GamePromptScene } from "../gamePrompts";
import { useGameActionConfirm } from "./GameActionConfirm";
import { usePersistedSize } from "../hooks/usePersistedSize";

type Notify = (message: string, ok?: boolean) => void;
type Step = (typeof GAME_PROMPT_GROUPS)[number]["steps"][number];
const steps = GAME_PROMPT_GROUPS.flatMap(group => group.steps);
const minDirectoryWidth = 220;
const splitTags = (text: string) => text.split(/[,，;；]/).map(tag => tag.trim()).filter(Boolean);
const withTags = (tags: string[] = [], text: string) => [...new Set([...tags, ...splitTags(text)])];

const contextDirections = [
  { title: "上文", count: "previousCount", length: "previous", lengthLabel: "每条取末尾（字符）" },
  { title: "下文", count: "followingCount", length: "following", lengthLabel: "每条取开头（字符）" },
] as const;
type ContextKey = ReturnType<typeof loadGameContextLengths>;
type ContextField = keyof ContextKey;
const contextFields = ["previousCount", "previous", "followingCount", "following"] as const;
const fieldLimit = (key: ContextField) => key.endsWith("Count") ? GAME_CONTEXT_COUNT_MAX : GAME_CONTEXT_MAX;

function GameContextSettings({ notify }: { notify: Notify }) {
  const [saved, setSaved] = useState(loadGameContextLengths);
  const [draft, setDraft] = useState(() => Object.fromEntries(contextFields.map(key => [key, String(saved[key])])) as Record<ContextField, string>);
  const dirty = contextFields.some(key => draft[key] !== String(saved[key]));

  const save = () => {
    if (!dirty) return;
    if (contextFields.some(key => !/^\d+$/.test(draft[key]) || Number(draft[key]) > fieldLimit(key))) {
      notify(`条数请输入 0–${GAME_CONTEXT_COUNT_MAX}，字符数请输入 0–${GAME_CONTEXT_MAX}。`, false);
      return;
    }
    try {
      const values = Object.fromEntries(contextFields.map(key => [key, Number(draft[key])])) as ContextKey;
      saveGameContextLengths(values);
      setSaved(values);
      setDraft(Object.fromEntries(contextFields.map(key => [key, String(values[key])])) as Record<ContextField, string>);
      notify("文本上下文设置已保存");
    } catch (error) { notify(String(error), false); }
  };
  const numberInput = (key: ContextField) => <input type="number" min={0} max={fieldLimit(key)} step={1} required
    value={draft[key]} onChange={event => setDraft(previous => ({ ...previous, [key]: event.target.value }))} />;

  return <section className="settings-card game-context-settings">
    <h2>游戏文本上下文</h2>
    <p className="hint">开启「附带上下文」后，从同一资源取相邻原文。条数或字符数为 0 时关闭该侧。</p>
    <form className="game-context-controls" onSubmit={event => { event.preventDefault(); save(); }}>
      {contextDirections.map(({ title, count, length, lengthLabel }) => <fieldset key={title} className="game-context-direction">
        <legend>{title}</legend>
        <label>条数{numberInput(count)}</label>
        <label>{lengthLabel}{numberInput(length)}</label>
      </fieldset>)}
      <button className="settings-panel-save" disabled={!dirty}>保存上下文</button>
    </form>
  </section>;
}

function PromptIcon({ kind }: { kind: "add" | "filter" | "delete" }) {
  return <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "add" ? <path d="M10 4v12M4 10h12" /> : kind === "filter" ? <path d="M3 4h14l-5.5 6v5l-3 1v-6Z" /> : <path d="M4 5h12M8 5V3h4v2M5.5 5l.8 12h7.4l.8-12M8 8v6m4-6v6" />}
  </svg>;
}

export function GamePromptPoolPanel({ notify }: { notify: Notify }) {
  const catalog = useGamePromptCatalog();
  const [stepId, setStepId] = useState("text-translate");
  const [id, setId] = useState("builtin:text");
  const [draft, setDraft] = useState<GamePrompt | null>(null);
  const [opened, setOpened] = useState(() => new Set(["text-translate"]));
  const [tagDraft, setTagDraft] = useState("");
  const [filterTags, setFilterTags] = useState<string[]>([]);
  const filterMenu = useRef<HTMLDivElement>(null);
  const filterId = useId();
  const layout = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const maxDirectoryWidth = availableWidth
    ? Math.max(minDirectoryWidth, Math.min(740, Math.floor(availableWidth * .55)))
    : 740;
  const directory = usePersistedSize("llmchat-game-prompt-directory-width", 350, minDirectoryWidth, maxDirectoryWidth, "x");
  useLayoutEffect(() => {
    const element = layout.current!;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setAvailableWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const confirmation = useGameActionConfirm();
  const step = steps.find(item => item.id === stepId)!;
  const current = catalog.find(entry => entry.id === id);
  const editing = draft ?? current;
  const effectiveTags = withTags(editing?.tags, tagDraft);
  const dirty = !!editing && (!current || editing.name.trim() !== current.name ||
    editing.scene !== current.scene || editing.prompt !== current.prompt ||
    JSON.stringify(effectiveTags) !== JSON.stringify(current.tags || []));
  const allTags = [...new Set(catalog.flatMap(entry => entry.tags ?? []))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const visiblePrompts = catalog.filter(entry => !filterTags.length || filterTags.every(tag => entry.tags?.includes(tag)));

  const moveTo = async (next: Step, nextId: string, nextDraft: GamePrompt | null = null) => {
    if (next.id === stepId && nextId === id && !nextDraft) return;
    if (dirty && !await confirmation.confirm("切换会放弃当前未保存的修改。", {
      title: "提示词尚未保存", okLabel: "放弃修改",
    })) return;
    setStepId(next.id);
    setId(nextId);
    setDraft(nextDraft);
    setTagDraft("");
    setOpened(previous => new Set([...previous, next.id]));
  };

  const toggleStep = (next: Step) => {
    if (opened.has(next.id)) {
      setOpened(previous => new Set([...previous].filter(key => key !== next.id)));
    } else {
      setOpened(previous => new Set([...previous, next.id]));
    }
  };

  const add = (next: Step) => {
    const entry = catalog.find(prompt => next.scenes.includes(prompt.scene));
    const newId = crypto.randomUUID();
    void moveTo(next, newId, { id: newId, name: "", scene: entry?.scene ?? next.scenes[0], prompt: entry?.prompt || "", tags: [] });
  };

  const commit = () => {
    if (!editing || !dirty) return;
    const name = editing.name.trim();
    if (!name || !editing.prompt.trim()) { notify("请填写提示词标题和内容", false); return; }
    if (catalog.some(entry => entry.id !== id && entry.scene === editing.scene && entry.name === name)) {
      notify("该场景已存在同名提示词", false);
      return;
    }
    try {
      saveGamePromptCatalog([...catalog.filter(entry => entry.id !== id), { ...editing, name, tags: effectiveTags }]);
      setDraft(null);
      setTagDraft("");
      notify("提示词已保存");
    } catch (error) { notify(String(error), false); }
  };

  const remove = async (entry: GamePrompt) => {
    if (entry.builtin || !await confirmation.ask("删除提示词", `删除「${entry.name}」后，引用它的步骤需要重新选择。`, "删除")) return;
    try {
      saveGamePromptCatalog(catalog.filter(item => item.id !== entry.id));
      if (id === entry.id) {
        setId("builtin:" + entry.scene);
        setDraft(null);
        setTagDraft("");
      }
      notify("提示词已删除");
    } catch (error) { notify(String(error), false); }
  };

  const positionFilter = (button: HTMLButtonElement) => {
    const menu = filterMenu.current!;
    const rect = button.getBoundingClientRect();
    const width = Math.min(280, innerWidth - 24);
    const below = innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const flip = below < 220 && above > below;
    Object.assign(menu.style, {
      width: width + "px",
      left: Math.max(12, Math.min(rect.right - width, innerWidth - width - 12)) + "px",
      top: flip ? "auto" : rect.bottom + 6 + "px",
      bottom: flip ? innerHeight - rect.top + 6 + "px" : "auto",
      maxHeight: Math.min(340, flip ? above : below) + "px",
    });
  };

  return <>
    <GameContextSettings notify={notify} />
    <section className="settings-card game-prompt-pool">
      {confirmation.dialog}
      <h2>游戏翻译提示词池</h2>
      <div ref={layout} className="game-prompt-layout" style={{ "--game-prompt-directory-width": directory.size + "px" } as CSSProperties}>
        <nav className="game-prompt-tree" aria-label="提示词目录">
          <div className="game-prompt-tree-head">
            <strong>目录</strong>
          </div>
          <div id={filterId} ref={filterMenu} popover="auto" className="game-prompt-filter" role="dialog" aria-label="标签筛选">
            <header><strong>按标签筛选</strong><button type="button" disabled={!filterTags.length} onClick={() => setFilterTags([])}>清除</button></header>
            <div className="game-prompt-filter-list">
              {allTags.map(tag => <label key={tag}>
                <input type="checkbox" checked={filterTags.includes(tag)} onChange={event =>
                  setFilterTags(previous => event.target.checked ? [...previous, tag] : previous.filter(value => value !== tag))} />{tag}
              </label>)}
            </div>
          </div>
          <div className="game-prompt-tree-scroll">
            {GAME_PROMPT_GROUPS.map(group => <details key={group.id} open>
              <summary>{group.name}</summary>
              <div className="game-prompt-branch">
                {group.steps.map(item => {
                  const expanded = opened.has(item.id);
                  const items = visiblePrompts.filter(entry => item.scenes.includes(entry.scene));
                  return <div key={item.id} className="game-prompt-directory">
                    <div className="game-prompt-directory-row game-prompt-step-row">
                      <button type="button" className="game-prompt-step" aria-current={stepId === item.id ? "true" : undefined}
                        aria-expanded={item.scenes.length ? expanded : undefined}
                        onClick={() => item.scenes.length ? toggleStep(item) : void moveTo(item, "")}>
                        {!!item.scenes.length && <span className="game-prompt-chevron" aria-hidden="true" />}{item.name}
                      </button>
                      {!!item.scenes.length && <div className="game-prompt-step-tools">
                        <button type="button" className="game-prompt-icon" aria-label={`筛选${item.name}的提示词标签`} aria-controls={filterId} popoverTarget={filterId}
                          aria-haspopup="dialog" data-tooltip="按标签筛选" onClick={event => positionFilter(event.currentTarget)}
                          data-active={!!filterTags.length}><PromptIcon kind="filter" /></button>
                        <button type="button" className="game-prompt-icon" aria-label={`新增${item.name}提示词`}
                          data-tooltip="新增" onClick={() => add(item)}><PromptIcon kind="add" /></button>
                      </div>}
                    </div>
                    {expanded && !!item.scenes.length && <div className="game-prompt-branch">
                      {items.map(entry => <div key={entry.id} className="game-prompt-directory-row">
                        <button type="button" className="game-prompt-item" aria-current={id === entry.id ? "true" : undefined}
                          data-tooltip={entry.name} onClick={() => void moveTo(item, entry.id)}>
                          <span className="game-prompt-item-name">{entry.name}</span>
                          {!!entry.tags?.length && <span className="game-prompt-tags game-prompt-inline-tags">{entry.tags.map(tag => <span key={tag}>{tag}</span>)}</span>}
                        </button>
                        {!entry.builtin && <button type="button" className="game-prompt-icon game-prompt-remove" aria-label={`删除${entry.name}`}
                          data-tooltip="删除提示词" onClick={() => void remove(entry)}><PromptIcon kind="delete" /></button>}
                      </div>)}
                      {!items.length && <p className="game-prompt-empty">没有符合筛选条件的提示词。</p>}
                    </div>}
                  </div>;
                })}
              </div>
            </details>)}
          </div>
        </nav>
        <button type="button" className="game-prompt-divider" role="separator" aria-label="调整目录宽度"
          aria-orientation="vertical" aria-valuemin={minDirectoryWidth} aria-valuemax={maxDirectoryWidth} aria-valuenow={directory.size}
          onMouseDown={event => directory.beginResize(event, 1)}
          onKeyDown={event => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            directory.setSize(width => width + (event.key === "ArrowRight" ? 16 : -16));
          }} />
        <div className="game-prompt-editor">
          {editing ? <form className="game-prompt-form" onSubmit={event => { event.preventDefault(); commit(); }}>
            <div className="game-prompt-editor-fields">
              <label>标题<input value={editing.name} placeholder="提示词标题" onChange={event => setDraft({ ...editing, name: event.target.value })} /></label>
              {!current && step.scenes.length > 1 && <label>适用场景<select value={editing.scene} onChange={event => setDraft({ ...editing, scene: event.target.value as GamePromptScene })}>
                {step.scenes.map(scene => <option key={scene} value={scene}>{GAME_PROMPT_SCENES[scene]}</option>)}
              </select></label>}
            </div>
            <div className="game-prompt-tag-editor">
              <label htmlFor={filterId + "-tag"}>标签</label>
              <div className="game-prompt-tag-field">
                {!!editing.tags?.length && <span className="game-prompt-tags">{editing.tags.map(tag => <span key={tag}>{tag}
                  <button type="button" aria-label={`移除标签 ${tag}`} onClick={() => setDraft({ ...editing, tags: editing.tags?.filter(item => item !== tag) })}>×</button>
                </span>)}</span>}
                <input id={filterId + "-tag"} aria-label="新增标签" value={tagDraft} placeholder="输入标签后按回车" onChange={event => setTagDraft(event.target.value)}
                  onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    setDraft({ ...editing, tags: effectiveTags });
                    setTagDraft("");
                  } }} />
              </div>
            </div>
            <label className="game-prompt-content-field">提示词内容<textarea rows={8} value={editing.prompt} onChange={event => setDraft({ ...editing, prompt: event.target.value })} /></label>
            <div className="game-prompt-editor-actions">
              <span className="game-prompt-variable-hint"><code>{"{source}"}</code> 原文语言　<code>{"{target}"}</code> 目标语言</span>
              <button className="settings-panel-save" disabled={!dirty}>保存</button>
            </div>
          </form> : <p className="game-prompt-empty">{step.scenes.length ? "选择一条提示词进行编辑。" : "此步骤使用本地规则，无需提示词。"}</p>}
        </div>
      </div>
    </section>
  </>;
}
