import { useState } from "react";
import { GameDialog } from "./GameActionConfirm";
import { currentGameSemanticReview, outstandingGameSemanticIssues, type GameSemanticEntry } from "../gameTextSemantics";
import { gameEntrySceneLocations, gameEntrySceneTranslations, gameSceneKey, gameSceneLabel, type GameSceneTranslation } from "../gameTextScenes";
import type { GameTextEntry, GameTextProject } from "../gameTextProject";
import "./GameTextEntryEditor.css";

export function GameTextEntryEditor({ project, entry, target, disabled, onChange, onSceneChange }: {
  project: GameTextProject; entry: GameTextEntry; target: string; disabled: boolean;
  onChange: (patch: Partial<GameSemanticEntry>) => void;
  onSceneChange: (scene: GameSceneTranslation) => void;
}) {
  const [opened, setOpened] = useState(false), [position, setPosition] = useState(0);
  const locations = gameEntrySceneLocations(project, entry), scenes = gameEntrySceneTranslations(project, entry, target);
  const issues = outstandingGameSemanticIssues(entry, target, project.glossary), review = currentGameSemanticReview(entry, target);
  if (locations.length <= 1 && !issues.length && !review) return null;
  const location = locations[position]?.location;
  const scene = location && scenes.find(value => gameSceneKey(value) === gameSceneKey(location));
  const shown: GameSemanticEntry = scene ? { ...entry, translation: scene.translation, error: scene.error, semanticReview: scene.semanticReview, sceneContextPending: !scene.contextKnown } : { ...entry, sceneContextPending: locations.length > 1 };
  const activeReview = currentGameSemanticReview(shown, target), activeIssues = outstandingGameSemanticIssues(shown, target, project.glossary);
  const patch = (value: Partial<GameSemanticEntry>) => {
    if (location && locations.length > 1) onSceneChange({ ...location, source: entry.source, target, translation: value.translation ?? shown.translation,
      error: value.translation !== undefined ? "" : shown.error, contextKnown: true, semanticReview: value.semanticReview });
    else onChange(value);
  };
  return <div className="game-text-entry-quality"><button className="unity-btn" disabled={disabled} onClick={() => setOpened(true)}>{locations.length > 1 ? `${locations.length} 处场景` : issues.length ? "待复核" : review?.state === "changed" ? "复核已修订" : "复核记录"}</button>
    {opened && <GameDialog className="game-text-scene-editor" title={`第 ${entry.id} 条 · 场景与复核`} description="核对当前场景的译文。修改立即记入工程，使用页面的保存按钮保存到文件。" onCancel={() => setOpened(false)} details={<>
      {locations.length > 1 && <label>场景<select value={position} onChange={e => setPosition(Number(e.target.value))}>{locations.map(({ location }, index) => <option key={gameSceneKey(location)} value={index}>{gameSceneLabel(location)}</option>)}</select></label>}
      {location && locations.length <= 1 && <small>{gameSceneLabel(location)}</small>}
      {locations[position] && project.dialoguePages && <div className="game-scene-context">{[-1, 1].map(offset => {
        const line = project.dialoguePages![locations[position].position.page].lines[locations[position].position.line + offset];
        return line && <p key={offset}>{offset < 0 ? "上文：" : "下文："}{line}</p>;
      })}</div>}
      <label>原文<pre>{entry.source}</pre></label><label>当前译文<textarea aria-label="场景译文" rows={4} value={shown.translation} disabled={disabled} onChange={e => patch({ translation: e.target.value })} /></label>
      {!!activeIssues.length && <p role="status">{activeIssues.map(issue => issue.detail).join("；")}</p>}
      {shown.error && <p role="alert">{shown.error}</p>}
      {activeReview && <div><p>{activeReview.state === "uncertain" ? "需人工确认" : activeReview.state === "failed" ? "复核失败" : "复核结论"}：{activeReview.reason}</p>{activeReview.previous !== undefined && <><label>修订前<pre>{activeReview.previous}</pre></label><button className="unity-btn" disabled={disabled} onClick={() => patch({ translation: activeReview.previous! })}>恢复修订前译文</button></>}</div>}
      <button className="unity-btn" disabled={disabled || !shown.translation.trim() || !!shown.error} onClick={() => patch({ semanticReview: { translation: shown.translation, target, state: "checked", reason: "人工确认当前译文", issues: [] } })}>确认当前译文</button>
    </>}><button className="game-confirm-cancel" onClick={() => setOpened(false)}>关闭</button></GameDialog>}
  </div>;
}
