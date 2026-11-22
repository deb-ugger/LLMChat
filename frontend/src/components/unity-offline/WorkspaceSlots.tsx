import type { ComponentProps, CSSProperties, Ref } from "react";
import { gameDisplayTextProblem } from "../../gameDisplayText";
import type { useGameFileDrop } from "../../hooks/useGameFileDrop";
import { unityTranslationError, type UnityEntry, type UnityProject } from "../../unityOffline";
import { explainUnityFailure } from "../../unityOfflineFeedback";
import type { UnityTranslationImportMode } from "../../unityTranslationFiles";
import { unityEntryLanguage, unityLanguageLabel } from "../../unityWorkflow";
import { GameMosaicCompletionContext, GameMosaicWorkbench } from "../GameMosaicWorkbench";
import { GameMosaicPatchButton } from "../GameMosaicPatchButton";
import { GamePageNumber } from "../GamePageNumber";
import { GAME_TEXT_IMPORT_CHOICES, GameTextFileMenu } from "../GameTextFileMenu";
import { GameTextFilterMenu } from "../GameTextFilterMenu";
import { GameTextScreenedEditor, GameTextScreenedSource } from "../GameTextScreening";
import { SearchHighlight } from "../SearchHighlight";
import { UnityDeploymentPanel } from "../UnityDeploymentPanel";
import { UnityImageWorkbench } from "../UnityImageWorkbench";

type DividerProps = ComponentProps<"button">;
type TextPanelProps = {
  textDropRoot: Ref<HTMLElement>;
  dropHandlers: ReturnType<typeof useGameFileDrop>["handlers"];
  active: boolean;
  busy: string;
  restoring: boolean;
  saving: boolean;
  testTitle?: string;
  scanReady: boolean;
  project: UnityProject | null;
  importPreview: { entries: UnityEntry[] } | null;
  importMode: UnityTranslationImportMode;
  textFilters: ComponentProps<typeof GameTextFilterMenu>["value"];
  matchedCount: number;
  filteredCount: number;
  errorsOnly: boolean;
  retryUnfinishedDisabled: boolean;
  search: string;
  discardDisabled: boolean;
  saveDisabled: boolean;
  tableRef: Ref<HTMLTableElement>;
  sourceWidth: number;
  originalRatio: number;
  sourceDivider: Pick<DividerProps, "onMouseDown" | "onKeyDown">;
  originalDivider: Pick<DividerProps, "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel" | "onKeyDown">;
  entriesLocked: boolean;
  checkedCount: number;
  hasMixedSelection: boolean;
  rows: UnityEntry[];
  rowJump: { id: string; sequence: number; error: boolean } | null;
  target: string;
  source: string;
  skipTargetLanguage: boolean;
  textScreened: boolean;
  qualityIssues: ReadonlyMap<string, string[]>;
  locateAcrossLanguages: boolean;
  scope: { label: string; count: number };
  selectedCount: number;
  done: number;
  visiblePage: number;
  pageCount: number;
  rowIssue: UnityEntry | null;
  rowFailure: ReturnType<typeof explainUnityFailure> | null;
  rowRetryQueued: boolean;
  retryIssueDisabled: boolean;
  retryIssueTitle: string;
  qualityIssue?: string[];
  qualityIssueId: string | null;
  onDownload: (range: "all" | "filtered") => void;
  onImport: (mode: UnityTranslationImportMode) => void;
  onLimitChange: ComponentProps<typeof GameTextFilterMenu>["onLimitChange"];
  onFilterChange: ComponentProps<typeof GameTextFilterMenu>["onChange"];
  onRetryUnfinished: () => void;
  onSearch: (search: string) => void;
  onDiscard: () => void;
  onSave: () => void;
  onCheckFiltered: (checked: boolean) => void;
  entryProblem: (entry: UnityEntry) => string;
  onUpdateEntry: (id: string, patch: Partial<UnityEntry>) => void;
  onOpenRowIssue: (entry: UnityEntry) => void;
  onOpenQualityIssue: (id: string) => void;
  onPage: (page: number) => void;
  onCheckImport: () => void;
  onRetryIssue: (id: string) => void;
  onCloseRowIssue: () => void;
  onLocateQualityIssue: () => void;
  onCloseQualityIssue: () => void;
};

type WorkspaceSlotsProps = {
  divider?: DividerProps;
  mosaic?: {
    visible: boolean;
    onCompletion: ComponentProps<typeof GameMosaicCompletionContext.Provider>["value"];
    workbench?: ComponentProps<typeof GameMosaicWorkbench>;
  };
  image: { visible: boolean; revision: number; workbench: ComponentProps<typeof UnityImageWorkbench> };
  text?: TextPanelProps;
};

export function DeploySlot({ model, actions, onFocusStep, mosaicDisabled }:
  Omit<ComponentProps<typeof UnityDeploymentPanel>, "mosaic"> & { mosaicDisabled: boolean }) {
  return <div className="unity-deployment-page">
    <UnityDeploymentPanel model={model} actions={actions} onFocusStep={onFocusStep}
      mosaic={<GameMosaicPatchButton gamePath={model.root} label="安装或卸载" disabled={mosaicDisabled} />} />
  </div>;
}

export function WorkspaceSlots({ divider, mosaic, image, text }: WorkspaceSlotsProps) {
  return <>
    {divider && <button {...divider} />}
    {mosaic && <div className="unity-image-result-pane" hidden={!mosaic.visible}>
      {mosaic.workbench && <GameMosaicCompletionContext.Provider value={mosaic.onCompletion}>
        <GameMosaicWorkbench key={mosaic.workbench.gamePath} {...mosaic.workbench} />
      </GameMosaicCompletionContext.Provider>}
    </div>}
    <div hidden={!image.visible} className="unity-image-result-pane">
      <UnityImageWorkbench key={image.revision} {...image.workbench} />
    </div>
    {text && <TextWorkspaceSlot {...text} />}
  </>;
}

function TextWorkspaceSlot({ textDropRoot, dropHandlers, active, busy, restoring, saving, testTitle, scanReady, project,
  importPreview, importMode, textFilters, matchedCount, filteredCount, errorsOnly, retryUnfinishedDisabled, search, discardDisabled, saveDisabled,
  tableRef, sourceWidth, originalRatio, sourceDivider, originalDivider, entriesLocked, checkedCount, hasMixedSelection, rows, rowJump, target, source,
  skipTargetLanguage, textScreened, qualityIssues, locateAcrossLanguages, scope, selectedCount, done, visiblePage, pageCount,
  rowIssue, rowFailure, rowRetryQueued, retryIssueDisabled, retryIssueTitle, qualityIssue, qualityIssueId,
  onDownload, onImport, onLimitChange, onFilterChange, onRetryUnfinished, onSearch, onDiscard, onSave, onCheckFiltered, entryProblem,
  onUpdateEntry, onOpenRowIssue, onOpenQualityIssue, onPage, onCheckImport, onRetryIssue, onCloseRowIssue, onLocateQualityIssue, onCloseQualityIssue }: TextPanelProps) {
  return <section ref={textDropRoot} data-game-drop-zone="text" {...dropHandlers} className={`unity-offline-workbench${importPreview ? " is-import-choice" : ""}`}>
      <div className="unity-offline-toolbar">
      <div className="unity-result-filters">
        <strong>{importPreview ? `导入预览 · ${importPreview.entries.length} 条` : "文本与译文"}</strong><GameTextFileMenu kind="download" active={active} disabled={!!busy || restoring || !scanReady || !!importPreview} options={[
          {value:"all",label:"下载全部",title:`下载工程全部 ${project?.entries.length||0} 条，包含未勾选条目`,disabled:!project?.entries.length},
          {value:"filtered",label:"下载筛选内容",title:`下载当前筛选匹配的全部 ${filteredCount} 条，包含其他分页`,disabled:!filteredCount},
        ]} onSelect={onDownload}/>
        <GameTextFileMenu kind="import" active={active} disabled={!!busy || restoring || !scanReady || !!importPreview} options={GAME_TEXT_IMPORT_CHOICES} onSelect={onImport}/>

        <GameTextFilterMenu active={active} disabled={!scanReady} value={textFilters} matched={matchedCount} shown={filteredCount}
          onLimitChange={onLimitChange} onChange={onFilterChange} />
        {errorsOnly && !importPreview && <button className="unity-btn" title={testTitle} disabled={retryUnfinishedDisabled} onClick={onRetryUnfinished}>重试未完成项</button>}
      </div>
      <div className="unity-result-tools">
        <input type="search" aria-label="搜索来源、原文和译文" data-tooltip="搜索来源、原文和译文" placeholder="搜索" value={scanReady ? search : ""} disabled={!scanReady} onChange={e => onSearch(e.target.value)} />
        <button className="unity-btn unity-text-discard" data-tooltip={importPreview?"取消此次导入预览，保留原工程":"取消当前未保存的文本勾选和译文修改，需要再次确认"} aria-label={importPreview?"取消此次导入预览，保留原工程":"取消当前未保存的文本勾选和译文修改，需要再次确认"} disabled={discardDisabled} onClick={onDiscard}>{importPreview?"取消导入":"取消修改"}</button><button className="unity-btn unity-result-save" data-tooltip={importPreview?`${importMode==="replace"?"覆盖已有译文":"仅补空白"}；保存后重置补丁与应用进度，保留图片处理结果` : "仅保存文本勾选与译文修改"} aria-label={importPreview?`${importMode==="replace"?"覆盖已有译文":"仅补空白"}；保存后重置补丁与应用进度，保留图片处理结果` : "仅保存文本勾选与译文修改"} disabled={saveDisabled} onClick={onSave}>{saving ? "保存中…" : importPreview?"保存导入":"保存"}</button>
      </div>
      </div>
      {scanReady && project ? <>
        <div className="unity-offline-table-scroll"><table ref={tableRef} className="unity-offline-table" style={{ minWidth: Math.max(560, (sourceWidth + 212) / (1 - originalRatio / 100)), "--unity-original-width": `${originalRatio}%` } as CSSProperties}><colgroup><col style={{ width: 32 }} /><col style={{ width: sourceWidth }} /><col style={{ width: "var(--unity-original-width)" }} /><col /></colgroup><thead><tr>
          <th><input type="checkbox" aria-label="勾选当前筛选结果"
            data-tooltip="仅勾选或取消当前筛选结果，包含其他分页。" disabled={entriesLocked || !!importPreview || !filteredCount}
            checked={filteredCount > 0 && checkedCount === filteredCount}
            ref={input => { if (input) input.indeterminate = hasMixedSelection; }} onChange={e => onCheckFiltered(e.target.checked)} /></th>
          <th className="unity-resizable-column">来源<button className="unity-column-divider" role="separator" aria-orientation="vertical" aria-label="调整来源列宽" aria-valuenow={Math.round(sourceWidth)} {...sourceDivider} /></th>
          <th className="unity-resizable-column">原文<button className="unity-column-divider" role="separator" aria-orientation="vertical" aria-label="调整原文和译文列宽" aria-valuenow={Math.round(originalRatio)} {...originalDivider} /></th><th>译文</th>
        </tr></thead><tbody>{rows.map(entry => <tr key={rowJump?.id === entry.id ? `${entry.id}:${rowJump.sequence}` : entry.id} data-entry-id={entry.id} tabIndex={-1} className={`${entryProblem(entry) ? "has-error" : ""}${rowJump?.id === entry.id ? ` unity-entry-target${rowJump.error ? " is-error-target" : ""}` : ""}`}>
          <td><input type="checkbox" aria-label={`选择第 ${entry.id} 条`} disabled={entriesLocked || !!importPreview} checked={entry.selected} onChange={e => onUpdateEntry(entry.id, { selected: e.target.checked })} /></td>
          <td data-tooltip={`${entry.file}\n${entry.container}\n${entry.locator}${entry.locale ? `\n语言字段：${entry.locale}` : ""}`}><span><SearchHighlight query={search} text={`#${entry.id} · ${entry.kind}${entry.locale ? ` · ${unityLanguageLabel(unityEntryLanguage(entry))}` : ""}`} /></span><small><SearchHighlight query={search} text={`${entry.file.split(/[\\/]/).pop()} · 对象 #${entry.objectId === "0" ? entry.id : entry.objectId}`} /></small>{search && [entry.file, entry.container, entry.locator].filter(value => value?.toLowerCase().includes(search.toLowerCase())).map((value, index) => <small className="search-matched-field" key={index}><SearchHighlight text={value} query={search} /></small>)}</td>
          <td className="unity-offline-source"><div className="unity-source-text" data-tooltip={entry.source}><GameTextScreenedSource completed={!!entry.translation && !entry.error && !unityTranslationError(entry.source, entry.translation) && !gameDisplayTextProblem(entry.source, entry.translation)} source={entry.source} target={target} sourceLanguage={source} locale={entry.locale} skipTarget={skipTargetLanguage} screened={entry.selected && !importPreview && (textScreened || entry.screeningDraft !== undefined || entry.translation === entry.source)} query={search} /></div></td>
          <td><div className="unity-entry-editor"><GameTextScreenedEditor screening={{ source: entry.source, target, sourceLanguage: source, locale: entry.locale, skipTarget: skipTargetLanguage, screened: entry.selected && !importPreview && (textScreened || entry.screeningDraft !== undefined || entry.translation === entry.source) }} screeningDraft={importPreview ? undefined : entry.screeningDraft} query={search} aria-label={`第 ${entry.id} 条译文`} value={entry.translation || entry.layoutDraft || ""} readOnly={entriesLocked} rows={1} onChange={e => onUpdateEntry(entry.id, { translation: e.target.value, layoutDraft: undefined, screeningDraft: undefined })} />{entryProblem(entry) && <button className="unity-row-error" data-tooltip={entry.error ? explainUnityFailure(entry.error).reason : entryProblem(entry)} aria-label={`第 ${entry.id} 条错误详情`} onClick={() => onOpenRowIssue(entry)}>!</button>}{qualityIssues.has(entry.id) && <button className="unity-row-error" style={{ color: "#9a6700", borderColor: "#d6b56a", background: "#fff8e6" }} data-tooltip={qualityIssues.get(entry.id)!.join("；")} aria-label={`第 ${entry.id} 条疑似问题`} onClick={() => onOpenQualityIssue(entry.id)}>?</button>}</div></td>
        </tr>)}</tbody></table>{!filteredCount && <div className="game-text-no-matches" role="status"><strong>没有匹配的文本</strong><span>请修改搜索词或筛选条件后重试。</span></div>}</div>
        <div className="unity-results-footer">
        {scanReady && <span aria-label="文本范围与选择统计">{locateAcrossLanguages ? "查看全部语言" : scope.label} · {selectedCount ? <>可回写 {done} / {selectedCount} 条{selectedCount !== scope.count && <> · 范围共 {scope.count} 条</>}</> : <>未选择 · 范围共 {scope.count} 条</>}</span>}
        <div className="unity-offline-pagination" aria-label="文本结果分页"><button className="unity-btn" disabled={visiblePage === 0} onClick={() => onPage(Math.max(0, visiblePage - 10))}>-10 页</button><button className="unity-btn" disabled={visiblePage === 0} onClick={() => onPage(visiblePage - 1)}>上一页</button><GamePageNumber page={visiblePage} pages={pageCount} onPage={onPage} /><button className="unity-btn" disabled={visiblePage + 1 >= pageCount} onClick={() => onPage(visiblePage + 1)}>下一页</button><button className="unity-btn" disabled={visiblePage + 1 >= pageCount} onClick={() => onPage(Math.min(pageCount - 1, visiblePage + 10))}>+10 页</button></div>
        </div>
      {rowIssue && rowFailure && <div className="unity-row-error-panel" role="dialog" aria-label={`第 ${rowIssue.id} 条错误详情`}><div className="unity-row-error-actions">{importPreview ? <button className="unity-btn" disabled={!!busy || restoring} onClick={onCheckImport}>校验当前预览</button> : <button className="unity-btn" aria-label={`重试第 ${rowIssue.id} 条`} title={testTitle} disabled={retryIssueDisabled} data-tooltip={retryIssueTitle} onClick={() => onRetryIssue(rowIssue.id)}>{rowRetryQueued ? "已在队列" : "重试此条"}</button>}<button className="unity-btn" onClick={onCloseRowIssue}>关闭</button></div><strong>第 {rowIssue.id} 条处理失败</strong><p>{rowFailure.reason}</p><p>{importPreview ? "请修改右侧预览译文，再校验或应用此次导入。" : rowFailure.action}</p>{rowFailure.technical && <details><summary>技术详情</summary><pre>{rowFailure.technical}</pre></details>}</div>}
      {qualityIssue && <div className="unity-row-error-panel" style={{ borderColor: "#d6b56a", background: "#fffaf0" }} role="dialog" aria-label={`第 ${qualityIssueId} 条疑似问题详情`}><div className="unity-row-error-actions"><button className="unity-btn" onClick={onLocateQualityIssue}>定位此条</button><button className="unity-btn" onClick={onCloseQualityIssue}>关闭</button></div><strong>第 {qualityIssueId} 条疑似问题</strong>{qualityIssue.map(issue => <p key={issue}>{issue}</p>)}<p>请结合原文和上下文复核；这些提示不会阻止生成补丁。</p></div>}
      </> : <div className="unity-offline-empty">扫描完成后显示文本与译文。</div>}
    </section>;
}
