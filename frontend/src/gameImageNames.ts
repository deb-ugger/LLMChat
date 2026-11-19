import { API_BASE } from "./api";
import { gameSpeakerNames, translateGameDisplayText } from "./gameDisplayText";
import type { UnityEntry } from "./unityOffline";

type Term = { src: string; dst: string; enabled?: boolean };
export type ImageNameMemory = { terms: ReadonlyMap<string, string>; title: string[]; conflicts: string[]; lettering: ReadonlySet<string> };
const compact = (text: string) => text.normalize("NFKC").replace(/\s+/g, "").trim();
const parts = (text: string) => text.normalize("NFKC").replace(/&/g, " & ").trim().split(/\s+/);
const shortName = (text: string) => /^[\p{Script=Katakana}ー・]{2,21}$/u.test(text) || /^[A-Z][A-Z '-]{2,24}$/.test(text);
const validName = (text: string) => text.length <= 32 && /\p{L}/u.test(text) && !/[\r\n\\{}<>]/.test(text);
const letteringWord = /[\p{Script=Katakana}ー]{2,8}\p{Script=Han}{1,5}/gu;

export function collectGameImageNames(entries: UnityEntry[], gamePath: string, target: string, glossary?: string): ImageNameMemory {
  const terms = new Map<string, string>();
  try {
    const configured = JSON.parse(glossary || "[]") as Term[];
    for (const row of configured) if (row.enabled !== false && row.src?.trim() && row.dst?.trim())
      terms.set(row.src.trim(), row.dst.trim());
  } catch { /* A malformed optional glossary cannot supply reliable names. */ }
  const alignTitle = (text: string) => compact(text.normalize("NFKC").replace(/\s*\([^()]+\)\s*$/u, ""));
  const gameTitle = alignTitle(gamePath.split(/[\\/]/).filter(Boolean).at(-1) || "");
  const eligible = entries.filter(entry => !entry.error && entry.translation.trim() &&
    (!entry.translationTarget || entry.translationTarget === target));
  const titleEntries = eligible.filter(entry => entry.source.length <= 160 && alignTitle(entry.source) === gameTitle);
  let title: string[] = [];
  if (titleEntries.length && new Set(titleEntries.map(row => compact(row.translation))).size === 1) {
    const words = parts(titleEntries[0].source);
    const translated = parts(titleEntries[0].translation);
    if (words.length === translated.length) {
      title = words;
      for (const [index, word] of words.entries()) {
        if (validName(word) && validName(translated[index]) && !terms.has(word)) terms.set(word, translated[index]);
      }
    }
  }
  const votes = new Map<string, Set<string>>();
  const vote = (name: string, translated: string) => {
    if (terms.has(name) || !validName(name) || !validName(translated)) return;
    const choices = votes.get(name) || new Set<string>();
    choices.add(translated);
    votes.set(name, choices);
  };
  for (const entry of eligible) {
    const name = entry.source.trim(), translated = entry.translation.trim();
    if (entry.rpgTextKind === "character" || shortName(name)) vote(name, translated);
  }
  const direct = new Set(votes.keys());
  for (const entry of eligible) {
    const originals = gameSpeakerNames(entry.source), translations = gameSpeakerNames(entry.translation);
    if (originals.length !== translations.length) continue;
    for (const [index, name] of originals.entries()) if (!direct.has(name)) vote(name, translations[index]);
  }
  const conflicts: string[] = [];
  for (const [source, values] of votes) {
    if (values.size === 1) terms.set(source, values.values().next().value!);
    else if (gameTitle.includes(compact(source))) conflicts.push(source);
  }
  const lettering = new Set(entries.flatMap(entry => entry.source.match(letteringWord) || []));
  return { terms, title, conflicts, lettering };
}

export async function readRpgGameImageNames(gamePath: string, target: string, glossary: string, signal: AbortSignal) {
  const response = await fetch(`${API_BASE}/api/game-text/load`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gamePath }), signal,
  });
  if (!response.ok) throw new Error("无法读取工程现有译名");
  const project = await response.json();
  return collectGameImageNames(Array.isArray(project?.entries) ? project.entries : [], gamePath, target, glossary);
}

export function gameImageNameHint(memory?: ImageNameMemory, logo = false) {
  if (!memory) return "";
  const names = [...memory.terms.keys()].filter(shortName);
  const words = [...new Set(logo ? [...memory.title, ...names] : [...memory.title.filter(shortName), ...names])].slice(0, 32);
  return words.length ? "\n工程已有原文拼写供核对（只抄图里确实存在的名称）：" + words.join("、") : "";
}

function editDistance(a: string, b: string) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let x = 1; x <= a.length; x++) {
    const next = [x];
    for (let y = 1; y <= b.length; y++) next[y] = Math.min(row[y] + 1, next[y - 1] + 1, row[y - 1] + Number(a[x - 1] !== b[y - 1]));
    row = next;
  }
  return row[b.length];
}

export function gameLetteringCandidate(text: string, memory?: ImageNameMemory) {
  const word = text.normalize("NFKC").replace(/[♡♥❤。！!]+$/u, "").trim();
  const parts = /^([\p{Script=Katakana}ー]{2,8})(\p{Script=Han}{1,5})$/u.exec(word);
  if (!parts || !memory?.lettering.size || memory.lettering.has(word)) return;
  const [ , reading, suffix] = parts;
  let candidate: string | undefined;
  for (const entry of memory.lettering) {
    if (entry.length !== word.length || !entry.endsWith(suffix)) continue;
    if (editDistance(reading, entry.slice(0,-suffix.length)) !== 1) continue;
    if (candidate) return;
    candidate = entry;
  }
  if (candidate) return { word, candidate };
}

const kanaRows = [
  ["アイウエオ","a i u e o"], ["カキクケコ","ka ki ku ke ko"], ["サシスセソ","sa shi su se so"],
  ["タチツテト","ta chi tsu te to"], ["ナニヌネノ","na ni nu ne no"], ["ハヒフヘホ","ha hi fu he ho"],
  ["マミムメモ","ma mi mu me mo"], ["ヤユヨ","ya yu yo"], ["ラリルレロ","ra ri ru re ro"],
  ["ワヲン","wa o n"], ["ガギグゲゴ","ga gi gu ge go"], ["ザジズゼゾ","za ji zu ze zo"],
  ["ダヂヅデド","da ji zu de do"], ["バビブベボ","ba bi bu be bo"], ["パピプペポ","pa pi pu pe po"],
];
const kanaSounds = new Map(kanaRows.flatMap(([kana,sounds]) => [...kana].map((char,i) => [char,sounds.split(" ")[i]])));
const foreignKana = new Map([["ジェ","je"],["シェ","she"],["チェ","che"],["ティ","ti"],["ディ","di"],
  ["ファ","fa"],["フィ","fi"],["フェ","fe"],["フォ","fo"],["クォ","kwo"],["ウィ","wi"],["ウェ","we"],["ウォ","wo"]]);
const soundKey = (roman: string) => roman.toLowerCase().replace(/[^a-z]/g, "")
  .replace(/g(?=[ei])/g,"j").replace(/r/g,"l").replace(/(.)\1+/g,"$1").replace(/([lmnpkst])u$/,"$1");

function katakanaSound(text: string) {
  let result = "";
  for (let index=0; index<text.length; index++) {
    const char=text[index], next=text[index+1];
    const pair=foreignKana.get(text.slice(index,index+2));
    if (pair) { result+=pair; index++; continue; }
    if (char === "ー" || char === "・" || char === "ッ") continue;
    const sound=kanaSounds.get(char);
    if (!sound) return "";
    if (next && /[ャュョ]/.test(next) && sound.endsWith("i")) {
      const prefix=sound.slice(0,-1);
      result+=prefix+(/^(?:sh|ch|j)$/.test(prefix)?"":"y")+"auo"["ャュョ".indexOf(next)];
      index++;
    } else result+=sound;
  }
  return soundKey(result);
}

export function gameImageHeadingName(text: string, names?: ImageNameMemory) {
  const heading=/^([A-Z][A-Z '-]*?)\s+OF\s+([A-Z][A-Z'-]{3,})$/.exec(text.trim());
  if (!heading || !names?.title.length) return;
  const direct=names.terms.get(heading[2]);
  if (direct) return { label: heading[1], name: direct };
  const key=soundKey(heading[2]);
  if (key.length<5) return;
  const candidates=names.title.flatMap(source => {
    const spelling=katakanaSound(source), name=names.terms.get(source);
    return name && spelling.length>=5 ? [{ name, score: editDistance(key,spelling) }] : [];
  }).sort((a,b)=>a.score-b.score);
  if (candidates.length && candidates[0].score<=1 && candidates[1]?.score!==candidates[0].score)
    return { label: heading[1], name: candidates[0].name };
}

export async function translateNamedImageText(text: string, translate: (input: string) => Promise<string>,
  target: string, names?: ImageNameMemory) {
  const heading=target.startsWith("zh") ? gameImageHeadingName(text,names) : undefined;
  if (heading) return heading.name+"的"+(await translate(heading.label)).trim();
  return names?.terms.size ? translateGameDisplayText(text,translate,target,"auto",names.terms,false) : translate(text);
}

export function correctGameLogoText(text: string, memory?: ImageNameMemory) {
  if (!memory?.title.length) return text;
  return text.replace(/[\p{Script=Katakana}ー]{3,}|\p{Script=Han}{3,}/gu, word => {
    const script = /\p{Script=Katakana}/u.test(word) ? /\p{Script=Katakana}/u : /\p{Script=Han}/u;
    const matches = memory.title.filter(name => name.length >= 3 && script.test(name)).map(name => ({
      name, distance: editDistance(word, name),
    })).sort((a, b) => a.distance - b.distance);
    const best = matches[0];
    if (!best || best.distance > (best.name.length >= 5 ? 2 : 1) || matches[1]?.distance === best.distance) return word;
    return best.name;
  });
}
