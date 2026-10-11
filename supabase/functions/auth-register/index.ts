// CareLoop 注册：用户名+密码 + 角色选择（患者/医护）
// 走 service-role 原子建号：auth.users + profiles + 患者档案一次完成
import { handleOptions, jsonResponse, errorResponse, corsHeaders } from '../_shared/cors.ts';
import { getAdminClient } from '../_shared/supabase.ts';

Deno.serve(async (req: Request): Promise<Response> => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return errorResponse('Method Not Allowed', 405);

  let body: {
    username?: string;
    password?: string;
    full_name?: string;
    role?: string;
    phone?: string;
  };
  try {
    body = await req.json();
  } catch {
    return errorResponse('请求体必须是 JSON');
  }

  const username = (body.username ?? '').trim();
  const password = body.password ?? '';
  const fullName = (body.full_name ?? '').trim();
  const role = body.role ?? 'patient';
  const phone = (body.phone ?? '').trim();

  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return errorResponse('用户名需为 3-20 位字母、数字或下划线');
  }
  if (password.length < 6) {
    return errorResponse('密码长度至少 6 位');
  }
  if (!fullName) {
    return errorResponse('请填写真实姓名');
  }
  if (role !== 'patient' && role !== 'clinician') {
    return errorResponse('角色不合法');
  }

  const admin = getAdminClient();
  const email = `${username.toLowerCase()}@miaoda.com`;

  // 幂等保护：同用户名重复注册直接拒绝
  const { data: existing } = await admin
    .from('profiles')
    .select('id')
    .eq('username', username)
    .maybeSingle();
  if (existing) {
    return errorResponse('该用户名已被注册', 409);
  }

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, role },
  });
  if (createErr || !created.user) {
    const msg = createErr?.message ?? '创建账号失败';
    return errorResponse(msg.includes('already') ? '该用户名已被注册' : msg, 400);
  }

  const userId = created.user.id;

  // 补齐 profiles 角色档案（触发器已建行，这里原子更新）
  const { error: profileErr } = await admin
    .from('profiles')
    .update({ username, full_name: fullName, role: role as 'patient' | 'clinician', phone: phone || null })
    .eq('id', userId);
  if (profileErr) {
    return errorResponse('初始化角色档案失败', 500);
  }

  // 患者角色自动建立患者档案（出院日期默认今天，可在端内修改）
  if (role === 'patient') {
    const { error: patientErr } = await admin.from('patients').insert({
      profile_id: userId,
      name: fullName,
      phone: phone || null,
      discharge_date: new Date().toISOString().slice(0, 10),
    });
    if (patientErr) {
      return errorResponse('初始化患者档案失败', 500);
    }
  }

  return jsonResponse({ ok: true, email, role });
});

export {};
