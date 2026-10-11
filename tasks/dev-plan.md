# 开发实施计划 · 愈见 CareLoop

> **给落地方 AI 的施工说明。** 按 Phase 顺序推进，每个 Phase 有明确交付物与验收标准。
> 骨架已生成（目录 + 配置 + Prisma schema + 占位文件），你需要做的是**填充业务逻辑**。
> 每完成一个 Phase，请自测「验收标准」全部通过再进入下一个。

---

## 施工前置阅读

按顺序阅读，建立全局认知：
1. `README.md` —— 项目背景与全貌
2. `docs/requirements.md` —— 要做什么（验收标准）
3. `docs/architecture.md` —— 怎么做（技术方案）
4. `docs/data-model.md` + `prisma/schema.prisma` —— 数据结构
5. `docs/api-spec.md` —— 接口契约

**编码约定**：
- 所有文件中的 `// TODO:` 注释标出了待实现点。
- 业务逻辑写进 `src/server/services/**`，路由只做校验/鉴权/转发。
- AI 调用统一走 `src/lib/ai/**`，不得在路由直接调模型。
- 数据库操作统一走 `src/server/repositories/**`。
- 提交前跑 `pnpm lint && pnpm typecheck`。

---

## Phase 0 · 脚手架与基础设施

**任务**
- [ ] `pnpm install`，确认依赖可安装
- [ ] `docker compose up -d` 拉起 PostgreSQL（含 pgvector）
- [ ] 配置 `.env`（复制 `.env.example`）
- [ ] 初始化 shadcn/ui 基础组件（`button` `card` `dialog` `input` `badge` `toast` `tabs` `textarea` `select`）
- [ ] 建 `src/lib/db.ts`（PrismaClient 单例）、`src/lib/utils.ts`（`cn()`）
- [ ] 根布局 `app/layout.tsx` + 全局样式 `styles/globals.css`（含移动端适配）

**交付物**：可 `pnpm dev` 启动空白站点，数据库连通。
**验收**：访问 `/api/health` 返回 `{ ok: true }` 且 `db: "up"`。

---

## Phase 1 · 数据模型与认证

**任务**
- [ ] 完善 `prisma/schema.prisma`（对照 `docs/data-model.md`，含所有实体/枚举/索引）
- [ ] `pnpm prisma migrate dev --name init`
- [ ] 编写 `prisma/seed.ts`（见 data-model.md 第 5 节），`pnpm prisma db seed`
- [ ] 实现 NextAuth 登录（Credentials）+ 角色写入 session（`src/lib/auth.ts`）
- [ ] `middleware.ts`：`(patient)` 仅 `PATIENT` 可进，`(clinician)` 仅 `CLINICIAN`/`ADMIN`
- [ ] 登录页 `(auth)/login/page.tsx`

**交付物**：三种角色可登录并跳转到各自首页。
**验收**：
- [ ] 患者访问 `/alerts` 被拒绝（403/重定向）
- [ ] `pnpm prisma studio` 可见种子数据

---

## Phase 2 · 文档解析 → 计划生成（★核心 AI）

**任务**
- [ ] `src/lib/ai/client.ts`：模型客户端封装（超时、重试、错误归一化）
- [ ] `src/lib/ai/extract.ts`：文档抽取 Prompt + JSON Schema（输出对齐 `ExtractedDischarge`）
- [ ] `src/server/services/document.service.ts`：
  - 上传落库（`Document`，status=UPLOADED）
  - 解析：调用 `extract` → 校验 → 写 `parsedJson`（PARSED/FAILED）
- [ ] 接口：`POST /api/documents/upload`、`/parse`、`GET/PATCH /api/documents/:id`、`/confirm`
- [ ] `src/lib/ai/plan.ts` + `plan.service.ts`：由结构化结果生成 `MedicationPlan` / `FollowUpPlan` / `FollowUpItem`
- [ ] 患者端页面：`P1` 上传承接页 + 结构化校对卡片 + 确认按钮

**交付物**：上传一张出院小结 → 得到可编辑结构化结果 → 确认后生成计划。
**验收**：
- [ ] 60 秒内返回结构化结果
- [ ] `confirm` 后数据库出现用药与随访节点
- [ ] 解析失败有明确提示与重试

---

## Phase 3 · 提醒调度与升级引擎（★核心）

**任务**
- [ ] `src/lib/notify/index.ts`：通道抽象（`inApp` 必做；`sms/email` 打桩写日志）
- [ ] `src/lib/scheduler/reminder-engine.ts`：扫描到期提醒 → 按 `scheduledAt` 生成并发送（幂等，乐观锁）
- [ ] `src/lib/scheduler/escalation.ts`：升级状态机（L0 App → L1 短信 → L2 家属 → L3 护士站），间隔读配置
- [ ] `POST /api/reminders/:id/ack`（TAKEN/SNOOZE/SKIP）+ `GET /api/reminders`
- [ ] `POST /api/internal/reminders/tick`（调度入口）
- [ ] `scripts/start-scheduler.ts`：node-cron 每分钟调用 tick
- [ ] 患者端：提醒列表 + 打卡交互（`medications` / `dashboard` 页）

**交付物**：到点自动提醒；未确认按级升级；确认后停止升级。
**验收**：
- [ ] 手动触发 tick 能发出到期提醒
- [ ] 反复 tick 不重复发送（幂等）
- [ ] 超时后 `escalationLevel` 递增且留痕
- [ ] ack 后不再升级

---

## Phase 4 · 智能问答 RAG（★核心 AI）

**任务**
- [ ] `src/lib/ai/rag.ts`：个人医嘱片段 + 知识库双路检索（pgvector 余弦）
- [ ] 知识库切片与向量化（`knowledge.service.ts`）
- [ ] `POST /api/assistant/chat`（SSE 流式）+ 会话落库
- [ ] 越界拒答策略（诊断/处方类问题）
- [ ] 患者端 `assistant/page.tsx`：对话 UI、流式渲染、历史回看

**交付物**：可多轮问答，引用患者本人医嘱，越界拒答。
**验收**：
- [ ] 问用药时间返回真实医嘱时间点
- [ ] 问诊断类问题明确拒答并建议就医
- [ ] 对话历史持久化

---

## Phase 5 · 症状分诊与预警闭环（★核心）

**任务**
- [ ] `src/lib/ai/triage.ts`：规则兜底（红旗表）+ LLM 判断，输出 `{level, advice, redFlags}`
- [ ] `POST /api/symptoms/analyze`、`POST /api/symptoms/report`
- [ ] `alert.service.ts`：由症状/打卡生成 `Alert`
- [ ] 患者端 `symptom/page.tsx`：描述 + 分级结果 + 二次确认上报
- [ ] 医护端 `alerts/page.tsx`：预警中心（列表/详情/处理动作/备注）
- [ ] `POST /api/alerts/:id/handle` + 导航角标未处理数

**交付物**：症状 → 分诊 → 生成预警 → 医护处理 全链路打通。
**验收**：
- [ ] 「伤口轻微发痒」→ GREEN
- [ ] 「红肿渗液 + 发烧38.5」→ RED 并生成红色预警
- [ ] 红色预警 5 秒内出现在医护端
- [ ] 处理动作与备注落库

---

## Phase 6 · 医护端患者管理与报告

**任务**
- [ ] `clinician/patients/page.tsx`：列表（风险降序）+ 搜索/筛选
- [ ] `clinician/patients/[id]/page.tsx`：360 视图（资料/计划/依从率/打卡/症状/AI 摘要）
- [ ] `GET /api/clinician/patients`、`/:id`
- [ ] `reports/page.tsx` + `GET /api/clinician/patients/:id/report`（JSON/PDF）
- [ ] 报告内容 100% 来自真实数据

**交付物**：医护可管理患者、一键生成随访报告。
**验收**：
- [ ] 列表默认红→黄→绿
- [ ] AI 摘要能正确概括近期风险
- [ ] 报告可导出

---

## Phase 7 · 患者端打磨与健康打卡

**任务**
- [ ] `checkins` 接口 + `checkin/page.tsx`（血压/血糖/体温/体重 + 趋势图）
- [ ] 异常阈值配置与医护端高亮
- [ ] `plan/page.tsx` 时间轴 + 倒计时
- [ ] `dashboard/page.tsx` 今日概览（今日用药/待办/提醒）
- [ ] `notifications/page.tsx` 消息中心
- [ ] 移动端适配、字号、无障碍（大按钮、清晰标签）

**交付物**：患者端体验完整、移动端可用。

---

## Phase 8 · 联调、演示数据与交付

**任务**
- [ ] 端到端走通 README「核心业务流程」8 步
- [ ] 完善种子数据（含演示用红/黄预警、完整对话）
- [ ] `pnpm lint && pnpm typecheck && pnpm build` 全部通过
- [ ] 编写 3 分钟演示脚本（讲清主线与 AI 亮点）
- [ ] README 补充真实运行截图/GIF（可选）

**验收**：
- [ ] `pnpm build` 无错误
- [ ] 演示主线一气呵成无报错

---

## 依赖关系（关键路径）

```
Phase 0 → Phase 1 → Phase 2 ─┐
                             ├─→ Phase 5 ─→ Phase 6 ─→ Phase 8
        Phase 3 ─────────────┤
        Phase 4 ─────────────┘
        Phase 7（可与 5/6 并行，依赖 2/3）
```
- Phase 2（解析）与 Phase 3（调度）可并行开发（都依赖 1）。
- Phase 4（RAG）依赖 1，可与 2/3 并行。
- Phase 5 依赖 2（要有计划）与 3（要有提醒）。

---

## 全局验收清单（交付前必查）

- [ ] 三角色鉴权与数据归属校验完备
- [ ] 6 大 Must 功能全部可用（见 requirements.md 第 5 节）
- [ ] AI 输出无幻觉越界；免责声明常驻
- [ ] 调度器幂等、有审计日志
- [ ] 种子数据可一键还原（`prisma db seed`）
- [ ] `pnpm build` 通过

---

## 附：占位文件清单（骨架中标注 TODO 的文件）

| 文件 | 待实现 |
| --- | --- |
| `src/app/layout.tsx` | 根布局、字体、Toaster |
| `src/app/page.tsx` | 落地页与角色分流 |
| `src/app/(auth)/login/page.tsx` | 登录表单 |
| `src/app/(patient)/**/page.tsx` | 7 个患者端页面 |
| `src/app/(clinician)/**/page.tsx` | 患者列表/详情/预警/报告 |
| `src/app/api/**/route.ts` | 全部接口 |
| `src/lib/ai/*.ts` | 抽取/计划/分诊/RAG/客户端 |
| `src/lib/scheduler/*.ts` | 提醒引擎与升级状态机 |
| `src/lib/notify/index.ts` | 通知通道 |
| `src/lib/auth.ts` | NextAuth 配置 |
| `src/server/services/*.ts` | 各业务服务 |
| `src/server/repositories/*.ts` | 各实体数据访问 |
| `prisma/seed.ts` | 种子数据 |
| `scripts/start-scheduler.ts` | 定时任务启动 |
