// CareLoop Edge Functions 共享 Supabase 客户端工厂
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

// service-role 客户端：仅用于 Edge Function 服务端可信操作
export function getAdminClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('服务端配置缺失');
  return createClient(url, key);
}

// 携带调用者 JWT 的客户端：RLS 按真实用户身份生效
export function getUserClient(req: Request): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !key) throw new Error('服务端配置缺失');
  return createClient(url, key, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
}

// 解析调用者身份；未登录返回 null
export async function getAuthUser(req: Request) {
  const userClient = getUserClient(req);
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}
