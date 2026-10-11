// 愈见 CareLoop 核心实体与类型定义

export type UserRole = 'patient' | 'clinician' | 'family';

export type AlertLevel = 'green' | 'yellow' | 'red';

export type ReminderStatus = 'pending' | 'sent' | 'acked' | 'snoozed' | 'escalated';

export type MedicationAction = 'taken' | 'snoozed' | 'skipped';

export type DocumentStatus = 'uploaded' | 'parsing' | 'parsed' | 'confirmed' | 'failed';

export type AlertStatus = 'open' | 'resolved';

export interface Profile {
  id: string;
  username: string;
  role: UserRole;
  full_name: string;
  phone?: string | null;
  avatar_url?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Patient {
  id: string;
  user_id: string;
  name: string;
  gender?: string | null;
  age?: number | null;
  phone?: string | null;
  bed_no?: string | null;
  diagnosis?: string | null;
  surgery?: string | null;
  discharge_date: string;
  department?: string | null;
  attending_doctor?: string | null;
  emergency_contact?: {
    name?: string;
    phone?: string;
    relation?: string;
  } | null;
  medical_history?: string | null;
  allergy?: string | null;
  risk_level: AlertLevel;
  compliance_rate?: number;
  assigned_nurse_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MedicationPlan {
  id: string;
  patient_id: string;
  document_id?: string | null;
  name: string;
  specification?: string | null;
  dosage: string;
  frequency: string;
  time_slots: number[]; // 0:早8, 1:中12, 2:晚18, 3:睡前21
  start_date: string;
  end_date?: string | null;
  notes?: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface MedicationLog {
  id: string;
  plan_id: string;
  patient_id: string;
  scheduled_date: string;
  time_slot: number;
  action: MedicationAction;
  action_time: string;
  reason?: string | null;
  created_at: string;
}

export interface Reminder {
  id: string;
  patient_id: string;
  plan_id?: string | null;
  scheduled_at: string;
  time_slot: number;
  current_level: number; // 0, 1, 2, 3
  status: ReminderStatus;
  snooze_until?: string | null;
  next_action_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface SymptomCheck {
  id: string;
  patient_id: string;
  chief_complaint: string;
  duration?: string | null;
  severity: number;
  accompanying_symptoms?: string | null;
  temperature?: number | null;
  systolic_bp?: number | null;
  diastolic_bp?: number | null;
  triage_level: AlertLevel;
  advice: string;
  evidence?: string | null;
  is_flagged: boolean;
  created_at: string;
}

export interface Alert {
  id: string;
  patient_id: string;
  level: AlertLevel;
  source: 'triage' | 'medication' | 'checkin' | 'manual';
  source_id?: string | null;
  title: string;
  detail: string;
  status: AlertStatus;
  action_taken?: string | null;
  handled_by?: string | null;
  handled_at?: string | null;
  created_at: string;
  patient?: Patient;
}

export interface HealthCheckin {
  id: string;
  patient_id: string;
  checkin_date: string;
  systolic_bp?: number | null;
  diastolic_bp?: number | null;
  heart_rate?: number | null;
  temperature?: number | null;
  blood_sugar?: number | null;
  weight?: number | null;
  pain_score?: number | null;
  notes?: string | null;
  created_at: string;
}

export interface FollowupItem {
  id: string;
  patient_id: string;
  title: string;
  due_date: string;
  category: string;
  status: 'pending' | 'completed' | 'cancelled';
  notes?: string | null;
  completed_at?: string | null;
  created_at: string;
}

export interface CareDocument {
  id: string;
  patient_id: string;
  file_url: string;
  file_name?: string | null;
  file_type?: string | null;
  status: DocumentStatus;
  parsed_json?: any;
  error_message?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CareMessage {
  id: string;
  patient_id: string;
  type: 'reminder' | 'escalation' | 'triage' | 'followup' | 'system';
  title: string;
  content: string;
  is_read: boolean;
  link_path?: string | null;
  created_at: string;
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  category: string;
  content: string;
  tags?: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface FollowupReport {
  id: string;
  patient_id: string;
  period_start: string;
  period_end: string;
  content: {
    period_days: number;
    compliance_rate: number;
    summary: string;
    vitals_summary?: {
      bp_avg?: string;
      hr_avg?: number;
      temp_max?: number;
    };
    alert_count?: number;
    doctor_notes?: string;
  };
  status: 'draft' | 'archived';
  created_by?: string | null;
  created_at: string;
  updated_at: string;
  patient?: Patient;
}
