import { supabase } from '@/db/supabase';
import { businessDate } from '@/lib/business-date';
import type { QueuedItem } from '@/lib/offline-cache';

export interface MedicationLogPayload {
  pid: string;
  planId: string;
  slot: number;
  action: 'taken' | 'snoozed' | 'skipped';
  reason: string | null;
  occurredAt: string;
  logDate: string;
  familyName?: string;
}

export function medicationEventTime(now = new Date()): Pick<MedicationLogPayload, 'occurredAt' | 'logDate'> {
  return { occurredAt: now.toISOString(), logDate: businessDate(now) };
}

// 旧版队列没有操作时间，使用队列创建时间还原，不能在补传时重取“今天”。
export function queuedMedicationPayload(item: QueuedItem): MedicationLogPayload {
  const payload = item.payload as unknown as MedicationLogPayload;
  const occurredAt = payload.occurredAt ?? new Date(item.createdAt).toISOString();
  return { ...payload, occurredAt, logDate: payload.logDate ?? businessDate(occurredAt) };
}

export async function sendMedicationEvent(payload: MedicationLogPayload): Promise<void> {
  const { error } = await supabase.rpc('record_medication_event', {
    p_patient_id: payload.pid,
    p_plan_id: payload.planId,
    p_slot: payload.slot,
    p_action: payload.action,
    p_reason: payload.reason,
    p_occurred_at: payload.occurredAt,
    p_log_date: payload.logDate,
  });
  if (error) throw new Error(error.message);
}
