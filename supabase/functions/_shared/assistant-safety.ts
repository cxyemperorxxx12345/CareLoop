export const SAFETY_RESPONSE =
  '听起来你现在很难受，我会认真对待。你现在安全吗？有没有已经伤害自己，或正准备这么做？' +
  '如果有立即危险，请马上联系当地急救或前往急诊。先联系一个你信任的人，请他现在陪着你。' +
  '你可以继续告诉我发生了什么。';

// 明确的自伤/轻生表达使用固定安全回应，前端离线也能运行。
// 这是规则兜底，不宣称覆盖全部风险；普通问答提示词仍需保留安全要求。
export function needsSafetyResponse(input: string): boolean {
  const text = input.normalize('NFKC').replace(/[\s\u200b-\u200d\ufeff]/g, '').toLowerCase();
  // 区分软件/文学讨论中的引用，避免把解释问题当成当前个人危机。
  if (/^(?:如果用户|假如患者|小说(?:中|里)|电影(?:中|里)|这句台词|如何预防自杀|怎么预防自杀|suicideprevention)/.test(text)
    && !/(?:但|其实|我现在|我真的).{0,12}(?:去死|想死|自杀|轻生|不想活)/.test(text)) return false;
  const clauses = text.split(/[。！？!?；;\n]/);
  return clauses.some((clause) => {
    const affirmative = clause.replace(/i(?:don'twanttodie|donotwanttodie|willnotkillmyself)/g, '').replace(/我(?:是不是|会不会|怕|担心|害怕).{0,8}(?:要死|死掉|死了|死亡)/g, '').replace(/(?:我|自己)(?:不想|不会|不打算|不准备|没有想过|没想过)(?:去死|死(?:掉|了)?|自杀|轻生|伤害自己)/g, '');
    return /^(?:自杀|轻生|去死|想死|不活了)$/.test(affirmative) || /(?:我|自己).{0,8}(?:想|要|准备|打算|决定|马上|正在|已经).{0,8}(?:去死|自杀|轻生|结束(?:自己)?的?生命|死(?:掉|了)?|伤害自己|割腕|跳楼|吞药)/.test(affirmative)
      || /(?:不想活(?:了)?|活不下去(?:了)?|不想再活|想一了百了|想结束这一切)/.test(affirmative)
      || /(?:怎么|如何|怎样).{0,8}(?:自杀|结束生命)/.test(affirmative)
      || /(?:i\s*want\s*to\s*die|killmyself|suicide|endmylife)/.test(affirmative);
  });
}
