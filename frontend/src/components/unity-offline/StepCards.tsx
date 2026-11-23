import type { ComponentProps, CSSProperties, ReactNode, Ref } from "react";
import { createPortal } from "react-dom";
import { GamePromptContext } from "../../gamePrompts";
import type { UnityProject } from "../../unityOffline";
import { GameFlowSequence, GameFlowPerformance } from "../GameFlowSequence";
import { StandaloneGameFlowCard, type GameFlowActivity } from "../GameFlowCard";
import { GameProgressBar } from "../GameStepProgress";
import type { StepPerformance } from "../../gameModelPerformance";
import { GameWorkflowSteps } from "../GameWorkflowSteps";
import { UnityActionIcon } from "../UnityActionIcon";
import { UnityIconButton } from "../UnityIconButton";
import { UnityTranslationProgress } from "../UnityTranslationProgress";

export type TranslationCardFlow = Omit<ComponentProps<typeof GameFlowSequence>, "actions" | "children">;
export type WorkflowTrack = Omit<ComponentProps<typeof GameWorkflowSteps>, "idPrefix" | "panelId">;

type ProgressDetailsProps = {
  manualReviewCount?: number;
  scanResource?: RegExpMatchArray | null;
  taskDetail?: string | false;
  scanThroughput?: string;
  scanTiming?: UnityProject["scanMetrics"];
  translation?: ComponentProps<typeof UnityTranslationProgress>;
};

export function StepProgressDetails({ manualReviewCount, scanResource, taskDetail, scanThroughput, scanTiming,
  translation }: ProgressDetailsProps) {
  return <>
    {!!manualReviewCount && <p className="unity-task-detail">待人工确认 {manualReviewCount} 张。请在右侧分组处理，或跳过剩余内容。</p>}
    {scanResource ? <div className="unity-scan-current-resource">
      <div className="unity-scan-resource-metrics"><span>对象 <b>{scanResource[2]}</b> / {scanResource[3]}</span><span>已提取 <b>{scanResource[4]}</b> 条文本</span></div>
      <GameProgressBar label="当前文件的对象进度" value={Math.min(100, Math.floor(Number(scanResource[2]) / Number(scanResource[3]) * 100))} />
    </div> : taskDetail && <p className="unity-task-detail">{taskDetail}</p>}
    {scanThroughput && <p className="game-flow-stage-throughput">扫描吞吐 <b>{scanThroughput}</b></p>}
    {scanTiming && <details className="unity-task-detail">
      <summary>扫描计时 · 重新解析 {scanTiming.parsed} 个 · 复用 {scanTiming.reused} 个</summary>
      <p>{([
        ["准备与列目录", scanTiming.prepareMs], ["校验文件与依赖", scanTiming.checkMs], ["打开资源与读取索引", scanTiming.openMs],
        ["解析字段和文本", scanTiming.parseMs], ["图片解码与编码", scanTiming.decodeMs], ["复用索引和原图", scanTiming.reuseMs],
        ["恢复译文和图片结果", scanTiming.restoreMs], ["保存工程", scanTiming.saveMs], ["其他扫描操作", scanTiming.otherMs],
      ] as const).map(([label, ms]) => `${label} ${(ms / 1000).toFixed(2)} 秒`).join(" · ")}</p>
    </details>}
    {translation && <UnityTranslationProgress {...translation} />}
  </>;
}

type StepCardsProps = {
  panelRef: Ref<HTMLElement>;
  workflowRef: Ref<HTMLElement>;
  panelStyle?: CSSProperties;
  generationState?: string;
  activeStep: number;
  imagePart: boolean;
  mosaicPage: boolean;
  track: WorkflowTrack;
  toolbar?: { target: HTMLElement; saveDisabled: boolean; saveTitle: string; save: () => void };
  mosaic?: { controlsRef: Ref<HTMLDivElement>; scanReady: boolean; hasImages: boolean; error?: string; hasMosaic: boolean };
  scan?: GameFlowActivity & { configuration: ReactNode; resources: ReactNode; measurement?: StepPerformance };
  translation?: {
    prompts: ComponentProps<typeof GamePromptContext.Provider>["value"];
    flow: TranslationCardFlow;
    configuration: ReactNode;
    skipDisabled: boolean;
    skipRemaining: () => void;
  };
  batch?: ReactNode;
  deployment?: ReactNode;
  errorPanel?: ReactNode;
};

export function StepCards({ panelRef, workflowRef, panelStyle, generationState, activeStep, imagePart, mosaicPage, track,
  toolbar, mosaic, scan, translation, batch, deployment, errorPanel }: StepCardsProps) {
  return <>
    {toolbar && createPortal(<>
      <UnityIconButton className="unity-project-save" aria-label="保存工程" title={toolbar.saveTitle} disabled={toolbar.saveDisabled} onClick={toolbar.save}><UnityActionIcon kind="save" /></UnityIconButton>
    </>, toolbar.target)}
    <aside ref={panelRef} className="unity-offline-config" style={panelStyle}>
      <div className="unity-offline-upper unity-workflow-layout">
        <GameWorkflowSteps idPrefix="unity-step" panelId="unity-step-panel" {...track} />
        <section ref={workflowRef} className={`unity-generation unity-workflow ${generationState || "idle"}`} aria-label="分步设置与当前任务">
          <div id="unity-step-panel" role="tabpanel" aria-labelledby={`unity-step-${mosaicPage ? "2.3" : activeStep === 2 ? imagePart ? "2.2" : "2.1" : activeStep}`} className="unity-step-panel">
            {mosaic && <div hidden={!mosaicPage}>
              <div ref={mosaic.controlsRef} />
              {!mosaic.scanReady && <p className="hint">扫描资源后即可筛选、框选并重绘打码区域。</p>}
              {mosaic.scanReady && !mosaic.hasImages && <p className="hint">当前工程没有可处理的图片。</p>}
              {mosaic.scanReady && mosaic.error && <p className="unity-offline-error">{mosaic.error}</p>}
              {mosaic.hasMosaic && <p className="hint">选中的去码图将在步骤 3 写入补丁。与译图同源时会合成。</p>}
            </div>}
            {!mosaicPage && <>
              {scan && <div className="unity-scan-layout">
                <div><StandaloneGameFlowCard stepId="scan" title="扫描资源" state={scan.state} label={scan.label} elapsed={scan.elapsed}
                  actions={scan.actions} progress={scan.progress} details={scan.details}
                  performance={<GameFlowPerformance measured={scan.measurement} />}
                  configuration={<div className="game-flow-field-wide">{scan.configuration}</div>} /></div>
                {scan.resources}
              </div>}
              {translation && <GamePromptContext.Provider value={translation.prompts}>
                <GameFlowSequence key={imagePart ? "images" : "text"} {...translation.flow}
                  actions={<button className="unity-btn unity-btn-warning unity-skip-remaining" disabled={translation.skipDisabled}
                    onClick={translation.skipRemaining}>跳过剩余内容</button>}>
                  {translation.configuration}
                </GameFlowSequence>
              </GamePromptContext.Provider>}
              {batch && <div className="unity-step-batch">{batch}</div>}
              {deployment}
            </>}
          </div>
          {errorPanel && <div className="unity-step-batch">{errorPanel}</div>}
        </section>
      </div>
    </aside>
  </>;
}
