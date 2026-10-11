-- ============================================================================
-- 【危险 · 人工执行 · 不可回滚】清理两个零业务数据的测试账号
--
-- 执行者：项目运维 / 负责人（需人工确认后手动在 SQL Editor 或 psql 中执行）
-- 文件位置：supabase/ops/purge_test_accounts.sql（刻意不放 migrations，避免被自动应用）
--
-- 执行前提（必须逐条确认）：
--   1. 已用 SQL 严格核实下面两个 uuid 对应的账号为明确测试名，且 9 张业务表
--      （checkins / medication_plans / medication_logs / symptom_checks / alerts /
--       messages / followup_items / reports / care_relations）关联数据量全部为 0。
--   2. 已确认这两个账号不是主演示账号 guifang / jianguo / chenming / doctor_wang。
--   3. 已备份或确认无需备份（本脚本无回滚方案）。
--   4. 建议先在 Supabase Dashboard 用只读查询单独跑一遍「第 1 步 复核」，确认
--      total_business_rows 均为 0，再执行删除段。
--
-- 回滚方式：无。auth.users 一旦删除，登录凭证与 auth.identities 即被级联清理，
--           不可恢复。请先确认再执行。
--
-- 安全边界：本脚本只针对下面写死的两个 uuid，无任何无差别批量 DELETE，
--           不触碰其他任何账号的数据。
--
-- 目标账号：
--   陈总  cxyemperorxxx12345@miaoda.com  de040a1d-be8a-4246-9c5e-b313095719e4
--   陶璨  taocan2008@miaoda.com          890f5e83-8ba9-44f9-b3a5-fcc76ff0161e
-- ============================================================================

BEGIN; -- 事务开始：任何一步 RAISE EXCEPTION 都会整体回滚

-- ---------------------------------------------------------------------------
-- 第 1 步：删除前复核（只读统计，不修改任何数据）
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  -- 目标 profile_id（auth.users.id = public.profiles.id）
  target_profiles uuid[] := ARRAY[
    'de040a1d-be8a-4246-9c5e-b313095719e4'::uuid,
    '890f5e83-8ba9-44f9-b3a5-fcc76ff0161e'::uuid
  ];
  target_patients uuid[];
  total_business_rows bigint;
  t text;
  c bigint;
  detail text := '';
BEGIN
  -- 收集目标患者档案 id
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
    INTO target_patients
    FROM public.patients
   WHERE profile_id = ANY(target_profiles);

  RAISE NOTICE '目标 patients.id：%', target_patients;

  -- 逐表统计 patient_id 命中数
  FOREACH t IN ARRAY ARRAY[
    'checkins', 'medication_plans', 'medication_logs', 'symptom_checks',
    'alerts', 'messages', 'followup_items', 'reports', 'care_relations'
  ]
  LOOP
    EXECUTE format(
      'SELECT COUNT(*) FROM public.%I WHERE patient_id = ANY($1)', t
    ) INTO c USING target_patients;
    detail := detail || format(E'  %s = %s\n', t, c);
  END LOOP;

  RAISE NOTICE '业务数据复核明细：%', E'\n' || detail;

  SELECT SUM(v)::bigint INTO total_business_rows
    FROM (
      SELECT (SELECT COUNT(*) FROM public.checkins        WHERE patient_id = ANY(target_patients)) AS v
      UNION ALL SELECT (SELECT COUNT(*) FROM public.medication_plans  WHERE patient_id = ANY(target_patients))
      UNION ALL SELECT (SELECT COUNT(*) FROM public.medication_logs   WHERE patient_id = ANY(target_patients))
      UNION ALL SELECT (SELECT COUNT(*) FROM public.symptom_checks    WHERE patient_id = ANY(target_patients))
      UNION ALL SELECT (SELECT COUNT(*) FROM public.alerts            WHERE patient_id = ANY(target_patients))
      UNION ALL SELECT (SELECT COUNT(*) FROM public.messages          WHERE patient_id = ANY(target_patients))
      UNION ALL SELECT (SELECT COUNT(*) FROM public.followup_items    WHERE patient_id = ANY(target_patients))
      UNION ALL SELECT (SELECT COUNT(*) FROM public.reports           WHERE patient_id = ANY(target_patients))
      UNION ALL SELECT (SELECT COUNT(*) FROM public.care_relations    WHERE patient_id = ANY(target_patients))
    ) s;

  RAISE NOTICE '业务数据总行数 total_business_rows = %', total_business_rows;

  IF total_business_rows > 0 THEN
    RAISE EXCEPTION '复核未通过：目标账号仍存在 % 行业务数据，已中止，未删除任何内容', total_business_rows;
  END IF;

  RAISE NOTICE '复核通过：两个测试账号业务数据均为 0，继续执行删除';
END $$;

-- ---------------------------------------------------------------------------
-- 第 2 步：删除患者档案（子表均 ON DELETE CASCADE，此处仅显式清理 patients 本体）
-- ---------------------------------------------------------------------------
DELETE FROM public.patients
 WHERE profile_id IN (
   'de040a1d-be8a-4246-9c5e-b313095719e4'::uuid,
   '890f5e83-8ba9-44f9-b3a5-fcc76ff0161e'::uuid
 );

-- ---------------------------------------------------------------------------
-- 第 3 步：删除 profile（public.profiles.id 引用 auth.users，需先于 auth.users 清理）
-- ---------------------------------------------------------------------------
DELETE FROM public.profiles
 WHERE id IN (
   'de040a1d-be8a-4246-9c5e-b313095719e4'::uuid,
   '890f5e83-8ba9-44f9-b3a5-fcc76ff0161e'::uuid
 );

-- ---------------------------------------------------------------------------
-- 第 4 步：删除登录凭证（auth.users 删除会级联清理 auth.identities 等）
-- ---------------------------------------------------------------------------
DELETE FROM auth.users
 WHERE id IN (
   'de040a1d-be8a-4246-9c5e-b313095719e4'::uuid,
   '890f5e83-8ba9-44f9-b3a5-fcc76ff0161e'::uuid
 );

-- ---------------------------------------------------------------------------
-- 第 5 步：提交（默认不提交）
--
--   ⚠ 当前生效的是 ROLLBACK：整段跑完不会删除任何数据，可安全试跑复核逻辑。
--   ⚠ 确认落库的步骤：
--        1) 跑一遍整段，确认 NOTICE 输出「复核通过」且 total_business_rows = 0；
--        2) 把下面这一行  ROLLBACK;  注释掉；
--        3) 把  -- COMMIT;  的注释去掉，让它生效；
--        4) 再跑一次，此时才真正删除。
--   ⚠ 一旦 COMMIT，不可回滚。
-- ---------------------------------------------------------------------------
-- COMMIT;
ROLLBACK;
