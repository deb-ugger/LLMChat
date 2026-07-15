export type LangOption = {
  code: string;
  label: string;
  aliases: string[];
};

/** Common languages for literature translation combobox */
export const LANG_OPTIONS: LangOption[] = [
  { code: "auto", label: "自动检测", aliases: ["auto", "detect"] },
  { code: "en", label: "英语 English", aliases: ["en", "eng", "english"] },
  {
    code: "zh-CN",
    label: "中文（简体）",
    aliases: ["zh", "zh-cn", "cn", "chinese", "chs"],
  },
  {
    code: "zh-TW",
    label: "中文（繁体）",
    aliases: ["zh-tw", "tw", "cht", "traditional"],
  },
  { code: "ja", label: "日语 Japanese", aliases: ["ja", "jp", "japanese"] },
  { code: "ko", label: "韩语 Korean", aliases: ["ko", "kr", "korean"] },
  { code: "fr", label: "法语 French", aliases: ["fr", "french"] },
  { code: "de", label: "德语 German", aliases: ["de", "german"] },
  { code: "es", label: "西班牙语 Spanish", aliases: ["es", "spanish"] },
  { code: "pt", label: "葡萄牙语 Portuguese", aliases: ["pt", "portuguese"] },
  { code: "ru", label: "俄语 Russian", aliases: ["ru", "russian"] },
  { code: "it", label: "意大利语 Italian", aliases: ["it", "italian"] },
  { code: "ar", label: "阿拉伯语 Arabic", aliases: ["ar", "arabic"] },
  { code: "th", label: "泰语 Thai", aliases: ["th", "thai"] },
  { code: "vi", label: "越南语 Vietnamese", aliases: ["vi", "vietnamese"] },
];

export function filterLangOptions(query: string): LangOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return LANG_OPTIONS;
  return LANG_OPTIONS.filter((opt) => {
    if (opt.code.toLowerCase().startsWith(q)) return true;
    if (opt.label.toLowerCase().includes(q)) return true;
    return opt.aliases.some(
      (a) => a.startsWith(q) || a.includes(q) || q.startsWith(a),
    );
  });
}
