-- ===== 家属账号 chenming（照抄 guifang 建号模式）=====
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'chenming@miaoda.com', crypt('ChenMing@CareLoop2026', gen_salt('bf', 10)), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"陈明"}'::jsonb, now(), now());

INSERT INTO public.profiles (id, username, email, full_name, role)
SELECT u.id, 'chenming', u.email, '陈明', 'family'
FROM auth.users u WHERE u.email = 'chenming@miaoda.com'
ON CONFLICT (id) DO UPDATE SET username = 'chenming', full_name = '陈明', role = 'family';

-- ===== care_relations 关联家属账号 =====
ALTER TABLE public.care_relations ADD COLUMN family_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX care_relations_patient_family_uniq ON public.care_relations (patient_id, family_user_id) WHERE family_user_id IS NOT NULL;

UPDATE public.care_relations cr
SET family_user_id = (SELECT u.id FROM auth.users u WHERE u.email = 'chenming@miaoda.com')
WHERE cr.family_name = '陈明' AND cr.status = 'ACTIVE';

-- ===== 家属角色 helper（SECURITY DEFINER，供 RLS 引用）=====
CREATE OR REPLACE FUNCTION public.get_family_patient_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT cr.patient_id FROM public.care_relations cr
  WHERE cr.family_user_id = auth.uid() AND cr.status = 'ACTIVE'
  ORDER BY cr.is_primary DESC, cr.created_at
  LIMIT 1
$$;
GRANT EXECUTE ON FUNCTION public.get_family_patient_id() TO authenticated;

-- ===== RLS：家属（ACTIVE 绑定）可读照护对象数据 =====
ALTER POLICY patients_select ON public.patients
  USING ((profile_id = uid()) OR is_clinician() OR (id = get_family_patient_id()));
ALTER POLICY med_plans_select ON public.medication_plans
  USING ((patient_id = get_my_patient_id()) OR is_clinician() OR (patient_id = get_family_patient_id()));
ALTER POLICY alerts_select ON public.alerts
  USING ((patient_id = get_my_patient_id()) OR is_clinician() OR (patient_id = get_family_patient_id()));
ALTER POLICY messages_select ON public.messages
  USING ((patient_id = get_my_patient_id()) OR is_clinician() OR (patient_id = get_family_patient_id()));
ALTER POLICY followups_select ON public.followup_items
  USING ((patient_id = get_my_patient_id()) OR is_clinician() OR (patient_id = get_family_patient_id()));
ALTER POLICY reminders_select ON public.reminders
  USING ((patient_id = get_my_patient_id()) OR is_clinician() OR (patient_id = get_family_patient_id()));
ALTER POLICY reminders_update ON public.reminders
  USING ((patient_id = get_my_patient_id()) OR is_clinician() OR (patient_id = get_family_patient_id()))
  WITH CHECK ((patient_id = get_my_patient_id()) OR is_clinician() OR (patient_id = get_family_patient_id()));
ALTER POLICY med_logs_select ON public.medication_logs
  USING ((patient_id = get_my_patient_id()) OR is_clinician() OR (patient_id = get_family_patient_id()));
-- 家属代打卡：可插入/更新（operator_type='family' 标注来源）
ALTER POLICY med_logs_insert ON public.medication_logs
  WITH CHECK ((patient_id = get_my_patient_id()) OR (patient_id = get_family_patient_id()));
ALTER POLICY med_logs_update ON public.medication_logs
  USING ((patient_id = get_my_patient_id()) OR (patient_id = get_family_patient_id()))
  WITH CHECK ((patient_id = get_my_patient_id()) OR (patient_id = get_family_patient_id()));
-- 家属可读自己的绑定关系
ALTER POLICY care_relations_select ON public.care_relations
  USING ((EXISTS (SELECT 1 FROM public.patients p WHERE p.id = care_relations.patient_id AND p.profile_id = auth.uid())) OR is_clinician() OR (family_user_id = auth.uid()));

-- ===== 家属响应 RPC：校验改为患者本人或 ACTIVE 绑定家属 =====
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
          WHEN 'escalate' THEN '患者仍无响应，请医护尽快介入'
        END
  WHERE id = p_alert_id;

  IF p_action = 'dosed' THEN
    UPDATE public.alerts SET status = 'resolved' WHERE id = p_alert_id;
  END IF;
  IF p_action = 'escalate' THEN
    UPDATE public.alerts SET level = 'red' WHERE id = p_alert_id;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.family_respond_alert(uuid, text, text) TO authenticated;

-- ===== 验证 =====
SELECT u.email, p.role, p.username FROM auth.users u JOIN public.profiles p ON p.id = u.id WHERE u.email = 'chenming@miaoda.com';
SELECT patient_id, family_name, family_user_id, status FROM public.care_relations;