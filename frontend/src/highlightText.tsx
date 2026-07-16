import type { ReactNode } from "react";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** HTML string with <mark class="search-hit-mark"> around matches. */
export function highlightSearchHtml(str: string, query: string): string {
  const q = query.trim();
  if (!q || !str) return escapeHtml(str);
  const lower = str.toLowerCase();
  const needle = q.toLowerCase();
  if (!lower.includes(needle)) return escapeHtml(str);

  let out = "";
  let i = 0;
  while (i < str.length) {
    const idx = lower.indexOf(needle, i);
    if (idx < 0) {
      out += escapeHtml(str.slice(i));
      break;
    }
    if (idx > i) out += escapeHtml(str.slice(i, idx));
    out += `<mark class="search-hit-mark">${escapeHtml(
      str.slice(idx, idx + q.length),
    )}</mark>`;
    i = idx + q.length;
  }
  return out;
}

/** React nodes with <mark> around query matches (for search result lists). */
export function highlightSearchNodes(str: string, query: string): ReactNode {
  const q = query.trim();
  if (!q || !str) return str;
  const lower = str.toLowerCase();
  const needle = q.toLowerCase();
  if (!lower.includes(needle)) return str;

  const nodes: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < str.length) {
    const idx = lower.indexOf(needle, i);
    if (idx < 0) {
      nodes.push(str.slice(i));
      break;
    }
    if (idx > i) nodes.push(str.slice(i, idx));
    nodes.push(
      <mark key={key++} className="search-hit-mark">
        {str.slice(idx, idx + q.length)}
      </mark>,
    );
    i = idx + q.length;
  }
  return nodes;
}
