import type { UnityEntry } from "./unityOffline";
import { gameTextNeedsNoTranslation, gameSpeakerNames, gameControlSignature, withoutGameSpeakerNames } from "./gameDisplayText";
import { unityTranslationProblem } from "./unityTokens";

type Term = { src: string; dst: string; enabled?: boolean };
const literal = (name: string) => /\p{L}/u.test(name) && !/[\\{}<>]/.test(name);
const matchesTarget = (name: string, target: string) => target.startsWith("zh") ? /\p{Script=Han}/u.test(name) && !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(name)
  : target === "en" ? /\p{Script=Latin}/u.test(name) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(name)
  : target === "ja" ? /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(name) : target === "ko" && /\p{Script=Hangul}/u.test(name);

/** Prepare a game-local, target-specific dictionary before concurrent dialogue requests. */
export async function prepareGameTerms(selected: UnityEntry[], references: UnityEntry[], target: string, glossary: string | Term[] | undefined,
  translate: (name: string, context: string) => Promise<string>, signal: AbortSignal, progress?: (detail: string, completed: number, total: number) => void) {
  signal.throwIfAborted();
  progress?.("正在解析插件姓名框，收集并合并重复说话人", 0, selected.length);
  const terms = new Map<string, string>();
  const configured: Term[] = typeof glossary === "string" ? JSON.parse(glossary || "[]") : glossary || [];
  for (const term of configured) if (term.enabled !== false && term.src?.trim() && term.dst?.trim()) terms.set(term.src.trim(), term.dst.trim());
  const requested = new Map<string, string>();
  for (const entry of selected) for (const name of gameSpeakerNames(entry.source)) if (literal(name) && !gameTextNeedsNoTranslation(`\\nc<${name}>`, target) && !terms.has(name)) requested.set(name, requested.get(name) || entry.source);
  if (!requested.size) {
    progress?.("说话人译名已就绪，复用术语表或原样保留的姓名", 0, 0);
    return terms;
  }
  progress?.(`已合并 ${requested.size} 个不同说话人，正在匹配工程已有译名`, 0, requested.size);
  const votes = new Map<string, Map<string, number>>();
  for (const entry of references) {
    if (entry.error || !entry.translation) continue;
    const original = gameSpeakerNames(entry.source);
    if (!original.some(name => requested.has(name))) continue;
    if (gameControlSignature(entry.source) !== gameControlSignature(entry.translation) || unityTranslationProblem(withoutGameSpeakerNames(entry.source), withoutGameSpeakerNames(entry.translation))) continue;
    const translated = gameSpeakerNames(entry.translation);
    if (original.length !== translated.length) continue;
    original.forEach((name, index) => {
      const value = translated[index];
      if (!requested.has(name) || !literal(value) || !matchesTarget(value, target)) return;
      const choices = votes.get(name) || new Map<string, number>(); choices.set(value, (choices.get(value) || 0) + 1); votes.set(name, choices);
    });
  }
  for (const [name, choices] of votes) terms.set(name, [...choices].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]);
  const pending = [...requested].filter(([name]) => !terms.has(name));
  const reusedNames = requested.size - pending.length;
  progress?.(`姓名去重完成：复用 ${reusedNames} 个已有译名，待确定 ${pending.length} 个新译名`, 0, pending.length);
  let completedNames = 0;
  for (let offset = 0; offset < pending.length; offset += 4) {
    const results = await Promise.allSettled(pending.slice(offset, offset + 4).map(async ([name, context], localIndex) => {
    const index = offset + localIndex;
    signal.throwIfAborted();
    progress?.(`正在确定姓名译名 ${index + 1}/${pending.length}：${name}，重复出现将共用本次结果`, completedNames, pending.length);
    let value: string;
    try { value = (await translate(name, context)).trim(); }
    catch (error) {
      signal.throwIfAborted();
      throw new Error(`确定译名「${name}」失败：${error instanceof Error ? error.message : String(error)}`);
    }
    signal.throwIfAborted();
    if (!literal(value) || /[\r\n]/.test(value)) throw new Error(`说话人「${name}」的译名无效，请在术语表指定译名后重试`);
    terms.set(name, value); progress?.(`说话人译名已确定：${name} → ${value}`, ++completedNames, pending.length);
    }));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  return terms;
}
