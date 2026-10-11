// CareLoop 随访报告：医护触发，聚合依从率/体征/症状/预警 + MiniMax 生成小结
import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { getAdminClient, getUserClient, getAuthUser } from '../_shared/supabase.ts';
import { callMiniMaxJson, extractContent, extractJsonObject } from '../_shared/minimax.ts';

Deno.serve(async (req: Request): Promise<Response> => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return errorResponse('Method Not Allowed', 405);

  const user = await getAuthUser(req);
  if (!user) return errorResponse('请先登录', 401);

  // 仅医护可生成报告
  const userClient = getUserClient(req);
  const { data: isClinician } = await userClient.rpc('is_clinician');
  if (!isClinician) return errorResponse('仅医护人员可生成随访报告', 403);

  let body: { patient_id?: string; period_days?: number };
  try {
    body = await req.json();
  } catch {
    return errorResponse('请求体必须是 JSON');
  }
  const patientId = body.patient_id ?? '';
  const periodDays = body.period_days === 14 ? 14 : body.period_days === 30 ? 30 : 7;
  if (!patientId) return errorResponse('缺少 patient_id');

  const admin = getAdminClient();
  const { data: patient } = await admin
    .from('patients')
    .select('id, name, diagnosis, discharge_date')
    .eq('id', patientId)
    .maybeSingle();
  if (!patient) return errorResponse('患者不存在', 404);
  const p = patient as unknown as { id: string; name: string; diagnosis: string | null; discharge_date: string };

  const startDate = new Date(Date.now() - periodDays * 24 * 3600 * 1000).toISOString().slice(0, 10);

  // ===== 聚合统计（数字全部以数据库为准，不信任模型生成） =====
  const { data: logs } = await admin
    .from('medication_logs')
    .select('action')
    .eq('patient_id', patientId)
    .gte('log_date', startDate);
  const logRows = (logs ?? []) as Array<{ action: string }>;
  const taken = logRows.filter((l) => l.action === 'taken').length;
  const skipped = logRows.filter((l) => l.action === 'skipped').length;
  const snoozed = logRows.filter((l) => l.action === 'snoozed').length;
  const answered = taken + skipped + snoozed;
  const complianceRate = answered ? Math.round((taken / answered) * 100) : 100;

  const { data: vitals } = await admin
    .from('checkins')
    .select('systolic, diastolic, heart_rate, temperature')
    .eq('patient_id', patientId)
    .gte('created_at', startDate);
  const vRows = (vitals ?? []) as Array<{ systolic: number | null; diastolic: number | null; heart_rate: number | null; temperature: number | null }>;
  const nums = (arr: Array<number | null>) => arr.filter((v): v is number => v !== null);
  const avg = (arr: number[]) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
  const vitalsSummary = {
    records: vRows.length,
    systolic_avg: avg(nums(vRows.map((v) => v.systolic))),
    diastolic_avg: avg(nums(vRows.map((v) => v.diastolic))),
    heart_rate_avg: avg(nums(vRows.map((v) => v.heart_rate))),
    temperature_max: vRows.length ? Math.max(...nums(vRows.map((v) => v.temperature ?? null)).map((v) => Number(v)), 0) : null,
  };

  const { data: symptoms } = await admin
    .from('symptom_checks')
    .select('chief_complaint, level, created_at')
    .eq('patient_id', patientId)
    .gte('created_at', startDate)
    .order('created_at', { ascending: false })
    .limit(5);
  const symptomRows = (symptoms ?? []) as Array<{ chief_complaint: string; level: string; created_at: string }>;

  const { data: alerts } = await admin
    .from('alerts')
    .select('level, status')
    .eq('patient_id', patientId)
    .gte('created_at', startDate);
  const alertRows = (alerts ?? []) as Array<{ level: string; status: string }>;

  const stats = {
    period_days: periodDays,
    period_start: startDate,
    adherence: { taken, skipped, snoozed, answered, compliance_rate: complianceRate },
    vitals: vitalsSummary,
    symptoms: symptomRows,
    alerts: {
      total: alertRows.length,
      open: alertRows.filter((a) => a.status === 'open').length,
      red: alertRows.filter((a) => a.level === 'red').length,
      yellow: alertRows.filter((a) => a.level === 'yellow').length,
    },
  };

  // ===== MiniMax 生成随访小结 =====
  let summary = '';
  try {
    const data = await callMiniMaxJson([
      {
        role: 'system',
        content:
          '你是出院随访报告撰写助手。根据给定的真实统计数据，撰写一段 150 字内的中文随访小结（markdown 段落），' +
          '内容涵盖用药依从性、体征趋势、症状与预警提示，并给出下一步随访建议。' +
          '只输出 JSON：{"summary":"小结文本"}。不得编造数据之外的信息。',
      },
      {
        role: 'user',
        content:
          `患者：${p.name}，诊断：${p.diagnosis ?? '未知'}，出院日期：${p.discharge_date}，统计周期：近 ${periodDays} 天。\n` +
          `用药打卡：应打 ${stats.adherence.answered} 次，已服 ${taken}，跳过 ${skipped}，稍后 ${snoozed}，依从率 ${complianceRate}%。\n` +
          `体征记录 ${vitalsSummary.records} 条：血压均值 ${vitalsSummary.systolic_avg ?? '-'}/${vitalsSummary.diastolic_avg ?? '-'}mmHg，` +
          `心率均值 ${vitalsSummary.heart_rate_avg ?? '-'} 次/分，体温最高 ${vitalsSummary.temperature_max ?? '-'}℃。\n` +
          `症状自查 ${symptomRows.length} 次：${symptomRows.map((s) => `${s.chief_complaint}(${s.level})`).join('、') || '无'}。\n` +
          `预警事件 ${alertRows.length} 条（未处理 ${stats.alerts.open} 条）。`,
      },
    ], { maxCompletionTokens: 2048, temperature: 0.5 });
    summary = String(extractJsonObject(extractContent(data)).summary ?? '');
  } catch {
    summary = `近 ${periodDays} 天用药依从率 ${complianceRate}%，体征记录 ${vitalsSummary.records} 条，预警 ${alertRows.length} 条，建议按计划继续随访。`;
  }

  const { data: report, error: repErr } = await admin
    .from('reports')
    .insert({
      patient_id: patientId,
      period_days: periodDays,
      content: { stats, summary },
      status: 'draft',
      created_by: user.id,
    })
    .select('id')
    .single();
  if (repErr || !report) return errorResponse('保存报告失败', 500);

  return jsonResponse({ ok: true, report_id: (report as { id: string }).id, content: { stats, summary } });
});

export {};
