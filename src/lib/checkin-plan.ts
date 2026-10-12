// 打卡页「今天该测什么」的决策与话术：纯规则，不上模型、不做医学推断。
//
// 背景：患者端原先把 7 个体征输入框平铺在一屏。字段本来就允许留空（只在填了值时做区间
// 校验），所以对老人来说问题不是"必须填完"，而是打开一屏不知道今天该测什么。这里按
// 诊断/术式/既往史/医嘱的关键词推导「今日建议项」，其余折叠进「更多（可选）」。
//
// 改口径只改本文件的 RULES 表；本文件不写入任何数据。

import type { BaselineMetric } from '@/lib/baseline';

/** 体征分组键：血压拆成收缩压/舒张压两个输入框，但作为一项来推荐 */
export type CheckinFieldKey = 'blood_pressure' | 'heart_rate' | 'glucose' | 'temperature' | 'pain' | 'weight';

/** 展示顺序：血压永远在最前，与卡片上的排版一致 */
export const FIELD_ORDER: CheckinFieldKey[] = ['blood_pressure', 'heart_rate', 'glucose', 'temperature', 'pain', 'weight'];

export const FIELD_LABEL: Record<CheckinFieldKey, string> = {
  blood_pressure: '血压',
  heart_rate: '心率',
  glucose: '血糖',
  temperature: '体温',
  pain: '疼痛评分',
  weight: '体重',
};

/**
 * 建议规则表：文本命中任一关键词 → 建议测这些项目。
 * reason 会原样显示在卡片上，让老人知道"为什么今天要测这几项"。
 */
const RULES: { keywords: string[]; fields: CheckinFieldKey[]; reason: string }[] = [
  { keywords: ['高血压', '血压'], fields: ['blood_pressure', 'heart_rate'], reason: '高血压' },
  {
    keywords: ['冠心病', '冠脉', '心衰', '心梗', '心脏', '心血管', '瓣膜', '支架', '搭桥', '房颤', '心律'],
    fields: ['blood_pressure', 'heart_rate'],
    reason: '心脏',
  },
  { keywords: ['糖尿病', '血糖', '糖耐量', '糖化'], fields: ['glucose'], reason: '糖尿病' },
  {
    keywords: ['术后', '手术', '搭桥', '移植', '切口', '伤口', '拆线', '造口'],
    fields: ['temperature', 'pain'],
    reason: '术后恢复',
  },
  { keywords: ['心衰', '肾衰', '透析', '水肿', '肥胖', '减重', '营养'], fields: ['weight'], reason: '体重管理' },
];

export interface CheckinPlan {
  /** 今日建议测量项（置顶、默认展开） */
  suggested: CheckinFieldKey[];
  /** 其余可选项（折叠进「更多（可选）」） */
  optional: CheckinFieldKey[];
  /** 命中依据：诊断/术式/既往史/医嘱里的病种关键词，用于向患者解释 */
  reasons: string[];
}

/**
 * 按患者的诊断、术式、既往史、医嘱文本推导今日建议项。
 * 无一条命中（例如档案还没有诊断）时不硬编"通用建议"，改为全部列为建议项，
 * 等档案完善后再收窄——宁可多显示，也不编造一个病种理由。
 */
export function buildCheckinPlan(texts: (string | null | undefined)[]): CheckinPlan {
  const hay = texts.filter((t): t is string => typeof t === 'string' && t.length > 0).join(' ');
  const hit = new Set<CheckinFieldKey>();
  const reasons: string[] = [];
  for (const rule of RULES) {
    if (!rule.keywords.some((k) => hay.includes(k))) continue;
    for (const f of rule.fields) hit.add(f);
    if (!reasons.includes(rule.reason)) reasons.push(rule.reason);
  }
  if (hit.size === 0) return { suggested: [...FIELD_ORDER], optional: [], reasons: [] };
  return {
    suggested: FIELD_ORDER.filter((f) => hit.has(f)),
    optional: FIELD_ORDER.filter((f) => !hit.has(f)),
    reasons,
  };
}

// ===== 沿用上一次记录 =====

/** 打卡行（checkins 表字段子集，PostgREST 返回 numeric 为 number） */
export interface RawCheckin {
  created_at: string;
  systolic?: number | null;
  diastolic?: number | null;
  heart_rate?: number | null;
  temperature?: number | null;
  blood_glucose?: number | null;
  weight?: number | null;
  pain_score?: number | null;
}

export interface CheckinSnapshot {
  /** 展示用日期，如「10月10日」 */
  dayLabel: string;
  /** 是否就是昨天——决定按钮写「沿用昨日」还是「沿用上次（某日）」 */
  isYesterday: boolean;
  systolic: number | null;
  diastolic: number | null;
  heart_rate: number | null;
  temperature: number | null;
  blood_glucose: number | null;
  weight: number | null;
  pain_score: number | null;
}

// 一律按本机日（患者感知的"今天/昨天"）取日键，不用 UTC——老人不会按 UTC 过日子
function localDayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function nn(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 取今天之前最近的一次打卡记录（用于「沿用」）。
 * 优先昨天；昨天没记录时退回最近一次，并把真实日期标注在按钮上——
 * 绝不把几天的旧记录说成"昨天的"。
 */
export function pickLastCheckin(rows: RawCheckin[], now = new Date()): CheckinSnapshot | null {
  const todayKey = localDayKey(now);
  const past = rows.filter((r) => r.created_at && localDayKey(new Date(r.created_at)) < todayKey);
  if (past.length === 0) return null;
  const last = past.reduce((a, b) => (new Date(a.created_at) >= new Date(b.created_at) ? a : b));
  const lastDate = new Date(last.created_at);
  const yesterdayKey = localDayKey(new Date(now.getTime() - 24 * 3600 * 1000));
  return {
    dayLabel: `${lastDate.getMonth() + 1}月${lastDate.getDate()}日`,
    isYesterday: localDayKey(lastDate) === yesterdayKey,
    systolic: nn(last.systolic),
    diastolic: nn(last.diastolic),
    heart_rate: nn(last.heart_rate),
    temperature: nn(last.temperature),
    blood_glucose: nn(last.blood_glucose),
    weight: nn(last.weight),
    pain_score: nn(last.pain_score),
  };
}

// ===== 提交后的人话反馈 =====

export interface FeedbackValues {
  systolic: number | null;
  diastolic: number | null;
  heart_rate: number | null;
  temperature: number | null;
  glucose: number | null;
}

type Direction = 'higher' | 'lower' | 'same';

const DIRECTION_TEXT: Record<Direction, string> = { higher: '高一些', lower: '低一些', same: '差不多' };

function fmtN(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

/** 只跟本人自己的波动带比：超出上沿=高一些，低于下沿=低一些，带内=差不多 */
function directionOf(v: number, b: BaselineMetric): Direction {
  if (v > b.bandHigh) return 'higher';
  if (v < b.bandLow) return 'lower';
  return 'same';
}

/** 收缩压/舒张压方向不一致（一高一低）时返回 null：说不清方向就不硬说 */
function mergeDirection(a: Direction, b: Direction): Direction | null {
  if (a === b) return a;
  if (a === 'same') return b;
  if (b === 'same') return a;
  return null;
}

/**
 * 提交成功后的反馈话术：把刚填的数值和「他自己的基线中位数」并排说一句。
 * 只陈述高低关系，不做任何医学判断；取不到基线就退化成温和反馈，绝不编造数值。
 */
export function buildCheckinFeedback(values: FeedbackValues, baselines: BaselineMetric[]): string {
  const byMetric = new Map(baselines.map((b) => [b.metric, b]));
  let sentence: string | null = null;

  const sysB = byMetric.get('systolic');
  const diaB = byMetric.get('diastolic');
  if (values.systolic !== null && values.diastolic !== null && sysB && diaB) {
    const d = mergeDirection(directionOf(values.systolic, sysB), directionOf(values.diastolic, diaB));
    if (d) {
      const now = `${fmtN(values.systolic)}/${fmtN(values.diastolic)}`;
      const usual = `${fmtN(sysB.median)}/${fmtN(diaB.median)}`;
      sentence =
        d === 'same'
          ? `今天血压 ${now}，和您自己平时的 ${usual} 差不多`
          : `今天血压 ${now}，比您自己平时的 ${usual} ${DIRECTION_TEXT[d]}`;
    }
  }

  if (!sentence) {
    const singles = [
      { value: values.heart_rate, label: '心率', metric: 'heart_rate' },
      { value: values.glucose, label: '血糖', metric: 'blood_glucose' },
      { value: values.temperature, label: '体温', metric: 'temperature' },
    ];
    for (const s of singles) {
      const b = byMetric.get(s.metric);
      if (s.value === null || !b) continue;
      const d = directionOf(s.value, b);
      const usual = fmtN(b.median);
      sentence =
        d === 'same'
          ? `今天${s.label} ${fmtN(s.value)}，和您自己平时的 ${usual} 差不多`
          : `今天${s.label} ${fmtN(s.value)}，比您自己平时的 ${usual} ${DIRECTION_TEXT[d]}`;
      break;
    }
  }

  if (!sentence) {
    // 无基线可比（样本不足 3 天）或本次没填可比项：只确认记录成功，不编造对比
    return baselines.length === 0
      ? '已记录，今天辛苦了。再记几天，就能看出您自己的规律了。'
      : '已记录，今天辛苦了。';
  }
  return `${sentence}，已记录，随访护士会看到。`;
}
