# 国内秒哒应用规格
页面：项目设置、户型/照片与尺寸、空间诊断、A/B/C方案对比、分房间编辑器、预算采购、可选效果图、专业复核与导出。
默认数据层：使用以 `${VITE_APP_ID}:space:` 开头的 `localStorage` 保存项目列表、当前项目、步骤、锁定家具和方案；刷新后按项目 ID 恢复，不只依赖 React Context 内存。
若组合图片Skill，实现 submit → poll → succeeded/failed/timeout → URL或Base64处理 → 必要时Storage → preview → download。刷新恢复未完成任务；查询失败不得重复创建计费任务。
验收：
1. 修改尺寸后冲突和相关方案同步更新。
2. 承重墙不进入拆除建议。
3. 锁定保留家具后局部生成仍保留。
4. 未接图片Skill时完整输出布局和提示词，但不声称已渲染。
5. 生产构建中首次访问、页面导航、刷新与复制深层地址重新打开均不出现 404 或空 `#root`。
6. 无账户需求时可直接新建、保存并恢复项目；账户版真实登录后才能向按 UUID 用户隔离的表写入。

## 流式模型调用与方案解析（强制）
1. SSE 消费函数只能在 `[DONE]`、`reader.done` 或明确失败后结束 Promise；使用可等待的读取循环或完成 Promise，禁止启动递归读取后立即返回。
2. 空间诊断、布局候选与房间规格必须先拼接完整文本，再执行 JSON/Schema 校验、尺寸与锁定条件校验；流结束前不得判空、关闭 loading 或显示完成。
3. 分别处理 HTTP/网关失败、SSE 中断、JSON/Schema 失败和业务约束过滤后为空。前三类显示真实可定位错误，只有最后一类可提示“没有满足全部条件的空间方案”。
4. 回调内部 `throw` 不能代替外层 Promise reject；底层错误必须传到页面 `catch`。验收覆盖跨 chunk JSON、4xx/5xx、中途断流、无效 JSON 和所有候选违反硬约束，并保证保留项目输入和锁定决定。

## 发布路由、项目恢复与认证（强制）
- 秒哒静态发布默认使用 `HashRouter`，路径使用 `/#/input`、`/#/diagnosis`、`/#/compare`、`/#/detail`、`/#/adjust`。只有发布服务器已实测支持 SPA fallback 时才可使用 `BrowserRouter`。
- 生产验收必须逐页执行“应用内进入 → 刷新 → 复制地址重新打开”，Network 不得出现页面路由 404，`#root` 必须有实际内容。
- `ProjectContext` 不能是唯一数据源。首次渲染时按持久化的 currentProjectId 恢复项目；找不到项目时显示可见提示并返回项目列表，不能空白。
- 默认免登录版本使用本地持久化，不创建 owner_id、RLS 或 Auth 依赖。
- 若用户明确要求账户/跨设备，再使用 Supabase：AuthProvider 必须包裹实际应用，必须存在可用登录入口，并先得到真实 UUID 用户再读写 `owner_id uuid`。
- 禁止用公开 Anon Token 的 `sub: "anon"` 充当 UUID 用户。遇到 PostgreSQL `22P02`、`invalid input syntax for type uuid: "anon"` 或新建项目 4xx，必须判定认证/字段类型不一致并阻止交付。
- 所有加载流程使用 `try/catch/finally`；认证、网络、RLS 或查询失败都要结束 loading、显示错误和重试。
