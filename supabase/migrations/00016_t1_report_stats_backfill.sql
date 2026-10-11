-- T1 · 第 3 项：存量随访报告的统计数据结构补齐
--
-- 问题：种子里那封「周建国」的已归档报告，content 是**扁平结构**
--   { adherence:'95%', medication_total:20, medication_taken:19, medication_skipped:1,
--     bp_summary:'收缩压 152-163mmHg…', symptoms:['头晕伴后颈部胀痛（黄色分诊）'],
--     alerts_count:1, summary:'出院1周…' }
--   没有嵌套的 stats 对象。前端 `content?.stats` 取不到 → 渲染「本报告暂无统计数据」，
--   而 `content.summary` 有值又渲染出完整小结 —— 同一张卡片出现自相矛盾的两段。
--
-- 修法（只做加法，不丢数据）：
--   把扁平结构**派生**出一份标准 stats，summary 提升为顶层键，
--   原始扁平内容原封不动保留在 stats.legacy_flat，便于回溯。
--
-- 幂等：只处理 content 里没有 stats、但有 summary 的行；重复执行不会再命中。
-- 安全边界：不删除任何报告，不修改 status / clinician_note / 任何业务表。

UPDATE public.reports
SET content = jsonb_build_object(
  'stats', jsonb_build_object(
    'period_days', COALESCE(NULLIF(content ->> 'period_days', '')::int, period_days),

    'adherence', jsonb_build_object(
      'taken',   COALESCE(NULLIF(content ->> 'medication_taken', '')::int, 0),
      'skipped', COALESCE(NULLIF(content ->> 'medication_skipped', '')::int, 0),
      'snoozed', 0,
      'answered', COALESCE(NULLIF(content ->> 'medication_total', '')::int, 0),
      -- 依从率：优先用 taken/total 实算；算不出来时退回解析 "95%" 这种文本
      'compliance_rate', COALESCE(
        CASE
          WHEN NULLIF(content ->> 'medication_total', '')::int > 0
            THEN round(
              NULLIF(content ->> 'medication_taken', '')::int::numeric
              / NULLIF(content ->> 'medication_total', '')::int * 100
            )::int
        END,
        NULLIF(regexp_replace(COALESCE(content ->> 'adherence', ''), '[^0-9.]', '', 'g'), '')::int,
        0
      )
    ),

    'vitals', jsonb_build_object(
      'records', 0,
      'systolic_avg', NULL,
      'diastolic_avg', NULL,
      'heart_rate_avg', NULL,
      'temperature_max', NULL,
      -- 扁平结构只有一段血压文字描述，没有可拆分的数值，原样保留
      'note', content ->> 'bp_summary'
    ),

    -- 扁平结构的 symptoms 是字符串数组，统一转成 {chief_complaint, level} 对象数组
    'symptoms', CASE
      WHEN jsonb_typeof(content -> 'symptoms') = 'array'
        THEN COALESCE(
          (SELECT jsonb_agg(jsonb_build_object('chief_complaint', t, 'level', 'yellow'))
           FROM jsonb_array_elements_text(content -> 'symptoms') AS t),
          '[]'::jsonb
        )
      ELSE '[]'::jsonb
    END,

    'alerts', jsonb_build_object(
      'total', COALESCE(NULLIF(content ->> 'alerts_count', '')::int, 0),
      'open', 0,
      'red', 0,
      'yellow', 0
    ),

    -- 原始扁平内容整段保留，不丢任何信息
    'legacy_flat', content
  ),
  'summary', content ->> 'summary'
)
WHERE content -> 'stats' IS NULL
  AND content ->> 'summary' IS NOT NULL;
