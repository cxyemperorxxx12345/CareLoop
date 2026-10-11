// CareLoop 症状分诊：红旗规则兜底 + MiniMax 综合分级，黄/红自动生成医护端预警
import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { getAdminClient, getUserClient, getAuthUser } from '../_shared/supabase.ts';
import { callMiniMaxJson, extractContent, extractJsonObject } from '../_shared/minimax.ts';

const RED_FLAG_KEYWORDS = ['胸痛', '胸闷', '气短', '呼吸困难', '意识不清', '咯血', '晕厥', '大汗淋漓'];

Deno.serve(async (req: Request): Promise<Response> => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return errorResponse('Method Not Allowed', 405);

  const user = await getAuthUser(req);
  if (!user) return errorResponse('请先登录', 401);

  let body: {
    chief_complaint?: string;
    duration?: string;
    severity?: number;
    accompanying?: string;
    temperature?: number | null;
    systolic?: number | null;
    diastolic?: number | null;
  };
  try {
    body = await req.json();
  } catch {
    return errorResponse('请求体必须是 JSON');
  }

  const chief = (body.chief_complaint ?? '').trim();
  if (!chief) return errorResponse('请描述主要症状');
  const accompanying = (body.accompanying ?? '').trim();
  const severity = Math.min(10, Math.max(1, Number(body.severity ?? 5)));
  const temperature = body.temperature ?? null;
  const systolic = body.systolic ?? null;

  const admin = getAdminClient();
  const { data: patient } = await admin
    .from('patients')
    .select('id, name, diagnosis, history, allergy, risk_level')
    .eq('profile_id', user.id)
    .maybeSingle();
  if (!patient) return errorResponse('未找到患者档案', 404);
  const p = patient as unknown as {
    id: string;
    name: string;
    diagnosis: string | null;
    history: string | null;
    allergy: string | null;
    risk_level: string;
  };

  // ===== 第一步：红旗规则兜底 =====
  const combined = `${chief} ${accompanying}`;
  const hitKeyword = RED_FLAG_KEYWORDS.find((k) => combined.includes(k));
  const feverRed = temperature !== null && temperature >= 39;
  const bpRed = systolic !== null && systolic >= 180;
  const ruleRed = Boolean(hitKeyword) || feverRed || bpRed;

  let level: 'green' | 'yellow' | 'red' = ruleRed ? 'red' : 'green';
  let advice = '';
  let evidence = '';

  if (ruleRed) {
    const reasons: string[] = [];
    if (hitKeyword) reasons.push(`命中红旗关键词「${hitKeyword}」`);
    if (feverRed) reasons.push(`体温 ${temperature}℃ ≥ 39℃`);
    if (bpRed) reasons.push(`收缩压 ${systolic}mmHg ≥ 180mmHg`);
    evidence = `红旗规则：${reasons.join('；')}`;
    advice =
      '【红色预警】您的症状存在高风险信号，请立即就医或拨打 120，不要自行观察等待。' +
      '本平台已同步通知您的责任医护与紧急联系人。';
  } else {
    // ===== 第二步：MiniMax 综合分级 =====
    const context = [
      `患者：${p.name}`,
      `出院诊断：${p.diagnosis ?? '未知'}`,
      `既往史：${p.history ?? '无记录'}`,
      `过敏史：${p.allergy ?? '无记录'}`,
    ].join('\n');
    try {
      const data = await callMiniMaxJson([
        {
          role: 'system',
          content:
            '你是出院患者症状分诊助手。结合患者出院资料与当前症状，按三级输出分级：green=居家观察、yellow=建议24小时内联系随访、red=立即就医。' +
            '仅以 JSON 输出：{"level":"green|yellow|red","advice":"给患者的具体建议（80字内）","evidence":"分级依据（60字内）"}。' +
            '不得做出确诊，只能给分级建议；拿不准时从严判 yellow。',
        },
        {
          role: 'user',
          content:
            `${context}\n\n当前症状：${chief}\n持续时长：${body.duration ?? '未填写'}\n严重度(1-10)：${severity}\n` +
            `伴随症状：${accompanying || '无'}\n体温：${temperature ?? '未测'}℃\n收缩压：${systolic ?? '未测'}mmHg`,
        },
      ], { maxCompletionTokens: 2048, temperature: 0.3 });
      const obj = extractJsonObject(extractContent(data));
      const lv = String(obj.level ?? 'yellow');
      level = lv === 'red' ? 'red' : lv === 'green' ? 'green' : 'yellow';
      advice = String(obj.advice ?? '');
      evidence = String(obj.evidence ?? '');
    } catch {
      // 模型不可用时按症状严重度兜底
      level = severity >= 7 ? 'yellow' : 'green';
      advice = level === 'yellow' ? '症状较明显，建议 24 小时内联系随访医护评估。' : '症状较轻，请按计划居家观察并继续打卡记录。';
      evidence = '系统兜底分级（AI 暂不可用）';
    }
  }

  if (level === 'red') {
    advice = advice.includes('立即就医') ? advice : `【红色预警】${advice} 请立即前往急诊或拨打 120。`;
  }

  // ===== 第三步：落库 =====
  const { data: inserted, error: insErr } = await admin
    .from('symptom_checks')
    .insert({
      patient_id: p.id,
      chief_complaint: chief,
      duration: body.duration ?? null,
      severity,
      accompanying: accompanying || null,
      level,
      advice,
      evidence,
    })
    .select('id')
    .single();
  if (insErr) return errorResponse('保存分诊记录失败', 500);
  const checkId = (inserted as { id: string }).id;

  // 黄/红：生成医护端预警 + 患者消息（alert_level 枚举仅 yellow/red）
  if (level !== 'green') {
    const flagTitle = level === 'red' ? '红旗症状预警' : '黄色分诊预警';
    const { error: alertErr } = await admin.from('alerts').insert({
      patient_id: p.id,
      source: 'triage',
      level,
      detail: `${flagTitle}：${p.name} 主诉「${chief}」，严重度 ${severity}/10。依据：${evidence}。建议：${advice}`,
      status: 'open',
    });
    // dedup_key 与本次分诊记录绑定：同一次 symptom_check 只产生一条患者消息
    const { error: msgErr } = await admin.from('messages').insert({
      patient_id: p.id,
      type: 'triage',
      title: flagTitle,
      content: advice,
      link_path: '/patient/messages',
      dedup_key: `triage:${checkId}`,
    });
    if (msgErr && msgErr.code !== '23505') {
      console.error('[triage-symptom] 写入消息失败', msgErr.message);
    }
    if (alertErr) return errorResponse('生成预警失败', 500);

    // 风险等级升级（只升不降）
    const rank = { green: 0, yellow: 1, red: 2 } as const;
    if (rank[level as 'yellow' | 'red'] > rank[(p.risk_level as keyof typeof rank) ?? 'green']) {
      await admin.from('patients').update({ risk_level: level }).eq('id', p.id);
    }
  }

  return jsonResponse({ ok: true, level, advice, evidence, symptom_check_id: checkId });
});

export {};
