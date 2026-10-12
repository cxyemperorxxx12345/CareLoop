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

