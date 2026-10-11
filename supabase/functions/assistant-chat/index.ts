// CareLoop 智能问答：个人医嘱 + 知识库双路检索，MiniMax SSE 流式回答
import { handleOptions, jsonResponse, errorResponse, corsHeaders } from '../_shared/cors.ts';
import { getAdminClient, getAuthUser } from '../_shared/supabase.ts';
import { callMiniMaxStream } from '../_shared/minimax.ts';

// 从问题中提取关键词（≥2字）用于知识库模糊检索
function extractKeywords(question: string): string[] {
  const cleaned = question.replace(/[，。！？、,.!?？:：;；\s]/g, ' ');
  const tokens = cleaned.split(' ').filter((t) => t.length >= 2);
  if (tokens.length > 0) return tokens.slice(0, 4);
  // 无空格的中文整句：滑动 2-4 字窗口取子串
  const raw = question.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const kws: string[] = [];
  for (let len = 4; len >= 2 && kws.length < 4; len--) {
    for (let i = 0; i + len <= raw.length && kws.length < 4; i += len) {
      kws.push(raw.slice(i, i + len));
    }
  }
  return kws.slice(0, 4);
}

Deno.serve(async (req: Request): Promise<Response> => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return errorResponse('Method Not Allowed', 405);

  const user = await getAuthUser(req);
  if (!user) return errorResponse('请先登录', 401);

  let body: { question?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse('请求体必须是 JSON');
  }
  const question = (body.question ?? '').trim();
  if (!question) return errorResponse('请输入问题');

  const admin = getAdminClient();
  const { data: patient } = await admin
    .from('patients')
    .select('id, name, diagnosis, history, allergy, instructions')
    .eq('profile_id', user.id)
    .maybeSingle();
  if (!patient) return errorResponse('仅患者端可使用智能问答', 403);
  const p = patient as unknown as {
    id: string;
    name: string;
    diagnosis: string | null;
    history: string | null;
    allergy: string | null;
    instructions: string | null;
  };

  // 个人用药上下文
  const { data: plans } = await admin
    .from('medication_plans')
    .select('medicine_name, dosage, frequency, note')
    .eq('patient_id', p.id)
    .eq('active', true);
  const medLines = ((plans ?? []) as Array<{ medicine_name: string; dosage: string | null; frequency: string | null; note: string | null }>)
    .map((m) => `- ${m.medicine_name} ${m.dosage ?? ''} ${m.frequency ?? ''}${m.note ? `（${m.note}）` : ''}`)
    .join('\n');

  // 知识库检索：关键词 ilike，最多 3 条
  const keywords = extractKeywords(question);
  let knowledge: Array<{ title: string; category: string; content: string }> = [];
  if (keywords.length > 0) {
    const orFilter = keywords.map((k) => `title.ilike.%${k}%,content.ilike.%${k}%`).join(',');
    const { data: docs } = await admin
      .from('knowledge_docs')
      .select('title, category, content')
      .or(orFilter)
      .limit(3);
    knowledge = (docs ?? []) as typeof knowledge;
  }

  const personalBlock = [
    `【个人出院资料】`,
    `诊断：${p.diagnosis ?? '未知'}`,
    `过敏史：${p.allergy ?? '无'}`,
    `既往史：${p.history ?? '无'}`,
    `出院医嘱：${p.instructions ?? '无'}`,
    `当前用药：\n${medLines || '无'}`,
  ].join('\n');

  const kbBlock = knowledge.length
    ? `【知识库资料】\n${knowledge.map((k, i) => `[${i + 1}]《${k.title}》（${k.category}）\n${k.content}`).join('\n---\n')}`
    : '【知识库资料】无相关资料';

  const evidenceTags: string[] = [];
  if (p.instructions || medLines) evidenceTags.push('个人医嘱');
  if (knowledge.length) evidenceTags.push(`知识库《${knowledge[0].title}》`);

  const systemPrompt =
    '你是「愈见 CareLoop」出院患者照护助手，仅基于【个人出院资料】与【知识库资料】回答问题。规则：\n' +
    '1. 资料中有依据时，用通俗语言回答，并在结尾标注来源，格式：[依据: 类型]。\n' +
    '2. 资料中无依据时，明确说“现有资料无法回答”，并建议联系随访医护，不要编造。\n' +
    '3. 不做确诊、不调整用药剂量；涉及病情变化一律建议及时就医。\n' +
    '4. 回答控制在 200 字以内，语气温暖专业。\n' +
    (evidenceTags.length ? `本次可参考来源：${evidenceTags.join('、')}。` : '');

  const streamRes = await callMiniMaxStream([
    { role: 'system', content: `${systemPrompt}\n\n${personalBlock}\n\n${kbBlock}` },
    { role: 'user', content: `患者提问：${question}` },
  ]);

  // 透传 SSE；补充 CORS 头
  const headers = new Headers(streamRes.headers);
  for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
  return new Response(streamRes.body, { status: streamRes.status, headers });
});

export {};
