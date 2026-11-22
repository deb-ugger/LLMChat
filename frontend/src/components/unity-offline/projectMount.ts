import { useEffect } from "react";
import type { UnityInspection, UnityProject, UnityWorkspace, legacyUnityOutputDirectory, unityRun } from "../../unityOffline";
import { sameUnityGamePath } from "../../unityTranslation";

type MountCheckpoint = {
  projectFolder: string;
  scanFolder: string;
  previousProjectFolder?: string;
  includeCode: boolean;
};
type MountPorts<T extends MountCheckpoint> = {
  run: typeof unityRun;
  outputDirectory: typeof legacyUnityOutputDirectory;
  readLegacyTask: () => string | null;
  removeLegacyTask: () => void;
  resetView: () => void;
  resetScreening: () => void;
  setLoadingDetail: (detail: string) => void;
  setRestoring: (restoring: boolean) => void;
  setInspection: (inspection: UnityInspection | null) => void;
  setInspectionError: (message: string) => void;
  reportError: (message: string) => void;
  reportRestore: (notices: string[]) => void;
  setWorkspaceFolders: (workspace: UnityWorkspace<T>) => void;
  loadProject: (folder: string, previousFolder?: string, onLoading?: (detail: string) => void) => Promise<UnityProject>;
  projectCheckpoint: (project: UnityProject, incomplete: boolean, completed: number | null, total: number | null) => T;
  restoreView: (workspace: UnityWorkspace<T>, project: UnityProject | null, checkpoint: T | null) => void;
  waitForTaskWrites: () => Promise<unknown>;
};

export function useProjectMount<T extends MountCheckpoint>(root: string, ports: MountPorts<T>) {
  const { run, outputDirectory, readLegacyTask, removeLegacyTask, resetView, resetScreening, setLoadingDetail,
    setRestoring, setInspection, setInspectionError, reportError, reportRestore, setWorkspaceFolders, loadProject,
    projectCheckpoint, restoreView, waitForTaskWrites } = ports;

  useEffect(() => {
    let cancelled = false; setInspection(null); setInspectionError("");
    if (root) void run<UnityInspection>("inspect", { root }).then(result => { if (!cancelled) setInspection(result); }).catch(error => { if (!cancelled) setInspectionError(String(error)); });
    return () => { cancelled = true; };
  }, [root]);

  useEffect(() => {
    resetView();
    let cancelled = false;
    const saved = readLegacyTask();
    if (!root) { setRestoring(false); return; }
    setLoadingDetail("正在读取工作目录与任务检查点…");
    resetScreening();
    setRestoring(true);
    const loading = (detail: string) => { if (!cancelled) setLoadingDetail(detail); };
    void (async () => {
      try {
        const workspace = await run<UnityWorkspace<T>>("workspace", { root, outputRoot: await outputDirectory(), task: saved ? JSON.parse(saved) : null },
          progress => loading(progress.detail));
        if (cancelled) return;
        setWorkspaceFolders(workspace);
        reportRestore(workspace.saved.notices);
        let value = workspace.task;
        const folder = value?.projectFolder || value?.scanFolder;
        let p: UnityProject | null;
        if (folder) p = await loadProject(folder, value?.previousProjectFolder, loading);
        else {
          const found = workspace.saved;
          if (cancelled) return;
          reportRestore(found.notices); p = found.project;
          if (p) {
            const incomplete = found.scanTotal !== null;
            if (!value) value = projectCheckpoint(p, incomplete, found.scanCompleted, found.scanTotal);
            else { value.projectFolder = p.folder; if (incomplete) value.scanFolder = p.folder; }
            if (found.includeCode !== null) value.includeCode = found.includeCode;
          }
        }
        if (cancelled) return;
        setLoadingDetail(p ? `正在恢复 ${p.entries.length.toLocaleString("zh-CN")} 条原文、译文及处理进度…` : "正在准备项目操作界面…");
        if (p && !sameUnityGamePath(p.root, root)) throw new Error("检查点不属于当前游戏");
        restoreView(workspace, p, value);
        await waitForTaskWrites();
        if (!cancelled) removeLegacyTask();
      } catch (e) { if (!cancelled) reportError(`恢复检查点失败：${e instanceof Error ? e.message : String(e)}`); }
      finally { if (!cancelled) setRestoring(false); }
    })();
    return () => { cancelled = true; };
  }, [root]);
}
