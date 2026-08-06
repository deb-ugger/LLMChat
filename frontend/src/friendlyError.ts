/**
 * Keep the original (usually English) error, then append a short Chinese hint.
 * Format: `Original English error（中文说明）`
 * Upstream dumps (HTML/JSON) are kept in full — never truncated.
 */
export function toFriendlyError(
  raw: unknown,
  fallback = "Operation failed（操作失败，请稍后重试）",
): string {
  let original = (raw instanceof Error ? raw.message : String(raw ?? "")).trim();
  if (!original) return fallback;

  const isHtml =
    /<!doctype\s*html/i.test(original) ||
    /<\s*html[\s>]/i.test(original) ||
    (/<\s*head[\s>]/i.test(original) && /<\s*body[\s>]/i.test(original));

  // Keep HTML / multi-line dumps intact for diagnosis; only collapse plain one-liners
  if (!isHtml) {
    original = original.replace(/\s+/g, " ");
  }

  // Already bilingual (contains Chinese paren hint) — don't double-wrap
  if (/（[^）]{2,}）/.test(original) && /[\u4e00-\u9fff]/.test(original)) {
    return original;
  }

  const zh = classifyChineseHint(original);
  if (!zh) return original;
  // If message is already pure Chinese matching our hint, keep as-is
  if (!/[A-Za-z]{3,}/.test(original) && original.includes(zh.slice(0, 6))) {
    return original;
  }
  return `${original}（${zh}）`;
}

function classifyChineseHint(s: string): string | null {
  const low = s.toLowerCase();

  if (
    low.includes("used all available free translations") ||
    low.includes("mymemory warning") ||
    low.includes("next available in") ||
    (low.includes("mymemory") && (low.includes("429") || low.includes("quota")))
  ) {
    return "今日免费翻译额度已用尽，请换用谷歌/Bing/大模型";
  }
  if (
    low.includes("429") ||
    low.includes("rate limit") ||
    low.includes("too many requests") ||
    (low.includes("quota") && !low.includes("mymemory"))
  ) {
    return "请求过于频繁或额度不足，请稍后再试或更换引擎";
  }
  if (
    low.includes("query length limit") ||
    low.includes("max allowed query") ||
    low.includes("length_limit") ||
    low.includes("too long")
  ) {
    return "文本过长，请增大最大长度或开启自动分段";
  }
  if (low.includes("aborted") || low.includes("abort")) {
    return "连接超时；谷歌翻译在国内常需系统代理，可改用 Bing/有道";
  }
  if (
    low.includes("google_captcha") ||
    low.includes("recaptcha") ||
    low.includes("unusual traffic") ||
    low.includes("captcha-form") ||
    /<!doctype\s*html/i.test(s) ||
    /<\s*html[\s>]/i.test(s) ||
    (low.includes("google") &&
      (low.includes("html") || low.includes("blocked") || low.includes("captcha")))
  ) {
    return "谷歌翻译触发人机验证（请求过频或 IP 被风控），已尝试/请改用 Bing；或稍后再试";
  }
  if (
    low.includes("timeout") ||
    low.includes("timed out") ||
    low.includes("failed to fetch") ||
    low.includes("winhttp") ||
    low.includes("cannot connect") ||
    low.includes("connection") ||
    low.includes("network") ||
    low.includes("econnrefused") ||
    low.includes("err_connection_refused")
  ) {
    if (low.includes("google") || low.includes("googleapis")) {
      return "谷歌翻译连接失败，国内常需系统代理，可改用 Bing/有道";
    }
    // Local backend (127.0.0.1) down looks like "Failed to fetch" — not a real WAN outage.
    if (
      low.includes("failed to fetch") ||
      low.includes("econnrefused") ||
      low.includes("err_connection_refused") ||
      low.includes("networkerror")
    ) {
      return "本地后端未连接：请完全退出并重新打开 LLMChat";
    }
    return "网络异常或连接超时，请检查网络或代理";
  }
  if (
    low.includes("401") ||
    low.includes("unauthorized") ||
    low.includes("invalid api key") ||
    low.includes("incorrect api key") ||
    low.includes("authentication")
  ) {
    return "API Key 无效或未授权，请检查设置";
  }
  if (low.includes("403") || low.includes("forbidden")) {
    return "没有访问权限，请检查 API 配置";
  }
  if (
    low.includes("404") ||
    low.includes("not found") ||
    low.includes("invalid url")
  ) {
    return "接口地址不正确或不存在";
  }
  if (low.includes("empty translation")) {
    return "翻译结果为空，请换引擎或稍后重试";
  }
  if (low.includes("parse") && low.includes("failed")) {
    return "返回内容无法解析，请换引擎或稍后重试";
  }
  if (low.includes("google") && (low.includes("fail") || low.includes("blocked") || low.includes("html"))) {
    return "谷歌翻译不可用，国内常需系统代理，可改用 Bing/有道";
  }
  if (low.includes("bing") && (low.includes("fail") || low.includes("auth"))) {
    return "Bing 翻译暂时不可用，请稍后重试或更换引擎";
  }
  if (low.includes("youdao") && low.includes("fail")) {
    return "有道翻译暂时不可用，请稍后重试或更换引擎";
  }
  if (low.includes("baidu") && low.includes("fail")) {
    return "百度翻译暂时不可用，请稍后重试或更换引擎";
  }
  if (low.includes("sogou") && low.includes("fail")) {
    return "搜狗翻译暂时不可用，请稍后重试或更换引擎";
  }
  if (low.includes("niutrans") && low.includes("fail")) {
    return "小牛翻译暂时不可用，请稍后重试或更换引擎";
  }
  if (low.includes("mymemory") && low.includes("fail")) {
    return "MyMemory 暂时不可用，请换引擎或稍后重试";
  }
  if (low.includes("unknown translate provider")) {
    return "未知的翻译引擎，请重新选择";
  }
  if (low.includes("text required")) {
    return "请输入要翻译的文本";
  }
  if (low.includes("llm") && (low.includes("http") || low.includes("fail"))) {
    if (low.includes("401") || low.includes("403")) return "大模型认证失败，请检查 API Key";
    if (low.includes("429")) return "大模型额度不足或请求过频";
    return "大模型接口调用失败，请检查 API URL、密钥与模型";
  }
  if (/^HTTP\s*\d{3}/i.test(s) || low.includes('"responsedata"')) {
    const code = s.match(/HTTP\s*(\d{3})/i)?.[1];
    if (code === "429") return "请求过于频繁或额度不足";
    if (code === "502" || code === "503" || code === "504") {
      return "翻译服务暂时不可用";
    }
    return "翻译请求失败，请稍后重试或更换引擎";
  }
  return null;
}
