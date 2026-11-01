import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes } from "react";
import { createPortal } from "react-dom";

export function unityTooltipPosition(anchor: { left: number; top: number; bottom: number; width: number }, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const left = Math.max(8, Math.min(anchor.left + (anchor.width - width) / 2, viewportWidth - width - 8));
  const below = anchor.bottom + 8;
  return { left, top: below + height <= viewportHeight - 8 ? below : Math.max(8, anchor.top - height - 8) };
}

export function UnityIconButton({ title, className = "", children, disabled, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> & { title: string }) {
  const id = useId();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!anchor || !tip.current) return;
    const box = tip.current.getBoundingClientRect();
    const position = unityTooltipPosition(anchor, box.width, box.height, window.innerWidth, window.innerHeight);
    tip.current.style.left = `${position.left}px`; tip.current.style.top = `${position.top}px`;
  }, [anchor, title]);
  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    window.addEventListener("scroll", close, true); window.addEventListener("resize", close); window.addEventListener("blur", close);
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); window.removeEventListener("blur", close); };
  }, [anchor]);
  return <span className="unity-icon-button-wrap" tabIndex={disabled ? 0 : undefined} aria-label={disabled ? title : undefined}
    onPointerEnter={event => setAnchor(event.currentTarget.getBoundingClientRect())} onPointerLeave={() => setAnchor(null)}
    onFocus={event => setAnchor(event.currentTarget.getBoundingClientRect())} onBlur={() => setAnchor(null)}>
    <button {...props} type={props.type || "button"} disabled={disabled} className={`unity-btn unity-header-icon ${className}`} aria-describedby={anchor ? id : undefined}>{children}</button>
    {anchor && createPortal(<div ref={tip} id={id} role="tooltip" className="unity-icon-tooltip" style={{ left: anchor.left, top: anchor.bottom + 8 }}>{title}</div>, document.body)}
  </span>;
}
