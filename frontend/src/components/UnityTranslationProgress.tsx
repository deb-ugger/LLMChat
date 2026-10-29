import type { UnityProgress } from "../unityOffline";
import { getEngineInfo } from "../translateEngines";

const engineColors: Record<string, string> = { bing: "#326df0", google: "#238b73", mymemory: "#c58a16", youdao: "#9254c8", baidu: "#d95765", sogou: "#238baf", niutrans: "#7a8545" };
export function UnityTranslationProgress({ progress, onLocate }: { progress: UnityProgress; running: boolean; onLocate: (id: string) => void }) {
  const characters = progress.engineStats?.reduce((sum, engine) => sum + engine.characters, 0) || 0;
  const last = progress.translation?.last;
  return <div className="unity-translation-progress" aria-label="文本翻译详细进度">
    {!!progress.engineStats?.length && <section className="unity-engine-meters" aria-label="各翻译引擎累计处理字符占比">
      <div className="unity-engine-stack" role="img" aria-label={`各引擎累计处理 ${characters.toLocaleString("zh-CN")} 字符`} style={{ height: 8 }}>
        {progress.engineStats.map(engine => <span key={engine.id} className="unity-engine-segment" title={`${getEngineInfo(engine.id)?.label || engine.id}：${engine.characters.toLocaleString("zh-CN")} 字符`} style={{ width: `${characters ? engine.characters / characters * 100 : 0}%`, backgroundColor: engineColors[engine.id] || "var(--accent,#326df0)" }} />)}
      </div>
      <div style={{ display: "flex", gap: "0 16px", overflowX: "auto", whiteSpace: "nowrap" }}>
        {progress.engineStats.map(engine => <div className="unity-engine-meter" key={engine.id} style={{ flexShrink: 0 }}>
          <div><strong><span className="unity-engine-swatch" aria-hidden="true" style={{ backgroundColor: engineColors[engine.id] || "var(--accent,#326df0)" }} />{getEngineInfo(engine.id)?.label || engine.id}</strong></div>
        </div>)}
      </div>
    </section>}
    {last && <button type="button" className="unity-progress-locate" onClick={() => onLocate(last.id)}>最近已处理：条目 #{last.id} · {last.failed ? "失败，已记录" : "成功"} · 点击定位</button>}
  </div>;
}
