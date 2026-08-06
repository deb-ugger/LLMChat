import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api";
import { toFriendlyError } from "../friendlyError";
import {
  DEFAULT_PRICING_TABLE,
  defaultVendorCurrency,
  emptyRates,
  newRuleId,
  type PricingCurrency,
  type PricingRule,
  type PricingTable,
  type TokenRates,
} from "../pricingDefaults";
import {
  currentEffectivePresets,
  effectiveGroupPresets,
  type ModelPreset,
} from "../modelPresets";

export type PricingPanelHandle = {
  save: () => Promise<void>;
  discard: () => Promise<void>;
  isDirty: () => boolean;
};

type Props = {
  active: boolean;
  notify: (message: string, ok?: boolean) => void;
};

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDaysIso(iso: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Convert legacy half-open adjacency (next.from === prev.to) to inclusive. */
function migrateHalfOpenRules(rules: PricingRule[]): PricingRule[] {
  const byModel = new Map<string, PricingRule[]>();
  for (const r of rules) {
    const id = r.model.trim();
    if (!id) continue;
    if (!byModel.has(id)) byModel.set(id, []);
    byModel.get(id)!.push({ ...r });
  }
  const out: PricingRule[] = [];
  for (const list of byModel.values()) {
    list.sort((a, b) =>
      (a.from || "0000-01-01").localeCompare(b.from || "0000-01-01"),
    );
    for (let i = 0; i + 1 < list.length; i++) {
      const cur = list[i];
      const next = list[i + 1];
      if (cur.to && next.from && next.from === cur.to) {
        cur.to = addDaysIso(cur.to, -1);
      }
    }
    out.push(...list);
  }
  // preserve rules without model
  for (const r of rules) {
    if (!r.model.trim()) out.push(r);
  }
  return out;
}

function normalizeTable(raw: Partial<PricingTable> & {
  rules?: Array<
    Partial<PricingRule> & {
      cny?: TokenRates;
      usd?: TokenRates;
      rates?: TokenRates;
    }
  >;
} | null | undefined): PricingTable {
  const displayCurrency: PricingCurrency =
    raw?.displayCurrency === "USD" ? "USD" : "CNY";
  const vendorCurrencies: Record<string, PricingCurrency> = {};
  const rawVc = raw?.vendorCurrencies ?? {};
  for (const [k, v] of Object.entries(rawVc)) {
    const vendor = k.trim();
    if (!vendor) continue;
    vendorCurrencies[vendor] = v === "USD" ? "USD" : "CNY";
  }

  const rules = Array.isArray(raw?.rules)
    ? raw!.rules.map((r) => {
        const vendor = (r.vendor || "").trim();
        let cur =
          vendorCurrencies[vendor] ?? defaultVendorCurrency(vendor);
        if (vendor && !(vendor in vendorCurrencies)) {
          vendorCurrencies[vendor] = cur;
        }
        let rates: TokenRates;
        if (r.rates) {
          rates = { ...emptyRates(), ...r.rates };
        } else {
          const legacy =
            cur === "USD"
              ? (r as { usd?: TokenRates }).usd
              : (r as { cny?: TokenRates }).cny;
          rates = { ...emptyRates(), ...(legacy || {}) };
        }
        return {
          id: (r.id || "").trim() || newRuleId(),
          vendor,
          model: (r.model || "").trim(),
          from: (r.from || "").trim(),
          to: (r.to || "").trim(),
          rates,
        };
      })
    : [];

  return { displayCurrency, vendorCurrencies, rules };
}

function syncRulesToPresets(
  rules: PricingRule[],
  presets: ModelPreset[],
  vendorCurrencies: Record<string, PricingCurrency>,
): PricingRule[] {
  const byModel = new Map<string, PricingRule[]>();
  for (const r of rules) {
    const id = r.model.trim();
    if (!id) continue;
    if (!byModel.has(id)) byModel.set(id, []);
    byModel.get(id)!.push(r);
  }

  const out: PricingRule[] = [];
  for (const p of presets) {
    const existing = byModel.get(p.model);
    if (existing && existing.length > 0) {
      for (const r of existing) {
        out.push({ ...r, vendor: p.group || r.vendor, model: p.model });
      }
      continue;
    }
    const seed = DEFAULT_PRICING_TABLE.rules.find((d) => d.model === p.model);
    out.push({
      id: newRuleId(),
      vendor: p.group,
      model: p.model,
      from: "",
      to: "",
      rates: seed ? { ...seed.rates } : emptyRates(),
    });
    if (!(p.group in vendorCurrencies)) {
      vendorCurrencies[p.group] =
        DEFAULT_PRICING_TABLE.vendorCurrencies[p.group] ??
        defaultVendorCurrency(p.group);
    }
  }
  return out;
}

/** Inclusive range keys; empty from=-∞, empty to=+∞ */
function rangeStartKey(from: string): string {
  return from.trim() || "0000-01-01";
}
function rangeEndKey(to: string): string {
  return to.trim() || "9999-12-31";
}

/** Inclusive [from, to] overlap */
function rangesOverlap(
  a: { from: string; to: string },
  b: { from: string; to: string },
): boolean {
  return (
    rangeStartKey(a.from) <= rangeEndKey(b.to) &&
    rangeStartKey(b.from) <= rangeEndKey(a.to)
  );
}

function isDeepSeekVendor(vendor: string): boolean {
  return vendor.trim().toLowerCase() === "deepseek";
}

function isIsoDate(s: string): boolean {
  return !s || /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * Validate single-rule shape + no overlap + day continuity per model.
 * Continuity: sorted by from, adjacent must satisfy next.from === prev.to + 1 day
 * (open-start only allowed as first; open-end only as last).
 */
function validateRules(rules: PricingRule[]): void {
  for (const r of rules) {
    if (!r.model.trim()) throw new Error("每条规则必须有模型 ID");
    if (!isIsoDate(r.from)) {
      throw new Error(`模型 ${r.model}：起始日期格式无效`);
    }
    if (!isIsoDate(r.to)) {
      throw new Error(`模型 ${r.model}：结束日期格式无效`);
    }
    // Inclusive: same day allowed; only reject to < from
    if (r.from && r.to && r.to < r.from) {
      throw new Error(`模型 ${r.model}：结束日期不能早于起始日期`);
    }
  }

  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      if (rules[i].model !== rules[j].model) continue;
      if (rangesOverlap(rules[i], rules[j])) {
        throw new Error(
          `模型 ${rules[i].model}：日期区间重叠，请调整起始/结束`,
        );
      }
    }
  }

  const byModel = new Map<string, PricingRule[]>();
  for (const r of rules) {
    const id = r.model.trim();
    if (!byModel.has(id)) byModel.set(id, []);
    byModel.get(id)!.push(r);
  }
  for (const [model, list] of byModel) {
    const sorted = [...list].sort((a, b) =>
      rangeStartKey(a.from).localeCompare(rangeStartKey(b.from)),
    );
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i];
      if (i === 0) {
        // open start ok
      } else if (!cur.from) {
        throw new Error(`模型 ${model}：仅第一段可以「不限起始」`);
      }
      if (i < sorted.length - 1 && !cur.to) {
        throw new Error(
          `模型 ${model}：中间区间不能「不限结束」，否则无法衔接后续`,
        );
      }
      if (i > 0) {
        const prev = sorted[i - 1];
        if (!prev.to) {
          throw new Error(`模型 ${model}：上一段不限结束，无法衔接`);
        }
        const expect = addDaysIso(prev.to, 1);
        if (cur.from !== expect) {
          throw new Error(
            `模型 ${model}：区间不连贯（上一段结束 ${prev.to}，下一段起始应为 ${expect}，当前为 ${cur.from || "不限"}）`,
          );
        }
      }
    }
  }
}

function maxIsoDate(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function BoundDateField({
  kind,
  value,
  peerDate,
  onChange,
}: {
  kind: "from" | "to";
  value: string;
  /** For end date: start date used when defaulting */
  peerDate?: string;
  onChange: (next: string) => void;
}) {
  const open = !value;
  const defaultDated = () => {
    if (kind === "to") {
      return maxIsoDate(todayIso(), (peerDate || "").trim());
    }
    return todayIso();
  };
  return (
    <div className="pricing-bound">
      <div className="pricing-bound-toggle" role="group">
        <button
          type="button"
          className={"pricing-bound-chip" + (open ? " is-active" : "")}
          onClick={() => onChange("")}
        >
          {kind === "from" ? "不限起始" : "不限结束"}
        </button>
        <button
          type="button"
          className={"pricing-bound-chip" + (!open ? " is-active" : "")}
          onClick={() => {
            if (!value) onChange(defaultDated());
          }}
        >
          指定日期
        </button>
      </div>
      {!open ? (
        <input
          type="date"
          className="pricing-date-input"
          value={value}
          min={kind === "to" && peerDate ? peerDate : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : null}
    </div>
  );
}

type DisplayRow = {
  rule: PricingRule;
  rowSpan: number; // >0 only on first of model; 0 = skip model cell
  intervalCount: number;
  isFirstOfModel: boolean;
};

export const PricingPanel = forwardRef<PricingPanelHandle, Props>(
  function PricingPanel({ active, notify }, ref) {
    const [table, setTable] = useState<PricingTable>(() => {
      const vendorCurrencies = {
        ...DEFAULT_PRICING_TABLE.vendorCurrencies,
      };
      return normalizeTable({
        displayCurrency: "CNY",
        vendorCurrencies,
        rules: syncRulesToPresets(
          [],
          currentEffectivePresets(),
          vendorCurrencies,
        ),
      });
    });
    const [loading, setLoading] = useState(false);
    const [dirty, setDirty] = useState(false);
    /** model = hover 模型ID（整组）；row = hover 某一区间（仅该行+模型ID） */
    const [hover, setHover] = useState<null | {
      mode: "model" | "row";
      model: string;
      ruleId?: string;
    }>(null);
    const tableRef = useRef(table);
    tableRef.current = table;

    const applyLocal = useCallback((next: PricingTable) => {
      setTable(next);
      tableRef.current = next;
      setDirty(true);
    }, []);

    const load = useCallback(async () => {
      setLoading(true);
      try {
        const res = await api.getPricing();
        const presets = currentEffectivePresets();
        const base = normalizeTable(res);
        const vendorCurrencies = { ...base.vendorCurrencies };
        const synced = normalizeTable({
          displayCurrency: base.displayCurrency,
          vendorCurrencies,
          rules: syncRulesToPresets(
            migrateHalfOpenRules(base.rules),
            presets,
            vendorCurrencies,
          ),
        });
        setTable(synced);
        tableRef.current = synced;
        setDirty(false);
      } catch (e) {
        notify(toFriendlyError(e, "加载价目表失败"), false);
      } finally {
        setLoading(false);
      }
    }, [notify]);

    useEffect(() => {
      if (active) void load();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    const save = useCallback(async () => {
      const presets = currentEffectivePresets();
      const vendorCurrencies = { ...tableRef.current.vendorCurrencies };
      const body: PricingTable = {
        displayCurrency: tableRef.current.displayCurrency,
        vendorCurrencies,
        rules: syncRulesToPresets(
          tableRef.current.rules,
          presets,
          vendorCurrencies,
        ),
      };
      try {
        validateRules(body.rules);
      } catch (e) {
        notify(e instanceof Error ? e.message : "价目表不符合规则", false);
        throw e;
      }
      const res = await api.putPricing(body);
      const base = normalizeTable(res);
      const vc = { ...base.vendorCurrencies };
      const synced = normalizeTable({
        displayCurrency: base.displayCurrency,
        vendorCurrencies: vc,
        rules: syncRulesToPresets(base.rules, presets, vc),
      });
      setTable(synced);
      tableRef.current = synced;
      setDirty(false);
      notify("已保存计费价目表");
    }, [notify]);

    useImperativeHandle(
      ref,
      () => ({
        save,
        discard: async () => {
          setLoading(true);
          try {
            const res = await api.getPricing();
            const presets = currentEffectivePresets();
            const base = normalizeTable(res);
            const vendorCurrencies = { ...base.vendorCurrencies };
            const synced = normalizeTable({
              displayCurrency: base.displayCurrency,
              vendorCurrencies,
              rules: syncRulesToPresets(
                migrateHalfOpenRules(base.rules),
                presets,
                vendorCurrencies,
              ),
            });
            setTable(synced);
            tableRef.current = synced;
            setDirty(false);
            notify("已取消修改，已恢复为已保存的价目表");
          } catch (e) {
            notify(toFriendlyError(e, "取消修改失败"), false);
            throw e;
          } finally {
            setLoading(false);
          }
        },
        isDirty: () => tableRef.current !== undefined && dirty,
      }),
      [save, notify, dirty],
    );

    const vendorGroups = useMemo(() => {
      const groups = effectiveGroupPresets();
      const rulesByModel = new Map<string, PricingRule[]>();
      for (const r of table.rules) {
        const id = r.model.trim();
        if (!id) continue;
        if (!rulesByModel.has(id)) rulesByModel.set(id, []);
        rulesByModel.get(id)!.push(r);
      }
      for (const list of rulesByModel.values()) {
        list.sort((a, b) =>
          rangeStartKey(a.from).localeCompare(rangeStartKey(b.from)),
        );
      }

      return groups.map((g) => {
        const rows: DisplayRow[] = [];
        for (const p of g.models) {
          const list = rulesByModel.get(p.model) ?? [];
          list.forEach((rule, idx) => {
            rows.push({
              rule: { ...rule, vendor: g.group },
              rowSpan: idx === 0 ? list.length : 0,
              intervalCount: list.length,
              isFirstOfModel: idx === 0,
            });
          });
        }
        return { vendor: g.group, rows };
      });
    }, [table.rules]);

    const tryPatchRule = (id: string, patch: Partial<PricingRule>) => {
      const cur = tableRef.current;
      const nextRules = cur.rules.map((r) =>
        r.id === id ? { ...r, ...patch } : r,
      );
      try {
        validateRules(nextRules);
      } catch (e) {
        notify(e instanceof Error ? e.message : "日期不符合规则", false);
        // still apply so user can continue editing toward a valid state
      }
      applyLocal({ ...cur, rules: nextRules });
    };

    const patchRateField = (
      id: string,
      field: keyof TokenRates,
      value: number,
    ) => {
      const cur = tableRef.current;
      const rule = cur.rules.find((r) => r.id === id);
      if (!rule) return;
      const next: PricingRule = {
        ...rule,
        rates: {
          ...rule.rates,
          [field]: Number.isFinite(value) ? Math.max(0, value) : 0,
        },
      };
      applyLocal({
        ...cur,
        rules: cur.rules.map((r) => (r.id === id ? next : r)),
      });
    };

    const setVendorCurrency = (vendor: string, currency: PricingCurrency) => {
      const cur = tableRef.current;
      applyLocal({
        ...cur,
        vendorCurrencies: {
          ...cur.vendorCurrencies,
          [vendor]: currency,
        },
      });
    };

    /** Local only until save. New start = previous inclusive end + 1 day. */
    const addNewRange = (src: PricingRule) => {
      const cur = tableRef.current;
      if (!src.to) {
        notify(
          `「${src.model}」当前为「不限结束」（此后全部适用）。请先指定结束日期，保存前再新增区间。`,
          false,
        );
        return;
      }
      const newFrom = addDaysIso(src.to, 1);
      if (src.from && newFrom < src.from) {
        notify("结束日期无效，无法衔接新区间", false);
        return;
      }

      const right: PricingRule = {
        id: newRuleId(),
        vendor: src.vendor,
        model: src.model,
        from: newFrom,
        to: "",
        rates: { ...src.rates },
      };
      const nextRules = [...cur.rules, right];
      try {
        validateRules(nextRules);
      } catch (e) {
        notify(e instanceof Error ? e.message : "无法新增区间", false);
        return;
      }
      applyLocal({ ...cur, rules: nextRules });
      notify(`已暂存新区间（自 ${newFrom} 起），请点「保存价目表」写入`);
    };

    const removeInterval = (row: DisplayRow) => {
      if (row.intervalCount <= 1) return;
      const cur = tableRef.current;
      applyLocal({
        ...cur,
        rules: cur.rules.filter((r) => r.id !== row.rule.id),
      });
      notify(`已暂存删除，请点「保存价目表」写入`);
    };

    const resetDefaults = () => {
      if (
        !window.confirm(
          "将用内置默认价覆盖当前价目表（需再点保存才会写入磁盘）。继续？",
        )
      ) {
        return;
      }
      const presets = currentEffectivePresets();
      const vendorCurrencies = {
        ...DEFAULT_PRICING_TABLE.vendorCurrencies,
      };
      applyLocal(
        normalizeTable({
          displayCurrency: tableRef.current.displayCurrency,
          vendorCurrencies,
          rules: syncRulesToPresets(
            DEFAULT_PRICING_TABLE.rules,
            presets,
            vendorCurrencies,
          ),
        }),
      );
    };

    return (
      <div className="pricing-panel">
        <div className="pricing-sync-banner" role="note">
          <strong>模型列表与「通用」同步</strong>
          <span>
            计费页模型来自通用已配置列表，不能在此新增/删除模型；仅可维护区间与单价。新增/删除区间需点击底部「保存价目表」后才会写入；保存时会检查不重叠且按日连贯。
          </span>
        </div>

        {loading ? (
          <p className="hint">加载价目表…</p>
        ) : (
          <>
            <section className="settings-card">
              <div className="settings-card-head">
                <h2>显示与编辑</h2>
              </div>
              <div className="pricing-toolbar">
                <label className="settings-half">
                  统计页默认货币
                  <select
                    value={table.displayCurrency}
                    onChange={(e) =>
                      applyLocal({
                        ...tableRef.current,
                        displayCurrency:
                          e.target.value === "USD" ? "USD" : "CNY",
                      })
                    }
                  >
                    <option value="CNY">人民币 (CNY)</option>
                    <option value="USD">美元 (USD)</option>
                  </select>
                </label>
                <div className="pricing-toolbar-actions">
                  <button
                    type="button"
                    className="pricing-btn pricing-btn-secondary"
                    onClick={resetDefaults}
                  >
                    恢复内置默认单价
                  </button>
                  {dirty ? (
                    <span className="pricing-dirty-hint">有未保存修改</span>
                  ) : null}
                </div>
              </div>
              <p className="hint">
                计费货币按厂商设置（见各厂商标题栏）。单价按该货币填写；统计页切换货币时，只汇总对应货币厂商的费用（不做汇率换算）。默认区间为「不限起始 +
                不限结束」；若拆分多段，日期为闭区间且须按日衔接。
              </p>
            </section>

            {vendorGroups.every((g) => g.rows.length === 0) ? (
              <div className="settings-card">
                <p className="hint">
                  通用中尚无可用模型。请先在「通用」配置厂商与模型。
                </p>
              </div>
            ) : (
              vendorGroups.map(({ vendor, rows }) => {
                if (rows.length === 0) return null;
                const vendorCur =
                  table.vendorCurrencies[vendor] ??
                  defaultVendorCurrency(vendor);
                const unitShort =
                  vendorCur === "USD" ? "$/1M" : "¥/1M";
                return (
                  <section
                    key={vendor}
                    className="settings-card pricing-vendor"
                  >
                    <div className="settings-card-head pricing-vendor-head">
                      <h2>{vendor}</h2>
                      <label className="pricing-vendor-currency">
                        <span className="pricing-vendor-currency-label">
                          计费货币
                        </span>
                        <select
                          value={vendorCur}
                          onChange={(e) =>
                            setVendorCurrency(
                              vendor,
                              e.target.value === "USD" ? "USD" : "CNY",
                            )
                          }
                        >
                          <option value="CNY">人民币 (CNY)</option>
                          <option value="USD">美元 (USD)</option>
                        </select>
                      </label>
                    </div>
                    <div className="pricing-table-scroll">
                      <table className="pricing-table">
                        <thead>
                          <tr>
                            <th>模型 ID</th>
                            <th>起始</th>
                            <th>结束</th>
                            {(
                              [
                                "Input",
                                "Output",
                                "Cache Read",
                                "Cache Write",
                              ] as const
                            ).map((label) => (
                              <th
                                key={label}
                                title={`${label}（${unitShort} tokens）`}
                              >
                                <span className="pricing-th-main">{label}</span>
                                <span className="pricing-th-unit">
                                  {unitShort}
                                </span>
                              </th>
                            ))}
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody onMouseLeave={() => setHover(null)}>
                          {rows.map((row) => {
                            const r = row.rule;
                            const rates = r.rates;
                            const deepseek = isDeepSeekVendor(vendor);
                            const groupHover =
                              hover?.mode === "model" &&
                              hover.model === r.model;
                            const intervalHover =
                              hover?.mode === "row" && hover.ruleId === r.id;
                            const modelIdHot =
                              !!hover &&
                              hover.model === r.model &&
                              row.rowSpan > 0 &&
                              !groupHover;
                            const activateRow = () =>
                              setHover({
                                mode: "row",
                                model: r.model,
                                ruleId: r.id,
                              });
                            return (
                              <tr
                                key={r.id}
                                className={
                                  "pricing-row" +
                                  (row.isFirstOfModel
                                    ? " is-model-start"
                                    : " is-interval-cont") +
                                  (groupHover ? " is-group-hover" : "") +
                                  (intervalHover ? " is-interval-hover" : "") +
                                  (modelIdHot ? " is-model-id-hot" : "")
                                }
                              >
                                {row.rowSpan > 0 ? (
                                  <td
                                    className="pricing-model-cell"
                                    rowSpan={row.rowSpan}
                                    onMouseEnter={() =>
                                      setHover({
                                        mode: "model",
                                        model: r.model,
                                      })
                                    }
                                  >
                                    <span
                                      className="pricing-model-id"
                                      title={r.model}
                                    >
                                      {r.model}
                                    </span>
                                  </td>
                                ) : null}
                                <td onMouseEnter={activateRow}>
                                  <BoundDateField
                                    kind="from"
                                    value={r.from}
                                    onChange={(from) =>
                                      tryPatchRule(r.id, { from })
                                    }
                                  />
                                </td>
                                <td onMouseEnter={activateRow}>
                                  <BoundDateField
                                    kind="to"
                                    value={r.to}
                                    peerDate={r.from}
                                    onChange={(to) =>
                                      tryPatchRule(r.id, { to })
                                    }
                                  />
                                </td>
                                {(
                                  ["input", "output", "cacheRead"] as const
                                ).map((field) => (
                                  <td key={field} onMouseEnter={activateRow}>
                                    <input
                                      type="number"
                                      className="pricing-rate-input"
                                      min={0}
                                      step="any"
                                      value={rates[field]}
                                      onChange={(e) =>
                                        patchRateField(
                                          r.id,
                                          field,
                                          Number(e.target.value),
                                        )
                                      }
                                    />
                                  </td>
                                ))}
                                <td onMouseEnter={activateRow}>
                                  {deepseek ? (
                                    <span
                                      className="pricing-na"
                                      title="DeepSeek 官方不计 Cache Write"
                                    >
                                      不计入
                                    </span>
                                  ) : (
                                    <input
                                      type="number"
                                      className="pricing-rate-input"
                                      min={0}
                                      step="any"
                                      value={rates.cacheWrite}
                                      onChange={(e) =>
                                        patchRateField(
                                          r.id,
                                          "cacheWrite",
                                          Number(e.target.value),
                                        )
                                      }
                                    />
                                  )}
                                </td>
                                <td
                                  className="pricing-row-actions"
                                  onMouseEnter={activateRow}
                                >
                                  <div className="pricing-row-actions-inner">
                                    <button
                                      type="button"
                                      className="pricing-btn pricing-btn-accent pricing-btn-sm"
                                      title="暂存：上一段结束日+1 起新增不限结束区间"
                                      onClick={() => addNewRange(r)}
                                    >
                                      新区间
                                    </button>
                                    {row.intervalCount > 1 ? (
                                      <button
                                        type="button"
                                        className="pricing-btn pricing-btn-danger pricing-btn-sm"
                                        onClick={() => removeInterval(row)}
                                      >
                                        删除区间
                                      </button>
                                    ) : null}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </section>
                );
              })
            )}
          </>
        )}
      </div>
    );
  },
);
