import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { API_BASE } from "../api";
import { showAppNotice } from "./AppNotice";
import { GameDialog } from "./GameActionConfirm";

type Destination = { id: string; label: string };
type PatchStatus = { destinations: Destination[]; patch?: { name: string; files: number; state: string; layer: string } };
type PatchFile = { path: string; size: number; modified: string; replace: boolean };
type Plan = { files: PatchFile[]; ignored: number };

export function GameMosaicPatchButton({ gamePath, disabled }: { gamePath: string; disabled?: boolean }) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<PatchStatus>();
  const [target, setTarget] = useState("game");
  const [mode, setMode] = useState<"package" | "rule">("package");
  const [source, setSource] = useState("");
  const [plan, setPlan] = useState<Plan>();
  const [shader, setShader] = useState("");
  const [texture, setTexture] = useState("");
  const [slot, setSlot] = useState("ib");
  const [confirm, setConfirm] = useState<"install" | "rule" | "uninstall">();

  const request = async <T,>(action: string, payload: object = {}): Promise<T> => {
    const response = await fetch(API_BASE + "/api/game-mosaic/" + action, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gamePath, target, ...payload }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "去码补丁操作失败");
    return result;
  };
  const execute = async (work: () => Promise<void>) => {
    setBusy(true);
    try { await work(); }
    catch (error) { showAppNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally { setBusy(false); }
  };
  const show = () => {
    setVisible(true); setPlan(undefined); setStatus(undefined); setConfirm(undefined);
    void execute(async () => {
      const current = await request<PatchStatus>("status");
      setStatus(current);
      setMode(current.patch?.layer === "package" ? "rule" : "package");
      if (!current.destinations.some(option => option.id === target)) setTarget("game");
    });
  };
  const chooseFolder = async () => {
    const folder = await open({ directory: true, multiple: false });
    if (typeof folder === "string") { setSource(folder); setPlan(undefined); }
  };
  const apply = () => {
    const action = confirm;
    setConfirm(undefined);
    if (!action) return;
    void execute(async () => {
      const payload = action === "install" ? { source, files: plan?.files }
        : action === "rule" ? { shader: shader.trim(), texture: texture.trim(), slot } : {};
      const response = await request<PatchStatus>(action, payload);
      setStatus(response);
      if (response.patch?.layer === "package") setMode("rule");
      else if (action === "uninstall") setMode("package");
      setPlan(undefined);
      showAppNotice(action === "uninstall" ? "去码补丁已撤销，原文件已恢复" : "去码补丁已应用", "success");
    });
  };
  const patch = status?.patch;
  const canAddRule = !patch || patch.layer === "package" && patch.state === "applied";
  const actionLabel = confirm === "uninstall" ? "恢复原文件" : confirm === "rule" ? "应用渲染规则" : "安装补丁";
  const description = confirm
    ? "请先关闭游戏。操作会保留备份，供之后恢复原文件。"
    : "管理当前 UE 或 Unity 游戏的去码补丁。只导入可信来源的文件。";

  return <>
    <button type="button" className="unity-btn" disabled={disabled} onClick={show}>去码补丁</button>
    {visible && <GameDialog title={confirm ? actionLabel : "去码补丁"} description={description} className="game-mosaic-dialog"
      onCancel={() => confirm ? setConfirm(undefined) : setVisible(false)} disabled={busy}
      details={confirm ? (patch && confirm === "uninstall" ? <p>{patch.name} · {patch.files} 个文件</p> : undefined)
        : <div className="game-mosaic-body">
          {busy && <p role="status">正在处理补丁…</p>}
          {patch && <div className="game-mosaic-installed">
            <span><strong>{patch.name}</strong><small>{patch.files} 个文件 · {patch.state === "applied" ? "已安装" : "待恢复"}</small></span>
            <button type="button" className="unity-btn" disabled={busy || disabled} onClick={() => setConfirm("uninstall")}>恢复原文件</button>
          </div>}
          {status && canAddRule && <>
            {!patch && <div className="game-mosaic-options" role="group" aria-label="补丁方式">
              <button type="button" className="unity-btn" aria-pressed={mode === "package"} disabled={busy}
                onClick={() => setMode("package")}>导入补丁目录</button>
              <button type="button" className="unity-btn" aria-pressed={mode === "rule"} disabled={busy}
                onClick={() => setMode("rule")}>3Dmigoto 规则</button>
            </div>}
            <label>目标位置<select value={target} disabled={busy} onChange={event => {setTarget(event.currentTarget.value); setPlan(undefined);}}>
              {status.destinations.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select></label>
            {mode === "package" ? <>
              <p className="hint">选择与目标位置对应的补丁目录。补丁分 x86 和 x64 时，只选择匹配游戏的那一层。</p>
              <div className="game-mosaic-options">
                <button type="button" className="unity-btn" disabled={busy} onClick={() => void chooseFolder()}>选择已解压目录</button>
                {source && <code data-tooltip={source}>{source}</code>}
              </div>
              <button type="button" className="unity-btn" disabled={busy || !source}
                onClick={() => void execute(async () => { setPlan(undefined); setPlan(await request<Plan>("preview",{source})); })}>检查文件清单</button>
              {plan && <>
                <p role="status">{plan.files.length} 个文件 · {plan.files.filter(file => file.replace).length} 个将替换{plan.ignored ? " · 跳过 " + plan.ignored + " 个非补丁文件" : ""}</p>
                <ul className="game-mosaic-files">{plan.files.map(file => <li key={file.path}>
                  <code data-tooltip={file.path}>{file.path}</code><span>{file.replace ? "替换" : "新增"}</span>
                </li>)}</ul>
              </>}
            </> : <>
              <p className="hint">适用于已安装 3Dmigoto 的 DX11 游戏。请填写在当前游戏中确认过的哈希。</p>
              <label>着色器哈希<input value={shader} maxLength={16} disabled={busy}
                placeholder="16 位十六进制" onChange={event => setShader(event.currentTarget.value)} /></label>
              <label>纹理或缓冲区哈希（可选）<input value={texture} maxLength={8} disabled={busy}
                placeholder="8 位十六进制" onChange={event => setTexture(event.currentTarget.value)} /></label>
              {!!texture && <label>绑定槽<select value={slot} disabled={busy} onChange={event => setSlot(event.currentTarget.value)}>
                {["ib","vb0","vb1","vb2","ps-t0","ps-t1","ps-t2","ps-t3","vs-t0"].map(value => <option key={value}>{value}</option>)}
              </select></label>}
            </>}
          </>}
        </div>}>
      {confirm ? <>
        <button type="button" className="game-confirm-accept" disabled={disabled || busy} onClick={apply}>{actionLabel}</button>
        <button type="button" className="game-confirm-cancel" onClick={() => setConfirm(undefined)}>返回</button>
      </> : <>
        {status && canAddRule && (mode === "package"
          ? !!plan?.files.length && <button type="button" className="game-confirm-primary" disabled={disabled || busy} onClick={() => setConfirm("install")}>安装补丁</button>
          : <button type="button" className="game-confirm-primary" disabled={disabled || busy || !/^[\da-f]{16}$/i.test(shader) || !!texture && !/^[\da-f]{8}$/i.test(texture)}
            onClick={() => setConfirm("rule")}>应用规则</button>)}
        <button type="button" className="game-confirm-cancel" disabled={busy} onClick={() => setVisible(false)}>关闭</button>
      </>}
    </GameDialog>}
  </>;
}
