import type { UnityEntry } from "./unityOffline";
import { gameBracketIssue } from "./gameTextStructure";
import { gameFormatTokens, gameJapaneseTextIssue } from "./gameDisplayText";

export type GameProjectTerm = { src: string; dst: string; target: string };
type Term = { src: string; dst: string; enabled?: boolean; info?: string };

export function gameProjectTermProblem(term: GameProjectTerm) {
  if (!term.src.trim() || !term.dst.trim()) return "请填写原词和译名";
  if (/[\r\n]/.test(term.src + term.dst)) return "词表用于名称或短语，请保持单行";
  if (term.src.match(gameFormatTokens())?.length || term.dst.match(gameFormatTokens())?.length) return "词条不要包含控制指令或动态参数";
  if (gameBracketIssue(term.src) || gameBracketIssue(term.dst)) return "词条的括号或引号需要配对";
  return "";
}

export function mergeGameGlossary(global: string | Term[] | undefined, project: readonly GameProjectTerm[], target: string) {
  const values: Term[] = typeof global === "string" ? JSON.parse(global || "[]") : global || [];
  const merged = new Map(values.filter(term => term.enabled !== false && term.src?.trim() && term.dst?.trim()).map(term => [term.src.trim(), { ...term, src: term.src.trim(), dst: term.dst.trim() }]));
  for (const term of project) if (term.target === target && !gameProjectTermProblem(term)) merged.set(term.src.trim(), { src: term.src.trim(), dst: term.dst.trim() });
  return [...merged.values()];
}

export function gameGlossaryCandidates(entries: readonly (UnityEntry & { rpgTerm?: boolean })[], target: string) {
  const values = new Map<string, GameProjectTerm>();
  for (const entry of entries) {
    if ((!entry.rpgTextKind || entry.rpgTextKind === "interface" && !entry.rpgTerm) || entry.error || !entry.translation.trim() || entry.source.length > 64) continue;
    const term = { src: entry.source.trim(), dst: entry.translation.trim(), target };
    if (!gameProjectTermProblem(term) && !gameJapaneseTextIssue(term.src, term.dst, target)) values.set(term.src, term);
  }
  return [...values.values()];
}
