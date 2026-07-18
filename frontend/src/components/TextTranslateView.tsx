import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, type Settings } from "../api";
import { toFriendlyError } from "../friendlyError";
import {
  assTextLooksEmpty,
  parseAss,
  parseSrt,
  serializeAss,
  serializeSrt,
} from "../subtitle";
import {
  buildGroupTranslatePayload,
  buildSubtitleCueGroups,
  splitGroupTranslation,
  type SubtitleCueGroup,
} from "../subtitleGroups";
import { retimeProjectSubtitles, type RetimeStepEvent } from "../subtitleRetime";
import {
  addTokens,
  createProject,
  emptyTokenStats,
  isProjectFileName,
  isSupportedSourceFileName,
  parseProject,
  PROJECT_EXT,
  serializeProject,
  type TextProject,
} from "../transProject";
import {
  applyReplaceRules,
  classifyEntryStatus,
  DEFAULT_SUBTITLE_PROMPT,
  DEFAULT_TEXT_PROMPT,
  entriesToManualTransJson,
  formatDuration,
  isNoNeedTranslate,
  parseJsonArray,
  parseManualTransFile,
  shouldSkipEntry,
  splitTextChunks,
  type GlossaryEntry,
  type ReplaceRule,
  type TransEntry,
} from "../textTranslate";
import { usePersistedWidth } from "../hooks/usePersistedWidth";
import { StatPieGroup, type PieSlice } from "./StatPie";
import {
  RetimeProgressPanel,
  type PipelineState,
} from "./RetimeProgressPanel";

type Props = { settings: Settings };
type Phase = "home" | "workbench";

type RecentItem = {
  name: string;
  folder: string;
  openedAt: number;
};

const RECENT_KEY = "llmchat-text-recent-v3";

const FORMAT_CARDS: { title: string; exts: string }[] = [
  { title: "纯文本 / Markdown", exts: ".txt · .md" },
  { title: "MTool", exts: ".json" },
  {
    title: "字幕",
    exts: ".srt · .ass · .ssa（句组翻译，时间码不动）",
  },
];

const SOURCE_FORMATS_HINT = ".json / .txt / .md / .srt / .ass / .ssa";

function loadRecent(): RecentItem[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as RecentItem[]) : [];
    return Array.isArray(list)
      ? list.filter((x) => x && x.folder && x.name).slice(0, 12)
      : [];
  } catch {
    return [];
  }
}

function pushRecent(item: RecentItem) {
  const next = [
    item,
    ...loadRecent().filter((r) => r.folder !== item.folder),
  ].slice(0, 12);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

async function saveExportWithPathDialog(
  fileName: string,
  content: string,
  ext: string,
): Promise<string | null> {
  const mime =
    ext === "json"
      ? "application/json"
      : ext === "srt" || ext === "ass" || ext === "txt"
        ? "text/plain"
        : "application/octet-stream";
  const w = window as Window & {
    showSaveFilePicker?: (options: {
      suggestedName?: string;
      types?: {
        description: string;
        accept: Record<string, string[]>;
      }[];
    }) => Promise<FileSystemFileHandle>;
  };

  if (typeof w.showSaveFilePicker === "function") {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: fileName,
        types: [
          {
            description: ext.toUpperCase(),
            accept: { [mime]: [`.${ext.replace(/^\./, "")}`] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(new Blob([content], { type: `${mime};charset=utf-8` }));
      await writable.close();
      return handle.name || fileName;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        return null;
      }
      throw e;
    }
  }

  // Fallback when File System Access API is unavailable
  downloadBlob(new Blob([content], { type: `${mime};charset=utf-8` }), fileName);
  return fileName;
}

function unsupportedSourceMessage(name: string) {
  return `不支持的源文件「${name}」。新建工程仅支持：${SOURCE_FORMATS_HINT}`;
}

function unsupportedProjectMessage(name: string) {
  return `「${name}」不是工程文件。打开工程仅支持：*${PROJECT_EXT}`;
}

function statusLabel(s: TransEntry["status"]): string {
  switch (s) {
    case "done":
      return "已译";
    case "pending":
      return "未译";
    case "skipped":
      return "无需译";
    case "error":
      return "失败";
    case "running":
      return "进行中";
    default:
      return s;
  }
}

function langFileTag(lang: string) {
  return (lang || "zh-CN").trim().replace(/-/g, "_") || "zh_CN";
}

function exportStem(name: string, sourceLang: string, targetLang: string) {
  let stem = name.trim();
  const srcTag = langFileTag(sourceLang);
  const dstTag = langFileTag(targetLang);
  // drop trailing .en / .zh_CN if already present
  const drop = new RegExp(
    `\\.(${srcTag}|${dstTag}|en|zh|zh_CN|zh_TW|ja|ko)$`,
    "i",
  );
  stem = stem.replace(drop, "");
  return stem || name || "translated";
}

function exportFileName(
  p: TextProject,
  ext: string,
) {
  const stem = exportStem(p.name, p.sourceLang, p.targetLang);
  return `${stem}.${langFileTag(p.targetLang)}.${ext}`;
}

function baseName(name: string) {
  return name.replace(/\.[^.]+$/i, "");
}

const STATUS_COLORS = {
  成功: "#91cc75",
  失败: "#ee6666",
  跳过: "#fac858",
  待翻译: "#5470c6",
} as const;

export function TextTranslateView({ settings }: Props) {
  const [phase, setPhase] = useState<Phase>("home");
  const [project, setProject] = useState<TextProject | null>(null);
  const [projectFolder, setProjectFolder] = useState<string | null>(null);
  const [projectFolderPath, setProjectFolderPath] = useState<string | null>(
    null,
  );
  const [promptDraft, setPromptDraft] = useState(DEFAULT_TEXT_PROMPT);
  const [showPrompt, setShowPrompt] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingSide, setPendingSide] = useState<"new" | "open">("new");
  const [recent, setRecent] = useState<RecentItem[]>(() => loadRecent());
  const [busy, setBusy] = useState(false);
  const [sessionDone, setSessionDone] = useState(0);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyUntranslated, setOnlyUntranslated] = useState(true);
  const [filter, setFilter] = useState("");
  const [dragOver, setDragOver] = useState<"new" | "open" | null>(null);
  const [pipeline, setPipeline] = useState<PipelineState | null>(null);
  const [entriesPanelOpen, setEntriesPanelOpen] = useState(false);
  const pipelineActiveRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const genRef = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const tickRef = useRef<number | null>(null);
  const elapsedBaseRef = useRef(0);
  const runStartedAtRef = useRef<number | null>(null);
  const projectRef = useRef(project);
  const busyRef = useRef(busy);
  const phaseRef = useRef(phase);
  const promptDraftRef = useRef(promptDraft);
  const projectFolderRef = useRef(projectFolder);
  projectRef.current = project;
  busyRef.current = busy;
  phaseRef.current = phase;
  promptDraftRef.current = promptDraft;
  projectFolderRef.current = projectFolder;
  const { width: srcWidth, beginResize } = usePersistedWidth(
    "llmchat-text-src-width",
    420,
    240,
    900,
  );

  const entries = project?.entries ?? [];
  const stats = useMemo(() => {
    const done = entries.filter((e) => e.status === "done").length;
    const failed = entries.filter((e) => e.status === "error").length;
    const skipped = entries.filter((e) => e.status === "skipped").length;
    const pending = entries.filter(
      (e) => e.status === "pending" || e.status === "running",
    ).length;
    return {
      total: entries.length,
      done,
      failed,
      skipped,
      pending,
      untranslated: pending + failed,
    };
  }, [entries]);

  /** 尚未开始翻译：无成功/失败、也无 token 消耗 */
  const notStarted =
    !busy &&
    stats.done === 0 &&
    stats.failed === 0 &&
    (project?.tokens.totalTokens || 0) === 0;

  const statusCountSlices: PieSlice[] = useMemo(() => {
    if (notStarted) {
      return [
        { label: "成功", value: 0, color: STATUS_COLORS.成功 },
        { label: "失败", value: 0, color: STATUS_COLORS.失败 },
        { label: "跳过", value: 0, color: STATUS_COLORS.跳过 },
        {
          label: "待翻译",
          value: Math.max(stats.total, 0),
          color: STATUS_COLORS.待翻译,
        },
      ];
    }
    return [
      { label: "成功", value: stats.done, color: STATUS_COLORS.成功 },
      { label: "失败", value: stats.failed, color: STATUS_COLORS.失败 },
      { label: "跳过", value: stats.skipped, color: STATUS_COLORS.跳过 },
      { label: "待翻译", value: stats.pending, color: STATUS_COLORS.待翻译 },
    ];
  }, [notStarted, stats]);

  const tokenSlices: PieSlice[] = useMemo(
    () => [
      {
        label: "提示",
        value: notStarted ? 0 : project?.tokens.promptTokens || 0,
        color: "#73c0de",
      },
      {
        label: "补全",
        value: notStarted ? 0 : project?.tokens.completionTokens || 0,
        color: "#fc8452",
      },
    ],
    [project?.tokens, notStarted],
  );

  const progressPct =
    busy && sessionTotal > 0
      ? Math.min(100, (sessionDone / sessionTotal) * 100)
      : stats.total > 0
        ? Math.min(100, (stats.done / stats.total) * 100)
        : 0;
  const progressPctLabel = progressPct.toFixed(3);
  const progressCountLabel =
    busy && sessionTotal > 0
      ? `${sessionDone}/${sessionTotal}`
      : `${stats.done}/${stats.total}`;

  const filteredEntries = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.src.toLowerCase().includes(q) ||
        e.dst.toLowerCase().includes(q) ||
        e.status.includes(q),
    );
  }, [entries, filter]);

  const glossaryFromSettings = useMemo(
    () =>
      parseJsonArray<GlossaryEntry>(settings.textGlossary, []).filter(
        (g) => g.src.trim() && g.dst.trim(),
      ),
    [settings.textGlossary],
  );
  const preFromSettings = useMemo(
    () => parseJsonArray<ReplaceRule>(settings.textPreReplace, []),
    [settings.textPreReplace],
  );
  const postFromSettings = useMemo(
    () => parseJsonArray<ReplaceRule>(settings.textPostReplace, []),
    [settings.textPostReplace],
  );

  const computeElapsedNow = () => {
    if (runStartedAtRef.current != null) {
      return (
        elapsedBaseRef.current +
        Math.round(performance.now() - runStartedAtRef.current)
      );
    }
    return projectRef.current?.elapsedMs || elapsedMs;
  };

  /** Persist full project snapshot (entries/tokens/elapsed/prompt). */
  const persistFullSnapshot = useCallback(
    async (opts?: { resetRunning?: boolean; project?: TextProject | null }) => {
      const base = opts?.project ?? projectRef.current;
      if (!base) return null;
      const nextElapsed = computeElapsedNow();
      const entries = opts?.resetRunning
        ? base.entries.map((e) =>
            e.status === "running"
              ? { ...e, status: "pending" as const, error: undefined }
              : e,
          )
        : base.entries;
      const next: TextProject = {
        ...base,
        prompt: promptDraftRef.current,
        model: settings.model || base.model,
        elapsedMs: nextElapsed,
        entries,
        folder: base.folder || projectFolderRef.current || undefined,
      };
      setProject(next);
      setElapsedMs(nextElapsed);
      projectRef.current = next;
      try {
        const saved = await api.saveTextProject({
          project: JSON.parse(serializeProject(next)),
          folder: next.folder || projectFolderRef.current || undefined,
          overwrite: true,
        });
        if (saved.folder) {
          setProjectFolder(saved.folder);
          projectFolderRef.current = saved.folder;
        }
        if (saved.folderPath) setProjectFolderPath(saved.folderPath);
        return next;
      } catch (e) {
        setError(toFriendlyError(e, "保存工程失败"));
        return next;
      }
    },
    [settings.model],
  );

  const stop = useCallback(
    async (opts?: { silent?: boolean }) => {
      abortRef.current?.abort();
      abortRef.current = null;
      genRef.current += 1;
      if (tickRef.current != null) {
        window.clearInterval(tickRef.current);
        tickRef.current = null;
      }
      setBusy(false);
      busyRef.current = false;
      if (pipelineActiveRef.current) {
        setPipeline((p) =>
          p
            ? {
                ...p,
                error: "已停止",
                detail: "已停止，进度已保存",
              }
            : p,
        );
      }
      await persistFullSnapshot({ resetRunning: true });
      runStartedAtRef.current = null;
      if (!opts?.silent) setStatusLine("已停止，进度已保存");
    },
    [persistFullSnapshot],
  );

  const persistFullSnapshotRef = useRef(persistFullSnapshot);
  const stopRef = useRef(stop);
  persistFullSnapshotRef.current = persistFullSnapshot;
  stopRef.current = stop;
  const closingRef = useRef(false);

  /** Close app: save everything; if translating, confirm stop first. */
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    const withTimeout = async (
      work: () => Promise<unknown>,
      ms: number,
    ): Promise<void> => {
      await Promise.race([
        work().then(() => undefined).catch(() => undefined),
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, ms);
        }),
      ]);
    };

    void (async () => {
      try {
        const win = getCurrentWindow();
        const fn = await win.onCloseRequested(async (event) => {
          event.preventDefault();
          if (closingRef.current) return;
          closingRef.current = true;
          try {
            if (phaseRef.current === "workbench" && projectRef.current) {
              if (busyRef.current) {
                const ok = window.confirm(
                  "正在翻译，是否停止并退出？\n点击「确定」将中断翻译，进行中的条目恢复为未翻译，并保存后退出。\n点击「取消」则继续翻译，不关闭。",
                );
                if (!ok) {
                  closingRef.current = false;
                  return;
                }
                await withTimeout(
                  () => stopRef.current({ silent: true }),
                  5000,
                );
              } else {
                await withTimeout(
                  () => persistFullSnapshotRef.current(),
                  5000,
                );
              }
            }
            await win.destroy();
          } catch {
            closingRef.current = false;
          }
        });
        if (disposed) fn();
        else unlisten = fn;
      } catch {
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
          if (busyRef.current) {
            e.preventDefault();
            e.returnValue = "";
          } else if (phaseRef.current === "workbench" && projectRef.current) {
            void persistFullSnapshotRef.current();
          }
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        unlisten = () =>
          window.removeEventListener("beforeunload", onBeforeUnload);
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const patchProject = useCallback((fn: (p: TextProject) => TextProject) => {
    setProject((p) => {
      if (!p) return p;
      const next = fn(p);
      projectRef.current = next;
      return next;
    });
  }, []);
  const resetSessionUi = (p: TextProject) => {
    setBusy(false);
    setSessionDone(0);
    setSessionTotal(0);
    setElapsedMs(p.elapsedMs || 0);
    elapsedBaseRef.current = p.elapsedMs || 0;
    runStartedAtRef.current = null;
    if (tickRef.current != null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  };

  const openWorkbench = (
    p: TextProject,
    meta?: { folder?: string; folderPath?: string },
  ) => {
    const folder = meta?.folder || p.folder || null;
    setProject({ ...p, folder: folder || p.folder });
    setProjectFolder(folder);
    setProjectFolderPath(meta?.folderPath || null);
    setPromptDraft(p.prompt || DEFAULT_TEXT_PROMPT);
    setPhase("workbench");
    setError(null);
    resetSessionUi(p);
    setStatusLine(
      `工程「${p.name}」· ${p.format.toUpperCase()} · ${p.entries.length} 条` +
        (meta?.folderPath ? ` · ${meta.folderPath}` : ""),
    );
    if (folder) {
      setRecent(
        pushRecent({
          name: p.name,
          folder,
          openedAt: Date.now(),
        }),
      );
    }
  };

  const persistProject = async (
    p: TextProject,
    opts?: {
      folder?: string | null;
      overwrite?: boolean;
      sourceFile?: File | null;
    },
  ) => {
    const folder = opts?.folder ?? p.folder ?? projectFolder;
    let sourceFileName: string | undefined;
    let sourceContent: string | undefined;
    if (opts?.sourceFile) {
      sourceFileName = opts.sourceFile.name;
      sourceContent = await opts.sourceFile.text();
    }
    const saved = await api.saveTextProject({
      project: JSON.parse(
        serializeProject({ ...p, folder: folder || undefined }),
      ),
      folder: folder || undefined,
      overwrite: opts?.overwrite ?? true,
      sourceFileName,
      sourceContent,
    });
    setProjectFolder(saved.folder);
    setProjectFolderPath(saved.folderPath);
    setProject({ ...p, folder: saved.folder });
    setRecent(
      pushRecent({
        name: p.name,
        folder: saved.folder,
        openedAt: Date.now(),
      }),
    );
    return saved;
  };

  const openRecentProject = async (item: RecentItem) => {
    try {
      setError(null);
      const data = await api.loadTextProject({ folder: item.folder });
      const p = parseProject(JSON.stringify(data.project));
      openWorkbench(p, {
        folder: data.folder,
        folderPath: data.folderPath,
      });
    } catch (e) {
      setError(toFriendlyError(e, "打开最近工程失败（可能已删除）"));
      const next = loadRecent().filter((r) => r.folder !== item.folder);
      setRecent(next);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
    }
  };

  const acceptPendingFile = (file: File, side: "new" | "open") => {
    setError(null);
    if (side === "new") {
      if (isProjectFileName(file.name)) {
        setError(
          `「${file.name}」是已有工程文件，请到右侧「打开工程」导入。`,
        );
        return;
      }
      if (!isSupportedSourceFileName(file.name)) {
        setError(unsupportedSourceMessage(file.name));
        return;
      }
    } else if (!isProjectFileName(file.name)) {
      setError(unsupportedProjectMessage(file.name));
      return;
    }
    setPendingSide(side);
    setPendingFile(file);
  };

  const buildFromSourceFile = async (
    file: File,
    side: "new" | "open" = "open",
  ) => {
    if (side === "new") {
      if (isProjectFileName(file.name)) {
        throw new Error(
          `工程文件请使用「打开工程」导入（*${PROJECT_EXT}）`,
        );
      }
      if (!isSupportedSourceFileName(file.name)) {
        throw new Error(unsupportedSourceMessage(file.name));
      }
    } else if (!isProjectFileName(file.name)) {
      throw new Error(unsupportedProjectMessage(file.name));
    }

    const text = await file.text();
    const lower = file.name.toLowerCase();
    const sourceLang = settings.textTranslateSource || "ja";
    const targetLang = settings.textTranslateTarget || "zh-CN";
    const model = settings.model || "";
    const name = baseName(
      isProjectFileName(file.name)
        ? file.name.replace(/\.llmchat-proj\.json$/i, "")
        : file.name,
    );

    if (side === "open" || isProjectFileName(file.name)) {
      const p = parseProject(text);
      const saved = await persistProject(p, {
        folder: p.folder || name,
        overwrite: true,
      });
      openWorkbench(
        { ...p, folder: saved.folder },
        { folder: saved.folder, folderPath: saved.folderPath },
      );
      return;
    }

    let built: TextProject | null = null;

    if (lower.endsWith(".srt")) {
      const cues = parseSrt(text);
      if (!cues.length) throw new Error("未能解析 SRT 字幕");
      const entries: TransEntry[] = cues.map((c, i) => ({
        id: `srt-${i}`,
        src: c.text,
        dst: "",
        status: classifyEntryStatus(c.text, ""),
        metaIndex: i,
      }));
      built = createProject({
        name,
        format: "srt",
        sourceLang,
        targetLang,
        model,
        prompt: settings.textTranslatePrompt || DEFAULT_SUBTITLE_PROMPT,
        glossary: glossaryFromSettings,
        preReplace: preFromSettings,
        postReplace: postFromSettings,
        entries,
        sourceFileName: file.name,
        sourceMeta: { srtCues: cues },
      });
    } else if (lower.endsWith(".ass") || lower.endsWith(".ssa")) {
      const assDoc = parseAss(text);
      if (!assDoc.dialogues.length) throw new Error("未能解析 ASS 对白行");
      const entries: TransEntry[] = assDoc.dialogues.map((d, i) => {
        const empty = assTextLooksEmpty(d.text);
        return {
          id: `ass-${i}`,
          src: d.text,
          dst: empty ? d.text : "",
          status: empty ? "skipped" : classifyEntryStatus(d.text, ""),
          metaIndex: i,
        };
      });
      built = createProject({
        name,
        format: "ass",
        sourceLang,
        targetLang,
        model,
        prompt: settings.textTranslatePrompt || DEFAULT_SUBTITLE_PROMPT,
        glossary: glossaryFromSettings,
        preReplace: preFromSettings,
        postReplace: postFromSettings,
        entries,
        sourceFileName: file.name,
        sourceMeta: { assDoc },
      });
    } else if (lower.endsWith(".json") || text.trimStart().startsWith("{")) {
      const { entries } = parseManualTransFile(text);
      built = createProject({
        name,
        format: "json",
        sourceLang,
        targetLang,
        model,
        prompt: settings.textTranslatePrompt || DEFAULT_TEXT_PROMPT,
        glossary: glossaryFromSettings,
        preReplace: preFromSettings,
        postReplace: postFromSettings,
        entries,
        sourceFileName: file.name,
      });
    } else {
      const chunks = splitTextChunks(text, 1200);
      const entries: TransEntry[] =
        chunks.length > 1
          ? chunks.map((c, i) => ({
              id: `p-${i}`,
              src: c,
              dst: "",
              status: classifyEntryStatus(c, ""),
            }))
          : [
              {
                id: "p-0",
                src: text,
                dst: "",
                status: classifyEntryStatus(text, ""),
              },
            ];
      built = createProject({
        name,
        format: "plain",
        sourceLang,
        targetLang,
        model,
        prompt: settings.textTranslatePrompt || DEFAULT_TEXT_PROMPT,
        glossary: glossaryFromSettings,
        preReplace: preFromSettings,
        postReplace: postFromSettings,
        entries,
        sourceFileName: file.name,
        sourceMeta: { plainText: text },
      });
    }

    const saved = await persistProject(built, {
      folder: built.name,
      overwrite: false,
      sourceFile: file,
    });
    openWorkbench(
      { ...built, folder: saved.folder },
      { folder: saved.folder, folderPath: saved.folderPath },
    );
  };

  const onConfirmFile = async () => {
    if (!pendingFile) return;
    try {
      await buildFromSourceFile(pendingFile, pendingSide);
      setPendingFile(null);
    } catch (e) {
      setError(toFriendlyError(e, "打开失败"));
    }
  };

  const saveProjectFile = () => {
    if (!project) return;
    void (async () => {
      try {
        const next = {
          ...project,
          prompt: promptDraft,
          model: settings.model || project.model,
          elapsedMs,
        };
        const saved = await persistProject(next, {
          folder: projectFolder || next.folder || next.name,
          overwrite: true,
        });
        setStatusLine(`工程已保存到 ${saved.folderPath}`);
      } catch (e) {
        setError(toFriendlyError(e, "保存工程失败"));
      }
    })();
  };

  const buildExportPayload = (p: TextProject) => {
    // 译文文件：时间轴保留，台词替换为目标语言译文
    if (p.format === "srt") {
      const cues =
        p.sourceMeta?.srtCues?.map((c, i) => {
          const e = p.entries.find((x) => x.metaIndex === i);
          return {
            ...c,
            text:
              e?.status === "skipped"
                ? c.text
                : (e?.dst || e?.src || c.text),
          };
        }) ??
        p.entries.map((e, i) => ({
          index: i + 1,
          start: "00:00:00,000",
          end: "00:00:02,000",
          text: e.status === "skipped" ? e.src : e.dst || e.src,
        }));
      return {
        fileName: exportFileName(p, "srt"),
        content: serializeSrt(cues),
        kind: "SRT" as const,
      };
    }
    if (p.format === "ass") {
      const base = p.sourceMeta?.assDoc;
      const dialogues = base
        ? base.dialogues.map((d, i) => {
            const e = p.entries.find((x) => x.metaIndex === i);
            return {
              ...d,
              text:
                e?.status === "skipped"
                  ? d.text
                  : (e?.dst || e?.src || d.text),
            };
          })
        : p.entries.map((e) => ({
            prefix: "Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,",
            text: e.status === "skipped" ? e.src : e.dst || e.src,
            rawLine: "",
          }));
      return {
        fileName: exportFileName(p, "ass"),
        content: serializeAss(
          base
            ? { ...base, dialogues }
            : { header: "[Script Info]\n\n[Events]\n", dialogues, footer: "" },
        ),
        kind: "ASS" as const,
      };
    }
    if (p.format === "json") {
      return {
        fileName: exportFileName(p, "json"),
        content: entriesToManualTransJson(p.entries),
        kind: "JSON" as const,
      };
    }
    return {
      fileName: exportFileName(p, "txt"),
      content: p.entries.map((e) => e.dst || e.src).join("\n\n"),
      kind: "TXT" as const,
    };
  };

  const exportResult = async (pOverride?: TextProject) => {
    const p = pOverride || project;
    if (!p) return null;
    const payload = buildExportPayload(p);
    const ext =
      p.format === "srt"
        ? "srt"
        : p.format === "ass"
          ? "ass"
          : p.format === "json"
            ? "json"
            : "txt";
    const savedName = await saveExportWithPathDialog(
      payload.fileName,
      payload.content,
      ext,
    );
    if (!savedName) {
      setStatusLine("已取消导出");
      return null;
    }
    setStatusLine(`${payload.kind} 已导出：${savedName}`);
    return savedName;
  };

  const runTranslate = useCallback(async (
    projectOverride?: TextProject,
    opts?: { forceRetime?: boolean },
  ) => {
    let active = projectOverride ?? projectRef.current;
    if (!active || busyRef.current) return;

    const gen = ++genRef.current;
    const ac = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ac;

    const wantRetime =
      (active.format === "srt" || active.format === "ass") &&
      !!active.subtitleRetiming &&
      (!active.subtitleRetimed || !!opts?.forceRetime);

    const showPipeline =
      (active.format === "srt" || active.format === "ass") &&
      !!active.subtitleRetiming;
    pipelineActiveRef.current = showPipeline;
    if (showPipeline) {
      setPipeline({
        visible: true,
        step: wantRetime ? 1 : 4,
        detail: wantRetime ? "准备重组时间轴…" : "跳过重组，开始翻译…",
        ratio: wantRetime ? 0 : 0.4,
      });
    } else {
      setPipeline(null);
      pipelineActiveRef.current = false;
    }

    const applyRetimeStep = (ev: RetimeStepEvent) => {
      if (gen !== genRef.current || !pipelineActiveRef.current) return;
      if (ev.phase === "pack") {
        setPipeline({
          visible: true,
          step: 1,
          detail: `打包完成 · ${ev.windowCount} 个窗口`,
          ratio: 0.05,
        });
        setStatusLine(`重组时间轴 · ${ev.windowCount} 个窗口…`);
      } else if (ev.phase === "split") {
        const p =
          ev.windowTotal > 0 ? ev.windowIndex / ev.windowTotal : 0;
        setPipeline({
          visible: true,
          step: 2,
          detail: `断句 ${ev.windowIndex}/${ev.windowTotal} · 本窗 ${ev.cueCount} 条碎片${
            ev.skipped > 0 ? ` · 已回退 ${ev.skipped} 窗` : ""
          }`,
          ratio: 0.05 + 0.3 * p,
        });
        setStatusLine(
          `重组时间轴 · 窗口 ${ev.windowIndex}/${ev.windowTotal}（${ev.cueCount} 条）…`,
        );
      } else if (ev.phase === "writeback") {
        setPipeline({
          visible: true,
          step: 3,
          detail: `写回时间轴 · ${ev.newCueCount} 条字幕`,
          ratio: 0.38,
        });
        setStatusLine(`写回时间轴 · ${ev.newCueCount} 条…`);
      } else if (ev.phase === "done") {
        setPipeline({
          visible: true,
          step: 3,
          detail: `重组完成 · ${ev.windowCount} 窗${
            ev.skippedWindows > 0
              ? `（${ev.skippedWindows} 窗回退原轴）`
              : ""
          }`,
          ratio: 0.4,
        });
      }
    };

    if (wantRetime) {
      setBusy(true);
      busyRef.current = true;
      setError(null);
      setStatusLine("重组时间轴…");
      try {
        const result = await retimeProjectSubtitles(active, {
          settings,
          sourceLang: active.sourceLang,
          signal: ac.signal,
          force: !!opts?.forceRetime,
          onStep: applyRetimeStep,
          onProgress: (msg) => {
            if (gen === genRef.current) setStatusLine(msg);
          },
        });
        if (gen !== genRef.current || ac.signal.aborted) return;
        active = result.project;
        setProject(active);
        projectRef.current = active;
        try {
          await persistProject(active, {
            folder: active.folder || projectFolderRef.current,
            overwrite: true,
          });
        } catch {
          /* keep going */
        }
        const skipNote =
          result.skippedWindows > 0
            ? `（${result.skippedWindows} 窗回退原轴）`
            : "";
        setStatusLine(
          `时间轴已重组 · ${active.entries.length} 条 · ${result.windowCount} 窗${skipNote}`,
        );
      } catch (e) {
        if (ac.signal.aborted || gen !== genRef.current) return;
        const msg = toFriendlyError(e, "时间轴重组失败");
        setError(msg);
        if (pipelineActiveRef.current) {
          setPipeline((p) =>
            p
              ? {
                  ...p,
                  step: 2,
                  error: msg,
                  detail: msg,
                }
              : p,
          );
        }
        setBusy(false);
        busyRef.current = false;
        abortRef.current = null;
        setStatusLine("时间轴重组失败，已中止翻译");
        return;
      }
    }

    const glossary = (active.glossary.length
      ? active.glossary
      : glossaryFromSettings
    ).filter((g) => g.src.trim() && g.dst.trim());
    const pre = active.preReplace.length
      ? active.preReplace
      : preFromSettings;
    const post = active.postReplace.length
      ? active.postReplace
      : postFromSettings;
    const prompt = promptDraftRef.current.trim() || DEFAULT_TEXT_PROMPT;

    const needsWork = (e: TransEntry) =>
      e.status !== "skipped" &&
      !shouldSkipEntry(e, { onlyUntranslated, skipEmpty: true }) &&
      (e.status === "pending" || e.status === "error");

    const workEntries = active.entries.filter(needsWork);
    if (!workEntries.length) {
      setStatusLine("没有待翻译条目");
      if (wantRetime) {
        setBusy(false);
        busyRef.current = false;
        abortRef.current = null;
      }
      return;
    }

    type WorkUnit = {
      id: string;
      entryIds: string[];
      sources: string[];
      sourceLens: number[];
    };

    let workUnits: WorkUnit[];
    if (
      (active.format === "srt" || active.format === "ass") &&
      !active.subtitleRetimed
    ) {
      const groups: SubtitleCueGroup[] = buildSubtitleCueGroups(
        active.entries,
        active.format,
        active.sourceMeta,
      );
      const workIdSet = new Set(workEntries.map((e) => e.id));
      workUnits = groups
        .filter((g) => g.entryIds.some((id) => workIdSet.has(id)))
        .map((g) => ({
          id: g.id,
          entryIds: g.entryIds,
          sources: g.sources,
          sourceLens: g.sourceLens,
        }));
    } else {
      workUnits = workEntries.map((e) => ({
        id: e.id,
        entryIds: [e.id],
        sources: [e.src],
        sourceLens: [Math.max(1, e.src.length)],
      }));
    }

    const entryWorkCount = workUnits.reduce(
      (a, u) => a + u.entryIds.length,
      0,
    );

    const t0 = performance.now();
    const elapsedBase = active.elapsedMs || 0;
    elapsedBaseRef.current = elapsedBase;
    runStartedAtRef.current = t0;
    setBusy(true);
    busyRef.current = true;
    setError(null);
    setSessionDone(0);
    setSessionTotal(entryWorkCount);
    setElapsedMs(elapsedBase);
    if (pipelineActiveRef.current) {
      setPipeline({
        visible: true,
        step: 4,
        detail: `翻译 0/${entryWorkCount}`,
        ratio: 0.4,
      });
    }
    setStatusLine(
      `翻译中 · 0 / ${entryWorkCount}` +
        (active.format === "srt" || active.format === "ass"
          ? active.subtitleRetimed
            ? "（已重组）"
            : `（${workUnits.length} 句组）`
          : ""),
    );
    if (tickRef.current != null) window.clearInterval(tickRef.current);
    tickRef.current = window.setInterval(() => {
      setElapsedMs(elapsedBase + Math.round(performance.now() - t0));
    }, 250);

    const workIdSet = new Set(workUnits.flatMap((u) => u.entryIds));
    patchProject((p) => ({
      ...p,
      prompt,
      entries: p.entries.map((e) =>
        workIdSet.has(e.id)
          ? { ...e, status: "pending", error: undefined }
          : e,
      ),
    }));

    let finished = 0;
    let okCount = 0;
    let failCount = 0;
    let cursor = 0;
    let tokenAcc = emptyTokenStats();
    const tokensAtStart = { ...active.tokens };
    const skippedAtStart = active.entries.filter(
      (e) => e.status === "skipped",
    ).length;
    let liveEntries = active.entries.map((e) => ({ ...e }));
    const folder = active.folder || projectFolderRef.current || undefined;

    const worker = async () => {
      while (true) {
        if (gen !== genRef.current || ac.signal.aborted) return;
        const idx = cursor++;
        if (idx >= workUnits.length) return;
        const unit = workUnits[idx];
        const idSet = new Set(unit.entryIds);

        liveEntries = liveEntries.map((e) =>
          idSet.has(e.id) ? { ...e, status: "running" as const } : e,
        );
        patchProject((p) => ({
          ...p,
          entries: p.entries.map((e) =>
            idSet.has(e.id) ? { ...e, status: "running" } : e,
          ),
        }));

        try {
          const preparedSources = unit.sources.map((s) =>
            applyReplaceRules(s, pre),
          );
          if (preparedSources.every((s) => !s.trim())) {
            okCount += unit.entryIds.length;
            liveEntries = liveEntries.map((e) =>
              idSet.has(e.id)
                ? {
                    ...e,
                    dst: e.src,
                    status: "skipped" as const,
                    error: undefined,
                  }
                : e,
            );
            patchProject((p) => ({
              ...p,
              entries: p.entries.map((e) =>
                idSet.has(e.id)
                  ? {
                      ...e,
                      dst: e.src,
                      status: "skipped",
                      error: undefined,
                    }
                  : e,
              ),
            }));
            continue;
          }

          const { text, prompt: callPrompt } = buildGroupTranslatePayload(
            preparedSources,
            prompt,
          );
          if (!text.trim()) {
            throw new Error("Empty text to translate");
          }
          const provider = settings.textTranslateProvider || "llm";
          const res = await api.translate(text, { signal: ac.signal }, {
            provider,
            source: active.sourceLang,
            target: active.targetLang,
            ...(provider === "llm"
              ? {
                  apiUrl: settings.apiUrl,
                  apiKey: settings.apiKey,
                  model: settings.model || active.model,
                  prompt: callPrompt,
                  glossary: JSON.stringify(glossary),
                }
              : {
                  maxLength: 0,
                  autoChunk: true,
                }),
          });

          const rawDst = res.translation || "";
          const parts = splitGroupTranslation(
            rawDst,
            unit.entryIds.length,
            unit.sourceLens,
          ).map((part) => applyReplaceRules(part, post));

          const tok = {
            promptTokens: res.promptTokens || 0,
            completionTokens: res.completionTokens || 0,
            totalTokens: res.totalTokens || 0,
          };
          tokenAcc = addTokens(tokenAcc, tok);
          if (gen !== genRef.current) return;

          okCount += unit.entryIds.length;
          const dstById = new Map(
            unit.entryIds.map((id, i) => [id, parts[i] ?? ""]),
          );
          liveEntries = liveEntries.map((e) =>
            dstById.has(e.id)
              ? {
                  ...e,
                  dst: dstById.get(e.id) || "",
                  status: "done" as const,
                  error: undefined,
                }
              : e,
          );
          patchProject((p) => ({
            ...p,
            tokens: addTokens(p.tokens, tok),
            entries: p.entries.map((e) =>
              dstById.has(e.id)
                ? {
                    ...e,
                    dst: dstById.get(e.id) || "",
                    status: "done",
                    error: undefined,
                  }
                : e,
            ),
          }));
        } catch (e) {
          if (ac.signal.aborted || gen !== genRef.current) return;
          const msg = toFriendlyError(e);
          failCount += unit.entryIds.length;
          liveEntries = liveEntries.map((x) =>
            idSet.has(x.id)
              ? { ...x, status: "error" as const, error: msg }
              : x,
          );
          patchProject((p) => ({
            ...p,
            entries: p.entries.map((x) =>
              idSet.has(x.id) ? { ...x, status: "error", error: msg } : x,
            ),
          }));
          setError(msg);
        } finally {
          finished += unit.entryIds.length;
          setSessionDone(finished);
          setStatusLine(
            `翻译中 · ${finished}/${entryWorkCount}（成功 ${okCount} · 失败 ${failCount}）`,
          );
          if (pipelineActiveRef.current) {
            const p =
              entryWorkCount > 0 ? finished / entryWorkCount : 1;
            setPipeline({
              visible: true,
              step: 4,
              detail: `翻译 ${finished}/${entryWorkCount}（成功 ${okCount} · 失败 ${failCount}）`,
              ratio: 0.4 + 0.55 * p,
            });
          }
        }
      }
    };

    try {
      await worker();
      if (gen !== genRef.current) return;
      if (pipelineActiveRef.current) {
        setPipeline({
          visible: true,
          step: 5,
          detail: "保存并导出…",
          ratio: 0.95,
        });
      }
      const finalElapsed = elapsedBase + Math.round(performance.now() - t0);
      const finalProject: TextProject = {
        ...active,
        prompt,
        folder,
        entries: liveEntries,
        tokens: addTokens(tokensAtStart, tokenAcc),
        elapsedMs: finalElapsed,
      };
      setElapsedMs(finalElapsed);
      setProject(finalProject);
      projectRef.current = finalProject;
      runStartedAtRef.current = null;
      try {
        await persistProject(finalProject, {
          folder: folder || projectFolderRef.current,
          overwrite: true,
        });
      } catch {
        /* keep UI state even if disk save fails */
      }
      if (failCount === 0) {
        try {
          const path = await exportResult(finalProject);
          setStatusLine(
            path
              ? `完成 · 成功 ${okCount} · 已导出：${path} · Token ${tokenAcc.totalTokens} · ${formatDuration(finalElapsed - elapsedBase)}`
              : `完成 · 成功 ${okCount} · 未导出（已取消选择路径） · Token ${tokenAcc.totalTokens} · ${formatDuration(finalElapsed - elapsedBase)}`,
          );
        } catch {
          setStatusLine(
            `完成 · 成功 ${okCount} · 导出失败 · Token ${tokenAcc.totalTokens} · ${formatDuration(finalElapsed - elapsedBase)}`,
          );
        }
      } else {
        setStatusLine(
          `完成 · 成功 ${okCount} · 失败 ${failCount} · 跳过 ${skippedAtStart} · Token ${tokenAcc.totalTokens} · ${formatDuration(finalElapsed - elapsedBase)}`,
        );
      }
      if (pipelineActiveRef.current) {
        setPipeline({
          visible: true,
          step: 5,
          detail:
            failCount === 0
              ? `完成 · 成功 ${okCount}`
              : `完成 · 成功 ${okCount} · 失败 ${failCount}`,
          ratio: 1,
        });
      }
    } finally {
      if (tickRef.current != null) {
        window.clearInterval(tickRef.current);
        tickRef.current = null;
      }
      if (runStartedAtRef.current != null) {
        const endElapsed =
          elapsedBaseRef.current +
          Math.round(performance.now() - runStartedAtRef.current);
        setElapsedMs(endElapsed);
        setProject((p) => {
          if (!p) return p;
          const next = { ...p, elapsedMs: endElapsed };
          projectRef.current = next;
          return next;
        });
        runStartedAtRef.current = null;
      }
      if (gen === genRef.current) {
        setBusy(false);
        busyRef.current = false;
        abortRef.current = null;
      }
    }
  }, [
    glossaryFromSettings,
    onlyUntranslated,
    patchProject,
    postFromSettings,
    preFromSettings,
    settings,
  ]);

  const onDragEnter = (side: "new" | "open") => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(side);
  };

  const onDragOverZone = (side: "new" | "open") => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    setDragOver(side);
  };

  const onDragLeaveZone = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const next = e.relatedTarget as Node | null;
    if (next && (e.currentTarget as HTMLElement).contains(next)) return;
    setDragOver(null);
  };

  const onDrop = (side: "new" | "open") => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(null);
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    acceptPendingFile(f, side);
  };

  const pickFile = (side: "new" | "open") => {
    setPendingSide(side);
    const input = fileRef.current;
    if (input) {
      input.accept =
        side === "new"
          ? ".json,.txt,.md,.srt,.ass,.ssa,text/plain,application/json"
          : `.llmchat-proj.json,${PROJECT_EXT}`;
      input.click();
    }
  };

  if (phase === "home") {
    return (
      <div className="text-home">
        {error && <p className="boot-error text-error">{error}</p>}
        <input
          ref={fileRef}
          type="file"
          accept=".json,.txt,.md,.srt,.ass,.ssa,text/plain,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) acceptPendingFile(f, pendingSide);
            e.target.value = "";
          }}
        />
        <div className="text-home-grid">
          <section className="text-home-card">
            <header className="text-home-card-head">
              <div className="text-home-icon" aria-hidden>
                <svg viewBox="0 0 24 24" width="28" height="28">
                  <path
                    fill="currentColor"
                    d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm1 7V3.5L19.5 9H15z"
                  />
                </svg>
              </div>
              <div>
                <h2>新建工程</h2>
                <p>
                  从源文件创建工程，自动保存到设置中的工程目录（每个工程一个文件夹）
                </p>
              </div>
            </header>
            <div
              role="button"
              tabIndex={0}
              className={`text-dropzone${dragOver === "new" ? " is-over" : ""}`}
              onClick={() => pickFile("new")}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  pickFile("new");
                }
              }}
              onDragEnter={onDragEnter("new")}
              onDragOver={onDragOverZone("new")}
              onDragLeave={onDragLeaveZone}
              onDrop={onDrop("new")}
            >
              <span className="text-dropzone-plus">＋</span>
              <strong>
                {pendingFile && pendingSide === "new"
                  ? pendingFile.name
                  : "点击或拖拽源文件"}
              </strong>
              <span>{SOURCE_FORMATS_HINT}</span>
            </div>
            <h3 className="text-home-sub">支持文件格式</h3>
            <div className="text-format-grid">
              {FORMAT_CARDS.map((f) => (
                <div key={f.title} className="text-format-item">
                  <strong>{f.title}</strong>
                  <span>{f.exts}</span>
                </div>
              ))}
            </div>
            <div className="text-home-actions">
              <button
                type="button"
                className="send-btn"
                disabled={!pendingFile || pendingSide !== "new"}
                onClick={() => void onConfirmFile()}
              >
                创建工程
              </button>
            </div>
          </section>

          <section className="text-home-card">
            <header className="text-home-card-head">
              <div className="text-home-icon" aria-hidden>
                <svg viewBox="0 0 24 24" width="28" height="28">
                  <path
                    fill="currentColor"
                    d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"
                  />
                </svg>
              </div>
              <div>
                <h2>打开工程</h2>
                <p>仅打开已保存的工程文件（*{PROJECT_EXT}）</p>
              </div>
            </header>
            <div
              role="button"
              tabIndex={0}
              className={`text-dropzone${dragOver === "open" ? " is-over" : ""}`}
              onClick={() => pickFile("open")}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  pickFile("open");
                }
              }}
              onDragEnter={onDragEnter("open")}
              onDragOver={onDragOverZone("open")}
              onDragLeave={onDragLeaveZone}
              onDrop={onDrop("open")}
            >
              <span className="text-dropzone-plus">＋</span>
              <strong>
                {pendingFile && pendingSide === "open"
                  ? pendingFile.name
                  : "点击或拖拽工程文件"}
              </strong>
              <span>*{PROJECT_EXT}</span>
            </div>
            <h3 className="text-home-sub">最近打开</h3>
            <ul className="text-recent-list">
              {recent.length === 0 && (
                <li className="text-recent-empty">暂无记录</li>
              )}
              {recent.map((r) => (
                <li key={`${r.folder}-${r.openedAt}`}>
                  <button
                    type="button"
                    className="text-recent-item"
                    onClick={() => void openRecentProject(r)}
                    title={r.folder}
                  >
                    <span className="text-recent-name">{r.name}</span>
                    <span className="text-recent-meta">
                      {r.folder} · {new Date(r.openedAt).toLocaleString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="text-home-actions">
              <button
                type="button"
                className="send-btn"
                disabled={!pendingFile || pendingSide !== "open"}
                onClick={() => void onConfirmFile()}
              >
                打开工程
              </button>
            </div>
          </section>
        </div>
      </div>
    );
  }

  if (!project) return null;

  const plainJoinedSrc =
    project.format === "plain"
      ? project.entries.map((e) => e.src).join("\n\n")
      : "";
  const plainJoinedDst =
    project.format === "plain"
      ? project.entries.map((e) => e.dst || "").join("\n\n")
      : "";

  return (
    <div className="text-layout">
      <div className="text-toolbar">
        <button
          type="button"
          className="text-tool-btn"
          onClick={() => {
            void (async () => {
              if (busy) await stop();
              else if (project) await persistFullSnapshot();
              setPhase("home");
            })();
          }}
        >
          ← 工程
        </button>
        <button
          type="button"
          className="text-tool-btn text-tool-btn-primary"
          disabled={busy || stats.untranslated === 0}
          onClick={() => void runTranslate()}
        >
          {busy ? "翻译中…" : "开始翻译"}
        </button>
        <button
          type="button"
          className="text-tool-btn"
          disabled={busy || !project}
          onClick={() => {
            if (!project || busy) return;
            const ok = window.confirm(
              project.subtitleRetiming
                ? "重新翻译将清空译文，并按「重组时间轴」从原始字幕重新切分后再翻译，是否继续？"
                : "重新翻译将清空全部条目的译文与状态（恢复为未译），并立即开始翻译，是否继续？",
            );
            if (!ok) return;
            void (async () => {
              const next: TextProject = {
                ...project,
                // Allow force retime from original ASR cues
                subtitleRetimed: project.subtitleRetiming
                  ? false
                  : project.subtitleRetimed,
                entries: project.entries.map((e) => {
                  if (isNoNeedTranslate(e.src)) {
                    return {
                      ...e,
                      dst: e.src,
                      status: "skipped" as const,
                      error: undefined,
                    };
                  }
                  return {
                    ...e,
                    dst: "",
                    status: "pending" as const,
                    error: undefined,
                  };
                }),
              };
              setProject(next);
              projectRef.current = next;
              setSessionDone(0);
              setSessionTotal(0);
              try {
                await persistFullSnapshot({ project: next });
              } catch {
                /* ignore */
              }
              await runTranslate(next, {
                forceRetime: !!next.subtitleRetiming,
              });
            })();
          }}
        >
          重新翻译
        </button>
        {busy && (
          <button
            type="button"
            className="text-tool-btn"
            onClick={() => void stop()}
          >
            停止
          </button>
        )}
        <button
          type="button"
          className="text-tool-btn"
          disabled={busy}
          onClick={saveProjectFile}
        >
          保存工程
        </button>
        <button
          type="button"
          className="text-tool-btn"
          disabled={!entries.some((e) => e.status === "done")}
          onClick={() => {
            void exportResult().catch((e) =>
              setError(toFriendlyError(e, "导出失败")),
            );
          }}
        >
          导出
        </button>
        <button
          type="button"
          className={showPrompt ? "text-tool-btn active" : "text-tool-btn"}
          onClick={() => setShowPrompt((v) => !v)}
        >
          提示词
        </button>
        <span className="text-toolbar-meta" title={statusLine || undefined}>
          {project.format.toUpperCase()} · {project.sourceLang} →{" "}
          {project.targetLang} ·{" "}
          {settings.textTranslateProvider === "llm"
            ? settings.model || project.model
            : settings.textTranslateProvider}
          {projectFolderPath
            ? ` · ${projectFolderPath}`
            : project.sourceFileName
              ? ` · ${project.sourceFileName}`
              : ""}
          {statusLine ? ` · ${statusLine}` : ""}
        </span>
      </div>

      {showPrompt && (
        <div className="text-prompt-panel">
          <div className="text-prompt-head">
            <strong>工程提示词</strong>
            <button
              type="button"
              className="settings-test-btn"
              onClick={() =>
                setPromptDraft(
                  project.format === "srt" || project.format === "ass"
                    ? DEFAULT_SUBTITLE_PROMPT
                    : DEFAULT_TEXT_PROMPT,
                )
              }
            >
              恢复默认
            </button>
          </div>
          <textarea
            className="settings-prompt"
            rows={4}
            value={promptDraft}
            disabled={busy}
            onChange={(e) => setPromptDraft(e.target.value)}
          />
        </div>
      )}

      <div className="text-stats-row">
        <section className="text-stats-card">
          <header className="text-stats-card-head">
            <strong>条目状态</strong>
            <span>
              {notStarted
                ? "未开始"
                : `合计 ${stats.total}${busy ? ` · ${progressPctLabel}%` : ""}`}
            </span>
          </header>
          <StatPieGroup slices={statusCountSlices} height={168} />
        </section>

        <section className="text-stats-card">
          <header className="text-stats-card-head">
            <strong>Token</strong>
            <span>
              {notStarted
                ? "未开始"
                : `${project.tokens.totalTokens} · ${stats.total} 条`}
            </span>
          </header>
          <StatPieGroup slices={tokenSlices} height={168} />
        </section>

        <div className="text-stats-side">
          <section className="text-stats-card text-stats-timer">
            <header className="text-stats-card-head">
              <strong>用时</strong>
            </header>
            <div className="text-timer-display">{formatDuration(elapsedMs)}</div>
          </section>
          <section className="text-stats-card text-stats-timer">
            <header className="text-stats-card-head">
              <strong>进度</strong>
              <span>{progressCountLabel}</span>
            </header>
            <div className="text-timer-display text-progress-pct">
              {progressPctLabel}%
            </div>
            <div className="text-progress-bar text-timer-bar">
              <div
                className="text-progress-fill"
                style={{ width: `${Math.min(100, progressPct)}%` }}
              />
            </div>
          </section>
        </div>
      </div>

      {pipeline?.visible && <RetimeProgressPanel state={pipeline} />}

      <div className="text-json-opts text-json-opts-stack">
        <div className="text-switch-row">
          <label
            className={`text-switch-card ${onlyUntranslated ? "is-on" : ""}`}
          >
            <input
              type="checkbox"
              className="text-switch"
              checked={onlyUntranslated}
              disabled={busy}
              onChange={(e) => setOnlyUntranslated(e.target.checked)}
            />
            <span className="text-switch-label">仅翻译未译条目</span>
          </label>
          {(project.format === "srt" || project.format === "ass") && (
            <label
              className={`text-switch-card ${project.subtitleRetiming ? "is-on" : ""}`}
              title="开启后，开始/重新翻译前会合并 ASR 碎片并重切时间码；关闭则保持原时间轴"
            >
              <input
                type="checkbox"
                className="text-switch"
                checked={!!project.subtitleRetiming}
                disabled={busy}
                onChange={(e) => {
                  const on = e.target.checked;
                  patchProject((p) => ({
                    ...p,
                    subtitleRetiming: on,
                  }));
                }}
              />
              <span className="text-switch-label">
                重组时间轴
                {project.subtitleRetimed ? " · 已重组" : ""}
              </span>
            </label>
          )}
        </div>
      </div>

      {error && <p className="boot-error text-error">{error}</p>}

      <div className="text-entries-footer">
        <button
          type="button"
          className="text-tool-btn entries-open-btn"
          title="从底部展开原文与译文对照"
          onClick={() => setEntriesPanelOpen(true)}
        >
          原文 / 译文
          {stats.total > 0 ? ` · ${stats.total} 条` : ""}
        </button>
      </div>

      {entriesPanelOpen && (
        <div
          className="entries-sheet-backdrop"
          role="presentation"
          onClick={() => setEntriesPanelOpen(false)}
        >
          <div
            className="entries-sheet"
            role="dialog"
            aria-labelledby="entries-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="entries-modal-head">
              <h3 id="entries-modal-title">原文 / 译文</h3>
              <div className="entries-modal-head-actions">
                {project.format !== "plain" && (
                  <input
                    className="text-filter"
                    placeholder="筛选原文/译文…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                )}
                <button
                  type="button"
                  className="text-tool-btn"
                  onClick={() => setEntriesPanelOpen(false)}
                >
                  关闭
                </button>
              </div>
            </header>

            {project.format === "plain" && entries.length <= 1 ? (
              <div className="text-panes entries-modal-body">
                <div
                  className="text-pane"
                  style={{ width: srcWidth, flex: "0 0 auto" }}
                >
                  <div className="text-pane-head">
                    <h3>原文</h3>
                  </div>
                  <textarea
                    className="text-pane-area"
                    value={plainJoinedSrc}
                    disabled={busy}
                    onChange={(e) => {
                      const v = e.target.value;
                      patchProject((p) => ({
                        ...p,
                        entries: [
                          {
                            id: "p-0",
                            src: v,
                            dst: p.entries[0]?.dst || "",
                            status: classifyEntryStatus(
                              v,
                              p.entries[0]?.dst || "",
                            ),
                          },
                        ],
                        sourceMeta: { plainText: v },
                      }));
                    }}
                  />
                </div>
                <div
                  className="col-resizer-panel text-pane-resizer"
                  title="拖动调整宽度"
                  onMouseDown={(e) => beginResize(e, "grow-right")}
                />
                <div className="text-pane" style={{ flex: 1, minWidth: 0 }}>
                  <div className="text-pane-head">
                    <h3>译文</h3>
                  </div>
                  <textarea
                    className="text-pane-area"
                    value={plainJoinedDst}
                    onChange={(e) => {
                      const v = e.target.value;
                      patchProject((p) => ({
                        ...p,
                        entries: [
                          {
                            id: "p-0",
                            src: p.entries[0]?.src || "",
                            dst: v,
                            status: classifyEntryStatus(
                              p.entries[0]?.src || "",
                              v,
                            ),
                          },
                        ],
                      }));
                    }}
                  />
                </div>
              </div>
            ) : (
              <div className="text-entry-wrap entries-modal-body">
                <div className="text-entry-table">
                  <div className="text-entry-row is-head">
                    <span>#</span>
                    <span>原文</span>
                    <span>译文</span>
                    <span>状态</span>
                  </div>
                  {filteredEntries.map((e, i) => (
                    <div
                      key={e.id}
                      className={`text-entry-row status-${e.status}`}
                      title={e.error || undefined}
                    >
                      <span className="text-entry-idx">{i + 1}</span>
                      <span className="text-entry-src">
                        {e.src || "（空）"}
                      </span>
                      <input
                        className="text-entry-dst"
                        value={e.dst}
                        disabled={busy || e.status === "skipped"}
                        onChange={(ev) => {
                          const v = ev.target.value;
                          patchProject((p) => ({
                            ...p,
                            entries: p.entries.map((x) =>
                              x.id === e.id
                                ? {
                                    ...x,
                                    dst: v,
                                    status:
                                      x.status === "skipped"
                                        ? "skipped"
                                        : classifyEntryStatus(x.src, v),
                                  }
                                : x,
                            ),
                          }));
                        }}
                      />
                      <span className={`text-entry-status is-${e.status}`}>
                        {statusLabel(e.status)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
