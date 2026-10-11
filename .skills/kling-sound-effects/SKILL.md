---
name: kling-sound-effects
description: 使用可灵生成短音效或为已有视频配音效和背景音乐。适用于文字生成环境声、动作声、游戏音效、视频配乐与 ASMR 音效；支持文生音效 3–10 秒、视频输入 3–20 秒、任务进度、MP3/WAV 试听下载及视频结果。生成应用时必须落实服务端用户归属校验，共享上游凭证的任务列表不得直接展示给终端用户。
license: MIT
---

# 音效生成 (可灵)

## 概览与适用场景
文生音效和视频生音效共用一个 Skill，按输入选择能力。不包含 MiniMax、歌曲演唱、语音克隆或长音乐生成。适合游戏效果音、环境声、短视频音效、配乐和 ASMR 场景。网页应用和通用任务使用同一后端隔离层。

## 先读与执行
1. 读取 [接口参考](references/api.md)、[秒哒部署与验收](references/integration.md)。
2. 已按用户提供的后台定义回填四个真实 API ID，见 references/api.md；保持接口集合不变。网关真实调用和 QA 仍需单独验收。
3. 应用复制 `assets/core.mjs`、`assets/media-policy.mjs`、`assets/edge.ts` 到同一个 Edge Function 目录，部署函数名 `kling-audio`；执行 `assets/schema.sql`；前端采用 `assets/client.js`。禁止仅复制文字规则后另写一套查询。
4. 生成期任务执行 `python3 scripts/gateway_task.py --help`；应用内用户任务执行 `python3 scripts/task.py --help`，通过已部署的隔离后端调用。应用用户未登录时不绕过归属校验。
5. 上游账号列表只保留在接口参考中供管理员理解，不出现在应用路由或普通用户脚本中。“我的记录”只查本应用数据库。

## 前置条件与接入阶段
服务端仅使用 `INTEGRATIONS_API_KEY` 和 `X-Gateway-Authorization` 调用秒哒网关。第三方凭证由后台托管，不复制到包或前端，也不要求用户再填上游令牌。Supabase 用户会话只用于本应用身份验证，与网关凭证分开。
生成期独立任务执行 `scripts/gateway_task.py`；创建后保留私有任务收据，查询只接受本执行上下文的收据。应用用户请求执行已有 `scripts/task.py` 或前端调用隔离 Edge，禁止将生成期脚本开放为无鉴权用户接口。

## 输入规则
- 文本：`prompt` 非空，最多 200 字符；`duration` 3.0–10.0 秒，精度一位小数。
- 视频：`video_id` 与 `video_url` 二选一。ID 指向 30 天内生成、3–20 秒视频；URL 指向 MP4/MOV、≤100M、3–20 秒素材。界面上传必须实测时长、类型和大小；这些素材属性不能仅靠 URL 后缀判断。
- `sound_effect_prompt` / `bgm_prompt` 各最多 200 字符；`asmr_mode` 为布尔值，默认 false。
- 应用不提供随意输入别人 video_id 的入口。视频 ID 必须已绑定当前用户的来源任务；参考实现拒绝未经数据库证明归属的 ID。无来源映射时使用本人上传文件的 URL。
- 公开 URL 模式由上游获取素材，说明素材可访问要求。应用自行上传采用私有存储及有足够有效期的签名 URL。
- `external_task_id` 由后端使用本地 UUID 设置；它不是鉴权依据。默认不开放任意 callback_url；回调验签协议未接入前用轮询。

## 隔离硬规则
- 共享上游凭证代表共享上游任务空间，不代表应用用户共享历史。
- 每个请求通过真实 Supabase 用户会话验证，身份来自 `auth.getUser`；前端 user_id、匿名 key、猜测的 UUID 都不是用户身份证明。
- 创建前存任务归属；查询、列表、转存逐次检查 `user_id`。禁止让客户端修改 owner/upstream_id/media。
- `task_id`、external ID、UUID 和签名 URL 都不是替代鉴权的理由。其他用户查询统一 404。
- 使用数据库 RLS 与私有 Storage；service role 只在后端，使用时仍显式加 owner 条件。
- 必须提供正常登录入口。这个共享凭证多用户方案有身份隔离需求，不默认启用匿名登录。

## 异步闭环
创建一次，存本地 UUID；相同 UUID 重试不再次创建计费任务。上游 submitted/processing 只表示处理中；仅 `succeed` 映射为 UI `succeeded`。校验返回 task_id 与本任务完全一致，成功还需非空媒体 URL。
前端逐次等待后再延迟 5 秒查询，不用 setInterval 堆积请求；页面卸载取消 watch，重渲染不重启，刷新从数据库恢复。超时恢复原任务，不重新生成。创建结果不明时标 timeout 并人工对账，不盲目重试 POST。
成功展示音频播放器、返回的视频播放器以及下载入口，默认不调用 save 转存。先渲染 media 中的原始播放器和打开/下载入口；仅后端返回 can_save=true 时提供独立的私有转存按钮。转存失败保留可用预览并单独重试保存；禁止重新生成。上游文件 30 天后清理，私有转存链接每次按用户签发。

## 注意事项与错误
不编造错误码：HTTP 错误与业务 code 非 0 都视为失败；任务 failed 展示 task_status_msg；未知状态/ID 不匹配/空结果视为协议错误。429 退避，402 提示额度，401 提示会话或服务配置错误；这些是 HTTP 处理分类，不是可灵业务码表。
界面至少包含 idle/submitting/submitted/processing/succeeded/failed/timeout。登录失败、轮询失败、保存失败保留输入、任务 ID 和重试入口。
无需额外文本大模型即可提交用户音效描述；不为形式附加其他技能。只有用户明确要求描述改写时再判断是否组合对应文本技能。


## 媒体交付规则（本次修复）
同目录部署 assets/media-policy.mjs、core.mjs 和 index.ts。默认交付使用上游媒体 URL 试听、预览及打开/下载，不在成功后自动调用 save。MEDIA_HOSTS 是可选的私有转存配置，不列入应用必填密钥，不要求普通用户填写。仅 can_save=true 才显示私有转存按钮；保存失败保留成功媒体。明确展示上游 30 天保留期，历史记录不等于永久保存。跨域打开链接不保证浏览器强制下载，不伪造下载成功提示。若产品要求永久保存，部署人员必须配置已核实的精确域名并实测转存后再开放该能力。


## 前端状态验收
生成界面前必须读取[前端状态契约](references/frontend-state.md)，复用 assets/task-state.mjs 的响应验收逻辑。当前结果由唯一 React state 驱动，禁止创建快照覆盖轮询成功结果；必须验收刷新恢复、旧响应隔离和实际播放器展示。
