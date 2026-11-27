export const gameBracketPairs = new Map(["()", "[]", "{}", "（）", "［］", "｛｝", "【】", "〔〕", "〈〉", "《》", "「」", "『』", "〖〗", "〘〙", "〚〛", "“”", "‘’"].map(pair => [pair[0], pair[1]]));
export const gameBracketEnds = new Set(gameBracketPairs.values());

export function gameBracketIssue(text: string) {
  const stack: { close: string; open: string; position: number }[] = [];
  let position = 0;
  for (const char of text) {
    position++;
    const close = gameBracketPairs.get(char);
    if (close) stack.push({ close, open: char, position });
    else if (gameBracketEnds.has(char)) {
      const expected = stack.pop();
      if (!expected) return `第 ${position} 字多出右括号「${char}」`;
      if (expected.close !== char) return `第 ${position} 字括号错配，应为「${expected.close}」，实际为「${char}」`;
    }
  }
  const unclosed = stack.at(-1);
  return unclosed ? `第 ${unclosed.position} 字「${unclosed.open}」缺少配对的「${unclosed.close}」` : "";
}

export function gameBracketProblem(source: string, translation: string) {
  if (gameBracketIssue(source)) return "";
  const issue = gameBracketIssue(translation);
  if (issue) return "译文括号或引用未成对：" + issue;
  const structure = (text: string) => [...text].filter(char => gameBracketPairs.has(char) || gameBracketEnds.has(char)).join("");
  const expected = structure(source), actual = structure(translation);
  return expected === actual ? "" : `译文括号或引用类型、数量或嵌套与原文不一致：应为「${expected || "无"}」，当前为「${actual || "无"}」`;
}

/** A quoted group containing format markers must stay in one translation request. */
export function splitGameTranslationSpans(text: string) {
  const spans: string[] = [], stack: string[] = [];
  let current = "", position = 0;
  const append = (part: string) => {
    for (const char of part) {
      const close = gameBracketPairs.get(char);
      if (close) stack.push(close);
      else if (gameBracketEnds.has(char) && stack.at(-1) === char) stack.pop();
      current += char;
    }
  };
  for (const match of text.matchAll(/\{LLMCHAT_FORMAT_\d+\}/g)) {
    append(text.slice(position, match.index));
    if (!stack.length) {
      if (current) spans.push(current);
      current = ""; spans.push(match[0]);
    } else current += match[0];
    position = match.index! + match[0].length;
  }
  append(text.slice(position));
  if (current) spans.push(current);
  return stack.length ? [text] : spans;
}
