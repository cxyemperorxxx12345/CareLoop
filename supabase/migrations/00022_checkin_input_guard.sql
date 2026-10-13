-- 00022：体征输入守卫；空参数不再清空已有的当日记录。
-- 不修改历史记录，仅约束后续写入。NOT VALID 保留历史异常数据供人工核对。
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.checkins'::regclass AND conname='checkins_vital_bounds') THEN
    ALTER TABLE public.checkins ADD CONSTRAINT checkins_vital_bounds CHECK (
      (systolic IS NULL OR systolic BETWEEN 60 AND 260) AND
      (diastolic IS NULL OR diastolic BETWEEN 30 AND 180) AND
      (heart_rate IS NULL OR heart_rate BETWEEN 30 AND 200) AND
      (temperature IS NULL OR temperature BETWEEN 33 AND 42) AND
      (blood_glucose IS NULL OR blood_glucose BETWEEN 2 AND 30) AND
      (weight IS NULL OR weight BETWEEN 20 AND 200) AND
      ((systolic IS NULL AND diastolic IS NULL) OR (systolic IS NOT NULL AND diastolic IS NOT NULL AND systolic > diastolic))
    ) NOT VALID;
  END IF;
END $$;

-- 直接表写入与 RPC 都执行同一守卫，返回可读错误。
CREATE OR REPLACE FUNCTION public.validate_checkin_write()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('收缩压', NEW.systolic::numeric, 60, 260), ('舒张压', NEW.diastolic::numeric, 30, 180),
    ('心率', NEW.heart_rate::numeric, 30, 200), ('体温', NEW.temperature, 33, 42),
    ('血糖', NEW.blood_glucose, 2, 30), ('体重', NEW.weight, 20, 200), ('疼痛评分', NEW.pain_score::numeric, 0, 10)
  ) AS v(label,value,low,high) LOOP
    IF r.value IS NOT NULL AND NOT (r.value BETWEEN r.low AND r.high) THEN
      RAISE EXCEPTION '%超出可录入范围，请核对读数和单位', r.label;
    END IF;
  END LOOP;
  IF (NEW.systolic IS NULL) <> (NEW.diastolic IS NULL) THEN
    RAISE EXCEPTION '血压需要同时填写收缩压和舒张压';
  END IF;
  IF NEW.systolic IS NOT NULL AND NEW.systolic <= NEW.diastolic THEN
    RAISE EXCEPTION '收缩压应高于舒张压，请核对两项是否填反';
  END IF;
  IF NEW.systolic IS NULL AND NEW.diastolic IS NULL AND NEW.heart_rate IS NULL
     AND NEW.temperature IS NULL AND NEW.blood_glucose IS NULL AND NEW.weight IS NULL
     AND NEW.pain_score IS NULL AND NULLIF(trim(NEW.note),'') IS NULL THEN
    RAISE EXCEPTION '请填写至少一项实测数据或备注';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS checkins_validate_write ON public.checkins;
CREATE TRIGGER checkins_validate_write BEFORE INSERT OR UPDATE ON public.checkins
  FOR EACH ROW EXECUTE FUNCTION public.validate_checkin_write();

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
    UPDATE public.checkins SET systolic = COALESCE(p_systolic, systolic), diastolic = COALESCE(p_diastolic, diastolic),
      heart_rate = COALESCE(p_heart_rate, heart_rate), temperature = COALESCE(p_temperature, temperature), blood_glucose = COALESCE(p_blood_glucose, blood_glucose),
      weight = COALESCE(p_weight, weight), pain_score = COALESCE(p_pain_score, pain_score), note = COALESCE(p_note, note), created_at = v_ts WHERE id = v_id;
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
