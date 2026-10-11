ALTER TABLE public.messages ADD COLUMN dedup_key text;
CREATE UNIQUE INDEX messages_patient_dedup_idx ON public.messages(patient_id, dedup_key) WHERE dedup_key IS NOT NULL;