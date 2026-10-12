-- T1 · 演示账号密码与登录页「一键填入」对齐
--
-- 背景：登录页（src/pages/LoginPage.tsx）一键填入的演示密码为 GuiFang@CareLoop2026 等口径，
--   而 00002 种子建号时使用的是 CareLoop#Gui2026!f9K 等旧口令；线上库口令被手工调整过，
--   导致「按迁移重建的新库 → 一键填入后登录失败」，新协作者无法直接跑起来。
--   本迁移把四个演示账号的口径统一到登录页（00007 建号的陈明本就一致，一并幂等重设）。
--
-- 幂等：重复执行即为同一口令，无副作用。
-- 边界：只改这四个 @miaoda.com 演示账号，不触碰任何其他用户；不删除、不新建账号。
-- 注意：需在 Supabase SQL Editor 以 postgres 身份执行（auth.users 属平台保留表）。

UPDATE auth.users
SET encrypted_password = crypt('GuiFang@CareLoop2026', gen_salt('bf', 10)), updated_at = now()
WHERE email = 'guifang@miaoda.com';

UPDATE auth.users
SET encrypted_password = crypt('JianGuo@CareLoop2026', gen_salt('bf', 10)), updated_at = now()
WHERE email = 'jianguo@miaoda.com';

UPDATE auth.users
SET encrypted_password = crypt('DrWang@CareLoop2026', gen_salt('bf', 10)), updated_at = now()
WHERE email = 'doctor_wang@miaoda.com';

UPDATE auth.users
SET encrypted_password = crypt('ChenMing@CareLoop2026', gen_salt('bf', 10)), updated_at = now()
WHERE email = 'chenming@miaoda.com';
