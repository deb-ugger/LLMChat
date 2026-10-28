import type { UnityProgress } from "../unityOffline";
import { getEngineInfo } from "../translateEngines";

const phases = { translating: "等待引擎 / 翻译中", reusing: "复用已有结果", formatting: "排版中", saving: "保存中" };
const engineColors: Record<string, string> = { bing: "#326df0", google: "#238b73", mymemory: "#c58a16", youdao: "#9254c8", baidu: "#d95765", sogou: "#238baf", niutrans: "#7a8545" };
export function UnityTranslationProgress({ progress, running, onLocate }: { progress: UnityProgress; running: boolean; onLocate: (id: string) => void }) {
  const summary = progress.translation;
  const target = progress.engineTargetCharacters || 0;
  const characters = progress.engineStats?.reduce((sum, engine) => sum + engine.characters, 0) || 0;
  const totalPercent = target ? Math.min(100, characters / target * 100) : 0;
  return <div className="unity-translation-progress" aria-label="文本翻译详细进度">
    {summary ? <dl className="unity-translation-counters">
      <div><dt>本轮已检查原文</dt><dd>{summary.processed} / {summary.pending} 种</dd></div>
      <div><dt>有效译文</dt><dd>{summary.successful} / {progress.total} 种</dd></div>
      <div><dt>右侧已填充条目</dt><dd>{progress.coverageCompleted} / {progress.coverageTotal} 条</dd></div>
      <div><dt>本轮失败</dt><dd>{summary.failed} 种原文 · {summary.failedEntries} 条目</dd></div>
      <div><dt>本轮送译尝试</dt><dd>{progress.requests || 0} 次</dd></div>
      <div><dt>复用已有结果</dt><dd>{progress.reused || 0} 种原文</dd></div>
    </dl> : <><dl className="unity-translation-counters">
      <div><dt>已有有效原文译文</dt><dd>{progress.completed} / {progress.total ?? "未知"} 种</dd></div>
      <div><dt>右侧已填充条目</dt><dd>{progress.coverageCompleted ?? "未记录"} / {progress.coverageTotal ?? "未知"} 条</dd></div>
      <div><dt>本轮送译尝试</dt><dd>{progress.requests ?? "未记录"} 次</dd></div>
      <div><dt>复用已有结果</dt><dd>{progress.reused ?? "未记录"} 种原文</dd></div>
    </dl><p className="hint">已载入工程中的有效译文；继续处理后显示当前条目的实时位置。</p></>}
    {!!progress.engineStats?.length && <section className="unity-engine-meters" aria-label="各翻译引擎字符进度与速度">
      <strong>本轮待送译原文：{target.toLocaleString("zh-CN")} 字符</strong>
      <div className="unity-engine-stack" role="progressbar" aria-label="翻译引擎合并字符进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={totalPercent} aria-valuetext={`已翻译 ${characters} / ${target} 字符，${totalPercent.toFixed(1)}%`}>
        {progress.engineStats.map(engine => <span key={engine.id} className="unity-engine-segment" title={`${getEngineInfo(engine.id)?.label || engine.id}：${engine.characters} 字符`} style={{ width: `${target ? Math.min(100, engine.characters / target * 100) : 0}%`, backgroundColor: engineColors[engine.id] || "var(--accent,#326df0)" }} />)}
      </div>
      {progress.engineStats.map(engine => {
        const percent = target ? Math.min(100, engine.characters / target * 100) : 0;
        return <div className="unity-engine-meter" key={engine.id}>
          <div><strong><span className="unity-engine-swatch" aria-hidden="true" style={{ backgroundColor: engineColors[engine.id] || "var(--accent,#326df0)" }} />{getEngineInfo(engine.id)?.label || engine.id}</strong><span>{engine.characters.toLocaleString("zh-CN")} 字符 · {percent.toFixed(1)}% · 当前 {running ? engine.speed.toFixed(1) : "0.0"} 字符/秒</span></div>
          {engine.entryId && <button type="button" className="unity-progress-locate" onClick={() => onLocate(engine.entryId!)}>{engine.active && running ? "当前" : "最近"}条目 #{engine.entryId} · 点击定位</button>}
        </div>;
      })}
    </section>}
    {!!summary?.active.length && <div className="unity-translation-active" aria-label="正在处理的条目">
      <strong>{running ? "正在处理" : "暂停或结束时的位置"}</strong>
      {summary.active.map(item => <button type="button" className="unity-progress-locate" key={item.id} onClick={() => onLocate(item.id)}>条目 #{item.id} · {phases[item.phase]} · 同原文 {item.references} 处</button>)}
    </div>}
    {summary?.last && <button type="button" className="unity-progress-locate" onClick={() => onLocate(summary.last!.id)}>最近已处理：条目 #{summary.last.id} · {summary.last.failed ? "失败，已记录" : "成功"} · 点击定位</button>}
  </div>;
}
