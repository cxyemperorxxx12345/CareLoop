// CareLoop 出院小结解析：多模态提取用药/随访/诊断，结果回写 documents.parsed_json
import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { getAdminClient, getAuthUser } from '../_shared/supabase.ts';
import { callMiniMaxJson, extractContent, extractJsonObject } from '../_shared/minimax.ts';

const EXTRACTION_PROMPT = `你是一名出院小结结构化助手。请阅读这张出院小结图片，提取以下信息并仅以 JSON 输出（不要输出任何其他文字）：
{
  "diagnosis": "出院诊断（字符串，多条用；分隔）",
  "medications": [
    { "name": "药品通用名", "spec": "规格如 0.25g*24片", "dosage": "单次剂量如 0.5g", "frequency": "频次如 每日三次", "slots": [0,1,2] }
  ],
  "followups": [
    { "title": "随访事项", "due_date": "YYYY-MM-DD", "category": "复查/换药/拆线/复诊", "detail": "补充说明" }
  ],
  "instructions": "出院医嘱与注意事项（字符串）"
}
slots 取值约定：0=早8点 1=中午12点 2=晚18点 3=睡前21点，根据每日服药时间推断。
若某项信息图片中确实没有，给空数组或空字符串。due_date 无法判断时给空字符串。`;

interface ParsedDoc {
  diagnosis?: string;
  medications?: Array<Record<string, unknown>>;
  followups?: Array<Record<string, unknown>>;
  instructions?: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return errorResponse('Method Not Allowed', 405);

  const user = await getAuthUser(req);
  if (!user) return errorResponse('请先登录', 401);

  let body: { document_id?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse('请求体必须是 JSON');
  }
  const documentId = body.document_id ?? '';
  if (!documentId) return errorResponse('缺少 document_id');

  const admin = getAdminClient();

  // 文档归属校验：仅患者本人或医护可触发解析
  const { data: doc, error: docErr } = await admin
    .from('documents')
    .select('id, patient_id, file_url, status, patients(profile_id)')
    .eq('id', documentId)
    .single();
  if (docErr || !doc) return errorResponse('文档不存在', 404);

  const docRow = doc as unknown as { id: string; patient_id: string; file_url: string; patients: { profile_id: string | null } | null };
  const { data: myProfile } = await admin.from('profiles').select('id, role').eq('id', user.id).single();
  const isOwner = docRow.patients?.profile_id === user.id;
  const isClinician = (myProfile as { role?: string } | null)?.role === 'clinician';
  if (!isOwner && !isClinician) return errorResponse('无权操作该文档', 403);

  // 进入解析状态
  await admin.from('documents').update({ status: 'parsing', error_message: null }).eq('id', documentId);

  const imageUrl = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/documents/${docRow.file_url}`;

  let parsed: ParsedDoc | null = null;
  let lastError = '';
  for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
    try {
      const data = await callMiniMaxJson([
        { role: 'system', content: EXTRACTION_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: '请结构化这张出院小结图片。' },
            { type: 'image_url', image_url: { url: imageUrl, detail: 'default' } },
          ],
        },
      ], { maxCompletionTokens: 8192 });
      const obj = extractJsonObject(extractContent(data));
      parsed = {
        diagnosis: String(obj.diagnosis ?? ''),
        medications: Array.isArray(obj.medications) ? obj.medications as Array<Record<string, unknown>> : [],
        followups: Array.isArray(obj.followups) ? obj.followups as Array<Record<string, unknown>> : [],
        instructions: String(obj.instructions ?? ''),
      };
    } catch (e) {
      lastError = (e as Error).message;
    }
  }

  if (!parsed) {
    await admin
      .from('documents')
      .update({ status: 'failed', error_message: lastError || '解析失败' })
      .eq('id', documentId);
    return errorResponse(`出院小结解析失败：${lastError}`, 502);
  }

  const { error: upErr } = await admin
    .from('documents')
    .update({ status: 'parsed', parsed_json: parsed, error_message: null })
    .eq('id', documentId);
  if (upErr) return errorResponse('回写解析结果失败', 500);

  return jsonResponse({ ok: true, document_id: documentId, parsed_json: parsed });
});

export {};
