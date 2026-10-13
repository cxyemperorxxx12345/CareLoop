import { businessDate } from '@/lib/business-date';
// 个人基线（机制①）统一入口
//
// 优先级：daily_baseline 表（迁移 00019，SQL 侧跑批产出）→ 表缺失/无数据时用患者本人
// 近 7 天打卡现算。演示库只应用到迁移 00011（无 daily_baseline 表）时，getBaselines 返回
// 空数组，此时若直接不渲染，「每个患者唯一的对照是他自己」这条主线在演示里就完全看不到，
// 所以这里补一层本地兜底——口径不是另起炉灶，而是严格照抄迁移里的 refresh_daily_baselines()：
//   · 窗口：昨天往前 7 天，不含今天（今天的读数是被判定对象，见迁移文件头 Q3）
//   · 中位数：percentile_cont(0.5)，偶数样本线性插值
//   · MAD：median(|v - 中位数|)，用 MAD 不用标准差是因为崩溃点 50%（Q1）
//   · 偏离带：中位数 ± GREATEST(2 * MAD, 最小半宽)，最小半宽防 MAD=0 时过度敏感（Q5）
//   · 样本 < 3 天不产出基线，前端不显示——绝不用通用参考值伪装成个人基线（Q4）
//
// 本文件只读取 api.ts 的既有函数，不修改 api.ts，也不写入任何数据。

import { getBaselines, patientApi } from '@/lib/api';

export interface BaselineMetric {
  metric: string;
  median: number;
  bandLow: number;
  bandHigh: number;
  sampleDays: number;
  // table：来自 daily_baseline 表；local：表无数据时由本人近 7 天打卡现算
  source: 'table' | 'local';
}

// 现算所需的最小打卡行结构（checkins 表字段的子集）
export interface BaselineCheckin {
  created_at: string;
  systolic?: number | null;
  diastolic?: number | null;
  heart_rate?: number | null;
  temperature?: number | null;
  blood_glucose?: number | null;
}

const WINDOW_DAYS = 7;
const MIN_SAMPLE_DAYS = 3;

// 波动带最小半宽（与迁移 00019 的 CASE 分支一致）：体温 0.3℃、血糖 0.5mmol/L，其余走 ELSE
const MIN_HALF_WIDTH: Record<string, number> = { temperature: 0.3, blood_glucose: 0.5 };
const MIN_HALF_WIDTH_DEFAULT = 5;

// 现算覆盖的指标：与迁移 00019 的 v_metrics 完全同集合（不含体重——体重走 CASE 的 ELSE 分支
// 会拿到 ±5kg 的最小半宽，临床意义弱且演示画面上突兀）
const LOCAL_METRICS = ['systolic', 'diastolic', 'heart_rate', 'temperature', 'blood_glucose'];

// 日期键一律取北京时间自然日（YYYY-MM-DD）：
//   · 与迁移 00021 的北京时间口径一致，保证现算结果与跑批结果一致
//   · 与前端既有口径一致（趋势图 X 轴就是 created_at.slice(5, 10)）
function dayKey(d: Date): string {
  return businessDate(d);
}

function parseDayKey(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return dayKey(d);
}

// percentile_cont(0.5)：连续百分位，偶数样本在两个中间值之间线性插值（与 Postgres 同口径）
function medianOf(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sorted[0];
  const rank = 1 + 0.5 * (n - 1); // 1-based 排名
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower - 1];
  return sorted[lower - 1] + (sorted[upper - 1] - sorted[lower - 1]) * (rank - lower);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

// 用近 7 天（不含今天）打卡现算个人基线；样本不足 3 天的指标直接不产出
export function computeLocalBaselines(rows: BaselineCheckin[]): BaselineMetric[] {
  const todayKey = dayKey(new Date());
  const startKey = dayKey(new Date(Date.now() - WINDOW_DAYS * 86400000));

  // 窗口内 日 → 值，按天聚合（同一天取最新快照，与 SQL 的 DISTINCT ON 口径一致）
  const byMetric = new Map<string, Map<string, number[]>>();
  const latest = new Map<string, BaselineCheckin>();
  for (const row of rows) {
    const key = parseDayKey(row.created_at);
    if (key && (!latest.has(key) || row.created_at > latest.get(key)!.created_at)) latest.set(key, row);
  }
  for (const row of latest.values()) {
    const k = parseDayKey(row.created_at);
    if (!k || k < startKey || k >= todayKey) continue;
    for (const metric of LOCAL_METRICS) {
      const v = (row as unknown as Record<string, unknown>)[metric];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const perDay = byMetric.get(metric) ?? new Map<string, number[]>();
      const bucket = perDay.get(k) ?? [];
      bucket.push(v);
      perDay.set(k, bucket);
      byMetric.set(metric, perDay);
    }
  }

  const out: BaselineMetric[] = [];
  for (const metric of LOCAL_METRICS) {
    const perDay = byMetric.get(metric);
    if (!perDay || perDay.size < MIN_SAMPLE_DAYS) continue; // 样本不足：宁可不显示
    const values: number[] = [];
    perDay.forEach((vs) => values.push(...vs));
    const median = medianOf(values.slice().sort((a, b) => a - b));
    if (!Number.isFinite(median)) continue;
    const mad = medianOf(values.map((v) => Math.abs(v - median)).sort((a, b) => a - b));
    const half = Math.max(2 * mad, MIN_HALF_WIDTH[metric] ?? MIN_HALF_WIDTH_DEFAULT);
    out.push({
      metric,
      median: round1(median),
      bandLow: round1(median - half),
      bandHigh: round1(median + half),
      sampleDays: perDay.size,
      source: 'local',
    });
  }
  return out;
}

/**
 * 读取患者个人基线。
 * a) daily_baseline 表有数据 → 原样返回（source='table'）；
 * b) 表缺失或为空 → 用传入的（或现取的）近 14 天打卡现算（source='local'）；
 * c) 样本不足 3 天 → 返回空数组，前端不显示该区块。
 */
export async function loadBaselines(
  patientId: string,
  checkins?: BaselineCheckin[] | null,
): Promise<BaselineMetric[]> {
  // 表缺失时 getBaselines 内部已吞掉错误返回 []，这里再兜一层异常防止取数失败打断页面
  const fromTable = await getBaselines(patientId).catch(() => []);
  if (fromTable.length > 0) {
    // 表口径固定 7 天滚动窗口（daily_baseline.window_days 恒为 7）
    return fromTable.map((b) => ({ ...b, sampleDays: b.sampleDays, source: 'table' as const }));
  }
  const rows = checkins ?? ((await patientApi.checkinHistory(patientId, 14)) as BaselineCheckin[]);
  const res = computeLocalBaselines(rows ?? []);
  return res;
}
