import { memo, Suspense, useEffect, useState, type ReactNode } from "react";

/** Initialize on first use; retain running tasks and local state after leaving. */
export const DeferredPanel = memo(function DeferredPanel({ active, label, children }: { active: boolean; label: string; children: ReactNode }) {
  const [visited, setVisited] = useState(false);
  useEffect(() => { if (active) setVisited(true); }, [active]);
  if (!active && !visited) return null;
  return (
    <Suspense fallback={
      <div className="page-loading" role="status">
        <span className="page-loading-spinner" aria-hidden="true" />
        <span>正在加载{label}</span>
      </div>
    }>
      {children}
    </Suspense>
  );
}, (previous, next) => !previous.active && !next.active);
