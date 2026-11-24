/** 运行记录页的分类切换：正式运行 / 测试运行。界面只负责切换，数据由父组件给。 */
export type RunRecordMode = "formal" | "test";

const TABS: { mode: RunRecordMode; label: string; hint: string }[] = [
  { mode: "formal", label: "正式记录", hint: "你在工作流里实际跑过的步骤" },
  { mode: "test", label: "测试运行", hint: "测试队列跑出来的对照结果" },
];

export function RunRecordTabs({
  mode,
  onChange,
  counts,
}: {
  mode: RunRecordMode;
  onChange: (mode: RunRecordMode) => void;
  counts?: Partial<Record<RunRecordMode, number>>;
}) {
  return (
    <div className="game-benchmark-modes" role="tablist" aria-label="运行记录分类">
      {TABS.map((tab) => {
        const active = tab.mode === mode;
        const count = counts?.[tab.mode];
        return (
          <button
            key={tab.mode}
            type="button"
            role="tab"
            aria-selected={active}
            className={active ? "is-active" : undefined}
            data-tooltip={tab.hint}
            onClick={() => onChange(tab.mode)}
          >
            {tab.label}
            {typeof count === "number" ? <small>{count}</small> : null}
          </button>
        );
      })}
    </div>
  );
}
