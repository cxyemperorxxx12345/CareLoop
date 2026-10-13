import { businessDate, shiftDate } from './business-date.ts';

interface Plan {
  id: string;
  slots: number[];
  active: boolean;
  created_at: string;
}
interface Dose {
  plan_id: string;
  slot: number;
}
interface Log extends Dose {
  log_date: string;
  action: string;
}
interface Reminder extends Dose {
  remind_date: string;
}
const SLOT_TIMES = ['08:00', '12:00', '18:00', '21:00'];

export function reportAdherence(plans: Plan[], reminders: Reminder[], logs: Log[], start: string, now = new Date()) {
  const end = businessDate(now);
  const doses = new Set<string>();
  const key = (day: string, dose: Dose) => `${day}|${dose.plan_id}|${dose.slot}`;
  const dueAt = (day: string, slot: number) => Date.parse(`${day}T${SLOT_TIMES[slot]}:00+08:00`);
  // 已留存的提醒覆盖历史计划；没有提醒时，从仍有效的计划生效时间补齐应服次数。
  for (const row of reminders) {
    if (row.remind_date >= start && row.remind_date <= end && dueAt(row.remind_date, row.slot) <= now.getTime()) {
      doses.add(key(row.remind_date, row));
    }
  }
  for (const plan of plans) {
    if (!plan.active) continue;
    for (let day = start; day <= end; day = shiftDate(day, 1)) {
      for (const slot of plan.slots ?? []) {
        const time = dueAt(day, slot);
        if (time >= Date.parse(plan.created_at) && time <= now.getTime()) doses.add(key(day, { plan_id: plan.id, slot }));
      }
    }
  }
  // 无完整历史计划时保留实际记录，但不能把未知的应服次数编出来。
  const byDose = new Map<string, Log>();
  for (const log of logs) {
    if (log.log_date < start || log.log_date > end || dueAt(log.log_date, log.slot) > now.getTime()) continue;
    const dose = key(log.log_date, log);
    doses.add(dose);
    byDose.set(dose, log);
  }
  const rows = [...byDose.values()];
  const taken = rows.filter((row) => row.action === 'taken').length;
  const skipped = rows.filter((row) => row.action === 'skipped').length;
  const snoozed = rows.filter((row) => row.action === 'snoozed').length;
  const scheduled = doses.size;
  const answered = rows.length;
  return {
    taken, skipped, snoozed, scheduled, answered,
    unconfirmed: scheduled - answered,
    compliance_rate: scheduled > 0 ? Math.round(taken / scheduled * 100) : null,
  };
}
