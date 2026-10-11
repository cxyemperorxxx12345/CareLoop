-- T1 · 第 3 项：messages 幂等查重索引
-- 背景：reminder-scan 被 pg_cron 每分钟轮询，边界条件下会对同一条提醒重复 INSERT，
--       造成患者端消息中心出现重复条目。修法是在插入侧补 dedup_key（见 reminder-scan /
--       triage-symptom），并在数据库层加唯一约束兜底。
-- 说明：00011 建的是「部分唯一索引」（WHERE dedup_key IS NOT NULL），PostgREST 的
--       ON CONFLICT 无法推断部分索引，因此这里换成**非部分**唯一索引。
--       PostgreSQL 的唯一索引把 NULL 视为互不相等，因此历史行（dedup_key 为 NULL）
--       不会互相冲突，无需回填即可安全替换；未带 dedup_key 的新写入也不受影响。

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS dedup_key text;

DROP INDEX IF EXISTS public.messages_patient_dedup_idx;

CREATE UNIQUE INDEX IF NOT EXISTS messages_patient_dedup_idx
  ON public.messages (patient_id, dedup_key);

COMMENT ON COLUMN public.messages.dedup_key IS
  '幂等查重键：patient_id + 业务维度 + 时间窗口。NULL 表示不参与去重。';
