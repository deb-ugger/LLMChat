import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { registerAppCloseGuard } from "../../appClose";
import { useClosingProgress } from "../ClosingProgress";
import type { UnityExitChoice } from "../UnityExitDialog";

export type UnityOfflineHandle = { prepareToLeave: () => Promise<boolean | "discard"> };

type ProjectSwitchOptions = {
  ref: Ref<UnityOfflineHandle>;
  active: boolean;
  hasProject: boolean;
  restoring: boolean;
  busy: string;
  imageEditorBusy: string;
  dirty: boolean;
  importPreview: object | null;
  pendingChanges: () => string[];
  importPreviewCount: () => number | undefined;
  hasRunningWork: () => boolean;
  flushParameters: () => void;
  waitForProjectWrites: () => Promise<unknown>;
  waitForTaskWrites: () => Promise<unknown>;
  abortWork: () => void;
  waitForRunningWork: () => Promise<void>;
  hasCurrentProject: () => boolean;
  applyImportPreview: () => Promise<boolean>;
  saveProject: () => Promise<unknown>;
  reportError: (message: string) => void;
};

export function useProjectSwitch({ ref, active, hasProject, restoring, busy, imageEditorBusy, dirty, importPreview,
  pendingChanges, importPreviewCount, hasRunningWork, flushParameters, waitForProjectWrites, waitForTaskWrites,
  abortWork, waitForRunningWork, hasCurrentProject, applyImportPreview, saveProject, reportError }: ProjectSwitchOptions) {
  const { phase: closingPhase, show: showClosing, clear: clearClosing } = useClosingProgress();
  const closing = useRef(false);
  const [exitPrompt, setExitPrompt] = useState<{ running: boolean; projectOnly: boolean; changes: string[] } | null>(null);
  const exitDecision = useRef<((choice: UnityExitChoice) => void) | null>(null);
  const status = useRef({ busy, dirty });
  status.current = { busy: busy || imageEditorBusy, dirty: dirty || !!importPreview };

  const requestExitChoice = (projectOnly: boolean): Promise<UnityExitChoice> => new Promise(resolve => {
    if (exitDecision.current) { resolve("cancel"); return; }
    exitDecision.current = resolve;
    const changes = pendingChanges();
    const count = importPreviewCount();
    if (count !== undefined) changes.unshift(`待应用的导入预览：${count} 条译文，含右侧编辑`);
    if (status.current.dirty && !changes.length) changes.push("工程参数或文本、图片编辑");
    if (status.current.busy) changes.push(`正在处理：${status.current.busy}`);
    setExitPrompt({ running: !!status.current.busy, projectOnly, changes });
  });
  const resolveExitChoice = (choice: UnityExitChoice) => {
    const resolve = exitDecision.current; exitDecision.current = null;
    setExitPrompt(null); resolve?.(choice);
  };

  useImperativeHandle(ref, () => ({ prepareToLeave: async () => {
    if (busy || hasRunningWork() || restoring) { reportError("请先中止任务或等待当前工作目录处理完成后切换"); return false; }
    try {
      flushParameters();
      if (dirty || importPreviewCount() !== undefined) {
        const choice = await requestExitChoice(true);
        if (choice === "cancel") return false;
        if (choice === "discard") { await Promise.allSettled([waitForProjectWrites(), waitForTaskWrites()]); return "discard"; }
        if (importPreviewCount() !== undefined && !await applyImportPreview()) return false;
        await saveProject();
      }
      await waitForTaskWrites(); return true;
    } catch (e) { reportError(String(e)); return false; }
  } }));
  useEffect(() => () => { abortWork(); exitDecision.current?.("cancel"); exitDecision.current = null; }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (!closing.current && (dirty || busy || imageEditorBusy || importPreview)) event.preventDefault(); };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy, imageEditorBusy, importPreview]);
  const needsCloseHandler = hasProject || !!busy || !!imageEditorBusy;
  const closeRelevant = active || dirty || !!busy || !!imageEditorBusy;
  useEffect(() => {
    if (!closeRelevant || !needsCloseHandler || !isTauri()) return;
    let dispose: (() => void) | undefined; let cancelled = false;
    void registerAppCloseGuard(async () => {
      if (closing.current) return false;
      closing.current = true;
      try {
        flushParameters();
        const choice = status.current.busy || status.current.dirty ? await requestExitChoice(false) : "save";
        if (choice === "cancel") return false;
        if (status.current.busy) {
          await showClosing("正在中止 Unity 任务，等待当前资源处理结束…");
          abortWork();
          await waitForRunningWork();
        }
        if (choice === "save") {
          if (importPreviewCount() !== undefined) {
            await showClosing("正在校验并保存待应用的导入预览…");
            if (!await applyImportPreview()) return false;
          }
          if (hasCurrentProject()) { await showClosing("正在保存 Unity 工程和编辑内容…"); await saveProject(); }
          await showClosing("正在等待工程文件写入完成…"); await waitForProjectWrites();
          await showClosing("正在保存任务进度与恢复信息…"); await waitForTaskWrites();
        } else {
          await showClosing("正在等待已开始的文件写入完成…");
          await Promise.allSettled([waitForProjectWrites(), waitForTaskWrites()]);
        }
        await showClosing("正在关闭窗口和后台服务…");
        return true;
      } catch (e) { reportError(`退出失败，窗口已保留：${String(e)}`); return false; }
      finally { clearClosing(); closing.current = false; }
    }).then(fn => { if (cancelled) fn(); else dispose = fn; }).catch(e => reportError(String(e)));
    return () => { cancelled = true; dispose?.(); };
  }, [closeRelevant, needsCloseHandler]);

  return { closing, closingPhase, showClosing, exitPrompt, resolveExitChoice };
}
