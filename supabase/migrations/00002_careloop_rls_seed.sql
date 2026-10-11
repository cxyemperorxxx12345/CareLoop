-- ============ CareLoop 迁移2：RLS 策略 + 角色守卫 + 演示种子 ============
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- 索引 ----------
CREATE INDEX idx_patients_profile ON public.patients (profile_id);
CREATE INDEX idx_documents_patient ON public.documents (patient_id);
CREATE INDEX idx_med_plans_patient ON public.medication_plans (patient_id);
CREATE INDEX idx_med_logs_patient_date ON public.medication_logs (patient_id, log_date);
CREATE INDEX idx_followups_patient ON public.followup_items (patient_id, due_date);
CREATE INDEX idx_reminders_scan ON public.reminders (status, next_action_at);
CREATE INDEX idx_checkins_patient ON public.checkins (patient_id, created_at);
CREATE INDEX idx_symptoms_patient ON public.symptom_checks (patient_id, created_at);
CREATE INDEX idx_alerts_status ON public.alerts (status, level, created_at);
CREATE INDEX idx_reports_patient ON public.reports (patient_id, created_at);
CREATE INDEX idx_messages_patient ON public.messages (patient_id, created_at);

-- ---------- 辅助函数（SECURITY DEFINER 防 RLS 自环） ----------
CREATE OR REPLACE FUNCTION public.is_clinician()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT public.get_user_role(auth.uid()) = 'clinician'::public.user_role $$;

CREATE OR REPLACE FUNCTION public.get_my_patient_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT id FROM public.patients WHERE profile_id = auth.uid() LIMIT 1 $$;

-- ---------- profiles 角色守卫（患者不可自行改角色） ----------
CREATE OR REPLACE FUNCTION public.guard_profile_role()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.role <> OLD.role AND auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION '角色不允许自行修改';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_profile_role_trigger
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_role();

-- ---------- RLS：profiles ----------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated USING (id = auth.uid() OR public.is_clinician());
CREATE POLICY profiles_update ON public.profiles FOR UPDATE TO authenticated USING (id = auth.uid() OR public.is_clinician()) WITH CHECK (id = auth.uid() OR public.is_clinician());

-- ---------- RLS：patients ----------
ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;
CREATE POLICY patients_select ON public.patients FOR SELECT TO authenticated USING (profile_id = auth.uid() OR public.is_clinician());
CREATE POLICY patients_insert ON public.patients FOR INSERT TO authenticated WITH CHECK (profile_id = auth.uid() OR public.is_clinician());
CREATE POLICY patients_update ON public.patients FOR UPDATE TO authenticated USING (profile_id = auth.uid() OR public.is_clinician()) WITH CHECK (profile_id = auth.uid() OR public.is_clinician());
CREATE POLICY patients_delete ON public.patients FOR DELETE TO authenticated USING (public.is_clinician());

-- ---------- RLS：documents ----------
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY documents_select ON public.documents FOR SELECT TO authenticated USING (patient_id = public.get_my_patient_id() OR public.is_clinician());
CREATE POLICY documents_insert ON public.documents FOR INSERT TO authenticated WITH CHECK (patient_id = public.get_my_patient_id());
CREATE POLICY documents_update ON public.documents FOR UPDATE TO authenticated USING (patient_id = public.get_my_patient_id() OR public.is_clinician()) WITH CHECK (patient_id = public.get_my_patient_id() OR public.is_clinician());
CREATE POLICY documents_delete ON public.documents FOR DELETE TO authenticated USING (patient_id = public.get_my_patient_id() OR public.is_clinician());

-- ---------- RLS：medication_plans ----------
ALTER TABLE public.medication_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY med_plans_select ON public.medication_plans FOR SELECT TO authenticated USING (patient_id = public.get_my_patient_id() OR public.is_clinician());
CREATE POLICY med_plans_insert ON public.medication_plans FOR INSERT TO authenticated WITH CHECK (patient_id = public.get_my_patient_id() OR public.is_clinician());
CREATE POLICY med_plans_update ON public.medication_plans FOR UPDATE TO authenticated USING (patient_id = public.get_my_patient_id() OR public.is_clinician()) WITH CHECK (patient_id = public.get_my_patient_id() OR public.is_clinician());
CREATE POLICY med_plans_delete ON public.medication_plans FOR DELETE TO authenticated USING (public.is_clinician());

-- ---------- RLS：medication_logs ----------
ALTER TABLE public.medication_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY med_logs_select ON public.medication_logs FOR SELECT TO authenticated USING (patient_id = public.get_my_patient_id() OR public.is_clinician());
CREATE POLICY med_logs_insert ON public.medication_logs FOR INSERT TO authenticated WITH CHECK (patient_id = public.get_my_patient_id());
CREATE POLICY med_logs_update ON public.medication_logs FOR UPDATE TO authenticated USING (patient_id = public.get_my_patient_id()) WITH CHECK (patient_id = public.get_my_patient_id());
CREATE POLICY med_logs_delete ON public.medication_logs FOR DELETE TO authenticated USING (public.is_clinician());

-- ---------- RLS：followup_items ----------
ALTER TABLE public.followup_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY followups_select ON public.followup_items FOR SELECT TO authenticated USING (patient_id = public.get_my_patient_id() OR public.is_clinician());
CREATE POLICY followups_insert ON public.followup_items FOR INSERT TO authenticated WITH CHECK (patient_id = public.get_my_patient_id() OR public.is_clinician());
CREATE POLICY followups_update ON public.followup_items FOR UPDATE TO authenticated USING (patient_id = public.get_my_patient_id() OR public.is_clinician()) WITH CHECK (patient_id = public.get_my_patient_id() OR public.is_clinician());
CREATE POLICY followups_delete ON public.followup_items FOR DELETE TO authenticated USING (public.is_clinician());

-- ---------- RLS：reminders ----------
ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;
CREATE POLICY reminders_select ON public.reminders FOR SELECT TO authenticated USING (patient_id = public.get_my_patient_id() OR public.is_clinician());
CREATE POLICY reminders_insert ON public.reminders FOR INSERT TO authenticated WITH CHECK (patient_id = public.get_my_patient_id() OR public.is_clinician());
CREATE POLICY reminders_update ON public.reminders FOR UPDATE TO authenticated USING (patient_id = public.get_my_patient_id() OR public.is_clinician()) WITH CHECK (patient_id = public.get_my_patient_id() OR public.is_clinician());
CREATE POLICY reminders_delete ON public.reminders FOR DELETE TO authenticated USING (public.is_clinician());

-- ---------- RLS：checkins ----------
ALTER TABLE public.checkins ENABLE ROW LEVEL SECURITY;
CREATE POLICY checkins_select ON public.checkins FOR SELECT TO authenticated USING (patient_id = public.get_my_patient_id() OR public.is_clinician());
CREATE POLICY checkins_insert ON public.checkins FOR INSERT TO authenticated WITH CHECK (patient_id = public.get_my_patient_id());
CREATE POLICY checkins_update ON public.checkins FOR UPDATE TO authenticated USING (patient_id = public.get_my_patient_id()) WITH CHECK (patient_id = public.get_my_patient_id());
CREATE POLICY checkins_delete ON public.checkins FOR DELETE TO authenticated USING (public.is_clinician());

-- ---------- RLS：symptom_checks ----------
ALTER TABLE public.symptom_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY symptoms_select ON public.symptom_checks FOR SELECT TO authenticated USING (patient_id = public.get_my_patient_id() OR public.is_clinician());
CREATE POLICY symptoms_insert ON public.symptom_checks FOR INSERT TO authenticated WITH CHECK (patient_id = public.get_my_patient_id());
CREATE POLICY symptoms_update ON public.symptom_checks FOR UPDATE TO authenticated USING (patient_id = public.get_my_patient_id() OR public.is_clinician()) WITH CHECK (patient_id = public.get_my_patient_id() OR public.is_clinician());
CREATE POLICY symptoms_delete ON public.symptom_checks FOR DELETE TO authenticated USING (public.is_clinician());

-- ---------- RLS：alerts ----------
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY alerts_select ON public.alerts FOR SELECT TO authenticated USING (patient_id = public.get_my_patient_id() OR public.is_clinician());
CREATE POLICY alerts_insert ON public.alerts FOR INSERT TO authenticated WITH CHECK (public.is_clinician());
CREATE POLICY alerts_update ON public.alerts FOR UPDATE TO authenticated USING (public.is_clinician()) WITH CHECK (public.is_clinician());
CREATE POLICY alerts_delete ON public.alerts FOR DELETE TO authenticated USING (public.is_clinician());

-- ---------- RLS：reports ----------
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY reports_select ON public.reports FOR SELECT TO authenticated USING (patient_id = public.get_my_patient_id() OR public.is_clinician());
CREATE POLICY reports_insert ON public.reports FOR INSERT TO authenticated WITH CHECK (public.is_clinician());
CREATE POLICY reports_update ON public.reports FOR UPDATE TO authenticated USING (public.is_clinician()) WITH CHECK (public.is_clinician());
CREATE POLICY reports_delete ON public.reports FOR DELETE TO authenticated USING (public.is_clinician());

-- ---------- RLS：knowledge_docs ----------
ALTER TABLE public.knowledge_docs ENABLE ROW LEVEL SECURITY;
CREATE POLICY knowledge_select ON public.knowledge_docs FOR SELECT TO authenticated USING (true);
CREATE POLICY knowledge_insert ON public.knowledge_docs FOR INSERT TO authenticated WITH CHECK (public.is_clinician());
CREATE POLICY knowledge_update ON public.knowledge_docs FOR UPDATE TO authenticated USING (public.is_clinician()) WITH CHECK (public.is_clinician());
CREATE POLICY knowledge_delete ON public.knowledge_docs FOR DELETE TO authenticated USING (public.is_clinician());

-- ---------- RLS：messages ----------
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_select ON public.messages FOR SELECT TO authenticated USING (patient_id = public.get_my_patient_id() OR public.is_clinician());
CREATE POLICY messages_insert ON public.messages FOR INSERT TO authenticated WITH CHECK (public.is_clinician());
CREATE POLICY messages_update ON public.messages FOR UPDATE TO authenticated USING (patient_id = public.get_my_patient_id() OR public.is_clinician()) WITH CHECK (patient_id = public.get_my_patient_id() OR public.is_clinician());
CREATE POLICY messages_delete ON public.messages FOR DELETE TO authenticated USING (public.is_clinician());

-- ---------- Storage：documents 桶 ----------
CREATE POLICY documents_bucket_read ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = 'documents');
CREATE POLICY documents_bucket_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'documents');
CREATE POLICY documents_bucket_update ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'documents' AND owner = auth.uid()) WITH CHECK (bucket_id = 'documents' AND owner = auth.uid());
CREATE POLICY documents_bucket_delete ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'documents' AND owner = auth.uid());

-- ---------- 演示账号（登录：用户名+密码，邮箱为 username@miaoda.com） ----------
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, last_sign_in_at,
  confirmation_token, recovery_token, email_change, email_change_token_new, email_change_token_current
) VALUES
  ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
   'doctor_wang@miaoda.com', crypt('CareLoop#Doc2026!x7Q', gen_salt('bf', 10)),
   now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"full_name":"王心怡"}'::jsonb,
   now(), now(), now(), '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
   'guifang@miaoda.com', crypt('CareLoop#Gui2026!f9K', gen_salt('bf', 10)),
   now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"full_name":"陈桂芳"}'::jsonb,
   now(), now(), now(), '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
   'jianguo@miaoda.com', crypt('CareLoop#Zhou2026!m3P', gen_salt('bf', 10)),
   now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"full_name":"周建国"}'::jsonb,
   now(), now(), now(), '', '', '', '', '');

UPDATE public.profiles SET username = 'doctor_wang', full_name = '王心怡', phone = '13901000001', role = 'clinician' WHERE email = 'doctor_wang@miaoda.com';
UPDATE public.profiles SET username = 'guifang', full_name = '陈桂芳', phone = '13901000002' WHERE email = 'guifang@miaoda.com';
UPDATE public.profiles SET username = 'jianguo', full_name = '周建国', phone = '13901000003' WHERE email = 'jianguo@miaoda.com';

-- ---------- 业务种子数据 ----------
DO $seed$
DECLARE
  v_doc uuid;
  v_gf uuid;
  v_zj uuid;
  v_gf_profile uuid;
  v_zj_profile uuid;
  v_plan record;
  d date;
BEGIN
  SELECT id INTO v_doc FROM public.profiles WHERE username = 'doctor_wang';
  SELECT id INTO v_gf_profile FROM public.profiles WHERE username = 'guifang';
  SELECT id INTO v_zj_profile FROM public.profiles WHERE username = 'jianguo';

  INSERT INTO public.patients (profile_id, name, gender, age, phone, emergency_contact, emergency_contact_phone, diagnosis, history, allergy, surgery, department, discharge_date, risk_level, assigned_clinician, instructions)
  VALUES (v_gf_profile, '陈桂芳', '女', 68, '13901000002', '陈明（儿子）', '13901000012', '冠心病（三支病变）；冠状动脉旁路移植术后', '高血压3级（很高危）；2型糖尿病', '青霉素', '冠状动脉旁路移植术（CABG）', '心血管外科', CURRENT_DATE - 3, 'red', v_doc, '1. 低盐低脂饮食，每日食盐<5g；2. 术后4周内避免上肢剧烈负重与扩胸运动；3. 每日晨起监测血压、心率并记录；4. 伤口保持干燥，红肿渗液及时上报；5. 术后2周心外科门诊拆线复查。')
  RETURNING id INTO v_gf;

  INSERT INTO public.patients (profile_id, name, gender, age, phone, emergency_contact, emergency_contact_phone, diagnosis, history, allergy, surgery, department, discharge_date, risk_level, assigned_clinician, instructions)
  VALUES (v_zj_profile, '周建国', '男', 59, '13901000003', '周莉（女儿）', '13901000013', '原发性高血压3级（很高危）', '2型糖尿病；高脂血症', '无已知过敏', NULL, '高血压科', CURRENT_DATE - 7, 'yellow', v_doc, '1. 低盐饮食，每日食盐<5g；2. 每日早晚测量血压并记录；3. 规律服药，不可自行停药或减量；4. 每周至少150分钟中等强度有氧运动；5. 2周后高血压门诊复诊。')
  RETURNING id INTO v_zj;

  INSERT INTO public.medication_plans (patient_id, medicine_name, spec, dosage, frequency, slots, note) VALUES
    (v_gf, '阿司匹林肠溶片', '100mg×30片', '100mg', '每日1次', ARRAY[0], '早餐前整片吞服'),
    (v_gf, '硫酸氢氯吡格雷片', '75mg×7片', '75mg', '每日1次', ARRAY[0], '早餐前服用'),
    (v_gf, '阿托伐他汀钙片', '20mg×7片', '20mg', '每日1次', ARRAY[3], '睡前服用'),
    (v_gf, '琥珀酸美托洛尔缓释片', '47.5mg×7片', '47.5mg', '每日1次', ARRAY[0], '早餐后服用，不可掰开嚼碎'),
    (v_zj, '苯磺酸氨氯地平片', '5mg×14片', '5mg', '每日1次', ARRAY[0], '早餐后服用'),
    (v_zj, '缬沙坦胶囊', '80mg×7粒', '80mg', '每日1次', ARRAY[0], '早餐后服用'),
    (v_zj, '阿托伐他汀钙片', '20mg×7片', '20mg', '每日1次', ARRAY[3], '睡前服用');

  -- 陈桂芳打卡：近2日全部按时，今日早间已服
  FOR v_plan IN SELECT id, unnest(slots) AS slot FROM public.medication_plans WHERE patient_id = v_gf LOOP
    FOR d IN SELECT generate_series(CURRENT_DATE - 2, CURRENT_DATE - 1, interval '1 day')::date LOOP
      INSERT INTO public.medication_logs (patient_id, plan_id, log_date, slot, action) VALUES (v_gf, v_plan.id, d, v_plan.slot, 'taken');
    END LOOP;
    IF v_plan.slot = 0 THEN
      INSERT INTO public.medication_logs (patient_id, plan_id, log_date, slot, action) VALUES (v_gf, v_plan.id, CURRENT_DATE, 0, 'taken');
    END IF;
  END LOOP;

  -- 周建国打卡：近6日基本按时，昨晚他汀因胃部不适跳过
  FOR v_plan IN SELECT id, unnest(slots) AS slot FROM public.medication_plans WHERE patient_id = v_zj LOOP
    FOR d IN SELECT generate_series(CURRENT_DATE - 6, CURRENT_DATE - 1, interval '1 day')::date LOOP
      IF v_plan.slot = 3 AND d = CURRENT_DATE - 1 THEN
        INSERT INTO public.medication_logs (patient_id, plan_id, log_date, slot, action, reason) VALUES (v_zj, v_plan.id, d, 3, 'skipped', '晚间胃部不适，电话咨询后暂停一次');
      ELSE
        INSERT INTO public.medication_logs (patient_id, plan_id, log_date, slot, action) VALUES (v_zj, v_plan.id, d, v_plan.slot, 'taken');
      END IF;
    END LOOP;
    IF v_plan.slot = 0 THEN
      INSERT INTO public.medication_logs (patient_id, plan_id, log_date, slot, action) VALUES (v_zj, v_plan.id, CURRENT_DATE, 0, 'taken');
    END IF;
  END LOOP;

  -- 今日提醒（早间已确认；午间一条 25/40 分钟后未确认将升级，供演示 L0-L3 引擎）
  INSERT INTO public.reminders (patient_id, plan_id, slot, remind_date, status, escalation_level, next_action_at)
  SELECT p.patient_id, p.id, s.slot, CURRENT_DATE, 'pending', 0, (CURRENT_DATE + make_interval(hours => s.hour))::timestamptz
  FROM public.medication_plans p
  JOIN (VALUES (0, 8), (1, 12), (2, 18), (3, 21)) AS s(slot, hour) ON s.slot = ANY (p.slots)
  WHERE p.patient_id IN (v_gf, v_zj);

  UPDATE public.reminders SET status = 'acked' WHERE remind_date = CURRENT_DATE AND slot = 0;
  UPDATE public.reminders SET status = 'sent', next_action_at = now() + interval '25 minutes' WHERE patient_id = v_gf AND remind_date = CURRENT_DATE AND slot = 1;
  UPDATE public.reminders SET status = 'sent', next_action_at = now() + interval '40 minutes' WHERE patient_id = v_zj AND remind_date = CURRENT_DATE AND slot = 1;

  -- 随访时间轴
  INSERT INTO public.followup_items (patient_id, title, category, due_date, detail, done) VALUES
    (v_gf, '心血管外科门诊拆线复查', '复诊', CURRENT_DATE + 11, '携带出院小结，评估伤口愈合情况', false),
    (v_gf, '心脏彩超 + 胸片复查', '检查', CURRENT_DATE + 27, '评估心功能与术后恢复', false),
    (v_gf, '每日步行康复训练', '康复', CURRENT_DATE + 7, '从每日15分钟开始，每周递增5分钟，以不引起胸闷为度', false),
    (v_zj, '高血压门诊复诊', '复诊', CURRENT_DATE + 7, '携带血压记录，评估降压方案', false),
    (v_zj, '24小时动态血压监测', '检查', CURRENT_DATE + 21, '评估全天血压节律', false);

  -- 体征打卡
  INSERT INTO public.checkins (patient_id, systolic, diastolic, heart_rate, temperature, blood_glucose, weight, pain_score, note, created_at) VALUES
    (v_gf, 138, 84, 76, 36.6, 6.8, 61.2, 2, '伤口轻微牵拉痛', now() - interval '2 days'),
    (v_gf, 136, 82, 74, 36.5, 6.5, 61.0, 1, NULL, now() - interval '1 day'),
    (v_gf, 142, 88, 78, 36.7, 7.1, 60.8, 2, '今晨略感胸闷，休息后缓解', now() - interval '3 hours'),
    (v_zj, 152, 94, 78, 36.4, 7.6, 78.5, 0, NULL, now() - interval '4 days'),
    (v_zj, 158, 96, 80, 36.5, 7.9, 78.2, 0, NULL, now() - interval '3 days'),
    (v_zj, 155, 95, 79, 36.4, 7.4, 78.0, 0, NULL, now() - interval '2 days'),
    (v_zj, 163, 98, 82, 36.6, 8.2, 77.8, 1, '睡眠不佳', now() - interval '1 day'),
    (v_zj, 160, 96, 80, 36.5, 7.8, 77.6, 0, NULL, now() - interval '5 hours');

  -- 症状自查
  INSERT INTO public.symptom_checks (patient_id, chief_complaint, duration, severity, accompanying, level, advice, evidence, created_at) VALUES
    (v_gf, '晨起胸闷、活动后气短', '1天', 5, '无胸痛、无出汗，休息后缓解', 'red', '术后早期出现胸闷气短需高度重视，请立即联系随访医生或就近就医，完善心电图检查。', '规则引擎：红旗关键词（胸闷、气短）+ 术后背景', now() - interval '3 hours'),
    (v_zj, '头晕伴后颈部胀痛', '2天', 4, '无恶心呕吐，无视物旋转', 'yellow', '血压控制欠佳可引起头晕，请今日加测一次血压并联系随访护士，必要时调整降压方案。', 'MiniMax 分诊模型结合高血压病史', now() - interval '1 day');

  -- 医护预警（红/黄各一条，供预警中心演示）
  INSERT INTO public.alerts (patient_id, source, level, detail, status, created_at) VALUES
    (v_gf, 'triage', 'red', '患者自查上报「晨起胸闷、活动后气短」，红色分诊；近3日收缩压 136-142mmHg。', 'open', now() - interval '3 hours'),
    (v_zj, 'checkin', 'yellow', '近3日收缩压 152-163mmHg，血压控制不稳；昨日起自查头晕（黄色分诊）。', 'open', now() - interval '5 hours');

  -- 消息中心
  INSERT INTO public.messages (patient_id, type, title, content, link_path, read, created_at) VALUES
    (v_gf, 'triage', '症状自查结果：红色预警', '您上报的「晨起胸闷、活动后气短」已触发红色预警，随访医生已收到通知。请立即联系随访医生或就近就医。本内容不构成医疗诊断。', '/patient/symptom', false, now() - interval '3 hours'),
    (v_gf, 'reminder', '今晚 18:00 用药提醒', '别忘了今晚和睡前的用药安排，点击查看今日用药。', '/patient/medications', true, now() - interval '6 hours'),
    (v_gf, 'followup', '出院第3天问候', '陈阿姨您好，出院3天了。记得保持伤口干燥，每日监测血压心率，有任何不适随时自查上报。', '/patient/dashboard', true, now() - interval '2 days'),
    (v_zj, 'triage', '症状自查结果：黄色提醒', '您上报的「头晕伴后颈部胀痛」为黄色提醒，建议今日加测血压并联系随访护士。', '/patient/symptom', false, now() - interval '1 day'),
    (v_zj, 'reminder', '今晚睡前用药提醒', '别忘了睡前服用阿托伐他汀钙片。', '/patient/medications', true, now() - interval '8 hours');

  -- 知识库
  INSERT INTO public.knowledge_docs (title, category, content) VALUES
    ('心脏术后康复期注意事项', '术后康复', '一、伤口护理：保持胸骨切口清洁干燥，2周内禁止盆浴；若出现红肿、渗液、发热（体温>38℃）请立即上报随访医生。
二、活动安排：术后4周内避免上肢剧烈负重与扩胸运动；步行训练从每日15分钟开始，以不引起胸闷气短为度，每周递增5分钟。
三、饮食：低盐低脂，每日食盐<5克，少食多餐，保持大便通畅，避免用力屏气。
四、监测：每日晨起测量血压、心率并记录；如血压>160/100mmHg或心率<50次/分，请及时联系随访护士。
五、服药：阿司匹林与氯吡格雷需长期联用，不可自行停药；如需拔牙或侵入性检查，请提前告知医生正在服用抗血小板药物。'),
    ('高血压患者饮食与生活管理', '慢病管理', '一、限盐：每日食盐摄入<5克，警惕咸菜、腌制品、酱料中的隐形盐。
二、减重：体质指数建议控制在24以下，腰围男性<90厘米、女性<85厘米。
三、运动：每周至少150分钟中等强度有氧运动（快走、慢跑、游泳），避免憋气发力动作。
四、戒烟限酒：建议完全戒烟；男性每日酒精摄入<25克，女性<15克。
五、监测：每日早晚各测量一次血压并记录，测量前静坐5分钟；如连续3日收缩压≥160mmHg，请联系随访护士调整方案。
六、情绪与睡眠：保持规律作息，避免情绪剧烈波动；睡眠不佳可引起晨起血压升高。'),
    ('出院后常用药物服用须知', '用药指导', '一、阿司匹林肠溶片：早餐前整片吞服，不可嚼碎；常见副作用为胃部不适，可遵医嘱联合护胃药；出现黑便、牙龈出血请立即上报。
二、硫酸氢氯吡格雷片：与阿司匹林同服增强抗血小板效果；当日发现漏服可补服，次日发现勿加倍。
三、阿托伐他汀钙片：睡前服用；服药期间如出现肌肉酸痛、乏力、尿色加深，请及时联系医生。
四、苯磺酸氨氯地平片：可能引起踝部水肿与面部潮红，多为良性，持续加重请复诊。
五、缬沙坦胶囊：降压同时保护肾脏；用药期间避免大量摄入高钾食物。');

  -- 已确认的出院小结（陈桂芳，归档展示）
  INSERT INTO public.documents (patient_id, file_url, status, parsed_json, created_at)
  VALUES (v_gf, 'documents/seed/guifang-discharge-summary.jpg', 'confirmed', jsonb_build_object(
    'diagnosis', jsonb_build_array('冠心病（三支病变）', '冠状动脉旁路移植术后', '高血压3级（很高危）', '2型糖尿病'),
    'medications', jsonb_build_array(
      jsonb_build_object('name', '阿司匹林肠溶片', 'spec', '100mg', 'dosage', '100mg 每日1次 早餐前'),
      jsonb_build_object('name', '硫酸氢氯吡格雷片', 'spec', '75mg', 'dosage', '75mg 每日1次 早餐前'),
      jsonb_build_object('name', '阿托伐他汀钙片', 'spec', '20mg', 'dosage', '20mg 每日1次 睡前'),
      jsonb_build_object('name', '琥珀酸美托洛尔缓释片', 'spec', '47.5mg', 'dosage', '47.5mg 每日1次 早餐后')
    ),
    'followup', jsonb_build_array(
      jsonb_build_object('title', '心血管外科门诊拆线复查', 'date', to_char(CURRENT_DATE + 11, 'YYYY-MM-DD')),
      jsonb_build_object('title', '心脏彩超+胸片复查', 'date', to_char(CURRENT_DATE + 27, 'YYYY-MM-DD'))
    ),
    'notes', jsonb_build_array('低盐低脂饮食，每日食盐<5g', '术后4周内避免上肢剧烈负重', '每日监测血压心率并记录', '伤口红肿渗液及时上报')
  ), now() - interval '3 days');

  -- 随访报告示例（周建国，已归档）
  INSERT INTO public.reports (patient_id, period_days, content, status, clinician_note, created_by, created_at)
  VALUES (v_zj, 7, jsonb_build_object(
    'adherence', '95%',
    'medication_total', 20,
    'medication_taken', 19,
    'medication_skipped', 1,
    'bp_summary', '收缩压 152-163mmHg，舒张压 94-98mmHg，控制未达标',
    'symptoms', jsonb_build_array('头晕伴后颈部胀痛（黄色分诊）'),
    'alerts_count', 1,
    'summary', '出院1周，服药依从性良好，但血压控制未达标，昨日起出现头晕症状。建议强化限盐宣教，2周内门诊复诊调整降压方案，必要时完善动态血压监测。'
  ), 'archived', '已电话沟通，强调限盐与按时服药，嘱2周内门诊复诊调整方案。', v_doc, now() - interval '6 hours');
END
$seed$;
