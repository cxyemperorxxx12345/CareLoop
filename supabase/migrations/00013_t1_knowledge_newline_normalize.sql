-- T1 一次性清洗：knowledge_docs 正文中被 JSON 字符串化转义的换行还原为真实换行符
-- 现象：content 里存的是「反斜杠 + n」两个字符（字面 \n），导致知识库卡片与智能问答引用时换行失效。
-- 幂等：WHERE 条件只命中确实含字面 \n 或真实 CRLF 的行，重复执行无副作用。
-- 说明：Postgres 默认 standard_conforming_strings = on，所以 '\n' 表示「反斜杠 + n」两个字符，
--       真正的换行符要用 chr(10)，回车符用 chr(13)。
-- 只涉及 public.knowledge_docs，不触碰其他表。

UPDATE public.knowledge_docs
SET
  content = replace(
    replace(
      -- 顺序不能反：先把字面 \r\n 还原成真换行，再处理单独的字面 \n
      replace(replace(content, '\r\n', chr(10)), '\n', chr(10)),
      -- 真实 CRLF 归一成 LF
      chr(13) || chr(10),
      chr(10)
    ),
    -- 单独存在的真实 CR 也归一成 LF
    chr(13),
    chr(10)
  ),
  title = CASE WHEN title IS NOT NULL THEN btrim(title) ELSE title END
-- 用 position() 而不是 LIKE 判定：LIKE 的默认转义符就是反斜杠，
-- 写 '%\n%' 会被解析成「匹配字母 n」，造成过度匹配。position() 是纯子串查找，语义精确。
WHERE
  content IS NOT NULL
  AND (
    position('\r\n' IN content) > 0   -- 字面反斜杠 r + 反斜杠 n
    OR position('\n' IN content) > 0  -- 字面反斜杠 + n
    OR position(chr(13) || chr(10) IN content) > 0
    OR position(chr(13) IN content) > 0
  );
