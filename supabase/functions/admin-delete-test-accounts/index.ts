// ============================================================================
// 【运维一次性工具 · 禁止从前端调用】admin-delete-test-accounts
//
// 用途：彻底销毁两个零业务数据的测试账号（auth.users + auth.identities 登录凭证、
//       public.profiles、public.patients）。
//
// 安全约定：
//   1. 目标账号硬编码在 WHITELIST 常量里，绝不接受请求参数传入——防止被篡改成
//      任意 uuid 从而误删主演示账号（guifang / jianguo / chenming / doctor_wang）。
//   2. 需要「双锁」同时满足才会真正删除：
//        锁一：请求体 confirm === 'DELETE_TEST_ACCOUNTS_CONFIRMED'
//        锁二：请求头 x-cleanup-token === 环境变量 CLEANUP_CONFIRM_TOKEN
//   3. 删除前逐个账号复核 9 张业务表的关联行数，任一张 > 0 即整体跳过该账号。
//   4. 支持 dry_run=true 只复核不删除，建议先跑一遍确认 businessCounts 全为 0。
//   5. 严禁任何无差别批量删除；本函数只循环 WHITELIST 里写死的两个账号。
//
// 调用方式（运维本地 curl，不要写进前端代码）：
//   复核：curl -X POST <FUNCTIONS_URL>/admin-delete-test-accounts \
//           -H 'Content-Type: application/json' \
//           -H "x-cleanup-token: $CLEANUP_CONFIRM_TOKEN" \
//           -d '{"confirm":"DELETE_TEST_ACCOUNTS_CONFIRMED","dry_run":true}'
//   真删：同上，把 dry_run 改成 false（或去掉该字段）
//
// 注意：_shared/cors.ts 的 Allow-Headers 未包含 x-cleanup-token，
//       浏览器预检会被拦（这正是我们想要的：它不该从浏览器调用）。curl 不受影响。
//
// 用完即焚：本函数属一次性运维工具，清理完成后应立即从 supabase/functions 目录
//           删除并重新部署（下线），不要长期留在生产环境。
// ============================================================================
import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { getAdminClient } from '../_shared/supabase.ts';

/** confirm 哨兵值：请求体必须严格等于它 */
const CONFIRM_SENTINEL = 'DELETE_TEST_ACCOUNTS_CONFIRMED';

/**
 * 硬编码白名单：只允许销毁这两个零业务数据的测试账号。
 * userId = auth.users.id = profiles.id；email 仅供报告可读性核对。
 */
const WHITELIST: ReadonlyArray<{ email: string; userId: string }> = [
  { email: 'cxyemperorxxx12345@miaoda.com', userId: 'de040a1d-be8a-4246-9c5e-b313095719e4' },
  { email: 'taocan2008@miaoda.com', userId: '890f5e83-8ba9-44f9-b3a5-fcc76ff0161e' },
];

/**
 * 删除前复核的业务表（以迁移 00001_careloop_schema_initial.sql / 00005 的真实表名为准）。
 * 注意：symptoms → symptom_checks，followups → followup_items，均按 patient_id 关联。
 */
const BUSINESS_TABLES = [
  'checkins',
  'medication_plans',
  'medication_logs',
  'symptom_checks',
  'alerts',
  'messages',
  'followup_items',
  'reports',
  'care_relations',
] as const;

interface ReportItem {
  email: string;
  userId: string;
  patientId: string | null;
  businessCounts: Record<string, number>;
  authDeleted: boolean;
  profileDeleted: boolean;
  patientDeleted: boolean;
  skipped: string | null;
  error: string | null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  // 1. CORS 预检短路
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  // 2. 只接受 POST
  if (req.method !== 'POST') return errorResponse('Method Not Allowed', 405);

  // 3. 解析请求体（只取 confirm 与 dry_run，目标账号绝不从请求里读）
  let body: { confirm?: unknown; dry_run?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse('请求体不是合法 JSON', 400);
  }

  // 4. 【锁一】confirm 哨兵校验
  if (body.confirm !== CONFIRM_SENTINEL) {
    return errorResponse('confirm 参数缺失或不匹配，已拒绝执行', 400);
  }

  // 5. 【锁二】运维令牌校验：环境变量必须存在，且请求头与之相等
  const token = Deno.env.get('CLEANUP_CONFIRM_TOKEN') ?? '';
  if (!token) return errorResponse('服务端未配置 CLEANUP_CONFIRM_TOKEN，已拒绝执行', 401);
  if (req.headers.get('x-cleanup-token') !== token) {
    return errorResponse('x-cleanup-token 校验失败，已拒绝执行', 401);
  }

  const dryRun = body.dry_run === true;
  const admin = getAdminClient();
  const report: ReportItem[] = [];

  // 6. 逐个白名单账号处理（串行，便于看清每一步结果）
  for (const target of WHITELIST) {
    const item: ReportItem = {
      email: target.email,
      userId: target.userId,
      patientId: null,
      businessCounts: {},
      authDeleted: false,
      profileDeleted: false,
      patientDeleted: false,
      skipped: null,
      error: null,
    };

    try {
      // (a) 取 patients.id
      const { data: patientRows, error: patientErr } = await admin
        .from('patients')
        .select('id')
        .eq('profile_id', target.userId);
      if (patientErr) throw new Error(`查询 patients 失败：${patientErr.message}`);

      const patientIds = (patientRows ?? []).map((r) => (r as { id: string }).id);
      item.patientId = patientIds[0] ?? null;

      // (a) 复核 9 张业务表（患者有多条档案时按全部 patient_id 统计）
      for (const table of BUSINESS_TABLES) {
        let total = 0;
        for (const pid of patientIds) {
          const { count, error: countErr } = await admin
            .from(table)
            .select('id', { count: 'exact', head: true })
            .eq('patient_id', pid);
          if (countErr) throw new Error(`统计 ${table} 失败：${countErr.message}`);
          total += count ?? 0;
        }
        item.businessCounts[table] = total;
      }

      const hasBusinessData = Object.values(item.businessCounts).some((n) => n > 0);
      if (hasBusinessData) {
        // 存在业务数据 → 跳过该账号，不做任何删除
        item.skipped = '存在业务数据';
        report.push(item);
        continue;
      }

      // (dry_run) 只复核：到此为止，不删任何东西
      if (dryRun) {
        item.skipped = 'dry_run 仅复核，未执行删除';
        report.push(item);
        continue;
      }

      // (b) auth admin 真删：彻底销毁 auth.users 与 auth.identities 中的登录凭证
      const { error: authErr } = await admin.auth.admin.deleteUser(target.userId);
      if (authErr) item.error = `deleteUser 失败：${authErr.message}`;
      item.authDeleted = !authErr;

      // (c) 删除 public.profiles
      const { error: profileErr } = await admin.from('profiles').delete().eq('id', target.userId);
      if (profileErr) item.error = `${item.error ?? ''} profiles 删除失败：${profileErr.message}`.trim();
      item.profileDeleted = !profileErr;

      // (d) 删除 public.patients
      const { error: delPatientErr } = await admin.from('patients').delete().eq('profile_id', target.userId);
      if (delPatientErr) item.error = `${item.error ?? ''} patients 删除失败：${delPatientErr.message}`.trim();
      item.patientDeleted = !delPatientErr;
    } catch (e) {
      item.error = e instanceof Error ? e.message : String(e);
    }

    report.push(item);
  }

  return jsonResponse({ ok: true, dryRun, report });
});

export {};
