-- 补齐 chenming 的 auth.identities 记录（GoTrue 登录依赖 identities 查询；email 为生成列不可显式插入）
INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
SELECT gen_random_uuid()::text, u.id,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true, 'phone_verified', false),
  'email', now(), now(), now()
FROM auth.users u
WHERE u.email = 'chenming@miaoda.com'
  AND NOT EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id);

-- 验证
SELECT i.provider, i.email, p.username, p.role FROM auth.identities i JOIN public.profiles p ON p.id = i.user_id WHERE i.email = 'chenming@miaoda.com';