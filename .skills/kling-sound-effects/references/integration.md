# 秒哒集成

## 部署顺序
1. 在有真实登录的应用执行 assets/schema.sql。该表仅用户可读，写入由 Edge 完成。私有 bucket kling-audio。
2. 将 edge.ts 改名 index.ts，与 core.mjs、media-policy.mjs 一起部署到 kling-audio。依赖 npm:@supabase/supabase-js@2；在目标平台检查实际构建。
3. 后端配置 SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、INTEGRATIONS_API_KEY、APP_ORIGIN。APP_ORIGIN 填真实应用来源。可选的私有转存配置 MEDIA_HOSTS 填经实际返回确认的精确媒体域名、逗号分隔，不使用通配符；下载拒绝重定向。
4. 已回填四个后台 API ID。Edge 使用网关地址和 X-Gateway-Authorization；当前用户会话用于本应用鉴权，二者不可混用。上线前实测目标秒哒 Edge 的网关转发、路径替换及四项接口。
5. 前端复制 client.js；`const api=audioClient(supabase)`；用户点击创建时生成一次 crypto.randomUUID() 并立即保存当前 UUID。调用 `api.call({action:'create',id,kind:'text',params:{prompt:'海浪拍岸',duration:5}})`；传入 api.watch(id,onUpdate,signal)，onUpdate 调用 api.render(container,task)。页面卸载 AbortController.abort()；同一任务只启动一个 watch。
6. 登录后 list 返回该用户最近 50 条，恢复未完成记录 watch；succeeded 立即渲染原始 media，不自动调用 save；仅 can_save=true 时提供单独私有转存按钮。无需前端传 owner。
7. `save` 返回私有存储短期签名链接，原生播放器可播放，链接可打开下载。要求直接下载时可用 Blob 下载，但先验证 CORS，不伪造成功 toast。音视频请求加载失败应显示重试。

## 有意保留的限制
- 当前转存每文件 32 MiB、下载超时 20 秒，这是 Edge 参考实现的资源保护预算，不是上游能力限制。更大文件须接平台支持的分段/后台转存能力并实测；不要宣称所有 100M 视频可在此预算内成功转存。
- 参考视频时长/容器/大小需要上传控件检测并由上游最终校验；客户端声明不等于可信服务器元数据。可灵来源 ID 在本表本人的视频结果中验证，外部技能任务必须先接可信来源映射。
- 创建异常可能已扣费，timeout 保留本地 external ID。缺失系统 ID 时交管理员按官方外部 ID 查询协议对账；未核实协议前不自动重发创建。
- 两个账号级列表仍在原始参考资料，应用与脚本均不开放。
- 限流/配额需接平台实际能力；上线前补用户级次数及并发预算，参考实现仅提供任务查询租约和同 UUID 防重复创建，不能替代全局用量治理。

## 双用户验收（上线前必测）
A 创建，B 查询/保存 A 的 UUID 返回 404；B 的 list 不出现 A；anon/过期会话返回 401；客户端直接改表被 RLS 拒绝；Storage 未签名访问失败；非法字段不进入上游；相同 UUID 并发创建只产生一次 POST；系统 ID 不匹配拒绝；unknown state/空媒体不显示成功；submitted→processing→succeed 展示真实播放和保存；failed 展示原因；刷新恢复、不重复计费；保存失败只重试保存；文生和视频生各完成真实样本。
离线参数/解析测试不等于 Supabase RLS、QA、上游付费生成或浏览器播放验收。

## 通用任务
`python3 scripts/task.py create --id UUID --kind text --params '{"prompt":"雨声","duration":3}'`
UUID 必须实际生成并保存；环境 KLING_EDGE_URL 为部署后的 Edge URL，APP_SESSION_TOKEN 为当前用户会话。随后 query / save 使用同一 --id。参数解析异常退出非 0；不把 Key 传命令行。生成期不得临时写请求替代包内脚本。
