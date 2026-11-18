import type { ReactNode } from "react";

const glyphs: Record<string, ReactNode> = {
  chat: <path d="M20 14a3 3 0 0 1-3 3h-6l-5 4v-4a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3zM7 8h9M7 12h6" />,
  literature: <><path d="M12 6C9 3 5 3 2.5 4v15c3-1 6.5-1 9.5 1 3-2 6.5-2 9.5-1V4C19 3 15 3 12 6Z"/><path d="M12 6v14"/></>,
  image: <><rect x="1.5" y="2" width="10" height="9" rx="1.5"/><circle cx="4.5" cy="4.8" r=".7" fill="currentColor"/><path d="m2 9 3-3 3 3 1.5-2 2 2M2 22 22 2M13 15v-2h9v2m-4.5-2v9M15 22h5"/></>,
  speech: <><rect x="4" y="1.5" width="4" height="7" rx="2"/><path d="M1.5 6.5V8a4.5 4.5 0 0 0 9 0V6.5M6 12.5V14M4 14h4M2 22 22 2M13 15v-2h9v2m-4.5-2v9M15 22h5"/></>,
  text: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 12h8M8 16h6"/></>,
  unity: <><path d="M7 7h10c2 0 3 2 3.5 4l1 6c.5 3-2 4-4 2l-3-3h-5l-3 3c-2 2-4.5 1-4-2l1-6C4 9 5 7 7 7Z"/><path d="M7 10v5m-2.5-2.5h5M16 11h.1M19 14h.1"/></>,
  stats: <><path d="M3 3v17h18M7 16v-5m5 5V6m5 10V9"/></>,
  settings: <><path d="M4 6h8m5 0h3M4 12h2m5 0h9M4 18h11m5 0h1"/><circle cx="14.5" cy="6" r="2.5"/><circle cx="8.5" cy="12" r="2.5"/><circle cx="17.5" cy="18" r="2.5"/></>,
};

export function FeatureIcon({ feature, size = 18 }: { feature: string; size?: number }) {
  const glyph = glyphs[feature];
  return glyph ? <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{glyph}</svg> : null;
}
