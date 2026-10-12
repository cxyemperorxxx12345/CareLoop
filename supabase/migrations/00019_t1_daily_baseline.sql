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
