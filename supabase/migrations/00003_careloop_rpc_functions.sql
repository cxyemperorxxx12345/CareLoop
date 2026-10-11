-- ============ CareLoop 迁移3：业务 RPC ============

-- 确认照护计划（患者校对出院小结后，原子写入用药计划 + 随访项 + 文档状态）
-- 经用户 JWT 调用（Edge Function 透传 Authorization），内部用 auth.uid() 校验归属
CREATE OR REPLACE FUNCTION public.confirm_care_plan(p_document_id uuid, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_patient uuid;
  v_med jsonb;
  v_fu jsonb;
  v_plans int := 0;
  v_followups int := 0;
BEGIN
  -- 归属校验：文档 → 患者 → 当前登录用户
  SELECT pt.id INTO v_patient
  FROM public.documents d
  JOIN public.patients pt ON pt.id = d.patient_id
  WHERE d.id = p_document_id AND pt.profile_id = auth.uid();

  IF v_patient IS NULL THEN
    RAISE EXCEPTION '文档不存在或无权操作';
  END IF;

  -- 用药计划
  FOR v_med IN SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'medications', '[]'::jsonb)) LOOP
    INSERT INTO public.medication_plans (patient_id, document_id, medicine_name, spec, dosage, frequency, slots, note)
    VALUES (v_patient, p_document_id,
            v_med->>'name', v_med->>'spec', v_med->>'dosage', v_med->>'frequency',
            COALESCE((SELECT array_agg(x::int) FROM jsonb_array_elements_text(COALESCE(v_med->'slots', '[]'::jsonb)) x), '{}'),
            v_med->>'note');
    v_plans := v_plans + 1;
  END LOOP;

  -- 随访项
  FOR v_fu IN SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'followup', '[]'::jsonb)) LOOP
    INSERT INTO public.followup_items (patient_id, title, category, due_date, detail)
    VALUES (v_patient, v_fu->>'title', COALESCE(NULLIF(v_fu->>'category', ''), 'followup'),
            (v_fu->>'due_date')::date, v_fu->>'detail');
    v_followups := v_followups + 1;
  END LOOP;

  UPDATE public.documents SET status = 'confirmed' WHERE id = p_document_id;

  RETURN jsonb_build_object('ok', true, 'plans', v_plans, 'followups', v_followups);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.confirm_care_plan(uuid, jsonb) FROM anon;

-- 每日提醒生成（北京时间口径，幂等：UNIQUE 冲突自动跳过）
-- 仅允许 service_role（reminder-scan Edge Function）调用
CREATE OR REPLACE FUNCTION public.ensure_today_reminders()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_inserted int;
BEGIN
  INSERT INTO public.reminders (patient_id, plan_id, slot, remind_date, status, escalation_level, next_action_at)
  SELECT mp.patient_id, mp.id, s, v_today, 'pending', 0,
         (v_today + (CASE s WHEN 0 THEN time '08:00' WHEN 1 THEN time '12:00' WHEN 2 THEN time '18:00' ELSE time '21:00' END)) AT TIME ZONE 'Asia/Shanghai'
  FROM public.medication_plans mp
  CROSS JOIN (VALUES (0), (1), (2), (3)) AS slots(s)
  WHERE mp.active AND s = ANY (mp.slots)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.ensure_today_reminders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_today_reminders() TO service_role;