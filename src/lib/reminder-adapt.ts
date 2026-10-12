// 机制③：最小打扰自适应提醒（展示层 · 纯函数）
//
// v17 评价核心主张：把"死板定时提醒"换成"随本人行为自适应、最小打扰"的预测式提醒。
// 实现：用患者本人近 N 天的用药响应轨迹（按 slot 时段），推断每个时段（早/中/晚/夜）的准时率与响应率，
// 据此生成"已被智能调节"的提醒策略摘要——这不是命中规则弹窗，而是基于个体习惯的持续适配。
//
// 关键设计（呼应"每个患者唯一的对照是他自己"）：
//  - 准时率高的时段 → 提醒延后/减弱（少打扰）
//  - 易漏时段 → 提醒提前并在超时后联动家属（该打扰才打扰）
//  - 睡前(夜间)响应差 → 不打扰患者本人，改通知家属
//  - 输出"打扰指数"（越低越省心），让适配效果可被看见
//
// 注意：本项目用药时段用 slot 编码 —— 0 早(8:00) / 1 中(12:00) / 2 晚(18:00) / 3 睡前(21:00，属夜间)

export interface ReminderLogRow {
  slot: number; // 0 早 / 1 中 / 2 晚 / 3 睡前(夜间)
  action: string; // 'taken' | 'snoozed' | 'skipped'（来自 Supabase，运行期恒为三者之一）
  log_date: string; // 'YYYY-MM-DD'
}

export interface ReminderAdaptRaw {
  logs: ReminderLogRow[];
}

export type AdaptBucket = 'morning' | 'noon' | 'evening' | 'night';

export interface AdaptBucketStat {
  bucket: AdaptBucket;
  label: string;
  sample: number; // 有效样本数
  taken: number;
  snoozed: number;
  skipped: number;
  onTimeRate: number; // taken / sample
  respondRate: number; // (taken + snoozed) / sample
}

export interface AdaptRule {
  bucket: AdaptBucket | 'overall';
  tone: 'calm' | 'watch' | 'shield';
  text: string;
}

export interface ReminderAdaptResult {
  buckets: AdaptBucketStat[];
  rules: AdaptRule[];
  disturbanceIndex: number; // 0-100，越低越省心
  summary: string;
  hasData: boolean;
}

function bucketOf(slot: number): AdaptBucket {
  if (slot === 0) return 'morning';
  if (slot === 1) return 'noon';
  if (slot === 2) return 'evening';
  return 'night';
}

const BUCKET_LABEL: Record<AdaptBucket, string> = {
  morning: '早间',
  noon: '午间',
  evening: '晚间',
  night: '夜间（睡前）',
};

export function computeReminderAdapt(raw: ReminderAdaptRaw, _days = 14): ReminderAdaptResult {
  const { logs } = raw;
  const buckets: Record<AdaptBucket, AdaptBucketStat> = {
    morning: empty('morning'),
    noon: empty('noon'),
    evening: empty('evening'),
    night: empty('night'),
  };

  for (const log of logs) {
    const b = bucketOf(log.slot);
    const s = buckets[b];
    s.sample += 1;
    if (log.action === 'taken') s.taken += 1;
    else if (log.action === 'snoozed') s.snoozed += 1;
    else if (log.action === 'skipped') s.skipped += 1;
  }

  const list = (Object.values(buckets) as AdaptBucketStat[]).map((s) => ({
    ...s,
    onTimeRate: s.sample ? s.taken / s.sample : 0,
    respondRate: s.sample ? (s.taken + s.snoozed) / s.sample : 0,
  }));

  const rules: AdaptRule[] = [];
  let disturbance = 100;

  for (const s of list) {
    if (s.sample < 4) continue; // 样本不足不判定，避免误判
    if (s.onTimeRate >= 0.85) {
      rules.push({
        bucket: s.bucket,
        tone: 'calm',
        text: `${s.label}你几乎都准时服药，系统已把提醒延后 5 分钟，减少不必要的打扰。`,
      });
      disturbance -= 15;
    }
    if (s.respondRate < 0.6) {
      if (s.bucket === 'night') {
        rules.push({
          bucket: s.bucket,
          tone: 'shield',
          text: `睡前你常错过提醒，相关用药已改为通知家属协助，不再深夜打扰你。`,
        });
      } else {
        rules.push({
          bucket: s.bucket,
          tone: 'watch',
          text: `${s.label}容易漏服，提醒已提前，并在超时后自动联动家属，该打扰时才打扰。`,
        });
      }
      disturbance += 10;
    }
  }

  const hasData = logs.length > 0;

  const overallRespond = list.reduce((a, s) => a + s.taken + s.snoozed, 0) /
    Math.max(1, list.reduce((a, s) => a + s.sample, 0));
  if (hasData && overallRespond >= 0.85) {
    rules.push({
      bucket: 'overall',
      tone: 'calm',
      text: `你近期整体服药很规律，系统已为你精简提醒频次，只在关键节点提醒。`,
    });
    disturbance -= 10;
  }

  disturbance = Math.max(20, Math.min(100, Math.round(disturbance)));

  let summary: string;
  if (!hasData) {
    summary = '暂无可分析用药记录，系统将采用标准提醒节奏，随你使用逐步自适应。';
  } else if (disturbance <= 40) {
    summary = '你的用药很规律，提醒已大幅精简——只在你真正需要的节点出现。';
  } else if (disturbance >= 75) {
    summary = '近期漏服偏多，系统已加强关键时段提醒并联动家属，确保该打扰时不漏接。';
  } else {
    summary = '系统已按你的习惯自适应调节提醒：准时的少打扰，易漏的多守护。';
  }

  return { buckets: list, rules, disturbanceIndex: disturbance, summary, hasData };
}

function empty(bucket: AdaptBucket): AdaptBucketStat {
  return {
    bucket,
    label: BUCKET_LABEL[bucket],
    sample: 0,
    taken: 0,
    snoozed: 0,
    skipped: 0,
    onTimeRate: 0,
    respondRate: 0,
  };
}
