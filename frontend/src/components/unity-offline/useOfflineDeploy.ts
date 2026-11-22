import { useState } from "react";
import type { UnityPatch, UnityProgress, UnityProject, UnityWorkspace, unityRun } from "../../unityOffline";
import type { measureDeploymentStage } from "../../unityWorkflow";
import type { useGameActionConfirm } from "../GameActionConfirm";
import { deploymentPhases, type DeploymentModel, type DeploymentPhase } from "../UnityDeploymentPanel";
import type { DeploymentPatch } from "./offlineExport";

type DeployPorts = {
  root: string;
  run: typeof unityRun;
  measure: typeof measureDeploymentStage;
  setBusy: (label: string) => void;
  setMessage: (message: string) => void;
  logAction: (message: string, level: "info" | "error", stage?: string) => void;
  onInstallationChange?: (root: string, installed: boolean) => void;
};

type Operation = (label: string, work: () => Promise<void>) => Promise<boolean>;
type UninstallOptions<T> = {
  locked: boolean;
  confirm: ReturnType<typeof useGameActionConfirm>["confirm"];
  operation: Operation;
  beforeUninstall: () => Promise<unknown>;
  onProgress: (progress: UnityProgress) => void;
  restoreWorkspace: (workspace: UnityWorkspace<T>) => void;
  finishUninstall: () => void;
};
type RemoveLayerOptions = {
  project: UnityProject | null;
  patch: UnityPatch | null;
  locked: boolean;
  ask: ReturnType<typeof useGameActionConfirm>["ask"];
  operation: Operation;
  uninstall: () => Promise<void>;
  exportReplacement: (project: UnityProject, excluded: DeploymentPhase[]) => Promise<DeploymentPatch>;
  rememberReplacement: (project: UnityProject, patch: DeploymentPatch) => void;
};

export function useOfflineDeploy({ root, run, measure, setBusy, setMessage, logAction, onInstallationChange }: DeployPorts) {
  const [applied, setApplied] = useState(false);
  const [installed, setInstalled] = useState(false);

  async function applyPatch(result: UnityPatch, onProgress?: (value: UnityProgress) => void, signal?: AbortSignal, discardOnStop = false) {
    setBusy("应用到游戏");
    const response = await measure(root, "apply",
      () => run<{ files?: number; restoredPatches: number }>("apply", { root, path: result.folder, discardOnStop }, progress => {
        if (progress.detail.includes("旧补丁")) logAction(progress.detail, "info", "补丁恢复");
        onProgress?.(progress);
      }, signal),
      applied => applied.files ?? result.files,
    ).catch(async cause => {
      try {
        const [status] = await run<Array<{ installed: boolean }>>("installation-status", { roots: [root] });
        setInstalled(status.installed);
        setApplied(false);
        onInstallationChange?.(root, status.installed);
      } catch (statusError) {
        logAction(`读取补丁恢复状态失败：${String(statusError)}`, "error");
      }
      throw cause;
    });
    setApplied(true); setInstalled(true); onInstallationChange?.(root, true);
    setMessage(`${response.restoredPatches > 0 ? `已卸载 ${response.restoredPatches} 个旧补丁并完成替换。` : ""}已将 ${result.files} 个补丁文件应用到游戏。原件保存在补丁目录的 original 文件夹，实际显示请启动游戏检查。`);
  }

  async function uninstallPatch<T>({ locked, confirm, operation, beforeUninstall, onProgress, restoreWorkspace,
    finishUninstall }: UninstallOptions<T>) {
    if (!installed || locked || !await confirm("卸载嵌字翻译补丁并恢复游戏原件？工程、译文、补丁及原件备份会保留。请先关闭游戏。", { title: "卸载补丁", kind: "warning", okLabel: "卸载补丁", cancelLabel: "取消" })) return;
    await operation("卸载补丁", async () => {
      await beforeUninstall();
      const workspace = await run<UnityWorkspace<T>>("uninstall", { root }, progress => {
        setMessage(progress.detail);
        onProgress(progress);
      });
      restoreWorkspace(workspace);
      setInstalled(workspace.installed); setApplied(false); onInstallationChange?.(root, workspace.installed);
      finishUninstall();
      setMessage("补丁已卸载，游戏原件已恢复；工程、译文和备份已保留。");
    });
  }

  async function removeLayer(phase: DeploymentPhase, { project, patch, locked, ask, operation, uninstall,
    exportReplacement, rememberReplacement }: RemoveLayerOptions) {
    if (!project || !applied || !installed || !patch || locked) return;
    const layers = patch as DeploymentPatch;
    const present = deploymentPhases.filter(id => id === "text" ? layers.entries || layers.fontReplacements
      : id === "image" ? layers.images : layers.mosaicImages);
    if (!present.includes(phase)) return;
    if (present.length === 1) { await uninstall(); return; }
    const label = phase === "text" ? "文本" : phase === "image" ? "译图" : "去码图";
    if (!await ask("卸载" + label, "将根据当前工程重新生成其余已安装的部分并替换游戏补丁。请先关闭游戏。")) return;
    await operation("卸载" + label, async () => {
      const excluded = deploymentPhases.filter(id => id === phase || !present.includes(id));
      const replacement = await exportReplacement(project, excluded);
      await applyPatch(replacement);
      rememberReplacement(project, replacement);
    });
  }

  return { applied, setApplied, installed, setInstalled, applyPatch, uninstallPatch, removeLayer };
}

type DeploymentProgress = UnityProgress & { step: number; state: "pending" | "running" | "done" | "stopped" | "error" | "skipped" };

export function mapOfflineDeploymentProgress(generation: DeploymentProgress | null, runLabel?: string): DeploymentModel["progress"] {
  if (!generation || generation.state === "done" || generation.state === "skipped") return null;
  return {
    percent: generation.total ? Math.min(100, Math.round((generation.completed / generation.total) * 100)) : null,
    state: generation.state === "error" ? "error" : generation.state === "running" ? "active" : "todo",
    detail: generation.detail,
    label: runLabel ?? (generation.step === 4 ? "应用到游戏" : "生成补丁"),
  };
}
