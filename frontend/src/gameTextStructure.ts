export const gameBracketPairs = new Map(["()", "[]", "{}", "（）", "［］", "｛｝", "【】", "〔〕", "〈〉", "《》", "「」", "『』", "〖〗", "〘〙", "〚〛", "“”", "‘’"].map(pair => [pair[0], pair[1]]));
export const gameBracketEnds = new Set(gameBracketPairs.values());

type BracketMark = { symbol: string; index: number; opening: boolean };
const quoteSymbols = new Set(['"', "'", "“", "”", "‘", "’", "「", "」", "『", "』"]);
const bracketWidth = new Map([["（", "("], ["）", ")"], ["［", "["], ["］", "]"], ["｛", "{"], ["｝", "}"]]);
const structureOf = (marks: BracketMark[]) => marks.map(mark => quoteSymbols.has(mark.symbol)
  ? mark.opening ? "“" : "”" : bracketWidth.get(mark.symbol) || mark.symbol).join("");

function readBrackets(text: string, compatibleStyles = false) {
  const stack: { close: string; open: string; position: number }[] = [];
  const marks: BracketMark[] = [];
  let position = 0, index = 0;
  for (const char of text) {
    position++;
    const at = index; index += char.length;
    if (char === '"' || char === "'" || char === "’") {
      let slashes = 0;
      for (let before = at - 1; before >= 0 && text[before] === "\\"; before--) slashes++;
      if (slashes % 2) continue;
      const previous = text[at - 1] || "", next = text[index] || "";
      const closesQuote = stack.at(-1)?.close === char;
      // Apostrophes in words/possessives and inch/foot units are not quote pairs.
      if ((char === "'" || char === "’") && /[A-Za-z0-9]/.test(previous) &&
          (/[A-Za-z0-9]/.test(next) || !closesQuote && (!next || /[\s.,;:!?]/.test(next)))) continue;
      if (char === '"' && !closesQuote && /[0-9]/.test(previous) && (!next || /[\s.,;:!?]/.test(next))) continue;
      if (char === '"' || char === "'") {
        marks.push({ symbol: char, index: at, opening: !closesQuote });
        if (closesQuote) stack.pop(); else stack.push({ close: char, open: char, position });
        continue;
      }
    }
    const close = gameBracketPairs.get(char);
    if (close) {
      marks.push({ symbol: char, index: at, opening: true });
      stack.push({ close, open: char, position });
    }
    else if (gameBracketEnds.has(char)) {
      const expected = stack.pop();
      if (!expected) return { marks, issue: `第 ${position} 字多出右括号「${char}」` };
      const sameStyleFamily = quoteSymbols.has(expected.close) && quoteSymbols.has(char) ||
        (bracketWidth.get(expected.close) || expected.close) === (bracketWidth.get(char) || char);
      if (expected.close !== char && !(compatibleStyles && sameStyleFamily))
        return { marks, issue: `第 ${position} 字括号错配，应为「${expected.close}」，实际为「${char}」` };
      marks.push({ symbol: char, index: at, opening: false });
    }
  }
  const unclosed = stack.at(-1);
  return { marks, issue: unclosed ? `第 ${unclosed.position} 字「${unclosed.open}」缺少配对的「${unclosed.close}」` : "" };
}

export function gameBracketIssue(text: string) {
  return readBrackets(text).issue;
}

export function gameBracketProblem(source: string, translation: string) {
  const original = readBrackets(source), translated = readBrackets(translation, true);
  if (original.issue) return "";
  if (translated.issue) return "译文括号或引用未成对：" + translated.issue;
  if (structureOf(original.marks) === structureOf(translated.marks)) return "";
  const expected = original.marks.map(mark => mark.symbol).join(""), actual = translated.marks.map(mark => mark.symbol).join("");
  return `译文括号或引用类型、数量或嵌套与原文不一致：应为「${expected || "无"}」，当前为「${actual || "无"}」`;
}

/** Restore source glyphs only when pairing, nesting and bracket families agree. */
export function restoreGameBracketStyle(source: string, translation: string) {
  const original = readBrackets(source), translated = readBrackets(translation, true);
  if (original.issue || translated.issue || structureOf(original.marks) !== structureOf(translated.marks)) return translation;
  let result = "", offset = 0;
  translated.marks.forEach((mark, index) => {
    result += translation.slice(offset, mark.index) + original.marks[index].symbol;
    offset = mark.index + mark.symbol.length;
  });
  return result + translation.slice(offset);
}

/** A quoted group containing format markers must stay in one translation request. */
export function splitGameTranslationSpans(text: string) {
  const brackets = readBrackets(text);
  if (brackets.issue) return [text];
  const spans: string[] = [];
  let current = "", position = 0, markIndex = 0, depth = 0;
  for (const match of text.matchAll(/\{LLMCHAT_FORMAT_\d+\}/g)) {
    current += text.slice(position, match.index);
    while (markIndex < brackets.marks.length && brackets.marks[markIndex].index < match.index!) {
      depth += brackets.marks[markIndex++].opening ? 1 : -1;
    }
    if (!depth) {
      if (current) spans.push(current);
      current = ""; spans.push(match[0]);
    } else current += match[0];
    position = match.index! + match[0].length;
  }
  current += text.slice(position);
  if (current) spans.push(current);
  return spans;
}
