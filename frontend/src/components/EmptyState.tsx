import type { HTMLAttributes, ReactNode } from "react";

type EmptyStateProps = Omit<HTMLAttributes<HTMLDivElement>, "children" | "title"> & {
  title: ReactNode;
  icon?: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  size?: "sm" | "md";
};

export function EmptyState({ title, icon, hint, action, size = "md", className, ...props }: EmptyStateProps) {
  return <div {...props} className={["empty-state", "empty-state-" + size, className].filter(Boolean).join(" ")}>
    {icon && <span className="empty-state-icon" aria-hidden="true">{icon}</span>}
    <div className="empty-state-title">{title}</div>
    {hint && <div className="empty-state-hint">{hint}</div>}
    {action && <div className="empty-state-action">{action}</div>}
  </div>;
}
