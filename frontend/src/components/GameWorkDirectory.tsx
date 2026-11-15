export function GameWorkDirectory({ path, onOpen, disabled = false }: { path: string; onOpen: (path: string) => void; disabled?: boolean }) {
  if (!path) return null;
  return <div className="game-work-directory"><span>工作目录</span><button type="button" className="game-work-directory-path" data-tooltip={path} aria-label={path} disabled={disabled} onClick={() => onOpen(path)}>{path}</button></div>;
}
