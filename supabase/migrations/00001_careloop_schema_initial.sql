-- ============ CareLoop 初始 schema ============
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 角色枚举（患者/医护）
CREATE TYPE public.user_role AS ENUM ('patient', 'clinician');
CREATE TYPE public.doc_status AS ENUM ('pending', 'parsing', 'parsed', 'failed', 'confirmed');
CREATE TYPE public.med_action AS ENUM ('taken', 'snoozed', 'skipped');
CREATE TYPE public.reminder_status AS ENUM ('pending', 'sent', 'acked', 'snoozed', 'escalated');
CREATE TYPE public.triage_level AS ENUM ('green', 'yellow', 'red');
CREATE TYPE public.alert_level AS ENUM ('yellow', 'red');
CREATE TYPE public.alert_status AS ENUM ('open', 'resolved');
CREATE TYPE public.report_status AS ENUM ('draft', 'archived');
CREATE TYPE public.message_type AS ENUM ('reminder', 'followup', 'triage', 'escalation', 'clinician_reply');

-- ============ profiles（auth 触发器同步） ============
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username text UNIQUE,
  email text,
  phone text,
  full_name text,
  role public.user_role NOT NULL DEFAULT 'patient',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, phone, role)
  VALUES (NEW.id, NEW.email, NEW.phone, 'patient'::public.user_role);
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- 角色读取辅助（防 RLS 自环）
CREATE OR REPLACE FUNCTION public.get_user_role(uid uuid)
RETURNS public.user_role
LANGUAGE sql
SECURITY DEFINER SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = uid;
$$;

-- ============ patients（患者档案） ============
CREATE TABLE public.patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  name text NOT NULL,
  gender text,
  age int,
  phone text,
  emergency_contact text,
  emergency_contact_phone text,
  diagnosis text,
  history text,
  allergy text,
  surgery text,
  department text,
  discharge_date date NOT NULL DEFAULT CURRENT_DATE,
  risk_level public.triage_level NOT NULL DEFAULT 'green',
  assigned_clinician uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  instructions text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============ documents（出院资料） ============
CREATE TABLE public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  file_url text NOT NULL,
  status public.doc_status NOT NULL DEFAULT 'pending',
  parsed_json jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============ medication_plans（用药计划） ============
CREATE TABLE public.medication_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  medicine_name text NOT NULL,
  spec text,
  dosage text,
  frequency text,
  slots int[] NOT NULL DEFAULT '{}',
  note text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============ medication_logs（用药打卡，幂等） ============
CREATE TABLE public.medication_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES public.medication_plans(id) ON DELETE CASCADE,
  log_date date NOT NULL DEFAULT CURRENT_DATE,
  slot int NOT NULL,
  action public.med_action NOT NULL,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, log_date, slot)
);

-- ============ followup_items（随访时间轴） ============
CREATE TABLE public.followup_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  title text NOT NULL,
  category text NOT NULL DEFAULT 'followup',
  due_date date NOT NULL,
  detail text,
  done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============ reminders（提醒 + L0-L3 升级状态机） ============
CREATE TABLE public.reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES public.medication_plans(id) ON DELETE CASCADE,
  slot int NOT NULL,
  remind_date date NOT NULL DEFAULT CURRENT_DATE,
  status public.reminder_status NOT NULL DEFAULT 'pending',
  escalation_level int NOT NULL DEFAULT 0,
  next_action_at timestamptz NOT NULL,
  snooze_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, remind_date, slot)
);

-- ============ checkins（健康打卡） ============
CREATE TABLE public.checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  systolic int,
  diastolic int,
  heart_rate int,
  temperature numeric(4,1),
  blood_glucose numeric(5,1),
  weight numeric(5,1),
  pain_score int CHECK (pain_score BETWEEN 0 AND 10),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============ symptom_checks（症状自查） ============
CREATE TABLE public.symptom_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  chief_complaint text NOT NULL,
  duration text,
  severity int,
  accompanying text,
  level public.triage_level NOT NULL,
  advice text,
  evidence text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============ alerts（预警中心） ============
CREATE TABLE public.alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  source text NOT NULL,
  level public.alert_level NOT NULL,
  detail text,
  status public.alert_status NOT NULL DEFAULT 'open',
  action text,
  resolution_note text,
  handled_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  handled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============ reports（随访报告） ============
CREATE TABLE public.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  period_days int NOT NULL DEFAULT 7,
  content jsonb NOT NULL,
  status public.report_status NOT NULL DEFAULT 'draft',
  clinician_note text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============ knowledge_docs（知识库） ============
CREATE TABLE public.knowledge_docs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  category text NOT NULL DEFAULT '宣教资料',
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============ messages（消息中心） ============
CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  type public.message_type NOT NULL DEFAULT 'reminder',
  title text NOT NULL,
  content text NOT NULL,
  link_path text,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============ Storage bucket ============
INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', true)
ON CONFLICT (id) DO NOTHING;
