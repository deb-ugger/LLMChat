import type { UnityProgress } from "../unityOffline";
import { getEngineInfo } from "../translateEngines";

const engineColors: Record<string, string> = { bing: "#326df0", google: "#238b73", mymemory: "#c58a16", youdao: "#9254c8", baidu: "#d95765", sogou: "#238baf", niutrans: "#7a8545" };
export const gameTextStageLabels = { screening: "筛选文本", names: "姓名统一", layout: "断行与校验" };
const activityLabels = { translating: "翻译正文", reusing: "复用译文", formatting: "断行与校验", saving: "提交结果" } as const;

export function UnityTranslationProgress({ progress, running, failure, onLocate }: {
  progress: UnityProgress; running: boolean; failure?: string; onLocate: (id: string) => void;
}) {
  const characters = progress.engineStats?.reduce((sum, engine) => sum + engine.characters, 0) || 0;
  const last = progress.translation?.last;
  const active = progress.translation?.active ?? [];
  return <div className="unity-translation-progress" aria-label="文本翻译详细进度">
    {progress.textStage ? <div className="game-text-progress-stages">
      <span>{gameTextStageLabels[progress.textStage]}{progress.total ? ` · ${progress.completed} / ${progress.total}` : ""}</span>
      {progress.model && <span data-tooltip={progress.model}>{progress.model}</span>}
    </div> : progress.translation && <div className="game-text-progress-stages">
      {Object.entries(activityLabels).map(([phase, label]) => {
        const count = active.filter(item => item.phase === phase).length;
        return <span key={phase} data-active={count > 0}>{label}{count > 0 ? ` · ${count} 项` : ""}</span>;
      })}
    </div>}
    {!!progress.engineStats?.length && <section className="unity-engine-meters" aria-label="各翻译引擎累计处理字符占比">
      <div className="unity-engine-stack" role="img" aria-label={`各引擎累计处理 ${characters.toLocaleString("zh-CN")} 字符`} style={{ height: 8 }}>
        {progress.engineStats.map(engine => <span key={engine.id} className="unity-engine-segment" data-tooltip={`${getEngineInfo(engine.id)?.label || engine.id}：${engine.characters.toLocaleString("zh-CN")} 字符`} style={{ width: `${characters ? engine.characters / characters * 100 : 0}%`, backgroundColor: engineColors[engine.id] || "var(--accent,#326df0)" }} />)}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px" }}>
        {progress.engineStats.map(engine => <div className="unity-engine-meter" key={engine.id} style={{ flexShrink: 0 }}>
          <div><strong><span className="unity-engine-swatch" aria-hidden="true" style={{ backgroundColor: engineColors[engine.id] || "var(--accent,#326df0)" }} />{getEngineInfo(engine.id)?.label || engine.id}</strong></div>
          <span>{engine.characters.toLocaleString("zh-CN")} 字符 · {(characters ? engine.characters * 100 / characters : 0).toFixed(1)}%{running && engine.speed != null && ` · 当前 ${engine.speed.toFixed(1)} 字符/秒`}</span>
          {engine.entryId && <button type="button" className="unity-progress-locate" onClick={() => onLocate(engine.entryId!)}>条目 #{engine.entryId}</button>}
        </div>)}
      </div>
    </section>}
    {last && <button type="button" className="unity-progress-locate" onClick={() => onLocate(last.id)}>最近已处理：条目 #{last.id} · {last.failed ? "失败，已记录" : "成功"} · 点击定位</button>}
    {failure
      ? <p className="game-text-progress-failure" role="alert">{failure}</p>
      : (running || progress.textStage) && progress.detail && <p className="unity-task-detail">{progress.detail.replace(/\s*·\s*失败\s*\d+\s*条\s*$/, "")}</p>}
  </div>;
}
