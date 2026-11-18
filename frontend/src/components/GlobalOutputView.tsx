import { useLayoutEffect, useState } from "react";
import { resolveOutputIssue, useAppOutput, useUnreadOutput, viewAppOutput } from "../appOutput";
import { useFollowLatest } from "../hooks/useFollowLatest";

export function OutputBadge() {
  const count = useUnreadOutput();
  return count ? <strong className="output-badge" aria-label={`${count} 条未读提醒或待处理错误`} role="status">{count}</strong> : null;
}

export function GlobalOutputView() {
  useLayoutEffect(viewAppOutput, []);
  const { rows, issues, warning, logPath } = useAppOutput();
  const [onlyIssues, setOnlyIssues] = useState(false);
  const openIds = new Set(issues.map(row => row.id));
  const openKeys = new Set(issues.map(row => row.issue));
  const visible = onlyIssues ? issues : rows;
  const scroll = useFollowLatest<HTMLUListElement>();
  return <section className="global-output" aria-label="全局输出">
    <header><h1>输出</h1><button type="button" aria-pressed={onlyIssues} onClick={() => setOnlyIssues(value => !value)}>待处理错误 · {issues.length}</button>{logPath && <code data-tooltip={logPath}>{logPath}</code>}</header>
    {warning && <p role="alert">{warning}</p>}
    {visible.length ? <ul ref={scroll} role="log" tabIndex={0} aria-label={onlyIssues ? "待处理错误" : "运行记录"}>
      {visible.map(row => <li key={row.id} className={`level-${row.level}`}><time>{row.time}</time><span>{row.text}</span>
        {openIds.has(row.id) ? <button type="button" onClick={() => resolveOutputIssue(row)}>标记已解决</button>
          : row.issue && !openKeys.has(row.issue) && <small>已解决</small>}</li>)}
    </ul> : <p>{onlyIssues ? "没有待处理错误" : "暂无输出"}</p>}
  </section>;
}
