import { memo, Suspense, useEffect, useState, type ReactNode } from "react";

/** Initialize on first use; retain running tasks and local state after leaving. */
export const DeferredPanel = memo(function DeferredPanel({ active, children }: { active: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(false);
  useEffect(() => { if (active) setVisited(true); }, [active]);
  if (!active && !visited) return null;
  return <Suspense fallback={<div role="status">正在加载…</div>}>{children}</Suspense>;
}, (previous, next) => !previous.active && !next.active);
