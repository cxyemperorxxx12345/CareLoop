-- ============================================================================
-- T1 待执行迁移合集（一次性按顺序跑完，供 Supabase SQL Editor 直接使用）
--
-- 生成方式：由 supabase/migrations/00012 ~ 00016 原样拼接，内容不改写。
-- 顺序必须保持：00012 → 00013 → 00014 → 00015 → 00016
--
-- 幂等：全部语句可重复执行，不会重复生效。
-- 安全边界：本文件不含任何 DELETE / TRUNCATE / DROP TABLE，
--           不触碰 auth.users（任务包铁律：禁止删除任何登录凭证）。
--
-- 【前置保护】下面两条确保前序迁移（00010 is_hidden / 00011 dedup_key）
-- 万一没跑过也不会中断本次执行。
-- ============================================================================

ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS dedup_key text;


-- ===================== 00012_t1_messages_dedup_index =====================
-- T1 · 第 3 项：messages 幂等查重索引
-- 背景：reminder-scan 被 pg_cron 每分钟轮询，边界条件下会对同一条提醒重复 INSERT，
--       造成患者端消息中心出现重复条目。修法是在插入侧补 dedup_key（见 reminder-scan /
--       triage-symptom），并在数据库层加唯一约束兜底。
-- 说明：00011 建的是「部分唯一索引」（WHERE dedup_key IS NOT NULL），PostgREST 的
--       ON CONFLICT 无法推断部分索引，因此这里换成**非部分**唯一索引。
--       PostgreSQL 的唯一索引把 NULL 视为互不相等，因此历史行（dedup_key 为 NULL）
--       不会互相冲突，无需回填即可安全替换；未带 dedup_key 的新写入也不受影响。

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS dedup_key text;

DROP INDEX IF EXISTS public.messages_patient_dedup_idx;

CREATE UNIQUE INDEX IF NOT EXISTS messages_patient_dedup_idx
  ON public.messages (patient_id, dedup_key);

COMMENT ON COLUMN public.messages.dedup_key IS
  '幂等查重键：patient_id + 业务维度 + 时间窗口。NULL 表示不参与去重。';

-- ===================== 00013_t1_knowledge_newline_normalize =====================
-- T1 一次性清洗：knowledge_docs 正文中被 JSON 字符串化转义的换行还原为真实换行符
-- 现象：content 里存的是「反斜杠 + n」两个字符（字面 \n），导致知识库卡片与智能问答引用时换行失效。
-- 幂等：WHERE 条件只命中确实含字面 \n 或真实 CRLF 的行，重复执行无副作用。
-- 说明：Postgres 默认 standard_conforming_strings = on，所以 '\n' 表示「反斜杠 + n」两个字符，
--       真正的换行符要用 chr(10)，回车符用 chr(13)。
-- 只涉及 public.knowledge_docs，不触碰其他表。

UPDATE public.knowledge_docs
SET
  content = replace(
    replace(
      -- 顺序不能反：先把字面 \r\n 还原成真换行，再处理单独的字面 \n
      replace(replace(content, '\r\n', chr(10)), '\n', chr(10)),
      -- 真实 CRLF 归一成 LF
      chr(13) || chr(10),
      chr(10)
    ),
    -- 单独存在的真实 CR 也归一成 LF
    chr(13),
    chr(10)
  ),
  title = CASE WHEN title IS NOT NULL THEN btrim(title) ELSE title END
-- 用 position() 而不是 LIKE 判定：LIKE 的默认转义符就是反斜杠，
-- 写 '%\n%' 会被解析成「匹配字母 n」，造成过度匹配。position() 是纯子串查找，语义精确。
WHERE
  content IS NOT NULL
  AND (
    position('\r\n' IN content) > 0   -- 字面反斜杠 r + 反斜杠 n
    OR position('\n' IN content) > 0  -- 字面反斜杠 + n
    OR position(chr(13) || chr(10) IN content) > 0
    OR position(chr(13) IN content) > 0
  );

-- ===================== 00014_t1_checkins_daily_upsert =====================
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

-- ===================== 00015_t1_soft_hide_test_patients =====================
-- T1 · 第 2 条：测试账号「软隐藏」（铁律：禁止删除 auth.users 任何记录 / 禁止 auth.admin.deleteUser）
--
-- 说明：患者列表里残留「陶璨」「陈总」两条测试档案（诊断、年龄全空）。
-- 按要求改为软隐藏 —— 用 public.patients.is_hidden（迁移 00010 已建，NOT NULL DEFAULT false），
-- 这两条置 true，列表查询统一加 `is_hidden is not true` 过滤。
-- 展示效果与删除一致，但完全不触碰 auth.users / auth.identities 里的登录凭证。
--
-- 安全边界：只按「邮箱 + 姓名」双重匹配命中这两条，不做任何无差别更新；幂等，可重复执行。

UPDATE public.patients p
SET is_hidden = true
FROM public.profiles pr
WHERE p.profile_id = pr.id
  AND pr.email IN ('cxyemperorxxx12345@miaoda.com', 'taocan2008@miaoda.com')
  AND p.name IN ('陈总', '陶璨')
  AND p.is_hidden IS NOT TRUE;

COMMENT ON COLUMN public.patients.is_hidden IS
  '软隐藏标记：true 表示演示期残留的测试档案，所有列表查询统一过滤 is_hidden is not true。严禁改用删除。';

-- ===================== 00016_t1_report_stats_backfill =====================
-- T1 · 第 3 项：存量随访报告的统计数据结构补齐
--
-- 问题：种子里那封「周建国」的已归档报告，content 是**扁平结构**
--   { adherence:'95%', medication_total:20, medication_taken:19, medication_skipped:1,
--     bp_summary:'收缩压 152-163mmHg…', symptoms:['头晕伴后颈部胀痛（黄色分诊）'],
--     alerts_count:1, summary:'出院1周…' }
--   没有嵌套的 stats 对象。前端 `content?.stats` 取不到 → 渲染「本报告暂无统计数据」，
--   而 `content.summary` 有值又渲染出完整小结 —— 同一张卡片出现自相矛盾的两段。
--
-- 修法（只做加法，不丢数据）：
--   把扁平结构**派生**出一份标准 stats，summary 提升为顶层键，
--   原始扁平内容原封不动保留在 stats.legacy_flat，便于回溯。
--
-- 幂等：只处理 content 里没有 stats、但有 summary 的行；重复执行不会再命中。
-- 安全边界：不删除任何报告，不修改 status / clinician_note / 任何业务表。

UPDATE public.reports
SET content = jsonb_build_object(
  'stats', jsonb_build_object(
    'period_days', COALESCE(NULLIF(content ->> 'period_days', '')::int, period_days),

    'adherence', jsonb_build_object(
      'taken',   COALESCE(NULLIF(content ->> 'medication_taken', '')::int, 0),
      'skipped', COALESCE(NULLIF(content ->> 'medication_skipped', '')::int, 0),
      'snoozed', 0,
      'answered', COALESCE(NULLIF(content ->> 'medication_total', '')::int, 0),
      -- 依从率：优先用 taken/total 实算；算不出来时退回解析 "95%" 这种文本
      'compliance_rate', COALESCE(
        CASE
          WHEN NULLIF(content ->> 'medication_total', '')::int > 0
            THEN round(
              NULLIF(content ->> 'medication_taken', '')::int::numeric
              / NULLIF(content ->> 'medication_total', '')::int * 100
            )::int
        END,
        NULLIF(regexp_replace(COALESCE(content ->> 'adherence', ''), '[^0-9.]', '', 'g'), '')::int,
        0
      )
    ),

    'vitals', jsonb_build_object(
      'records', 0,
      'systolic_avg', NULL,
      'diastolic_avg', NULL,
      'heart_rate_avg', NULL,
      'temperature_max', NULL,
      -- 扁平结构只有一段血压文字描述，没有可拆分的数值，原样保留
      'note', content ->> 'bp_summary'
    ),

    -- 扁平结构的 symptoms 是字符串数组，统一转成 {chief_complaint, level} 对象数组
    'symptoms', CASE
      WHEN jsonb_typeof(content -> 'symptoms') = 'array'
        THEN COALESCE(
          (SELECT jsonb_agg(jsonb_build_object('chief_complaint', s.txt, 'level', 'yellow'))
           FROM jsonb_array_elements_text(content -> 'symptoms') AS s(txt)),
          '[]'::jsonb
        )
      ELSE '[]'::jsonb
    END,

    'alerts', jsonb_build_object(
      'total', COALESCE(NULLIF(content ->> 'alerts_count', '')::int, 0),
      'open', 0,
      'red', 0,
      'yellow', 0
    ),

    -- 原始扁平内容整段保留，不丢任何信息
    'legacy_flat', content
  ),
  'summary', content ->> 'summary'
)
WHERE content -> 'stats' IS NULL
  AND content ->> 'summary' IS NOT NULL;
