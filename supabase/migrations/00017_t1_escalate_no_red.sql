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
