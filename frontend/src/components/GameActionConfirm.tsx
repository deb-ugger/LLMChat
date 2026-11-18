import { Children, isValidElement, useEffect, useId, useRef, useState, type ReactNode, type MouseEvent } from "react";
import { createPortal } from "react-dom";

export function logGameButton(event: MouseEvent<HTMLElement>, output: (text: string) => void) {
  const button = (event.target as Element).closest<HTMLButtonElement>("button");
  if (!button || button.disabled) return;
  const label = button.getAttribute("aria-label") || button.textContent?.trim() || button.title;
  // Capture processing actions only. Tabs, resizing, preview, pagination,
  // filters and menus change the view, not the project or its progress.
  if (label && /^(?:(?:开始|继续|恢复|中止|停止)(?:筛选|识别|翻译|扫描|处理|读取|断行|一键流程).*|中止|停止|重新(?:筛选|识别|翻译|扫描|生成译图).*|清理(?:译文|图片|缓存).*|重做(?:翻译|断行|图片处理|此步)|跳过剩余.*|生成补丁|应用(?:到游戏|译图)|卸载(?:补丁|译图)|安装(?:翻译插件|插件框架)|保存(?:修改|导入|工程|图片与译文修改)?|取消(?:修改|当前修改|导入)|下载(?:全部|筛选内容)|(?:识别|翻译)(?:图片|所选|所选图片|当前图片)?|重绘|替换(?:译图)?)$/.test(label)) output(`操作：${label}`);
}
export function GameDialog({ title, description, onCancel, disabled = false, children, details, className }: {
  title: string; description: string; onCancel: () => void; disabled?: boolean; children: ReactNode; details?: ReactNode; className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null), id = useId();
  const actions = Children.toArray(children);
  const isCancel = (node: ReactNode) => isValidElement<{ className?: string }>(node) && node.props.className?.split(/\s+/).includes("game-confirm-cancel") ? 1 : 0;
  actions.sort((a, b) => isCancel(a) - isCancel(b));
  useEffect(() => { const previous = document.activeElement; const el = ref.current!; el.showModal(); return () => { el.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  return createPortal(<dialog ref={ref} className={className ? `game-action-confirm ${className}` : "game-action-confirm"} aria-labelledby={id} aria-describedby={`${id}-body`} onCancel={event => { event.preventDefault(); if (!disabled) onCancel(); }}>
    <header><h2 id={id}>{title}</h2><button type="button" className="game-confirm-close" aria-label="关闭提示" disabled={disabled} onClick={onCancel}>×</button></header>
    <p id={`${id}-body`}>{description}</p>{details && <section className="game-confirm-details">{details}</section>}
    <footer>{actions}</footer>
  </dialog>, document.body);
}
type Options = { title?: string; okLabel?: string; cancelLabel?: string; kind?: string };
type Question = { title: string; description: string; accept: string; cancel: string; kind?: string; resolve: (accepted: boolean) => void };
export function useGameActionConfirm(output?: (text: string) => void) {
  const [question, setQuestion] = useState<Question | null>(null);
  const pending = useRef<((accepted: boolean) => void) | null>(null), logger = useRef(output); logger.current = output;
  useEffect(() => () => pending.current?.(false), []);
  const request = (title: string, description: string, accept: string, cancel: string, kind = "warning") => new Promise<boolean>(resolve => {
    const finish = (accepted: boolean) => { pending.current = null; setQuestion(null); if (accepted) logger.current?.(`已确认：${title}`); resolve(accepted); };
    pending.current?.(false); pending.current = finish; setQuestion({ title, description, accept, cancel, kind, resolve: finish });
  });
  const ask = (title: string, description: string, accept = "确认清理") => request(title, description, accept, "取消");
  const confirm = (description: string, options: Options = {}) => request(options.title || "确认操作", description, options.okLabel || "确定", options.cancelLabel || "取消", options.kind || "warning");
  const dialog = question && <GameDialog title={question.title} description={question.description} onCancel={() => question.resolve(false)}>
    <button type="button" className="game-confirm-cancel" autoFocus onClick={() => question.resolve(false)}>{question.cancel}</button>
    <button type="button" className={question.kind === "info" ? "game-confirm-primary" : "game-confirm-accept"} onClick={() => question.resolve(true)}>{question.accept}</button>
  </GameDialog>;
  return { ask, confirm, dialog };
}
