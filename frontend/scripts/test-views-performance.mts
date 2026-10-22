import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// A hook/JSX harness exercises component request and pagination logic without a
// WebView, backend, real timers, model downloads, or paid translation requests.
type Node = { type: any; props: any; key?: string };
function nodes(tree: any): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...nodes(tree.props?.children)];
}
const label = (tree: any): string => Array.isArray(tree)
  ? tree.map(label).join("")
  : tree?.props ? label(tree.props.children) : typeof tree === "string" ? tree : "";
const button = (tree: any, title: string) => nodes(tree).find((node) => node.type === "button" && label(node) === title)!;

function harness(seed?: (initial: any, stateIndex: number) => any) {
  const slots: any[] = [];
  let cursor = 0, stateIndex = 0, dirty = false;
  let effects: Array<() => void> = [];
  let component: any, props: any, tree: any;
  const same = (a?: any[], b?: any[]) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const hooks = {
    useState(initial: any) {
      const at = cursor++, ordinal = stateIndex++;
      if (!(at in slots)) {
        const value = typeof initial === "function" ? initial() : initial;
        slots[at] = { value: seed ? seed(value, ordinal) : value };
      }
      return [slots[at].value, (next: any) => {
        const value = typeof next === "function" ? next(slots[at].value) : next;
        if (!Object.is(value, slots[at].value)) { slots[at].value = value; dirty = true; }
      }];
    },
    useRef(value: any) { const at = cursor++; return slots[at] ??= { current: value }; },
    useMemo(create: () => any, deps: any[]) {
      const at = cursor++;
      if (!slots[at] || !same(slots[at].deps, deps)) slots[at] = { value: create(), deps };
      return slots[at].value;
    },
    useCallback(fn: any, deps: any[]) { return hooks.useMemo(() => fn, deps); },
    useEffect(effect: () => any, deps: any[]) {
      const at = cursor++;
      if (slots[at] && same(slots[at].deps, deps)) return;
      effects.push(() => { slots[at]?.cleanup?.(); slots[at] = { deps, cleanup: effect() }; });
    },
    memo(fn: any) { fn.isMemo = true; return fn; },
  };
  function render(nextProps = props) {
    props = nextProps;
    let count = 0;
    do {
      assert.ok(++count < 30, "render loop converges");
      cursor = 0; stateIndex = 0; dirty = false; effects = [];
      tree = component(props);
      effects.forEach((effect) => effect());
    } while (dirty);
    return tree;
  }
  return {
    hooks,
    mount(fn: any, initial: any) { component = fn; return render(initial); },
    render,
    get tree() { return tree; },
    async settle() { for (let i = 0; i < 6; i++) { await Promise.resolve(); if (dirty) render(); } return tree; },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

const storage = { getItem: () => null, setItem: () => {} };
const timers = new Map<number, () => void>();
let timerId = 0;
const browser = {
  localStorage: storage,
  setTimeout(fn: () => void) { timers.set(++timerId, fn); return timerId; },
  clearTimeout(id: number) { timers.delete(id); },
  setInterval(fn: () => void) { timers.set(++timerId, fn); return timerId; },
  clearInterval(id: number) { timers.delete(id); },
  addEventListener() {}, removeEventListener() {},
};
function load(path: string, hooks: any, imports: Record<string, any> = {}) {
  const source = readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports: any = {};
  vm.runInNewContext(output, {
    exports, require(name: string) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return {
        jsx: (type: any, props: any, key: string) => ({ type, props, key }),
        jsxs: (type: any, props: any, key: string) => ({ type, props, key }), Fragment: "fragment",
      };
      if (name in imports) return imports[name];
      if (name === "echarts/core") return { use() {} };
      return {};
    },
    window: browser, localStorage: storage, performance, AbortController, URL, console,
  }, { filename: path });
  return exports;
}

{
  const h = harness();
  const pending: any[] = [];
  let pricingCalls = 0;
  const api = {
    async getPricing() { pricingCalls++; return { displayCurrency: "CNY", rules: [] }; },
    usageReport(params: any, init: any) {
      return new Promise((resolve) => pending.push({ params, signal: init.signal, resolve }));
    },
  };
  const { StatsView } = load("components/StatsView.tsx", h.hooks, {
    "../api": { api }, "../pricingDefaults": { formatMoney: String },
    "../friendlyError": { toFriendlyError: String },
  });
  const report = (key: string) => ({
    summary: [{ key, requests: 1, ok: 1, fail: 0, totalTokens: 2, cost: 1 }], chart: [], events: [],
    pagination: { total: 250, pages: 3 },
  });
  const chart = () => nodes(h.tree).find((node) => node.type?.name === "UsageBarChart")!;
  h.mount(StatsView, { active: false }); await h.settle();
  assert.equal(pricingCalls, 0); assert.equal(pending.length, 0, "hidden statistics do not fetch");
  h.render({ active: true }); await h.settle();
  assert.equal(pricingCalls, 1); assert.equal(pending.length, 1);
  assert.equal(pending[0].params.detailsOnly, false);
  pending[0].resolve(report("first")); await h.settle();
  const summary = chart().props.items, chartEvents = chart().props.events;
  button(h.tree, "下一页").props.onClick(); h.render(); await h.settle();
  assert.equal(pending[1].params.detailsOnly, true);
  assert.equal(pending[1].params.page, 2);
  assert.equal(chart().props.items, summary, "chart stays mounted during pagination");
  pending[1].resolve({ events: [], pagination: { total: 250, pages: 3 } }); await h.settle();
  assert.equal(chart().props.items, summary); assert.equal(chart().props.events, chartEvents);
  button(h.tree, "刷新").props.onClick(); h.render();
  const obsolete = pending.at(-1);
  const featureSelect = nodes(h.tree).find((node) => node.type === "select" && node.props.value === "")!;
  featureSelect.props.onChange({ target: { value: "chat" } }); h.render(); await h.settle();
  assert.equal(obsolete.signal.aborted, true, "superseded request is aborted");
  pending.at(-1).resolve(report("new-filter")); await h.settle();
  obsolete.resolve(report("obsolete")); await h.settle();
  assert.equal(chart().props.items[0].key, "new-filter", "late response cannot overwrite newer filters");
  button(h.tree, "刷新").props.onClick(); h.render();
  const closing = pending.at(-1);
  h.render({ active: false });
  assert.equal(closing.signal.aborted, true, "hiding cancels request");
  h.unmount();
}

if (process.argv.includes("--stats-only")) {
  assert.equal(timers.size, 0, "statistics tests leave no timers");
  console.log("statistics: lazy reports, pagination, cancellation and stale-response isolation passed");
  process.exit(0);
}

function textHarness(format: string, entries: any[], apiOverrides: Record<string, any> = {}) {
  const project = {
    name: "fixture", createdAt: "2026-09-07", format, entries,
    sourceLang: "en", targetLang: "zh-CN", tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    glossary: [], preReplace: [], postReplace: [], model: "test",
  };
  const h = harness((initial, index) => index === 0 ? "workbench" : index === 1 ? project : initial);
  const { TextTranslateView } = load("components/TextTranslateView.tsx", h.hooks, {
    "../api": { api: { getVendorModels: async () => ({ vendors: {} }), ...apiOverrides } },
    "../text-entry-state": load("text-entry-state.ts", h.hooks),
    "../transProject": {
      emptyTokenStats: () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
      addTokens: (a: any, b: any) => ({
        promptTokens: a.promptTokens + b.promptTokens,
        completionTokens: a.completionTokens + b.completionTokens,
        totalTokens: a.totalTokens + b.totalTokens,
      }),
      serializeProject: JSON.stringify,
    },
    "../modelPresets": { resolveFeatureLlm: () => ({ model: "test" }), setVendorModelsOverrideCache() {} },
    "../textTranslate": {
      parseJsonArray: (raw: string, fallback: any) => raw ? JSON.parse(raw) : fallback,
      formatDuration: String,
      DEFAULT_TEXT_PROMPT: "translate",
      shouldSkipEntry: () => false,
      applyReplaceRules: (text: string) => text,
      classifyEntryStatus: (_src: string, dst: string) => dst ? "done" : "pending",
    },
    "../subtitleGroups": {
      buildGroupTranslatePayload: (sources: string[], prompt: string) => ({ text: sources.join("\n"), prompt }),
      splitGroupTranslation: (text: string) => [text],
    },
    "../hooks/usePersistedWidth": { usePersistedWidth: () => ({ width: 420, beginResize() {} }) },
    "@tauri-apps/api/core": { isTauri: () => false },
    "@tauri-apps/api/window": { getCurrentWindow: () => ({ onCloseRequested: async () => () => {} }) },
  });
  h.mount(TextTranslateView, { settings: { textTranslateProvider: "llm" } });
  return h;
}
{
  let sourceReads = 0;
  const entry = { id: "plain", get src() { sourceReads++; return "def fn():\n    return 1"; }, dst: "译文\n第二行", status: "done" };
  const h = textHarness("plain", [entry]);
  assert.equal(sourceReads, 0, "closed pane does not join source text");
  nodes(h.tree).find((node) => node.props.className === "text-tool-btn entries-open-btn")!.props.onClick();
  h.render();
  const areas = nodes(h.tree).filter((node) => node.type === "textarea" && node.props.className === "text-pane-area");
  assert.equal(areas[0].props.value, "def fn():\n    return 1");
  assert.equal(areas[1].props.value, "译文\n第二行");
  const reads = sourceReads; h.render();
  assert.equal(sourceReads, reads, "unchanged rerender reuses memoized plaintext");
  h.unmount();
}
{
  const entries = Array.from({ length: 1001 }, (_, i) => ({ id: String(i), src: `source-${i}`, dst: "", status: "pending" }));
  const h = textHarness("json", entries);
  nodes(h.tree).find((node) => node.props.className === "text-tool-btn entries-open-btn")!.props.onClick(); h.render();
  const rows = () => nodes(h.tree).filter((node) => node.props.className === "text-entry-row status-pending");
  assert.equal(rows().length, 100, "only one page of rows is rendered");
  assert.equal(rows()[0].key, "0");
  button(h.tree, "下一页").props.onClick(); h.render();
  assert.equal(rows().length, 100); assert.equal(rows()[0].key, "100");
  nodes(h.tree).find((node) => node.props.className === "text-filter")!.props.onChange({ target: { value: "source-1000" } }); h.render();
  assert.equal(rows().length, 1); assert.equal(rows()[0].key, "1000", "filter searches all pages");
  h.unmount();
}
{
  const requests: any[] = [], saved: any[] = [];
  const h = textHarness("json", [
    { id: "a", src: "first", dst: "", status: "pending" },
    { id: "b", src: "second", dst: "", status: "pending" },
  ], {
    translate: (_text: string, init: any) => new Promise((resolve) => requests.push({ resolve, signal: init.signal })),
    saveTextProject: async (body: any) => { saved.push(body.project); return {}; },
  });
  button(h.tree, "开始翻译").props.onClick(); h.render(); await h.settle();
  assert.equal(requests.length, 1);
  requests[0].resolve({ translation: "first translated", promptTokens: 3, completionTokens: 4, totalTokens: 7 });
  await h.settle();
  assert.equal(requests.length, 2);
  // No publication timeout has fired: stop must flush buffered success before saving.
  button(h.tree, "停止").props.onClick(); await h.settle();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].entries[0].dst, "first translated");
  assert.equal(saved[0].entries[0].status, "done");
  assert.equal(saved[0].entries[1].status, "pending");
  assert.equal(saved[0].tokens.totalTokens, 7);
  assert.equal(requests[1].signal.aborted, true);
  requests[1].resolve({ translation: "late response", promptTokens: 20, completionTokens: 20, totalTokens: 40 });
  await h.settle();
  assert.equal(saved.length, 1, "cancelled worker does not save stale progress");
  assert.equal(saved[0].tokens.totalTokens, 7);
  h.unmount();
}
{
  const h = harness();
  const { RichText } = load("components/RichText.tsx", h.hooks, {
    "react-markdown": { default: "markdown" },
    "../latexToMarkdown": { preprocessRichText: (value: string) => value },
  });
  assert.equal(RichText.isMemo, true);
  const a = RichText({ content: "one" }).props.children;
  const b = RichText({ content: "two" }).props.children;
  assert.equal(a.props.remarkPlugins, b.props.remarkPlugins);
  assert.equal(a.props.rehypePlugins, b.props.rehypePlugins);
}
assert.equal(timers.size, 0, "tests leave no timers");
console.log("views: lazy/cancelled reports, detail-only pagination, plaintext memo, 100-row pages and stable rich-text plugins passed");
