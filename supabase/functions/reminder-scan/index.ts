// CareLoop 提醒调度扫描（pg_cron 每分钟调用）：
// L0站内 → 30min → L1短信(打桩) → L2家属 → L3护士站预警，任意打卡即终止
import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { getAdminClient } from '../_shared/supabase.ts';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const SLOT_NAMES = ['早', '中', '晚', '睡前'];
const SLOT_TIMES = ['08:00', '12:00', '18:00', '21:00'];
const ESCALATE_STEP_MIN = 30;

type MessagePayload = {
  patient_id: string;
  type: string;
  title: string;
  content: string;
  link_path: string;
};

// 分钟级时间窗口：YYYY-MM-DDTHH，用于「同一小时内只允许一条」的幂等键
function hourWindow(d: Date): string {
  return d.toISOString().slice(0, 13);
}

// 幂等写入消息：先查后插 + 唯一索引兜底。
// reminder-scan 每分钟被 pg_cron 调用一次，任何边界条件下的重复触发都不应产生重复消息。
// 返回 'inserted' | 'duplicate' | 'failed'
async function insertMessageOnce(
  admin: SupabaseClient,
  payload: MessagePayload,
  dedupKey: string,
): Promise<'inserted' | 'duplicate' | 'failed'> {
  const { data: exists, error: selErr } = await admin
    .from('messages')
    .select('id')
    .eq('patient_id', payload.patient_id)
    .eq('dedup_key', dedupKey)
    .limit(1);
  if (!selErr && exists && exists.length) return 'duplicate';

  const { error } = await admin.from('messages').insert({ ...payload, dedup_key: dedupKey });
  if (!error) return 'inserted';
  // 23505 unique_violation：并发下已被写入，视为已存在
  if (error.code === '23505') return 'duplicate';
  console.error('[reminder-scan] 写入消息失败', dedupKey, error.message);
  return 'failed';
}

Deno.serve(async (req: Request): Promise<Response> => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return errorResponse('Method Not Allowed', 405);

  // pg_cron 经 pg_net 调用，用 publishable key（anon）鉴权
  const apikey = req.headers.get('apikey') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  if (!apikey || apikey !== anonKey) return errorResponse('鉴权失败', 401);

  const admin = getAdminClient();
  const now = new Date();
  const in30 = new Date(now.getTime() + ESCALATE_STEP_MIN * 60 * 1000);
  const result = { ensured: false, sent: 0, escalated: 0, rearmed: 0, alerts_created: 0, errors: 0 as number };

  // 0. 幂等生成今日提醒（service_role 专用 RPC）
  const { error: ensureErr } = await admin.rpc('ensure_today_reminders');
  if (!ensureErr) result.ensured = true;

  // 取到期提醒（含药品名，用于消息文案）
  const { data: due } = await admin
    .from('reminders')
    .select('id, patient_id, plan_id, slot, status, escalation_level, next_action_at, snooze_until, medication_plans(medicine_name)')
    .lte('next_action_at', now.toISOString())
    .in('status', ['pending', 'sent', 'snoozed', 'escalated']);
  const rows = (due ?? []) as Array<{
    id: string;
    patient_id: string;
    slot: number;
    status: string;
    escalation_level: number;
    snooze_until: string | null;
    medication_plans: { medicine_name: string } | null;
  }>;

  for (const r of rows) {
    const medName = r.medication_plans?.medicine_name ?? '药品';
    const slotLabel = `${SLOT_NAMES[r.slot] ?? ''} ${SLOT_TIMES[r.slot] ?? ''}`;

    try {
      // ---- snoozed 到期：重新推送并重置 30 分钟升级时钟 ----
      if (r.status === 'snoozed') {
        const { data: upd } = await admin
          .from('reminders')
          .update({ status: 'sent', snooze_until: null, next_action_at: in30.toISOString() })
          .eq('id', r.id)
          .eq('status', 'snoozed')
          .select('id');
        if (upd && upd.length) {
          const st = await insertMessageOnce(
            admin,
            {
              patient_id: r.patient_id,
              type: 'reminder',
              title: `该服药啦 · ${SLOT_NAMES[r.slot] ?? ''}`,
              content: `您稍后提醒的 ${medName} 到点了，请及时打卡确认。`,
              link_path: '/patient/medications',
            },
            `med:rearm:${r.id}:${hourWindow(now)}`,
          );
          if (st === 'failed') result.errors += 1;
          if (st === 'inserted') result.rearmed += 1;
        }
        continue;
      }

      // ---- pending（到点未推送）→ L0 站内推送 ----
      if (r.status === 'pending') {
        const { data: upd } = await admin
          .from('reminders')
          .update({ status: 'sent', next_action_at: in30.toISOString() })
          .eq('id', r.id)
          .eq('status', 'pending')
          .select('id');
        if (upd && upd.length) {
          const st = await insertMessageOnce(
            admin,
            {
              patient_id: r.patient_id,
              type: 'reminder',
              title: `该服药啦 · ${SLOT_NAMES[r.slot] ?? ''}`,
              content: `到了 ${slotLabel} 的服药时间：${medName}，请打卡确认。`,
              link_path: '/patient/medications',
            },
            `med:l0:${r.id}`,
          );
          if (st === 'failed') result.errors += 1;
          if (st === 'inserted') result.sent += 1;
        }
        continue;
      }

      // ---- sent/escalated 到期：升级一级 ----
      if (r.status !== 'sent' && r.status !== 'escalated') continue;

      const nextLevel = r.escalation_level + 1;
      if (nextLevel === 1) {
        // L0 → L1：短信通道（演示打桩，仅留痕消息）
        const { data: upd } = await admin
          .from('reminders')
          .update({ escalation_level: 1, next_action_at: in30.toISOString() })
          .eq('id', r.id)
          .in('status', ['sent', 'escalated'])
          .select('id');
        if (upd && upd.length) {
          const st = await insertMessageOnce(
            admin,
            {
              patient_id: r.patient_id,
              type: 'escalation',
              title: '漏服提醒升级 · 短信通知',
              content: `您 ${slotLabel} 的 ${medName} 尚未确认，系统已向预留手机号发送短信提醒（演示通道）。`,
              link_path: '/patient/medications',
            },
            `med:l1:${r.id}`,
          );
          if (st === 'failed') result.errors += 1;
          if (st === 'inserted') result.escalated += 1;
        }
        continue;
      }

      if (nextLevel === 2) {
        // L1 → L2：通知紧急联系人；无联系人自动跳级
        const { data: patient } = await admin
          .from('patients')
          .select('emergency_contact, emergency_contact_phone, name')
          .eq('id', r.patient_id)
          .single();
        const pt = patient as unknown as { emergency_contact: string | null; emergency_contact_phone: string | null; name: string } | null;
        const hasContact = Boolean(pt?.emergency_contact_phone);

        if (hasContact) {
          const { data: upd } = await admin
            .from('reminders')
            .update({ escalation_level: 2, next_action_at: in30.toISOString() })
            .eq('id', r.id)
            .in('status', ['sent', 'escalated'])
            .select('id');
          if (upd && upd.length) {
            const st = await insertMessageOnce(
              admin,
              {
                patient_id: r.patient_id,
                type: 'escalation',
                title: '漏服提醒升级 · 已通知家属',
                content: `${slotLabel} 的 ${medName} 仍未确认，已同步通知紧急联系人 ${pt?.emergency_contact ?? ''} 协助督促。`,
                link_path: '/patient/medications',
              },
              `med:l2:${r.id}`,
            );
            if (st === 'failed') result.errors += 1;
            if (st === 'inserted') result.escalated += 1;
            // 【M1】L2 从"仅发短信"升级为"可处置"：有 ACTIVE 家属绑定时生成家属端待办任务
            const { data: bound } = await admin
              .from('care_relations')
              .select('id, family_name')
              .eq('patient_id', r.patient_id)
              .eq('status', 'ACTIVE')
              .limit(1);
            if (bound && bound.length) {
              await admin.from('alerts').insert({
                patient_id: r.patient_id,
                source: 'medication',
                level: 'yellow',
                detail: `【待家属协助】${pt?.name ?? '患者'} ${slotLabel} 的 ${medName} 超过 30 分钟未确认，请协助确认服药或联系患者。`,
                status: 'open',
                assignee_role: 'family',
              });
              result.alerts_created += 1;
            }
          }
        } else {
          // 无家属 → 自动跳级 L3
          const { data: upd } = await admin
            .from('reminders')
            .update({ escalation_level: 3, status: 'escalated', next_action_at: in30.toISOString() })
            .eq('id', r.id)
            .in('status', ['sent', 'escalated'])
            .select('id');
          if (upd && upd.length) {
            await admin.from('alerts').insert({
              patient_id: r.patient_id,
              source: 'medication',
              level: 'yellow',
              detail: `用药提醒多次未确认（${pt?.name ?? '患者'}，${slotLabel} ${medName}），未登记紧急联系人自动升级至 L3，请护士站电话介入。`,
              status: 'open',
            });
            const st = await insertMessageOnce(
              admin,
              {
                patient_id: r.patient_id,
                type: 'escalation',
                title: '漏服提醒升级 · 护士站介入',
                content: `您 ${slotLabel} 的 ${medName} 长时间未确认，护士站已收到预警并可能电话联系您。`,
                link_path: '/patient/messages',
              },
              `med:l3:${r.id}`,
            );
            if (st === 'failed') result.errors += 1;
            if (st === 'inserted') result.escalated += 1;
            result.alerts_created += 1;
          }
        }
        continue;
      }

      if (nextLevel >= 3 && r.escalation_level < 3) {
        // L2 → L3：终态，生成护士站黄色预警
        const { data: patient } = await admin
          .from('patients')
          .select('name')
          .eq('id', r.patient_id)
          .single();
        const pt = patient as unknown as { name: string } | null;
        const { data: upd } = await admin
          .from('reminders')
          .update({ escalation_level: 3, status: 'escalated' })
          .eq('id', r.id)
          .in('status', ['sent', 'escalated'])
          .select('id');
        if (upd && upd.length) {
          await admin.from('alerts').insert({
            patient_id: r.patient_id,
            source: 'medication',
            level: 'yellow',
              detail: `用药提醒 L3 升级（${pt?.name ?? '患者'}，${slotLabel} ${medName}），30 分钟内未确认，请电话介入并录入处置结论。`,
              status: 'open',
            });
            const st = await insertMessageOnce(
              admin,
              {
                patient_id: r.patient_id,
                type: 'escalation',
                title: '漏服提醒升级 · 护士站介入',
                content: `您 ${slotLabel} 的 ${medName} 长时间未确认，护士站已收到预警并可能电话联系您。`,
                link_path: '/patient/messages',
              },
              `med:l3:${r.id}`,
            );
            if (st === 'failed') result.errors += 1;
            if (st === 'inserted') result.escalated += 1;
            result.alerts_created += 1;
        }
        continue;
      }
    } catch {
      result.errors += 1;
    }
  }

  return jsonResponse({ ok: true, ...result });
});

export {};
