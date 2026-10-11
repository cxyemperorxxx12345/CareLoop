// CareLoop 计划确认：调用 RPC confirm_care_plan 原子生成用药计划+随访事项+医嘱
import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { getUserClient, getAuthUser } from '../_shared/supabase.ts';

Deno.serve(async (req: Request): Promise<Response> => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return errorResponse('Method Not Allowed', 405);

  const user = await getAuthUser(req);
  if (!user) return errorResponse('请先登录', 401);

  let body: { document_id?: string; payload?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return errorResponse('请求体必须是 JSON');
  }
  if (!body.document_id || !body.payload) return errorResponse('缺少 document_id 或 payload');

  const userClient = getUserClient(req);
  const { data, error } = await userClient.rpc('confirm_care_plan', {
    p_document_id: body.document_id,
    p_payload: body.payload,
  });
  if (error) return errorResponse(error.message, 400);

  return jsonResponse({ ok: true, result: data });
});

export {};
