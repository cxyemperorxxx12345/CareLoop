// 照护业务统一使用北京时间自然日，与 ensure_today_reminders 的口径一致。
const DAY_MS = 86400000;
const OFFSET_MS = 8 * 3600000;

export function businessDate(value: Date | string | number = new Date()): string {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) throw new Error('无效的记录时间');
  return new Date(ms + OFFSET_MS).toISOString().slice(0, 10);
}

export function shiftDate(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function businessDayStart(day: string): string {
  return new Date(`${day}T00:00:00+08:00`).toISOString();
}
