-- ============================================================================
-- CareLoop · Miaoda 一键部署包（迁移 00012 ~ 0021 + reminders.operator_type）
-- 适用对象：当前 Miaoda 托管库（supabase367321646417096704）仅应用到 00011，
--          00012–0021 全部未应用。
-- ----------------------------------------------------------------------------
-- 在 Miaoda 后台的部署步骤（Supabase → SQL Editor）：
--   1. 进入 SQL Editor，新建查询（New query）
--   2. 将本文件【全文】复制粘贴进编辑器
--   3. 点击 Run
--   4. 用文末「验收 SQL」逐条执行确认无报错、有预期结果
-- ----------------------------------------------------------------------------
-- 安全性说明：
--   - 所有变更均为 IF NOT EXISTS / CREATE OR REPLACE / upsert，重复执行无副作用；
--   - 仅新增列、函数、索引、cron 任务与演示数据；无任何 DROP / DELETE / TRUNCATE；
--   - 必须在「拉取新版前端 origin/main（其前端直接调用 00021 的 RPC）之前或同时」完成，
--     否则患者/家属用药打卡与医护预警回执会因 RPC 不存在而抛错。
-- ----------------------------------------------------------------------------
-- 本包包含：
--   00012  messages dedup 索引
--   00013  知识库换行符归一化
--   00014  checkins 日粒度 upsert 函数
--   00015  测试患者软隐藏
--   00016  报告统计回填
--   00017  漏服 escalate 不再升级红色（family_respond_alert 语义）
--   00018  演示账号口令与登录页一键填入对齐
--   00019  daily_baseline 表 + refresh_daily_baselines() + cron + 演示基线
--   00020  患者端「一键同步到医护端」RPC + 随访科室电话
--   00021  verified 修复：alerts.reminder_ids / record_medication_event /
--         resolve_alert_with_receipt / upsert_daily_checkin(更新) / refresh(更新)
--   D5     reminders.operator_type（家属代操作结构化标注，来自部署清单 D 节）
-- ============================================================================


-- ==================== 00012_t1_messages_dedup_index ====================
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

-- ==================== 00013_t1_knowledge_newline_normalize ====================
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

-- ==================== 00014_t1_checkins_daily_upsert ====================
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

-- ==================== 00015_t1_soft_hide_test_patients ====================
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

-- ==================== 00016_t1_report_stats_backfill ====================
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

-- ==================== 00017~0020 (PENDING_apply_now) ====================
-- ============================================================================
-- CareLoop · 待应用迁移合并包（00017 + 00018 + 00019 + 00020）
-- 用法：Supabase 后台 → SQL Editor → 新建查询 → 本文件全文粘贴 → Run
-- 生效内容：
--   00017 漏服 escalate 不再升级红色（已是黄色的转医护回电）
--   00018 演示账号口令与登录页一键填入对齐
--   00019 机制①数据层：daily_baseline 表 + refresh_daily_baselines() 跑批 + 演示数据
--   00020 患者端「一键同步到医护端」RPC（修 RLS 报错）+ patients.followup_phone 随访电话
-- 全部幂等：重复执行无副作用。跑完到 docs/部署清单.md 待办区划掉第 1、2、3 项。
-- ============================================================================

-- T1 · 第 7 项：修正漏服升级链的红色标签语义（评审报告 P1「严重度错配」）
--
-- 问题：家属响应「仍无响应」后，family_respond_alert 会把漏服他汀这类预警 level 置为 'red'，
--   医护端徽章显示「红色·立即就医」。漏服一次他汀临床上远达不到「立即就医」，
--   红黄标签语义被稀释后，真正的红旗（分诊红色 / 危险体征）反而会被淹没。
--
-- 修法（语义归位，不丢数据）：
--   1) family_respond_alert：'escalate' 不再升级为 red —— 保持 yellow、
--      assignee_role='clinician' 交还医护端，detail 注明「请医护回电」。
--      红色只保留给分诊红旗与危险体征预警。
--   2) 存量修复：曾被 escalate 误标为红色的用药预警降回黄色（幂等，条件只命中仍是 red 的行）。
--   3) 'dosed' / 'contacted' 行为与 00005/00007 完全一致，仅 escalate 分支变化。
--
-- 安全边界：只改 alerts 的 level / assignee_role / detail 语义，不删除任何行，不触碰其他表。

CREATE OR REPLACE FUNCTION public.family_respond_alert(p_alert_id uuid, p_action text, p_family_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_patient uuid; v_authorized boolean;
BEGIN
  SELECT a.patient_id INTO v_patient FROM public.alerts a WHERE a.id = p_alert_id;
  IF v_patient IS NULL THEN RAISE EXCEPTION '预警不存在'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.patients p
    WHERE p.id = v_patient AND p.profile_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM public.care_relations cr
    WHERE cr.patient_id = v_patient AND cr.family_user_id = auth.uid() AND cr.status = 'ACTIVE'
  ) INTO v_authorized;
  IF NOT v_authorized THEN RAISE EXCEPTION '无权响应该预警'; END IF;
  IF p_action NOT IN ('dosed', 'contacted', 'escalate') THEN RAISE EXCEPTION '无效的响应动作'; END IF;

  UPDATE public.alerts
  SET family_action = p_action,
      family_responded_at = now(),
      detail = detail || E'\n家属 ' || p_family_name || ' 已响应：' ||
        CASE p_action
          WHEN 'dosed' THEN '已代为打卡服药，链路终止'
          WHEN 'contacted' THEN '已联系患者，维持观察'
          WHEN 'escalate' THEN '患者仍无响应，请医护回电'
        END
  WHERE id = p_alert_id;

  -- 已代打卡：链路终止，预警关闭
  IF p_action = 'dosed' THEN
    UPDATE public.alerts SET status = 'resolved' WHERE id = p_alert_id;
  END IF;
  -- 转医护：保持黄色「需医护回电」并交还医护端；不再升级为红色。
  -- 红色仅保留给分诊红旗（triage）与危险体征，避免红标语义被稀释。
  IF p_action = 'escalate' THEN
    UPDATE public.alerts SET level = 'yellow', assignee_role = 'clinician' WHERE id = p_alert_id;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.family_respond_alert(uuid, text, text) TO authenticated;

-- 存量修复：reminder-scan 只会产生黄色用药预警，source='medication' 的红色
-- 只可能来自历史版本的 escalate 误标。降回黄色，与 L2/L3 升级链保持一致。
UPDATE public.alerts
SET level = 'yellow'
WHERE source = 'medication'
  AND family_action = 'escalate'
  AND level = 'red';

-- T1 · 演示账号密码与登录页「一键填入」对齐
--
-- 背景：登录页（src/pages/LoginPage.tsx）一键填入的演示密码为 GuiFang@CareLoop2026 等口径，
--   而 00002 种子建号时使用的是 CareLoop#Gui2026!f9K 等旧口令；线上库口令被手工调整过，
--   导致「按迁移重建的新库 → 一键填入后登录失败」，新协作者无法直接跑起来。
--   本迁移把四个演示账号的口径统一到登录页（00007 建号的陈明本就一致，一并幂等重设）。
--
-- 幂等：重复执行即为同一口令，无副作用。
-- 边界：只改这四个 @miaoda.com 演示账号，不触碰任何其他用户；不删除、不新建账号。
-- 注意：需在 Supabase SQL Editor 以 postgres 身份执行（auth.users 属平台保留表）。

UPDATE auth.users
SET encrypted_password = crypt('GuiFang@CareLoop2026', gen_salt('bf', 10)), updated_at = now()
WHERE email = 'guifang@miaoda.com';

UPDATE auth.users
SET encrypted_password = crypt('JianGuo@CareLoop2026', gen_salt('bf', 10)), updated_at = now()
WHERE email = 'jianguo@miaoda.com';

UPDATE auth.users
SET encrypted_password = crypt('DrWang@CareLoop2026', gen_salt('bf', 10)), updated_at = now()
WHERE email = 'doctor_wang@miaoda.com';

UPDATE auth.users
SET encrypted_password = crypt('ChenMing@CareLoop2026', gen_salt('bf', 10)), updated_at = now()
WHERE email = 'chenming@miaoda.com';

-- ============ CareLoop 迁移19：个人基线与轨迹偏离（机制① 数据层） ============
--
-- 叙事升级（v17 评价主线）：「我们不盯达标线，我们盯偏离」——
-- 每个出院患者唯一的对照，是他自己。
--
-- 本迁移内容（全部幂等，可重复执行）：
--   1. daily_baseline 表：患者 × 指标 的 7 天滚动基线（中位数 + MAD + 偏离带）
--   2. refresh_daily_baselines()：唯一的基线计算函数（SQL 侧实现，可审计、
--      可手动调用、可被 pg_cron 直接调度——不需要额外的 Edge Function）
--   3. pg_cron 每日 00:30（北京时间）自动重算：基线随康复移动
--   4. 演示数据：为陈桂芳（基线约 120/75）与周建国（基线约 150/95 且逐日下降）
--      铺 8 天打卡历史，并即时回填首批基线——迁移执行完演示即可用
--
-- ===== 方法论证（答辩必须能答，答不上来比不加更糟）=====
--   Q1 为什么用 MAD 不用标准差？
--      术后体征常有单点极值（一次测量紧张、伤口疼痛日的抬高）。标准差会被
--      单个极值带偏（统计崩溃点 0%），MAD 的崩溃点是 50%——少数脏数据
--      动摇不了基线。宁要稳健，不要"平均掉异常"。
--   Q2 为什么窗口是 7 天？
--      覆盖一个完整星期的行为周期（工作日/周末作息、随访日安排不同），
--      又与出院后 2-8 周过渡期的观察粒度匹配。窗口太短基线抖动，太长跟不上康复。
--   Q3 为什么排除今天？
--      基线代表「今天的你之前的正常轨道」；今天的读数是被判定对象。
--      若把今天纳入基线，判定就变成自己对照自己，偏离永远测不出来。
--   Q4 为什么至少 3 天样本？
--      少于 3 天时中位数/MAD 不稳定，宁可退化为群体阈值判定（前端标注「基线建立中」）。
--   Q5 为什么波动带有下限？
--      有人 7 天血压纹丝不动，MAD 可能为 0，带宽归零会导致 1mmHg 波动就报偏离。
--      按指标设最小半宽（收缩压/舒张压/心率 5、体温 0.3℃、血糖 0.5mmol/L）防过度敏感。
--   Q6 判定怎么用这条基线？
--      双通道：群体安全阈值（≥180/≥39 等，非 negotiable）+ 个体偏离（对照本人偏离带）。
--      群体越线 → 红；未越线但偏离本人轨道 → 黄（中间态）；两者都正常 → 绿。
--      详见迁移 00020 / triage-symptom 判定层实现。

-- ===== 1. 基线表 =====
CREATE TABLE IF NOT EXISTS public.daily_baseline (
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  metric text NOT NULL,
  median numeric NOT NULL,
  mad numeric NOT NULL,
  band_low numeric NOT NULL,
  band_high numeric NOT NULL,
  sample_count int NOT NULL,
  window_days int NOT NULL DEFAULT 7,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_baseline_pkey PRIMARY KEY (patient_id, metric)
);
CREATE INDEX IF NOT EXISTS idx_daily_baseline_patient ON public.daily_baseline (patient_id);

ALTER TABLE public.daily_baseline ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS daily_baseline_select ON public.daily_baseline;
-- 读：本人与责任医护（与 checkins_select 同口径）；写：仅 service_role（跑批函数 SECURITY DEFINER）
CREATE POLICY daily_baseline_select ON public.daily_baseline FOR SELECT TO authenticated
  USING (patient_id = public.get_my_patient_id() OR public.is_clinician());

-- ===== 2. 基线计算函数（唯一实现，SQL 侧）=====
CREATE OR REPLACE FUNCTION public.refresh_daily_baselines()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_metric text;
  v_min_half numeric;
  v_metrics text[] := ARRAY['systolic', 'diastolic', 'heart_rate', 'temperature', 'blood_glucose'];
BEGIN
  FOREACH v_metric IN ARRAY v_metrics LOOP
    -- 波动带最小半宽：防止 MAD=0 时过度敏感（见文件头 Q5）
    v_min_half := CASE v_metric
      WHEN 'temperature' THEN 0.3
      WHEN 'blood_glucose' THEN 0.5
      ELSE 5 END;
    EXECUTE format($sql$
      WITH win AS (
        SELECT patient_id, %I AS v
        FROM public.checkins
        WHERE created_at::date < CURRENT_DATE
          AND created_at::date >= CURRENT_DATE - 7
          AND %I IS NOT NULL
      ), med AS (
        SELECT patient_id,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY v) AS m,
               count(*)::int AS n
        FROM win
        GROUP BY patient_id
        HAVING count(*) >= 3
      ), dev AS (
        SELECT w.patient_id,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(w.v - med.m)) AS mad
        FROM win w
        JOIN med ON med.patient_id = w.patient_id
        GROUP BY w.patient_id
      )
      INSERT INTO public.daily_baseline
        (patient_id, metric, median, mad, band_low, band_high, sample_count, window_days, computed_at)
      SELECT med.patient_id, %L, med.m, dev.mad,
             med.m - GREATEST(2 * dev.mad, %s),
             med.m + GREATEST(2 * dev.mad, %s),
             med.n, 7, now()
      FROM med JOIN dev ON dev.patient_id = med.patient_id
      ON CONFLICT (patient_id, metric) DO UPDATE SET
        median = EXCLUDED.median, mad = EXCLUDED.mad,
        band_low = EXCLUDED.band_low, band_high = EXCLUDED.band_high,
        sample_count = EXCLUDED.sample_count, window_days = EXCLUDED.window_days,
        computed_at = EXCLUDED.computed_at
    $sql$, v_metric, v_metric, v_metric, v_min_half, v_min_half);
  END LOOP;
  RETURN (SELECT count(*) FROM public.daily_baseline);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.refresh_daily_baselines() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_daily_baselines() TO service_role;

-- ===== 3. pg_cron 每日重算（00:30 北京时间 = 16:30 UTC；先删后建保证幂等）=====
DO $$
BEGIN
  PERFORM cron.unschedule('careloop-baseline-refresh');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
SELECT cron.schedule(
  'careloop-baseline-refresh',
  '30 16 * * *',
  $$ SELECT public.refresh_daily_baselines(); $$
);

-- ===== 4. 演示数据：两位患者的 8 天打卡史（走 upsert_daily_checkin，幂等）=====
-- 陈桂芳：7 天稳定在 118-124/73-78（基线约 120/75），今日 142/88 显著偏离
-- 周建国：7 天自 155/98 缓降至 148/93（基线约 150/95），今日 138/85 低于本人带（好转）
DO $$
DECLARE v_gf uuid; v_zj uuid; r record;
BEGIN
  SELECT id INTO v_gf FROM public.patients WHERE name = '陈桂芳' AND is_hidden = false ORDER BY created_at LIMIT 1;
  SELECT id INTO v_zj FROM public.patients WHERE name = '周建国' AND is_hidden = false ORDER BY created_at LIMIT 1;

  FOR r IN
    SELECT * FROM (VALUES
      (v_gf, -7, 118, 73, 70, 36.5, 6.5, 61.0, 1, '术后恢复平稳'),
      (v_gf, -6, 121, 76, 72, 36.6, 6.7, 61.1, 1, NULL),
      (v_gf, -5, 119, 74, 71, 36.5, 6.6, 61.0, 1, '伤口换药，恢复可'),
      (v_gf, -4, 122, 77, 73, 36.7, 6.9, 60.9, 2, NULL),
      (v_gf, -3, 120, 75, 72, 36.6, 6.8, 61.0, 1, NULL),
      (v_gf, -2, 124, 78, 74, 36.7, 7.0, 60.8, 2, '今日活动量稍大'),
      (v_gf, -1, 118, 73, 70, 36.5, 6.5, 61.0, 1, NULL),
      (v_gf,  0, 142, 88, 86, 36.8, 7.1, 60.8, 2, '今晨略感胸闷，休息后缓解；自测血压 142/88，明显高于近期水平'),
      (v_zj, -7, 155, 98, 78, 36.5, 7.8, 78.5, 0, NULL),
      (v_zj, -6, 152, 96, 80, 36.4, 7.6, 78.3, 0, '睡眠不佳'),
      (v_zj, -5, 150, 94, 79, 36.5, 7.5, 78.1, 0, NULL),
      (v_zj, -4, 154, 99, 81, 36.6, 7.9, 78.0, 0, NULL),
      (v_zj, -3, 147, 91, 77, 36.4, 7.3, 77.9, 0, NULL),
      (v_zj, -2, 150, 95, 79, 36.5, 7.6, 77.8, 0, NULL),
      (v_zj, -1, 148, 93, 78, 36.4, 7.4, 77.7, 0, NULL),
      (v_zj,  0, 138, 85, 74, 36.5, 7.5, 77.6, 0, '晨起头晕较前减轻；血压 138/85，为近一周最低')
    ) AS t(pid, d, sys, dia, hr, temp, glu, wt, pain, note)
  LOOP
    IF r.pid IS NOT NULL THEN
      PERFORM public.upsert_daily_checkin(
        r.pid, r.sys, r.dia, r.hr, r.temp, r.glu, r.wt, r.pain, r.note,
        -- 历史日固定 08:00；今日取当前时刻，避免写入未来时间
        (CURRENT_DATE + r.d) + CASE WHEN r.d = 0 THEN now()::time ELSE time '08:00' END
      );
    END IF;
  END LOOP;

  -- 预警文案随新数据口径更新（让预警中心叙事与基线机制一致）
  IF v_gf IS NOT NULL THEN
    UPDATE public.alerts
    SET detail = '患者自查上报「晨起胸闷、活动后气短」，红色分诊；今日收缩压 142/88mmHg，显著偏离本人基线（120/75，偏离带 115-125），需高度重视。'
    WHERE patient_id = v_gf AND source = 'triage' AND status = 'open';
  END IF;
  IF v_zj IS NOT NULL THEN
    UPDATE public.alerts
    SET detail = '近3日收缩压 150→138mmHg 逐日下降，今日 138/85 已低于本人基线带（150/95），倾向好转；昨日起自查头晕（黄色分诊），症状转归前持续观察。'
    WHERE patient_id = v_zj AND source = 'checkin' AND status = 'open';
  END IF;
END $$;

-- ===== 5. 即时回填首批基线（不等 cron，迁移执行完即可演示）=====
SELECT public.refresh_daily_baselines();
-- ============================================================================
-- 00020 · T1 · 患者端「一键同步到医护端」安全通道 + 随访科室电话
-- 背景：
--   1) alerts 的 INSERT 策略仅限 is_clinician()（见 00009 RLS 段），患者端
--      前端直插 alerts 会被 RLS 拦截，报
--      "new row violates row-level security policy for table alerts"。
--   2) 「直拨随访科室」原先写死 tel: 链接且桌面端无响应，演示时"按了没反应"。
-- 方案：
--   A. 新增 SECURITY DEFINER RPC patient_escalate_alert(p_summary)，
--      仿照 family_respond_alert 的安全模型：绕过 RLS 但内部强制校验
--      调用者即患者本人（get_my_patient_id()），防越权上报他人/伪造患者。
--      写入黄色预警（电话随访级）、来源 manual、交办 clinician，
--      出现在医护端预警中心（AlertsPage 的 source 枚举即 triage/medication/
--      checkin/manual，故选 manual）。
--   B. patients 增加 followup_phone 列：出院资料自带的随访科室电话，
--      患者端可读（RLS select 本就允许本人），支撑「直拨随访科室」。
--      患者无法读取 profiles（profiles_select 仅本人/医护），故不能取主管医护电话。
--   C. 演示数据：给两个演示患者填随访科室电话。
-- 幂等：函数 CREATE OR REPLACE；列 ADD COLUMN IF NOT EXISTS；UPDATE 按用户名条件命中。
-- ==============================================================================

-- A. 一键同步 RPC
CREATE OR REPLACE FUNCTION public.patient_escalate_alert(p_summary text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_patient_id uuid;
  v_alert_id uuid;
BEGIN
  -- 仅患者本人可调用：取当前登录用户绑定的患者档案
  v_patient_id := public.get_my_patient_id();
  IF v_patient_id IS NULL THEN
    RAISE EXCEPTION '仅患者端可执行该操作';
  END IF;

  IF p_summary IS NULL OR length(btrim(p_summary)) = 0 THEN
    RAISE EXCEPTION '同步内容不能为空';
  END IF;

  INSERT INTO public.alerts (patient_id, source, level, detail, status, assignee_role)
  VALUES (v_patient_id, 'manual', 'yellow', '【患者咨询上报】' || left(btrim(p_summary), 200), 'open', 'clinician')
  RETURNING id INTO v_alert_id;

  RETURN v_alert_id;
END;
$$;

-- 最小授权：撤销 PUBLIC 默认执行权，仅登录用户可调
REVOKE ALL ON FUNCTION public.patient_escalate_alert(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.patient_escalate_alert(text) TO authenticated;

-- B. 患者表增加随访科室电话（出院资料自带，患者可读）
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS followup_phone text;

-- C. 演示数据：两个演示患者的随访科室电话
UPDATE public.patients SET followup_phone = '010-88886666'
WHERE name = '陈桂芳' AND (followup_phone IS NULL OR followup_phone = '');
UPDATE public.patients SET followup_phone = '010-88887777'
WHERE name = '周建国' AND (followup_phone IS NULL OR followup_phone = '');


-- ==================== 00021 (origin/main) ====================
-- 已确认问题修复：逐药事务、原始操作日期、处置回执、北京时间打卡/基线。
-- 不改历史迁移，不重置业务数据；本迁移可重复执行。
ALTER TABLE public.alerts ADD COLUMN IF NOT EXISTS reminder_ids uuid[];

CREATE OR REPLACE FUNCTION public.record_medication_event(
  p_patient_id uuid, p_plan_id uuid, p_slot int, p_action text,
  p_reason text, p_occurred_at timestamptz, p_log_date date
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_family_name text;
  v_is_patient boolean;
  v_operator text;
  v_applied uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('taken', 'snoozed', 'skipped') THEN
    RAISE EXCEPTION '无效的服药动作';
  END IF;
  IF p_occurred_at IS NULL OR p_log_date IS NULL
     OR p_log_date <> (p_occurred_at AT TIME ZONE 'Asia/Shanghai')::date
     OR p_occurred_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION '操作时间或日期无效';
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.patients
    WHERE id = p_patient_id AND profile_id = auth.uid()) INTO v_is_patient;
  IF NOT v_is_patient THEN
    SELECT family_name INTO v_family_name FROM public.care_relations
    WHERE patient_id = p_patient_id AND family_user_id = auth.uid() AND status = 'ACTIVE'
    LIMIT 1;
    IF v_family_name IS NULL THEN RAISE EXCEPTION '无权为该患者打卡'; END IF;
  END IF;
  v_operator := CASE WHEN v_is_patient THEN 'patient' ELSE 'family' END;
  -- 锁计划再锁本药提醒；患者与家属并发操作按同一顺序串行化。
  PERFORM 1 FROM public.medication_plans
    WHERE id = p_plan_id AND patient_id = p_patient_id AND p_slot = ANY(slots)
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '药品计划或时段不匹配'; END IF;
  PERFORM id FROM public.reminders
    WHERE patient_id = p_patient_id AND plan_id = p_plan_id
      AND remind_date = p_log_date AND slot = p_slot FOR UPDATE;
  INSERT INTO public.medication_logs
    (patient_id, plan_id, slot, log_date, action, reason, operator_type, operator_name, updated_at)
  VALUES (p_patient_id, p_plan_id, p_slot, p_log_date, p_action::public.med_action,
    p_reason, v_operator, v_family_name, p_occurred_at)
  ON CONFLICT (plan_id, log_date, slot) DO UPDATE
    SET action = EXCLUDED.action, reason = EXCLUDED.reason,
        operator_type = EXCLUDED.operator_type, operator_name = EXCLUDED.operator_name,
        updated_at = EXCLUDED.updated_at
    -- 较早离线操作不能覆盖已经收到的较新操作。
    WHERE medication_logs.updated_at < EXCLUDED.updated_at
  RETURNING id INTO v_applied;
  IF v_applied IS NULL THEN RETURN jsonb_build_object('applied', false); END IF;
  IF p_action = 'taken' THEN
    UPDATE public.reminders SET status = 'acked', snooze_until = NULL, updated_at = now()
    WHERE patient_id = p_patient_id AND plan_id = p_plan_id
      AND remind_date = p_log_date AND slot = p_slot;
    -- 合并任务只在关联的每一种药均已确认后关闭，不关闭其他时段的家属任务。
    UPDATE public.alerts a SET status = 'resolved', family_action = 'dosed',
      family_responded_at = now(), handled_at = now()
    WHERE a.patient_id = p_patient_id AND a.source = 'medication'
      AND a.status = 'open' AND cardinality(a.reminder_ids) > 0
      AND EXISTS (SELECT 1 FROM public.reminders r WHERE r.id = ANY(a.reminder_ids)
        AND r.plan_id = p_plan_id AND r.remind_date = p_log_date AND r.slot = p_slot)
      AND NOT EXISTS (SELECT 1 FROM unnest(a.reminder_ids) AS ids(id)
        LEFT JOIN public.reminders r ON r.id = ids.id
        WHERE r.id IS NULL OR r.status <> 'acked');
  ELSIF p_action = 'snoozed' THEN
    UPDATE public.reminders SET status = 'snoozed',
      snooze_until = p_occurred_at + interval '30 minutes',
      next_action_at = p_occurred_at + interval '30 minutes', updated_at = now()
    WHERE patient_id = p_patient_id AND plan_id = p_plan_id
      AND remind_date = p_log_date AND slot = p_slot AND status <> 'acked';
  END IF;
  RETURN jsonb_build_object('applied', true);
END;
$$;
REVOKE ALL ON FUNCTION public.record_medication_event(uuid, uuid, int, text, text, timestamptz, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_medication_event(uuid, uuid, int, text, text, timestamptz, date) TO authenticated;

-- 预警和回执同一事务：消息写入失败则处置也回滚，允许安全重试。
CREATE OR REPLACE FUNCTION public.resolve_alert_with_receipt(
  p_alert_id uuid, p_action text, p_resolution_note text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_alert public.alerts%ROWTYPE; v_content text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_clinician() THEN RAISE EXCEPTION '仅医护可处理预警'; END IF;
  SELECT * INTO v_alert FROM public.alerts WHERE id = p_alert_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '预警不存在'; END IF;
  IF v_alert.status <> 'resolved' THEN
    UPDATE public.alerts SET status = 'resolved', action = p_action,
      resolution_note = p_resolution_note, handled_by = auth.uid(), handled_at = now()
    WHERE id = p_alert_id;
    v_content := concat_ws('。', NULLIF(trim(p_action), ''), NULLIF(trim(p_resolution_note), ''));
  ELSE
    -- 为旧版已处理但回执写入失败的预警补发，保留原处置结论。
    v_content := concat_ws('。', NULLIF(trim(v_alert.action), ''), NULLIF(trim(v_alert.resolution_note), ''));
  END IF;
  INSERT INTO public.messages (patient_id, type, title, content, link_path, read, dedup_key)
  VALUES (v_alert.patient_id, 'clinician_reply', '医护已查看您的上报',
    COALESCE(NULLIF(v_content, ''), '医护已查看您的上报，请按随访安排继续记录。'),
    '/patient/messages', false, 'alert-receipt:' || p_alert_id)
  ON CONFLICT (patient_id, dedup_key) DO NOTHING;
  RETURN jsonb_build_object('notified', true, 'notifyError', NULL);
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_alert_with_receipt(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_alert_with_receipt(uuid, text, text) TO authenticated;

-- 日界与提醒一致；锁患者行避免同日“先查后插”的并发重复。
CREATE OR REPLACE FUNCTION public.upsert_daily_checkin(
  p_patient_id uuid, p_systolic int, p_diastolic int, p_heart_rate int,
  p_temperature numeric, p_blood_glucose numeric, p_weight numeric,
  p_pain_score int, p_note text, p_created_at timestamptz
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_ts timestamptz := COALESCE(p_created_at, now()); v_date date; v_id uuid;
BEGIN
  IF auth.uid() IS NULL AND COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION '请先登录';
  END IF;
  IF auth.uid() IS NOT NULL AND NOT (p_patient_id = public.get_my_patient_id() OR public.is_clinician()) THEN
    RAISE EXCEPTION '无权为该患者写入打卡记录';
  END IF;
  PERFORM id FROM public.patients WHERE id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '患者不存在'; END IF;
  v_date := (v_ts AT TIME ZONE 'Asia/Shanghai')::date;
  SELECT id INTO v_id FROM public.checkins
    WHERE patient_id = p_patient_id AND (created_at AT TIME ZONE 'Asia/Shanghai')::date = v_date
    ORDER BY created_at DESC LIMIT 1;
  IF v_id IS NOT NULL THEN
    UPDATE public.checkins SET systolic = p_systolic, diastolic = p_diastolic,
      heart_rate = p_heart_rate, temperature = p_temperature, blood_glucose = p_blood_glucose,
      weight = p_weight, pain_score = p_pain_score, note = p_note, created_at = v_ts WHERE id = v_id;
  ELSE
    INSERT INTO public.checkins (patient_id, systolic, diastolic, heart_rate, temperature,
      blood_glucose, weight, pain_score, note, created_at)
    VALUES (p_patient_id, p_systolic, p_diastolic, p_heart_rate, p_temperature,
      p_blood_glucose, p_weight, p_pain_score, p_note, v_ts) RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.upsert_daily_checkin(uuid, int, int, int, numeric, numeric, numeric, int, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_daily_checkin(uuid, int, int, int, numeric, numeric, numeric, int, text, timestamptz) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.refresh_daily_baselines()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_metric text; v_half numeric; v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
BEGIN
  FOREACH v_metric IN ARRAY ARRAY['systolic','diastolic','heart_rate','temperature','blood_glucose'] LOOP
    v_half := CASE v_metric WHEN 'temperature' THEN 0.3 WHEN 'blood_glucose' THEN 0.5 ELSE 5 END;
    EXECUTE format($sql$
      WITH latest AS (
        SELECT DISTINCT ON (patient_id, (created_at AT TIME ZONE 'Asia/Shanghai')::date)
          patient_id, %I AS v FROM public.checkins
        WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::date < $1
          AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= $1 - 7
        ORDER BY patient_id, (created_at AT TIME ZONE 'Asia/Shanghai')::date, created_at DESC, id DESC
      ), win AS (SELECT * FROM latest WHERE v IS NOT NULL), med AS (
        SELECT patient_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY v) AS median, count(*) AS n
        FROM win GROUP BY patient_id HAVING count(*) >= 3
      ), mad AS (
        SELECT w.patient_id, m.median, m.n,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(w.v-m.median)) AS mad
        FROM win w JOIN med m USING (patient_id) GROUP BY w.patient_id, m.median, m.n
      )
      INSERT INTO public.daily_baseline (patient_id, metric, median, mad, band_low, band_high, sample_count, window_days, computed_at)
      SELECT patient_id, %L, median, mad, median-greatest(2*mad,%L::numeric),
        median+greatest(2*mad,%L::numeric), n, 7, now() FROM mad
      ON CONFLICT (patient_id,metric) DO UPDATE SET median=EXCLUDED.median, mad=EXCLUDED.mad,
        band_low=EXCLUDED.band_low, band_high=EXCLUDED.band_high, sample_count=EXCLUDED.sample_count,
        window_days=EXCLUDED.window_days, computed_at=EXCLUDED.computed_at
    $sql$, v_metric, v_metric, v_half, v_half) USING v_today;
  END LOOP;
  RETURN (SELECT count(*)::int FROM public.daily_baseline WHERE (computed_at AT TIME ZONE 'Asia/Shanghai')::date = v_today);
END;
$$;
REVOKE ALL ON FUNCTION public.refresh_daily_baselines() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_daily_baselines() TO service_role;

-- ==================== D5 · reminders.operator_type（部署清单 D 节建议）====================
-- 家属代为 ack/snooze 提醒时，reminders 表无任何操作人列，与患者本人操作无法区分。
-- 新增结构化标注列（patient=本人 / family=家属代操作）。前端已在 medication_logs.reason
-- 做「由家属X代填」文本冗余标注，本列用于结构化展示，可选 operator_name。
ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS operator_type text NOT NULL DEFAULT 'patient' CHECK (operator_type IN ('patient','family'));
ALTER TABLE public.reminders ADD COLUMN IF NOT EXISTS operator_name text;

-- ============================================================================
-- 验收 SQL（Run 后逐条执行，确认有结果/无报错）
-- ============================================================================
-- 1) cron 定时任务：应有 careloop-reminder-scan 与 careloop-baseline-refresh 两条
SELECT jobname FROM cron.job ORDER BY jobname;

-- 2) 关键 RPC 全部存在（00017/00020/00021）
SELECT proname FROM pg_proc
WHERE proname IN ('family_respond_alert','patient_escalate_alert','resolve_alert_with_receipt','record_medication_event','upsert_daily_checkin','refresh_daily_baselines')
ORDER BY proname;

-- 3) 演示基线数据（daily_baseline 应有陈桂芳/周建国多条）
SELECT p.name, count(*) AS baseline_rows
FROM daily_baseline b JOIN patients p ON p.id = b.patient_id
WHERE p.is_hidden = false
GROUP BY p.name;

-- 4) 一键同步 RPC 所需列 + 随访电话已写入
SELECT name, followup_phone FROM patients WHERE name IN ('陈桂芳','周建国') AND is_hidden = false;

-- 5) reminders.operator_type 列已存在
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'reminders' AND column_name = 'operator_type';

-- 6) alerts.reminder_ids 列已存在（00021）
SELECT column_name FROM information_schema.columns
WHERE table_name = 'alerts' AND column_name = 'reminder_ids';
