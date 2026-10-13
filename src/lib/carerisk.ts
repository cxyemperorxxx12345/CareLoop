// CareRisk 随访关注评分：按近期记录加权，辅助安排随访，不表示未来概率。

export type TriageLevel = 'green' | 'yellow' | 'red';
export type CareRiskLevel = 'low' | 'medium' | 'high';

// 原始输入：窗口内（windowDays）该患者本人的全部轨迹
export interface CareRiskRaw {
  plans: { id: string; slots: number[] | null }[];
  logs: { plan_id: string; slot: number; action: string; log_date: string }[];
  checkins: { created_at: string }[];
  symptoms: { level: TriageLevel | string; created_at: string }[];
  dischargeDate: string | null;
}

export interface CareRiskDimension {
  key: 'medication' | 'checkin' | 'escalation' | 'recency';
  label: string;
  risk: number; // 0–1，越高越危险
  weight: number;
}

export interface CareRiskResult {
  score: number; // 0–100
  level: CareRiskLevel;
  dimensions: CareRiskDimension[];
  drivers: string[]; // 可读的驱动因子
  forecast: string; // 根据近期记录给出的随访建议
  windowDays: number;
}

const WEIGHTS = {
  medication: 0.4,
  checkin: 0.25,
  escalation: 0.2,
  recency: 0.15,
} as const;

function daysBetween(fromISO: string, toMs = Date.now()): number {
  const t = Date.parse(fromISO);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.round((toMs - t) / 86400000));
}

/**
 * 计算 CareRisk 履约风险评分。
 * @param raw 窗口内本人轨迹
 * @param windowDays 回溯窗口（默认 14 天；列表页可用 7 天）
 */
export function computeCareRisk(raw: CareRiskRaw, windowDays = 14): CareRiskResult {
  const w = windowDays;
  const now = Date.now();
  const windowStart = now - w * 86400000;

  // 活跃天数：出院后才开始有数据，且不超过窗口
  let daysActive = w;
  if (raw.dischargeDate) {
    const dd = Date.parse(raw.dischargeDate.slice(0, 10));
    if (!Number.isNaN(dd)) {
      const sinceDischarge = Math.max(1, Math.floor((now - dd) / 86400000) + 1);
      daysActive = Math.min(w, sinceDischarge);
    }
  }

  // 每日应服剂量 = 在服方案的时间槽总数
  const dailySlots = raw.plans.reduce((n, p) => n + (Array.isArray(p.slots) ? p.slots.length : 0), 0);
  const scheduledDoses = daysActive * dailySlots;

  // 用药依从 + 趋势：把窗口切为「近期半窗」与「较早半窗」，看是否在走低
  const half = Math.floor(w / 2);
  const recentStart = now - half * 86400000;
  const recentLogs = raw.logs.filter((l) => Date.parse(l.log_date) >= recentStart);
  const earlierLogs = raw.logs.filter((l) => {
    const t = Date.parse(l.log_date);
    return t >= windowStart && t < recentStart;
  });
  const takenAll = raw.logs.filter((l) => l.action === 'taken').length;
  const recentTaken = recentLogs.filter((l) => l.action === 'taken').length;
  const earlierTaken = earlierLogs.filter((l) => l.action === 'taken').length;

  const adherence = scheduledDoses > 0 ? takenAll / scheduledDoses : 1;
  const recentDays = Math.min(half, daysActive);
  const earlierDays = Math.max(0, daysActive - recentDays);
  const recentScheduled = recentDays * dailySlots;
  const earlierScheduled = earlierDays * dailySlots;
  const recentAdherence = recentScheduled > 0 ? recentTaken / recentScheduled : 1;
  const earlierAdherence = earlierScheduled > 0 ? earlierTaken / earlierScheduled : 1;
  const decline = Math.max(0, earlierAdherence - recentAdherence); // 近期比前期差多少（0–1）

  let medRisk = 1 - Math.min(1, adherence);
  medRisk = Math.min(1, medRisk + decline * 0.3); // 趋势恶化附加惩罚

  // 打卡规律性：窗口内实际打卡天数 / 应打卡天数
  const checkedDays = new Set(
    raw.checkins
      .filter((c) => Date.parse(c.created_at) >= windowStart)
      .map((c) => c.created_at.slice(0, 10)),
  ).size;
  const checkinRisk = daysActive > 0 ? 1 - Math.min(1, checkedDays / daysActive) : 0;

  // 症状预警密度
  const red = raw.symptoms.filter((s) => s.level === 'red').length;
  const yellow = raw.symptoms.filter((s) => s.level === 'yellow').length;
  const escalationRisk = Math.min(1, red * 0.4 + yellow * 0.15);

  // 互动静默：距最近一次活动（用药/打卡/症状）的天数
  const lastActivity = [
    ...raw.logs.map((l) => `${l.log_date}T00:00:00`),
    ...raw.checkins.map((c) => c.created_at),
    ...raw.symptoms.map((s) => s.created_at),
  ]
    .filter(Boolean)
    .sort()
    .pop();
  const daysSilent = lastActivity ? daysBetween(lastActivity) : daysActive;
  const recencyRisk = Math.min(1, daysSilent / 4); // 静默 ≥4 天即拉满

  const dimensions: CareRiskDimension[] = [
    { key: 'medication', label: '用药依从', risk: medRisk, weight: WEIGHTS.medication },
    { key: 'checkin', label: '打卡规律', risk: checkinRisk, weight: WEIGHTS.checkin },
    { key: 'escalation', label: '症状预警', risk: escalationRisk, weight: WEIGHTS.escalation },
    { key: 'recency', label: '互动静默', risk: recencyRisk, weight: WEIGHTS.recency },
  ];

  const composite =
    medRisk * WEIGHTS.medication +
    checkinRisk * WEIGHTS.checkin +
    escalationRisk * WEIGHTS.escalation +
    recencyRisk * WEIGHTS.recency;

  const score = Math.round(composite * 100);
  const level: CareRiskLevel = score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low';

  // 驱动因子：挑出真正在拉高风险的维度，给出可读文案
  const drivers: string[] = [];
  if (decline > 0.15 && medRisk > 0.3) drivers.push('近几日服药依从在走低');
  if (adherence < 0.7 && medRisk > 0.3) {
    drivers.push(`用药漏服偏多（近 ${w} 天依从 ${Math.round(adherence * 100)}%）`);
  }
  if (checkinRisk > 0.4) drivers.push('健康打卡经常漏记');
  if (red + yellow > 0) drivers.push(`近 ${w} 天出现 ${red + yellow} 次症状预警`);
  if (recencyRisk > 0.5) drivers.push(`已 ${daysSilent} 天未在 App 活跃`);
  if (drivers.length === 0) drivers.push('各项指标平稳，履约良好');

  const forecast =
    level === 'high'
      ? '近期记录需要重点关注，建议主动电话随访'
      : level === 'medium'
        ? '近期有漏记或异常记录，建议与患者及家属确认情况'
        : '近期记录较规律，可按既定计划随访';

  return { score, level, dimensions, drivers, forecast, windowDays: w };
}

// 展示配色：与全局 triage 色板一致
export const CARERISK_META: Record<CareRiskLevel, { label: string; cls: string; ring: string }> = {
  low: { label: '低', cls: 'bg-triage-green-bg text-triage-green', ring: 'hsl(var(--triage-green))' },
  medium: { label: '中', cls: 'bg-triage-amber-bg text-triage-amber', ring: 'hsl(var(--triage-amber))' },
  high: { label: '高', cls: 'bg-triage-red-bg text-triage-red', ring: 'hsl(var(--triage-red))' },
};

// 单个维度风险值 → 配色（绿/黄/红）
export function riskTone(risk: number): { ring: string; text: string } {
  if (risk >= 0.6) return { ring: 'hsl(var(--triage-red))', text: 'text-triage-red' };
  if (risk >= 0.3) return { ring: 'hsl(var(--triage-amber))', text: 'text-triage-amber' };
  return { ring: 'hsl(var(--triage-green))', text: 'text-triage-green' };
}
