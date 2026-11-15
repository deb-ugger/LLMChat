import type { ButtonHTMLAttributes } from "react";

export function UnityIconButton({ title, className = "", children, disabled, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> & { title: string }) {
  return <span className="unity-icon-button-wrap" data-tooltip={title} tabIndex={disabled ? 0 : undefined} aria-label={disabled ? title : undefined}>
    <button {...props} type={props.type || "button"} disabled={disabled} className={`unity-btn unity-header-icon ${className}`} aria-label={props["aria-label"] || title}>{children}</button>
  </span>;
}
