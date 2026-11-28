import { useState } from "react";
import { GameDialog } from "./GameActionConfirm";
import { gameGlossaryCandidates, gameProjectTermProblem, type GameProjectTerm } from "../gameProjectGlossary";
import type { GameTextEntry } from "../gameTextProject";
import "./GameProjectGlossary.css";

export function GameProjectGlossary({ terms, entries, target, onSave, onClose }: {
  terms: GameProjectTerm[]; entries: GameTextEntry[]; target: string;
  onSave: (terms: GameProjectTerm[]) => Promise<boolean>; onClose: () => void;
}) {
  const [draft, setDraft] = useState(terms.filter(term => term.target === target).map(term => ({ ...term })));
  const [src, setSrc] = useState(""), [dst, setDst] = useState(""), [search, setSearch] = useState("");
  const [error, setError] = useState(""), [saving, setSaving] = useState(false);
  const candidates = gameGlossaryCandidates(entries, target).filter(term => !draft.some(value => value.src === term.src) && (term.src + term.dst).toLowerCase().includes(search.toLowerCase()));
  const add = (term: GameProjectTerm) => {
    const value = { ...term, src: term.src.trim(), dst: term.dst.trim() }, problem = gameProjectTermProblem(value);
    if (problem) { setError(problem); return; }
    setDraft(previous => [...previous.filter(row => row.src !== value.src), value]); setError(""); setSrc(""); setDst("");
  };
  const save = async () => {
    setSaving(true);
    try { if (await onSave([...terms.filter(term => term.target !== target), ...draft])) onClose(); }
    finally { setSaving(false); }
  };
  return <GameDialog className="game-project-glossary" title="本游戏正式词表" description="人工确认的译名优先用于本游戏，按目标语言保存。清理自动术语缓存时保留。候选译名需要确认后才会生效。" disabled={saving} onCancel={onClose} details={<>
    <div className="game-glossary-add"><input aria-label="原词" placeholder="原词" value={src} disabled={saving} onChange={e => setSrc(e.target.value)} /><input aria-label="确认译名" placeholder="确认译名" value={dst} disabled={saving} onChange={e => setDst(e.target.value)} /><button className="unity-btn" disabled={saving} onClick={() => add({ src, dst, target })}>确认词条</button></div>
    {error && <p role="alert">{error}</p>}
    <input aria-label="搜索词条" type="search" placeholder="搜索原词或译名" value={search} onChange={e => setSearch(e.target.value)} />
    <section className="game-glossary-list"><h3>已确认 · {draft.length}</h3>{draft.filter(term => (term.src + term.dst).toLowerCase().includes(search.toLowerCase())).map(term => <div key={term.src}><span>{term.src}</span><strong>{term.dst}</strong><button className="unity-btn" disabled={saving} onClick={() => { setSrc(term.src); setDst(term.dst); }}>编辑</button><button className="unity-btn" disabled={saving} onClick={() => setDraft(rows => rows.filter(row => row.src !== term.src))}>移除</button></div>)}{!draft.length && <p>尚无确认词条。</p>}</section>
    <section className="game-glossary-list"><h3>已有名称候选 · {candidates.length}</h3>{candidates.slice(0, 100).map(term => <div key={term.src}><span>{term.src}</span><span>{term.dst}</span><button className="unity-btn" disabled={saving} onClick={() => add(term)}>确认</button></div>)}{candidates.length > 100 && <small>请搜索以缩小候选范围。</small>}</section>
  </>}><button className="game-confirm-cancel" disabled={saving} onClick={onClose}>取消</button><button className="game-confirm-primary" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存词表"}</button></GameDialog>;
}
