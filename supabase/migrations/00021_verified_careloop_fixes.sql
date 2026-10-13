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
