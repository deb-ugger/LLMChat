import type { KeyboardEvent } from "react";

export type ImageTool = {
  id: string; label: string; key: string; shortcut: string;
  modifier?: string; disabled?: boolean; pressed?: boolean; reason?: string;
  icon: string; run: () => void;
};

export function runImageToolShortcut(event: KeyboardEvent<HTMLElement>, tools: readonly ImageTool[], hasSelection = false) {
  if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.repeat ||
      (event.target as Element).closest("input, textarea, select, [contenteditable]")) return;
  const modifier = event.ctrlKey || event.metaKey ? "command" : event.shiftKey ? "shift" : undefined;
  if (modifier === "command" && event.shiftKey) return;
  const action = tools.find(item => item.key === event.key.toLowerCase() && (item.modifier === modifier ||
    (item.id === "clear" && hasSelection && modifier === "shift")));
  if (!action || action.disabled) return;
  event.preventDefault(); event.stopPropagation(); action.run();
}

export function ImageMaskToolbar({ tools, hasSelection = false }: { tools: readonly ImageTool[]; hasSelection?: boolean }) {
  return <div className="game-mosaic-image-tools" role="group" aria-label="原图蒙版工具" onDoubleClick={event => event.stopPropagation()}>
    {tools.map(tool => <button key={tool.id} type="button" className="game-mosaic-image-tool" data-tool={tool.id}
      aria-label={tool.label} aria-pressed={tool.pressed}
      aria-keyshortcuts={tool.modifier === "command" ? "Control+Z Meta+Z" : tool.id === "clear" && hasSelection ? "Delete Shift+Delete" : tool.shortcut}
      data-tooltip={[tool.label + " · " + tool.shortcut, tool.reason].filter(Boolean).join("\n")} disabled={tool.disabled} onClick={tool.run}>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={tool.icon} /></svg>
    </button>)}
  </div>;
}

export function MaskResizeControls({ box }: { box: readonly [number, number, number, number] }) {
  const [left, top, right, bottom] = box;
  const sides = [["n", left, top, right, top], ["s", left, bottom, right, bottom],
    ["w", left, top, left, bottom], ["e", right, top, right, bottom]] as const;
  const corners = [["nw", left, top], ["ne", right, top], ["sw", left, bottom], ["se", right, bottom]] as const;
  return <g aria-hidden="true">
    {sides.map(([edge, x1, y1, x2, y2]) => <line key={edge} data-mosaic-resize={edge}
      className="game-mosaic-resize-edge" x1={x1} y1={y1} x2={x2} y2={y2} vectorEffect="non-scaling-stroke" />)}
    {corners.map(([edge, x, y]) => <line key={edge} data-mosaic-resize={edge}
      className="game-mosaic-resize-corner" x1={x} y1={y} x2={x + .01} y2={y} vectorEffect="non-scaling-stroke" />)}
  </g>;
}
