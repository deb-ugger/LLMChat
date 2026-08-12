/** Built-in default rates per 1M tokens. Currency is per vendor (see vendorCurrencies). */

export type PricingCurrency = "CNY" | "USD";

export type TokenRates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type PricingRule = {
  id: string;
  vendor: string;
  model: string;
  /** Inclusive start YYYY-MM-DD */
  from: string;
  /** Inclusive end YYYY-MM-DD; empty = open */
  to: string;
  /** Rates in the vendor's billing currency */
  rates: TokenRates;
};

export type PricingTable = {
  displayCurrency: PricingCurrency;
  /** Billing currency for each vendor */
  vendorCurrencies: Record<string, PricingCurrency>;
  /** Model IDs whose rates/dates are locked against accidental edits */
  lockedModels: string[];
  rules: PricingRule[];
};

function rates(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): TokenRates {
  return { input, output, cacheRead, cacheWrite };
}

function rule(
  vendor: string,
  model: string,
  from: string,
  r: TokenRates,
  to = "",
): PricingRule {
  return {
    id: `builtin-${vendor}-${model}-${from}`,
    vendor,
    model,
    from,
    to,
    rates: r,
  };
}

const FROM = ""; // empty = open start (不限起始)

/** Default billing currency by vendor. */
export const DEFAULT_VENDOR_CURRENCIES: Record<string, PricingCurrency> = {
  DeepSeek: "CNY",
  OpenAI: "USD",
  Google: "USD",
  通义千问: "CNY",
};

export function defaultVendorCurrency(vendor: string): PricingCurrency {
  const v = vendor.trim();
  if (v in DEFAULT_VENDOR_CURRENCIES) return DEFAULT_VENDOR_CURRENCIES[v]!;
  return "USD";
}

/** Default price table used for reset / display when API empty. */
const DEFAULT_RULES: PricingRule[] = [
    // DeepSeek — CNY — https://api-docs.deepseek.com/zh-cn/quick_start/pricing
    // input=缓存未命中, cacheRead=缓存命中, output=输出, cacheWrite 官方无此项→0
    rule("DeepSeek", "deepseek-v4-flash", FROM, rates(1.0, 2.0, 0.02, 0)),
    rule("DeepSeek", "deepseek-v4-pro", FROM, rates(3.0, 6.0, 0.025, 0)),
    rule("DeepSeek", "deepseek-chat", FROM, rates(1.0, 2.0, 0.02, 0)),
    rule("DeepSeek", "deepseek-reasoner", FROM, rates(1.0, 2.0, 0.02, 0)),
    // OpenAI — USD
    rule("OpenAI", "gpt-4o", FROM, rates(2.5, 10.0, 1.25, 2.5)),
    rule("OpenAI", "gpt-4o-mini", FROM, rates(0.15, 0.6, 0.075, 0.15)),
    rule("OpenAI", "gpt-4-turbo", FROM, rates(10.0, 30.0, 5.0, 10.0)),
    rule("OpenAI", "gpt-3.5-turbo", FROM, rates(0.5, 1.5, 0.25, 0.5)),
    // Google — USD
    rule("Google", "gemini-2.0-flash", FROM, rates(0.1, 0.4, 0.025, 0.1)),
    // 通义千问 — CNY
    rule("通义千问", "qwen-plus", FROM, rates(0.8, 2.0, 0.16, 0.8)),
    rule("通义千问", "qwen-turbo", FROM, rates(0.3, 0.6, 0.06, 0.3)),
];

export const DEFAULT_PRICING_TABLE: PricingTable = {
  displayCurrency: "CNY",
  vendorCurrencies: { ...DEFAULT_VENDOR_CURRENCIES },
  lockedModels: [...new Set(DEFAULT_RULES.map((r) => r.model))],
  rules: DEFAULT_RULES,
};

export function emptyRates(): TokenRates {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function newRuleId(): string {
  return `p${Date.now()}-${Math.floor(Math.random() * 0xffff)}`;
}

export function cloneDefaultPricingTable(): PricingTable {
  const rules = DEFAULT_PRICING_TABLE.rules.map((r) => ({
    ...r,
    id: newRuleId(),
    rates: { ...r.rates },
  }));
  return {
    displayCurrency: DEFAULT_PRICING_TABLE.displayCurrency,
    vendorCurrencies: { ...DEFAULT_PRICING_TABLE.vendorCurrencies },
    // New/default tables start locked for all models
    lockedModels: [...new Set(rules.map((r) => r.model))],
    rules,
  };
}

export function formatMoney(n: number, currency: PricingCurrency): string {
  const sym = currency === "USD" ? "$" : "¥";
  if (!Number.isFinite(n) || n === 0) return `${sym}0.00`;
  const abs = Math.abs(n);
  if (abs < 0.0001) return `<${sym}0.0001`;
  if (abs < 0.01) return `${sym}${n.toFixed(4)}`;
  if (abs < 1) return `${sym}${n.toFixed(4)}`;
  return `${sym}${n.toFixed(2)}`;
}
