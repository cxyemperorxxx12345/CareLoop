-- ===== 家属关怀模式：照护绑定表 =====
CREATE TABLE public.care_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  family_name text NOT NULL,
  relation text NOT NULL CHECK (relation IN ('儿子','女儿','配偶','其他')),
  phone text,
  is_primary boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','REVOKED')),
  authorized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.care_relations ENABLE ROW LEVEL SECURITY;

CREATE POLICY care_relations_select ON public.care_relations FOR SELECT TO authenticated
  USING ((EXISTS (SELECT 1 FROM public.patients p WHERE p.id = care_relations.patient_id AND p.profile_id = auth.uid())) OR is_clinician());
CREATE POLICY care_relations_insert ON public.care_relations FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.patients p WHERE p.id = care_relations.patient_id AND p.profile_id = auth.uid()));
CREATE POLICY care_relations_update ON public.care_relations FOR UPDATE TO authenticated
  USING ((EXISTS (SELECT 1 FROM public.patients p WHERE p.id = care_relations.patient_id AND p.profile_id = auth.uid())) OR is_clinician());
CREATE POLICY care_relations_delete ON public.care_relations FOR DELETE TO authenticated
  USING ((EXISTS (SELECT 1 FROM public.patients p WHERE p.id = care_relations.patient_id AND p.profile_id = auth.uid())) OR is_clinician());

-- ===== alerts：家属任务与响应字段 =====
ALTER TABLE public.alerts ADD COLUMN assignee_role text NOT NULL DEFAULT 'clinician' CHECK (assignee_role IN ('clinician','family'));
ALTER TABLE public.alerts ADD COLUMN family_action text CHECK (family_action IN ('dosed','contacted','escalate'));
ALTER TABLE public.alerts ADD COLUMN family_responded_at timestamptz;

-- ===== medication_logs：代打卡来源标注 =====
ALTER TABLE public.medication_logs ADD COLUMN operator_type text NOT NULL DEFAULT 'patient' CHECK (operator_type IN ('patient','family'));
ALTER TABLE public.medication_logs ADD COLUMN operator_name text;

-- ===== 家属响应 RPC（SECURITY DEFINER：患者端家属模式回写响应，不放宽 alerts 全列 UPDATE）=====
CREATE OR REPLACE FUNCTION public.family_respond_alert(p_alert_id uuid, p_action text, p_family_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 仅允许该预警所属患者的账号触发（患者端家属协助模式）
  IF NOT EXISTS (
    SELECT 1 FROM public.alerts a
    JOIN public.patients p ON p.id = a.patient_id
    WHERE a.id = p_alert_id AND p.profile_id = auth.uid()
  ) THEN
    RAISE EXCEPTION '无权响应该预警';
  END IF;
  IF p_action NOT IN ('dosed', 'contacted', 'escalate') THEN
    RAISE EXCEPTION '无效的响应动作';
  END IF;

  UPDATE public.alerts
  SET family_action = p_action,
      family_responded_at = now(),
      detail = detail || E'\n家属 ' || p_family_name || ' 已响应：' ||
        CASE p_action
          WHEN 'dosed' THEN '已代为打卡服药'
          WHEN 'contacted' THEN '已联系患者'
          WHEN 'escalate' THEN '患者仍无响应，请医护介入'
        END
  WHERE id = p_alert_id;

  -- 已代打卡：链路终止，预警关闭
  IF p_action = 'dosed' THEN
    UPDATE public.alerts SET status = 'resolved', assignee_role = 'clinician' WHERE id = p_alert_id;
  END IF;
  -- 转医护：升级为红旗并交还医护处理
  IF p_action = 'escalate' THEN
    UPDATE public.alerts SET level = 'red', assignee_role = 'clinician' WHERE id = p_alert_id;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.family_respond_alert(uuid, text, text) TO authenticated;

-- ===== 预置演示数据：陈桂芳 ↔ 陈明 ACTIVE 绑定 + 一条 L2 家属协助任务 =====
INSERT INTO public.care_relations (patient_id, family_name, relation, phone, is_primary, status, authorized_at)
SELECT id, '陈明', '儿子', '13901000012', true, 'ACTIVE', now() - interval '5 days'
FROM public.patients WHERE name = '陈桂芳';

INSERT INTO public.alerts (patient_id, level, source, detail, status, assignee_role, created_at)
SELECT id, 'yellow', 'medication',
  '【待家属协助】陈桂芳 睡前 21:00 的 阿托伐他汀 20mg 超过 30 分钟未确认，请协助确认服药或联系患者。',
  'open', 'family', now() - interval '40 minutes'
FROM public.patients WHERE name = '陈桂芳';