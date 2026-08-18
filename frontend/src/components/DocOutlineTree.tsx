import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { highlightSearchNodes } from "../highlightText";

/** Shared outline node for PDF / EPUB sidebars. */
export type DocOutlineNode = {
  title: string;
  pageNumber?: number | null;
  /** PDF destination (resolved on click when pageNumber missing). */
  dest?: unknown;
  /** EPUB nav href. */
  href?: string;
  items: DocOutlineNode[];
};

function collectOutlineBranchKeys(
  items: DocOutlineNode[],
  prefix = "",
): string[] {
  const keys: string[] = [];
  items.forEach((it, i) => {
    const key = prefix ? `${prefix}.${i}` : `${i}`;
    if (it.items.length > 0) {
      keys.push(key);
      keys.push(...collectOutlineBranchKeys(it.items, key));
    }
  });
  return keys;
}

function defaultCollapsedKeys(items: DocOutlineNode[]): Set<string> {
  const initial = new Set<string>();
  for (const key of collectOutlineBranchKeys(items)) {
    if (key.includes(".")) initial.add(key);
  }
  return initial;
}

function outlineAncestorKeys(key: string): string[] {
  const parts = key.split(".");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    out.push(parts.slice(0, i).join("."));
  }
  return out;
}

function findOutlineNode(
  items: DocOutlineNode[],
  key: string,
): DocOutlineNode | null {
  const parts = key.split(".").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  let list = items;
  let node: DocOutlineNode | null = null;
  for (const idx of parts) {
    node = list[idx] ?? null;
    if (!node) return null;
    list = node.items;
  }
  return node;
}

function outlineRevealExpandKeys(
  items: DocOutlineNode[],
  activeKey: string,
): string[] {
  const keys = [...outlineAncestorKeys(activeKey)];
  let node = findOutlineNode(items, activeKey);
  let key = activeKey;
  while (node && node.items.length > 0) {
    keys.push(key);
    key = `${key}.0`;
    node = node.items[0] ?? null;
  }
  return keys;
}

/** PDF: last outline entry with page <= currentPage. */
export function findActiveOutlineKeyByPage(
  items: DocOutlineNode[],
  currentPage: number,
): string | null {
  if (!Number.isFinite(currentPage) || currentPage < 1) return null;
  let best: string | null = null;
  const walk = (list: DocOutlineNode[], prefix: string) => {
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const key = prefix ? `${prefix}.${i}` : `${i}`;
      if (it.pageNumber != null && it.pageNumber <= currentPage) {
        best = key;
      }
      if (it.items.length > 0) walk(it.items, key);
    }
  };
  walk(items, "");
  return best;
}

function normalizeHref(href: string): string {
  return href
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .split("#")[0]
    .toLowerCase();
}

/**
 * EPUB: prefer exact / suffix match on chapter href; last match in TOC order wins
 * (mirrors PDF's "deepest / latest" preference). Keeps #fragment when both sides have it.
 */
export function findActiveOutlineKeyByHref(
  items: DocOutlineNode[],
  currentHref: string,
): string | null {
  const raw = (currentHref || "").trim().replace(/\\/g, "/");
  if (!raw) return null;
  const curFull = raw.replace(/^\.\//, "").toLowerCase();
  const curBase = normalizeHref(raw);
  let best: string | null = null;
  let bestScore = -1;
  const walk = (list: DocOutlineNode[], prefix: string) => {
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const key = prefix ? `${prefix}.${i}` : `${i}`;
      const hrefRaw = (it.href || "").trim().replace(/\\/g, "/");
      const hrefFull = hrefRaw.replace(/^\.\//, "").toLowerCase();
      const hrefBase = normalizeHref(hrefRaw);
      if (hrefBase) {
        let score = 0;
        if (curFull === hrefFull) score = 5;
        else if (curFull.split("#")[0] === hrefFull.split("#")[0] && hrefFull.includes("#") && curFull.includes("#")) {
          // same file, different fragment — only count if fragment matches
          if (curFull === hrefFull) score = 5;
        } else if (curBase === hrefBase) score = 3;
        else if (curBase.endsWith("/" + hrefBase) || curBase.endsWith(hrefBase))
          score = 2;
        else if (hrefBase.endsWith(curBase)) score = 1;
        if (score > 0 && score >= bestScore) {
          bestScore = score;
          best = key;
        }
      }
      if (it.items.length > 0) walk(it.items, key);
    }
  };
  walk(items, "");
  return best;
}

/**
 * Prefer location-based active chapter when TOC items have pageNumber
 * from book.locations (1-based). Same rule as PDF pages.
 */
export function findActiveOutlineKeyByLocation(
  items: DocOutlineNode[],
  currentLocation: number,
): string | null {
  if (!Number.isFinite(currentLocation) || currentLocation < 0) return null;
  // pageNumber is 1-based ≈ location index + 1
  const currentPage = Math.floor(currentLocation) + 1;
  return findActiveOutlineKeyByPage(items, currentPage);
}

function collectOutlineTitleMatches(
  items: DocOutlineNode[],
  query: string,
  prefix = "",
  matches = new Set<string>(),
  visible = new Set<string>(),
): { matches: Set<string>; visible: Set<string> } {
  const q = query.trim().toLowerCase();
  if (!q) return { matches, visible };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const key = prefix ? `${prefix}.${i}` : `${i}`;
    const selfHit = it.title.toLowerCase().includes(q);
    collectOutlineTitleMatches(it.items, query, key, matches, visible);
    let hasVisibleChild = false;
    for (let j = 0; j < it.items.length; j++) {
      if (visible.has(`${key}.${j}`)) {
        hasVisibleChild = true;
        break;
      }
    }
    if (selfHit) matches.add(key);
    if (selfHit || hasVisibleChild) visible.add(key);
  }
  return { matches, visible };
}

function OutlineBranch({
  items,
  onActivate,
  depth,
  path,
  collapsed,
  onToggle,
  titleQuery,
  visibleKeys,
  activeKey,
}: {
  items: DocOutlineNode[];
  onActivate: (node: DocOutlineNode) => void;
  depth: number;
  path: string;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  titleQuery: string;
  visibleKeys: Set<string> | null;
  activeKey: string | null;
}) {
  const level = Math.min(Math.max(depth, 0), 4);
  const q = titleQuery.trim();
  return (
    <ul className={`pdf-outline-list is-depth-${level}`}>
      {items.map((it, i) => {
        const key = path ? `${path}.${i}` : `${i}`;
        if (visibleKeys && !visibleKeys.has(key)) return null;
        const hasKids =
          it.items.length > 0 &&
          (!visibleKeys ||
            it.items.some((_, j) => visibleKeys.has(`${key}.${j}`)));
        const isCollapsed = hasKids && collapsed.has(key);
        const isActive = activeKey === key;
        return (
          <li key={key} className={isCollapsed ? "is-collapsed" : undefined}>
            <div
              className={`pdf-outline-row is-l${level}${isActive ? " is-active" : ""}`}
              data-outline-key={key}
            >
              {hasKids ? (
                <button
                  type="button"
                  className={`pdf-outline-twist${isCollapsed ? " is-collapsed" : ""}`}
                  aria-expanded={!isCollapsed}
                  aria-label={isCollapsed ? "展开" : "折叠"}
                  title={isCollapsed ? "展开" : "折叠"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(key);
                  }}
                >
                  <span className="pdf-outline-twist-icon" aria-hidden />
                </button>
              ) : (
                <span className="pdf-outline-twist is-leaf" aria-hidden />
              )}
              <button
                type="button"
                className={`pdf-outline-item is-l${level}${isActive ? " is-active" : ""}`}
                onClick={() => onActivate(it)}
                title={
                  it.pageNumber != null
                    ? `第 ${it.pageNumber} 页`
                    : it.href
                      ? it.href
                      : "点击跳转"
                }
              >
                <span className="pdf-outline-item-text">
                  {q ? highlightSearchNodes(it.title, q) : it.title}
                </span>
                {it.pageNumber != null ? (
                  <span className="pdf-outline-item-page">{it.pageNumber}</span>
                ) : null}
              </button>
            </div>
            {hasKids && !isCollapsed && (
              <OutlineBranch
                items={it.items}
                onActivate={onActivate}
                depth={depth + 1}
                path={key}
                collapsed={collapsed}
                onToggle={onToggle}
                titleQuery={titleQuery}
                visibleKeys={visibleKeys}
                activeKey={activeKey}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

type Props = {
  items: DocOutlineNode[];
  onActivate: (node: DocOutlineNode) => void;
  activeKey: string | null;
  emptyHint?: string;
};

/** Shared PDF/EPUB outline: fold, search, locate current chapter. */
export function DocOutlineTree({
  items,
  onActivate,
  activeKey,
  emptyHint = "无目录",
}: Props) {
  const treeRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [titleQuery, setTitleQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const branchKeys = useMemo(() => collectOutlineBranchKeys(items), [items]);
  const { matches, visible } = useMemo(
    () => collectOutlineTitleMatches(items, titleQuery),
    [items, titleQuery],
  );
  const filtering = titleQuery.trim().length > 0;
  const visibleKeys = filtering ? visible : null;

  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const next = defaultCollapsedKeys(items);
    if (activeKey) {
      for (const a of outlineAncestorKeys(activeKey)) next.delete(a);
    }
    return next;
  });

  useEffect(() => {
    if (filtering) {
      setCollapsed(new Set());
      return;
    }
    const next = defaultCollapsedKeys(items);
    if (activeKey) {
      for (const a of outlineAncestorKeys(activeKey)) next.delete(a);
    }
    setCollapsed(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, filtering]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const onToggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    setCollapsed(new Set());
  }, []);

  const collapseAll = useCallback(() => {
    setCollapsed(new Set(branchKeys));
  }, [branchKeys]);

  const revealActive = useCallback(() => {
    if (!activeKey) return;
    const expandKeys = outlineRevealExpandKeys(items, activeKey);
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (const k of expandKeys) next.delete(k);
      return next;
    });
    window.setTimeout(() => {
      requestAnimationFrame(() => {
        const root = scrollRef.current ?? treeRef.current;
        const el = root?.querySelector(`[data-outline-key="${activeKey}"]`);
        el?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    }, 80);
  }, [activeKey, items]);

  const toggleSearch = useCallback(() => {
    setSearchOpen((open) => {
      if (open) setTitleQuery("");
      return !open;
    });
  }, []);

  useEffect(() => {
    revealActive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (items.length === 0) {
    return <p className="hint">{emptyHint}</p>;
  }

  return (
    <div className="pdf-outline-tree" ref={treeRef}>
      <div className="pdf-outline-toolbar">
        <div className="pdf-outline-actions">
          <button
            type="button"
            className="pdf-outline-icon-btn"
            onClick={revealActive}
            disabled={!activeKey}
            data-tip="定位到当前章节"
            aria-label="定位到当前章节"
          >
            <svg viewBox="0 0 24 24" aria-hidden>
              <path
                d="M5 4.5h14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
              <rect
                x="4.5"
                y="8"
                width="15"
                height="8"
                rx="1.8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
              />
              <path
                d="M5 19.5h14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            type="button"
            className={`pdf-outline-icon-btn${searchOpen ? " is-active" : ""}`}
            onClick={toggleSearch}
            data-tip="搜索标题"
            aria-label="搜索标题"
            aria-pressed={searchOpen}
          >
            <svg viewBox="0 0 24 24" aria-hidden>
              <circle
                cx="10.5"
                cy="10.5"
                r="7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
              />
              <path
                d="M16 16l5.2 5.2"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
          {branchKeys.length > 0 && (
            <button
              type="button"
              className="pdf-outline-icon-btn"
              onClick={() => {
                if (collapsed.size === 0) collapseAll();
                else expandAll();
              }}
              data-tip={collapsed.size === 0 ? "全部折叠" : "全部展开"}
              aria-label={collapsed.size === 0 ? "全部折叠" : "全部展开"}
            >
              {collapsed.size === 0 ? (
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path
                    d="M5 3.5l7 6.5 7-6.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M5 20.5l7-6.5 7 6.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path
                    d="M5 10L12 3.5 19 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M5 14L12 20.5 19 14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          )}
        </div>
        {searchOpen && (
          <div className="pdf-outline-filter">
            <input
              ref={searchInputRef}
              type="search"
              value={titleQuery}
              placeholder="搜索标题…"
              onChange={(e) => setTitleQuery(e.target.value)}
              aria-label="搜索目录标题"
            />
            {filtering && (
              <span className="pdf-outline-filter-count">
                {matches.size > 0 ? `${matches.size} 条` : "无匹配"}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="pdf-outline-scroll" ref={scrollRef}>
        {filtering && matches.size === 0 ? (
          <p className="hint pdf-outline-filter-empty">未找到匹配的标题</p>
        ) : (
          <OutlineBranch
            items={items}
            onActivate={onActivate}
            depth={0}
            path=""
            collapsed={collapsed}
            onToggle={onToggle}
            titleQuery={titleQuery}
            visibleKeys={visibleKeys}
            activeKey={activeKey}
          />
        )}
      </div>
    </div>
  );
}

export function navItemsToOutline(
  items: { label: string; href: string; subitems?: unknown[] }[],
): DocOutlineNode[] {
  return items.map((it) => ({
    title: (it.label || "（无标题）").trim() || "（无标题）",
    href: it.href || "",
    items: Array.isArray(it.subitems)
      ? navItemsToOutline(
          it.subitems as { label: string; href: string; subitems?: unknown[] }[],
        )
      : [],
  }));
}

/** Attach 1-based location pages from book.locations onto outline nodes. */
export function attachOutlinePages(
  items: DocOutlineNode[],
  locationFromHref: (href: string) => number,
): DocOutlineNode[] {
  return items.map((it) => {
    const href = (it.href || "").trim();
    let pageNumber: number | null = it.pageNumber ?? null;
    if (href) {
      try {
        const loc = locationFromHref(href);
        if (Number.isFinite(loc) && loc >= 0) pageNumber = Math.floor(loc) + 1;
      } catch {
        /* keep previous */
      }
    }
    return {
      ...it,
      pageNumber,
      items: attachOutlinePages(it.items, locationFromHref),
    };
  });
}
