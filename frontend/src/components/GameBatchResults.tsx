
import { useState } from "react";
import { GamePageNumber } from "./GamePageNumber";
import type { UnityImage } from "../unityOffline";
import type { ImageIndexIssue } from "../gameImageGroupChanges";
import { imageManuallyExcluded, IMAGE_PRESENCE_CONFLICT, IMAGE_PRESENCE_REVIEW_HINT } from "../gameImageScreening";

export type BatchRow = { id: string; label: string; detail: string; group?: string } & (
  { kind: "text" } | { kind: "resource"; paths: string[]; text?: { source: string; translation: string } }
);
export function gameImageBatchErrors(images: UnityImage[], includeExcluded = false) {
  const errors: ImageIndexIssue[] = [];
  for (const image of images) {
    const screening = image.screening;
    const error = screening?.redrawError || image.error ||
      (screening?.refineFailed || screening?.state === "failed" ? screening.reason : undefined) ||
      image.regions.find(region => region.selected && region.error)?.error;
    if (error && (includeExcluded || !imageManuallyExcluded(image))) {
      const conflict = error.indexOf(IMAGE_PRESENCE_CONFLICT);
      const detail = conflict < 0 ? error : error.slice(0, conflict + IMAGE_PRESENCE_CONFLICT.length) + "。" + IMAGE_PRESENCE_REVIEW_HINT;
      errors.push({ id: image.id, detail });
    }
  }
  return errors;
}

const pageSize = 30;
const imagePresenceConflictGroup = "复筛判断矛盾";

export function batchFailureType(detail: string) {
  if (detail.includes(IMAGE_PRESENCE_CONFLICT)) return imagePresenceConflictGroup;
  const categories: [RegExp, string][] = [
    [/输出被截断|输出达到长度上限/, "模型输出被截断"],
    [/置信度无效/, "置信度无效"],
    [/识别区域|区域.*坐标|坐标或置信度|缺少文字/, "识别区域无效"],
    [/JSON|结构化|输出格式/, "模型输出格式无效"],
    [/已取消或超过时限/, "请求超时或取消"],
    [/超时|timeout|timed out/i, "请求超时"],
    [/拒答|未提供译文|译文为空|空译文/, "译文内容无效"],
    [/占位符|转义|富文本|控制符/, "译文格式校验失败"],
    [/排版|断行|无法放入/, "译文排版失败"],
    [/连接|网络|fetch|HTTP|服务未/i, "连接或服务异常"],
    [/资源.*(?:改变|改动)|补丁.*冲突/, "资源发生变化"],
    [/读取|写入|文件|目录|路径/, "文件读写失败"],
  ];
  return categories.find(([pattern]) => pattern.test(detail))?.[1] || "其他处理失败";
}

function BatchGroup({ title, rows, onLocate }: { title: string; rows: BatchRow[]; onLocate: (row: BatchRow) => void }) {
  const [page, setPage] = useState(0);
  const pages = Math.ceil(rows.length / pageSize);
  const current = Math.max(0, Math.min(page, pages - 1));
  const visible = rows.slice(current * pageSize, (current + 1) * pageSize);
  return <details className="game-batch-group">
    <summary>{title} · {rows.length}</summary>
    {title === imagePresenceConflictGroup && <p className="hint">{IMAGE_PRESENCE_REVIEW_HINT}</p>}
    <ul>{visible.map(row => <li key={row.kind + ":" + row.id}>
      <button type="button" className="unity-progress-locate" aria-label={"定位 " + row.label} data-tooltip={row.label}
        onClick={() => onLocate(row)}>{row.label}</button>
      <span className="game-batch-detail" data-tooltip={row.detail}>{row.detail}</span>
    </li>)}</ul>
    {pages > 1 && <div className="game-batch-page-controls" role="group" aria-label={title + "翻页"}>
      <button type="button" aria-label="上一页" data-tooltip="上一页" disabled={current === 0} onClick={() => setPage(current - 1)}>
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m12 5-5 5 5 5" /></svg>
      </button>
      <GamePageNumber page={current} pages={pages} onPage={setPage} />
      <button type="button" aria-label="下一页" data-tooltip="下一页" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m8 5 5 5-5 5" /></svg>
      </button>
    </div>}
  </details>;
}

function BatchList({ title, rows, onLocate, onRetry, failed = false }: {
  title: string; rows: BatchRow[]; failed?: boolean; onLocate: (row: BatchRow) => void; onRetry?: () => void;
}) {
  const groups = new Map<string, BatchRow[]>();
  for (const row of rows) {
    const group = row.group || (failed ? batchFailureType(row.detail) : title);
    const items = groups.get(group) || [];
    items.push(row);
    groups.set(group, items);
  }
  return <details className={`game-batch-list${failed && rows.length ? " is-error" : ""}`}>
    <summary>{title} · {rows.length}</summary>
    {onRetry && <button type="button" className="unity-btn" onClick={onRetry}>重试失败文本</button>}
    {[...groups].map(([name, items]) => <BatchGroup key={name} title={name} rows={items} onLocate={onLocate} />)}
  </details>;
}

export function GameBatchResults({ errors, repairs, onLocate, onRetry }: {
  errors: BatchRow[]; repairs?: BatchRow[]; onLocate: (row: BatchRow) => void; onRetry?: () => void;
}) {
  return <div className="game-batch-results">
    {!!errors.length && <BatchList failed title="失败条目" rows={errors} onLocate={onLocate} onRetry={onRetry} />}
    {!!repairs?.length && <BatchList title="对话纠错" rows={repairs} onLocate={onLocate} />}
  </div>;
}

