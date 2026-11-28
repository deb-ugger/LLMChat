import type { UnityEntry } from "./unityOffline";

const systemArguments: Record<string, string[]> = {
  partyName: ["领队姓名"], emerge: ["敌人名称"], preemptive: ["队伍名称"], surprise: ["队伍名称"],
  victory: ["队伍名称"], defeat: ["队伍名称"], obtainExp: ["获得的经验数量，不是人物", "经验名称或单位"],
  obtainGold: ["获得的金钱数量"], obtainItem: ["获得的物品名称"], obtainSkill: ["学会的技能名称"],
  levelUp: ["角色姓名", "等级的名称", "提升后的等级数值"], useItem: ["使用者姓名", "物品或技能名称"],
  actorDamage: ["受伤角色姓名", "伤害数值"], enemyDamage: ["受伤敌人名称", "伤害数值"],
  actorRecovery: ["恢复资源的角色姓名", "资源名称，例如 HP、MP、TP", "恢复数量，不是施事者"],
  enemyRecovery: ["恢复资源的敌人名称", "资源名称，例如 HP、MP、TP", "恢复数量，不是施事者"],
  actorGain: ["角色姓名", "资源名称", "增加的数量"], enemyGain: ["敌人名称", "资源名称", "增加的数量"],
  actorLoss: ["角色姓名", "资源名称", "减少的数量"], enemyLoss: ["敌人名称", "资源名称", "减少的数量"],
  actorDrain: ["被吸取资源的角色姓名", "被吸取的资源名称", "被吸取的数量，不是吸取者"],
  enemyDrain: ["被吸取资源的敌人名称", "被吸取的资源名称", "被吸取的数量，不是吸取者"],
  actorNoDamage: ["角色姓名"], enemyNoDamage: ["敌人名称"], actorNoHit: ["角色姓名"], enemyNoHit: ["敌人名称"],
  evasion: ["躲避者姓名"], magicEvasion: ["躲避者姓名"], magicReflection: ["反射魔法者姓名"], counterAttack: ["反击者姓名"],
  substitute: ["代为承受攻击者的姓名", "原攻击目标的姓名"],
  buffAdd: ["角色姓名", "能力名称"], debuffAdd: ["角色姓名", "能力名称"], buffRemove: ["角色姓名", "能力名称"],
};

export function gameSystemMessageContext(message?: string) {
  if (!message) return "";
  const roles = systemArguments[message];
  return `RPG 系统消息：${message}。${roles ? roles.map((role, index) => `%${index + 1} 表示${role}`).join("；") : "位置参数的身份未明确时，不猜测人物或数值的角色"}。参数编号原样保留，可以按中文语法调整位置。游戏可能使用自定义文案，实际动作方向以本条原文为准。`;
}

export function semanticGameParameter(token: string) {
  if (/^\\P\[\d+\]$/i.test(token)) return "队伍成员姓名；作为主语时姓名已经完整，不另补他、她、它或我";
  if (/^\\N\[\d+\]$/i.test(token)) return "角色姓名；不要自行猜测性别或另加代词";
  if (/^\\V\[\d+\]$/i.test(token)) return "运行时变量的显示内容；没有具体定义时不猜测其身份";
  if (/^\\G$/i.test(token)) return "货币单位";
  if (/^%[1-9]\d*(?!\$)$/.test(token)) return "位置参数；含义以系统消息参数说明为准，不能默认当作人物";
  if (/^\{[^{}\r\n]+\}$/.test(token)) return "动态显示参数，原样保留";
  return "";
}

export function gameParameterContext(source: string, tokens: readonly string[], semantic: ReadonlySet<number>) {
  const descriptions = [...semantic].map(index => {
    const token = tokens[index];
    return `{LLMCHAT_FORMAT_${index}} 对应 ${token}：${semanticGameParameter(token) || "已有的可见文字或确认译名，不重复翻译或抄写其内容"}`;
  });
  return descriptions.length ? `当前完整原文：${source}\n保护标记的语义（仅供理解，输出仍复制标记本身）：\n${descriptions.join("\n")}` : source;
}

/** Only source templates verified against the engine arguments are handled here. */
export function knownGameSystemTranslation(entry: Pick<UnityEntry, "source" | "rpgSystemMessage"> | undefined, target: string) {
  if (!entry?.rpgSystemMessage || target !== "zh-CN") return undefined;
  const source = entry.source.trim().normalize("NFKC"), end = /[!！。]$/.test(entry.source.trim()) ? entry.source.trim().slice(-1) : "";
  const patterns: Record<string, [RegExp, string]> = {
    obtainExp: [/^%1\s*の\s*%2を得た[!。]?$/, "获得了%1点%2"],
    obtainGold: [/^%1\\G\s*手に入れた[!。]?$/, "获得了%1\\G"],
    obtainItem: [/^『%1』を手に入れた[!。]?$/, "获得了『%1』"],
    partyName: [/^%1たち$/, "%1一行人"],
    levelUp: [/^%1は%2\s*%3\s*に上がった[!。]?$/, "%1升至%2 %3"],
    actorRecovery: [/^%1の%2が\s*%3\s*回復した[!。]?$/, "%1恢复了%3点%2"],
    enemyRecovery: [/^%1の%2が\s*%3\s*回復した[!。]?$/, "%1恢复了%3点%2"],
    actorGain: [/^%1の%2が\s*%3\s*増えた[!。]?$/, "%1的%2增加了%3"],
    enemyGain: [/^%1の%2が\s*%3\s*増えた[!。]?$/, "%1的%2增加了%3"],
    actorLoss: [/^%1の%2が\s*%3\s*減った[!。]?$/, "%1的%2减少了%3"],
    enemyLoss: [/^%1の%2が\s*%3\s*減った[!。]?$/, "%1的%2减少了%3"],
    actorDrain: [/^%1は%2を\s*%3\s*奪われた[!。]?$/, "%1被吸取了%3点%2"],
    enemyDrain: [/^%1の%2を\s*%3\s*奪った[!。]?$/, "从%1处吸取了%3点%2"],
  };
  const pattern = patterns[entry.rpgSystemMessage];
  if (!pattern?.[0].test(source)) return undefined;
  return entry.source.replace(/\S[\s\S]*\S|\S/, () => pattern[1] + end);
}
