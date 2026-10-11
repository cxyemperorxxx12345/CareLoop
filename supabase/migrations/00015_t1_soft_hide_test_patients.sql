-- T1 · 第 2 条：测试账号「软隐藏」（铁律：禁止删除 auth.users 任何记录 / 禁止 auth.admin.deleteUser）
--
-- 说明：患者列表里残留「陶璨」「陈总」两条测试档案（诊断、年龄全空）。
-- 按要求改为软隐藏 —— 用 public.patients.is_hidden（迁移 00010 已建，NOT NULL DEFAULT false），
-- 这两条置 true，列表查询统一加 `is_hidden is not true` 过滤。
-- 展示效果与删除一致，但完全不触碰 auth.users / auth.identities 里的登录凭证。
--
-- 安全边界：只按「邮箱 + 姓名」双重匹配命中这两条，不做任何无差别更新；幂等，可重复执行。

UPDATE public.patients p
SET is_hidden = true
FROM public.profiles pr
WHERE p.profile_id = pr.id
  AND pr.email IN ('cxyemperorxxx12345@miaoda.com', 'taocan2008@miaoda.com')
  AND p.name IN ('陈总', '陶璨')
  AND p.is_hidden IS NOT TRUE;

COMMENT ON COLUMN public.patients.is_hidden IS
  '软隐藏标记：true 表示演示期残留的测试档案，所有列表查询统一过滤 is_hidden is not true。严禁改用删除。';
