# 认证与权限 Debug 准则

适用症状：登录失败/卡住、权限不足、数据被 RLS 过滤为空、Realtime 收不到事件。

---

## 认证登录

### 先直连后端查真实错误码和账号状态

排查登录/认证失败时，不要只在前端改路由、错误提示或输入格式。第一步：

- 用 service_role 调 auth admin API 或直接请求 auth/v1/token 获取真实错误码
- 查 auth.users、auth.identities 确认账号完整性与 NULL 状态
- GoTrue 要求某些字段为非 NULL 字符串，实际为 NULL 会导致 500

确认后端认证链路正常后，再改前端。

### 登录/权限类走真实 Auth 接口闭环

登录/权限类 bug 必须：

- 先查 auth.users / profiles / identities 等真实账号态
- 用提示的测试账号走真实认证接口复现

不要绕过认证直接测页面逻辑。

---

## RLS 策略

### 改全量数据源前必须先确认 RLS

把前端数据源从"子集/关联表"改为"全量查某张表"时：

- 先查该表的 RLS 策略：authenticated 角色是否有权读全部行
- 若存在 own_record / role_filter 限制，普通用户只能查到自己的行
- 解决方案：新建 Edge Function 用 service_role_key 取全量数据，前端调用该函数

### Realtime 订阅受 RLS 保护的表

使用 Supabase Realtime 监听启用 RLS 的表时：

- 在 subscribe() 前注入当前用户的 access_token（setAuth 或 setSession）
- 确保登录状态变化时重建 channel
- 用 Network/Realtime 面板验证事件确实推送到前端
- anon key 连接被 RLS 拒绝时不会报错，只是静默无事件

---

## 排查顺序（定位根因用）

1. 直接用 curl/API 测认证接口，确认返回码和错误信息
2. 查 auth.users 表确认账号存在且字段完整
3. 查目标表 RLS 策略，确认当前角色的可见范围
4. 用目标角色身份查询数据，确认返回条数
5. 最后才查前端路由/跳转逻辑
