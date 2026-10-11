-- ============ CareLoop 迁移14：checkins「日」粒度幂等写入（T1-5） ============
--
-- 【日粒度约定】（后续 T2 播种脚本 / 每日重算作业请严格照此执行）
--
--   1. 日粒度界定
--      public.checkins 只有 created_at timestamptz，没有独立的 date 类型字段，
--      因此统一以 created_at::date 作为「当日唯一体征快照」的标准。
--      所有按天统计、趋势图聚合一律走 created_at::date 换算，不额外造列。
--
--   2. 防重策略（幂等写入）
--      禁止裸 INSERT。批量播种 / 每日重算前，先查该患者当日是否已有 checkins 记录：
--         · 存在 → UPDATE 覆盖当日快照
--         · 不存在 → INSERT 新建
--      保证同一患者同一天在表里最多只有一条记录，绝不造成同天数据堆积。
--      刻意不在 checkins 上加 UNIQUE / 部分唯一索引：表达式索引会让 PostgREST
--      的 upsert 推断失败，本项目统一走本函数的「先查后插/覆盖」策略。
--
--   3. 时间锚定
--      播种历史数据必须显式指定 created_at（例如每天上午 8 点），
--      让 9 天序列落在 9 个不同的自然日上，在趋势图里均匀连续；
--      不传则取 now()，只适用于「患者实时打卡」场景。
--
-- 【NULL 语义】UPDATE 分支选择「传入 NULL 即覆盖为 NULL」：
--   本次调用里某个体征参数传 NULL，落库后该字段就是 NULL（清空），
--   不会保留该患者上一次打卡的旧值。语义简单可预测。
--   若希望只更新部分字段，请在调用前把原值一并传回来。
--
-- 【时区注意】::date 依赖会话 TimeZone（Supabase 默认 UTC）。
--   若需要「北京时间口径」的日界，请把下面 v_date 一行改成
--     v_date := (v_ts AT TIME ZONE 'Asia/Shanghai')::date;
--   并保证与前端 src/pages/patient/CheckinPage.tsx 按天聚合的口径一致。
--   本次按约定保持最朴素的 created_at::date，不做隐式时区转换。

-- 幂等：重复执行本迁移只会替换函数定义，不影响表结构与 RLS 策略。
CREATE OR REPLACE FUNCTION public.upsert_daily_checkin(
  p_patient_id uuid,
  p_systolic int,
  p_diastolic int,
  p_heart_rate int,
  p_temperature numeric,
  p_blood_glucose numeric,
  p_weight numeric,
  p_pain_score int,
  p_note text,
  p_created_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_ts timestamptz;
  v_date date;
  v_id uuid;
BEGIN
  -- 参数兜底
  IF p_patient_id IS NULL THEN
    RAISE EXCEPTION 'upsert_daily_checkin: p_patient_id 不能为空';
  END IF;

  -- 归属守卫（防止 authenticated 用户横向写入他人快照）：
  -- service_role / Edge Function（无 JWT，auth.uid() 为 NULL）直接放行，供播种脚本调用；
  -- 患者端只能写自己的 patient_id，医护端（clinician）可代写。
  IF auth.uid() IS NOT NULL
     AND NOT (p_patient_id = public.get_my_patient_id() OR public.is_clinician()) THEN
    RAISE EXCEPTION 'upsert_daily_checkin: 无权为该患者写入打卡记录';
  END IF;

  -- 步骤 1：时间锚定，不传则取当前时刻
  v_ts := coalesce(p_created_at, now());

  -- 步骤 2：日粒度界定
  v_date := (v_ts)::date;

  -- 步骤 3：查该患者当日是否已有快照，取当天最后一条
  SELECT id INTO v_id
  FROM public.checkins
  WHERE patient_id = p_patient_id
    AND created_at::date = v_date
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    -- 步骤 4：已存在 → 覆盖当日快照（NULL 一并写回，见文件头「NULL 语义」）
    UPDATE public.checkins
    SET systolic = p_systolic,
        diastolic = p_diastolic,
        heart_rate = p_heart_rate,
        temperature = p_temperature,
        blood_glucose = p_blood_glucose,
        weight = p_weight,
        pain_score = p_pain_score,
        note = p_note,
        created_at = v_ts
    WHERE id = v_id;
  ELSE
    -- 步骤 5：不存在 → 新建当日快照
    INSERT INTO public.checkins (
      patient_id, systolic, diastolic, heart_rate, temperature,
      blood_glucose, weight, pain_score, note, created_at
    )
    VALUES (
      p_patient_id, p_systolic, p_diastolic, p_heart_rate, p_temperature,
      p_blood_glucose, p_weight, p_pain_score, p_note, v_ts
    )
    RETURNING id INTO v_id;
  END IF;

  -- 步骤 6：返回 checkin 行 id
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.upsert_daily_checkin(uuid, int, int, int, numeric, numeric, numeric, int, text, timestamptz)
  IS 'checkins 日粒度幂等写入：以 created_at::date 判定当日快照，存在则覆盖、不存在则插入，返回 checkin id。NULL 参数按「覆盖为 NULL」处理。';

-- 权限：仅 service_role（播种/Edge Function）与 authenticated（患者端）可调用
REVOKE EXECUTE ON FUNCTION public.upsert_daily_checkin(uuid, int, int, int, numeric, numeric, numeric, int, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_daily_checkin(uuid, int, int, int, numeric, numeric, numeric, int, text, timestamptz) TO service_role, authenticated;
