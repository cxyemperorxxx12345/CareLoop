-- ============================================================================
-- CareLoop · 待应用迁移合并包（00017 + 00018 + 00019 + 00020）
-- 用法：Supabase 后台 → SQL Editor → 新建查询 → 本文件全文粘贴 → Run
-- 生效内容：
--   00017 漏服 escalate 不再升级红色（已是黄色的转医护回电）
--   00018 演示账号口令与登录页一键填入对齐
--   00019 机制①数据层：daily_baseline 表 + refresh_daily_baselines() 跑批 + 演示数据
--   00020 患者端「一键同步到医护端」RPC（修 RLS 报错）+ patients.followup_phone 随访电话
-- 全部幂等：重复执行无副作用。
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

