// CareLoop 前端数据访问层：所有 Supabase 查询与 Edge Function 调用统一入口
import { supabase } from '@/db/supabase';
import type { CareRiskRaw } from '@/lib/carerisk';
import type { ReminderAdaptRaw } from '@/lib/reminder-adapt';

// ===== 通用工具 =====

export function toArray<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

// 知识库文本归一化：把写入链路中被转义成「字面反斜杠 + n」的换行还原为真实换行符。
// 用于 knowledge_docs 的 title / content，写入前与读取后都会调用，保证存量脏数据也能正确显示换行。
export function normalizeKnowledgeText(input: string): string {
  if (typeof input !== 'string') return '';
  return input
    // 先处理字面 \r\n（反斜杠 r + 反斜杠 n），再处理字面 \n，顺序不能反
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    // 真实 CRLF 与单独的 CR 统一成 LF
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // 连续 3 个以上换行压缩为 2 个，避免清洗后出现大片空白
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function invokeFn<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    // functions.invoke 的错误详情在 error.context
    const ctx = (error as { context?: Response }).context;
    let detail = error.message;
    if (ctx && typeof ctx.text === 'function') {
      try {
        const t = await ctx.text();
        if (t) detail = t;
      } catch { /* 忽略读取失败 */ }
    }
    throw new Error(detail);
  }
  const payload = data as { error?: string } | null;
  if (payload && typeof payload === 'object' && payload.error) {
    throw new Error(payload.error);
  }
  return data as T;
}

// ===== 当前患者 =====

export async function getMyPatient() {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return null;
  const { data } = await supabase
    .from('patients')
    .select('*')
    .eq('profile_id', uid)
    .maybeSingle();
  return data;
}

// ===== 家属照护对象（ACTIVE 绑定的患者，家属端数据入口）=====

export interface FamilyPatient {
  patient: { id: string; name: string; gender: string | null; discharge_date: string; risk_level: string | null };
  family_name: string;
  relation: string;
}

export async function getFamilyPatient(): Promise<FamilyPatient | null> {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return null;
  const { data } = await supabase
    .from('care_relations')
    .select('family_name, relation, patients(id, name, gender, discharge_date, risk_level)')
    .eq('family_user_id', uid)
    .eq('status', 'ACTIVE')
    .order('is_primary', { ascending: false })
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as {
    family_name: string;
    relation: string;
    patients: FamilyPatient['patient'] | null;
  };
  if (!row.patients) return null;
  return { patient: row.patients, family_name: row.family_name, relation: row.relation };
}

// ===== 患者端 API =====

export const patientApi = {
  async dashboard(patientId: string) {
    const today = new Date().toISOString().slice(0, 10);
    const [plans, logs, followups, checkins, reminders] = await Promise.all([
      supabase.from('medication_plans').select('*').eq('patient_id', patientId).eq('active', true),
      supabase.from('medication_logs').select('*').eq('patient_id', patientId).eq('log_date', today),
      supabase.from('followup_items').select('*').eq('patient_id', patientId).order('due_date', { ascending: true }).limit(5),
      supabase.from('checkins').select('*').eq('patient_id', patientId).order('created_at', { ascending: false }).limit(1),
      supabase.from('reminders').select('*').eq('patient_id', patientId).eq('remind_date', today),
    ]);
    return {
      plans: toArray(plans.data),
      todayLogs: toArray(logs.data),
      followups: toArray(followups.data),
      latestCheckin: checkins.data ?? null,
      todayReminders: toArray(reminders.data),
    };
  },

  async documents(patientId: string) {
    const { data } = await supabase
      .from('documents')
      .select('*')
      .eq('patient_id', patientId)
      .order('created_at', { ascending: false });
    return toArray(data);
  },

  async medicationDetail(patientId: string) {
    const today = new Date().toISOString().slice(0, 10);
    const [plans, logs, reminders] = await Promise.all([
      supabase.from('medication_plans').select('*').eq('patient_id', patientId).eq('active', true),
      supabase.from('medication_logs').select('*').eq('patient_id', patientId).eq('log_date', today),
      supabase.from('reminders').select('*').eq('patient_id', patientId).eq('remind_date', today),
    ]);
    return { plans: toArray(plans.data), todayLogs: toArray(logs.data), todayReminders: toArray(reminders.data) };
  },

  async followupItems(patientId: string) {
    const { data } = await supabase
      .from('followup_items')
      .select('*')
      .eq('patient_id', patientId)
      .order('due_date', { ascending: true });
    return toArray(data);
  },

  async checkinHistory(patientId: string, days = 14) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    const { data } = await supabase
      .from('checkins')
      .select('*')
      .eq('patient_id', patientId)
      .gte('created_at', since)
      .order('created_at', { ascending: true });
    return toArray(data);
  },

  async messages(patientId: string) {
    const { data } = await supabase
      .from('messages')
      .select('*')
      .eq('patient_id', patientId)
      .order('created_at', { ascending: false })
      .limit(50);
    return toArray(data);
  },

  async unreadCount(patientId: string) {
    const { count } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('patient_id', patientId)
      .eq('read', false);
    return count ?? 0;
  },

  async markMessageRead(id: string) {
    await supabase.from('messages').update({ read: true }).eq('id', id);
  },

  // 一键已读：将某患者全部未读消息标记为已读，返回更新条数
  async markAllMessagesRead(patientId: string) {
    const { data, error } = await supabase
      .from('messages')
      .update({ read: true })
      .eq('patient_id', patientId)
      .eq('read', false)
      .select('id');
    if (error) throw new Error(error.message);
    return Array.isArray(data) ? data.length : 0;
  },

  async symptomHistory(patientId: string) {
    const { data } = await supabase
      .from('symptom_checks')
      .select('*')
      .eq('patient_id', patientId)
      .order('created_at', { ascending: false })
      .limit(10);
    return toArray(data);
  },
};

// ===== 医护端 API =====

export const clinicianApi = {
  async patients(filters?: { name?: string; diagnosis?: string; risk?: string; department?: string }) {
    // 软隐藏：过滤掉演示期残留的测试档案（is_hidden），不删除任何账号
    let q = supabase.from('patients').select('*').eq('is_hidden', false).order('discharge_date', { ascending: false });
    if (filters?.name) q = q.ilike('name', `%${filters.name}%`);
    if (filters?.diagnosis) q = q.ilike('diagnosis', `%${filters.diagnosis}%`);
    if (filters?.risk && filters.risk !== 'all') q = q.eq('risk_level', filters.risk);
    if (filters?.department) q = q.eq('department', filters.department);
    const { data } = await q.limit(200);
    return toArray(data);
  },

  async patientDetail(patientId: string) {
    const since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const since7 = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const today = new Date().toISOString().slice(0, 10);
    const [patient, plans, logs7, followups, checkins30, symptoms, alerts, documents] = await Promise.all([
      supabase.from('patients').select('*').eq('id', patientId).maybeSingle(),
      supabase.from('medication_plans').select('*').eq('patient_id', patientId).eq('active', true),
      supabase.from('medication_logs').select('*').eq('patient_id', patientId).gte('log_date', since7.slice(0, 10)),
      supabase.from('followup_items').select('*').eq('patient_id', patientId).order('due_date', { ascending: true }),
      supabase.from('checkins').select('*').eq('patient_id', patientId).gte('created_at', since30).order('created_at', { ascending: true }),
      supabase.from('symptom_checks').select('*').eq('patient_id', patientId).order('created_at', { ascending: false }).limit(10),
      supabase.from('alerts').select('*').eq('patient_id', patientId).order('created_at', { ascending: false }).limit(20),
      supabase.from('documents').select('*').eq('patient_id', patientId).order('created_at', { ascending: false }).limit(5),
    ]);
    return {
      patient: patient.data ?? null,
      plans: toArray(plans.data),
      logs7: toArray(logs7.data),
      followups: toArray(followups.data),
      checkins30: toArray(checkins30.data),
      symptoms: toArray(symptoms.data),
      alerts: toArray(alerts.data),
      documents: toArray(documents.data),
    };
  },

  async alerts(status?: string) {
    let q = supabase
      .from('alerts')
      .select('*, patients(name, department, diagnosis)')
      .order('created_at', { ascending: false })
      .limit(100);
    if (status && status !== 'all') q = q.eq('status', status);
    const { data } = await q;
    return toArray(data);
  },

  async resolveAlert(id: string, action: string, resolutionNote: string, handledBy: string) {
    await supabase
      .from('alerts')
      .update({ status: 'resolved', action, resolution_note: resolutionNote, handled_by: handledBy, handled_at: new Date().toISOString() })
      .eq('id', id);
  },

  async reports(patientId?: string) {
    let q = supabase
      .from('reports')
      .select('*, patients(name, diagnosis)')
      .order('created_at', { ascending: false })
      .limit(50);
    if (patientId) q = q.eq('patient_id', patientId);
    const { data } = await q;
    return toArray(data);
  },

  async archiveReport(id: string, clinicianNote?: string) {
    await supabase
      .from('reports')
      .update({ status: 'archived', clinician_note: clinicianNote ?? null })
      .eq('id', id);
  },

  async knowledge(keyword?: string) {
    let q = supabase.from('knowledge_docs').select('*').order('created_at', { ascending: false }).limit(100);
    if (keyword) q = q.or(`title.ilike.%${keyword}%,content.ilike.%${keyword}%`);
    const { data } = await q;
    // 读取端防御性归一化：存量数据可能仍含字面 \n，返回前统一还原为真实换行
    return toArray<{ title?: string; content?: string }>(data).map((row) => ({
      ...row,
      title: normalizeKnowledgeText(row.title ?? ''),
      content: normalizeKnowledgeText(row.content ?? ''),
    }));
  },

  async saveKnowledge(doc: { id?: string; title: string; category: string; content: string }) {
    const title = normalizeKnowledgeText(doc.title);
    const content = normalizeKnowledgeText(doc.content);
    if (doc.id) {
      await supabase.from('knowledge_docs').update({ title, category: doc.category, content }).eq('id', doc.id);
      return doc.id;
    }
    const { data } = await supabase.from('knowledge_docs').insert({ title, category: doc.category, content }).select('id').single();
    return (data as { id: string } | null)?.id ?? '';
  },

  async deleteKnowledge(id: string) {
    await supabase.from('knowledge_docs').delete().eq('id', id);
  },
};

// ===== Edge Function 快捷入口 =====

export const fnApi = {
  register: (body: Record<string, unknown>) => invokeFn<{ email: string }>('auth-register', body),
  parseDocument: (documentId: string) => invokeFn('parse-document', { document_id: documentId }),
  confirmPlan: (documentId: string, payload: Record<string, unknown>) => invokeFn('confirm-plan', { document_id: documentId, payload }),
  triage: (body: Record<string, unknown>) =>
    invokeFn<{
      level: 'green' | 'yellow' | 'red';
      advice: string;
      evidence: string;
      baseline: { available: boolean; metrics: BaselineMetric[] };
    }>('triage-symptom', body),
  generateReport: (patientId: string, periodDays: number) =>
    invokeFn<{ report_id: string; content: { stats: unknown; summary: string } }>('generate-report', { patient_id: patientId, period_days: periodDays }),
};

// 个体基线指标（机制①）：患者本人 7 天滚动中位数 + 偏离带上下界
export interface BaselineMetric {
  metric: string;
  median: number;
  bandLow: number;
  bandHigh: number;
}

// 读取患者个人基线；表不存在/无数据（迁移 00019 未应用或样本不足）时优雅降级返回空数组
export async function getBaselines(patientId: string): Promise<BaselineMetric[]> {
  const { data, error } = await supabase
    .from('daily_baseline')
    .select('metric, median, band_low, band_high')
    .eq('patient_id', patientId);
  if (error) return [];
  return (data ?? []).map((b) => ({
    metric: b.metric,
    median: Number(b.median),
    bandLow: Number(b.band_low),
    bandHigh: Number(b.band_high),
  }));
}

// ===== 机制② CareRisk 履约风险预测：原始轨迹输入 =====

// 读取患者近 windowDays 天的本人轨迹（用药/打卡/症状 + 出院日），供 computeCareRisk 使用。
// 表均为现有表，无需新增迁移；任意查询失败返回空结构，由调用方优雅降级。
export async function getCareRiskInputs(patientId: string, windowDays = 14): Promise<CareRiskRaw> {
  const sinceMs = Date.now() - windowDays * 86400000;
  const sinceIso = new Date(sinceMs).toISOString();
  const sinceDate = sinceIso.slice(0, 10);
  const [plans, logs, checkins, symptoms, patient] = await Promise.all([
    supabase.from('medication_plans').select('id, slots').eq('patient_id', patientId).eq('active', true),
    supabase.from('medication_logs').select('plan_id, slot, action, log_date').eq('patient_id', patientId).gte('log_date', sinceDate),
    supabase.from('checkins').select('created_at').eq('patient_id', patientId).gte('created_at', sinceIso),
    supabase.from('symptom_checks').select('level, created_at').eq('patient_id', patientId).gte('created_at', sinceIso),
    supabase.from('patients').select('discharge_date').eq('id', patientId).maybeSingle(),
  ]);
  const safe = <T>(d: unknown): T[] => (Array.isArray(d) ? (d as T[]) : []);
  return {
    plans: safe<{ id: string; slots: number[] | null }>(plans.data),
    logs: safe<{ plan_id: string; slot: number; action: string; log_date: string }>(logs.data),
    checkins: safe<{ created_at: string }>(checkins.data),
    symptoms: safe<{ level: string; created_at: string }>(symptoms.data),
    dischargeDate: (patient.data as { discharge_date?: string } | null)?.discharge_date ?? null,
  };
}

// ===== 机制③ 最小打扰自适应提醒：近 windowDays 天用药响应轨迹 =====
// 复用现有 medication_logs（按 slot 时段），无需新增迁移；查询失败返回空结构由调用方降级。
export async function getReminderAdaptInputs(patientId: string, windowDays = 14): Promise<ReminderAdaptRaw> {
  const sinceDate = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);
  const { data } = await supabase
    .from('medication_logs')
    .select('plan_id, slot, action, log_date')
    .eq('patient_id', patientId)
    .gte('log_date', sinceDate);
  return { logs: toArray<{ slot: number; action: string; log_date: string }>(data) };
}
