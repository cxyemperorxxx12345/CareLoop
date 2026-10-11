# 技术架构 · 愈见 CareLoop

---

## 1. 架构总览

采用 **Next.js 单体架构**（前后端同仓），以降低落地复杂度、便于 demo 一键启动。AI 能力统一封装在服务层，通过清晰接口与业务解耦。

```
┌─────────────────────────────────────────────────────────────┐
│                        客户端 (浏览器)                         │
│   患者端 (patient)          医护端 (clinician)                 │
│   React Server Components + 少量客户端组件 (TanStack Query)    │
└───────────────┬─────────────────────────┬───────────────────┘
                │ HTTPS / JSON / SSE       │
┌───────────────▼─────────────────────────▼───────────────────┐
│                    Next.js App Router (单体)                  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │ 页面 RSC      │  │ Route Handlers│ │ Server Actions     │  │
│  └──────┬───────┘  └──────┬───────┘  └─────────┬──────────┘  │
│         └─────────────────┴────────────────────┘             │
│                    ┌──────────────────────┐                  │
│                    │   Server Services    │  ← 业务逻辑层      │
│                    │  (src/server/services)│                  │
│                    └──────────┬───────────┘                  │
│         ┌─────────────────────┼──────────────────────┐       │
│  ┌──────▼──────┐  ┌───────────▼────────┐  ┌──────────▼────┐  │
│  │ AI 层        │  │ 调度层 Scheduler    │  │ 通知网关       │  │
│  │ lib/ai       │  │ lib/scheduler      │  │ lib/notify    │  │
│  └──────┬──────┘  └───────────┬────────┘  └──────────┬────┘  │
└─────────┼─────────────────────┼──────────────────────┼──────┘
          │                     │                      │
   ┌──────▼──────┐      ┌───────▼────────┐     ┌───────▼──────┐
   │ LLM / OCR   │      │ node-cron      │     │ 站内/短信/邮件 │
   │ (外部 API)  │      │ (或 BullMQ)    │     │ (可打桩)      │
   └─────────────┘      └───────┬────────┘     └──────────────┘
                                │
                        ┌───────▼────────────────────────────┐
                        │ PostgreSQL + pgvector (Prisma ORM) │
                        └────────────────────────────────────┘
```

---

## 2. 分层职责

| 层 | 目录 | 职责 | 约束 |
| --- | --- | --- | --- |
| 路由/UI | `src/app/**` | 页面渲染、表单、数据获取入口 | 不写复杂业务逻辑，调用 service |
| 接口 | `src/app/api/**` | 参数校验、鉴权、调用 service、返回 | 保持薄；统一错误格式 |
| 业务服务 | `src/server/services/**` | 核心业务编排（解析、计划、分诊、升级） | 可被路由与调度器复用 |
| 数据访问 | `src/server/repositories/**` | 封装 Prisma 查询 | 唯一直接操作 db 的地方 |
| AI | `src/lib/ai/**` | 模型调用、Prompt、结构化输出、RAG | 统一出口，含重试与降级 |
| 调度 | `src/lib/scheduler/**` | 提醒扫描、升级状态机 | 幂等，可重入 |
| 通知 | `src/lib/notify/**` | 通道抽象与发送 | 失败重试与日志 |
| 组件 | `src/components/**` | 可复用 UI | `ui` 为基础组件 |

---

## 3. 关键技术方案

### 3.1 文档解析（P1 / S1）
1. 上传到对象存储（demo 可用本地 `public/uploads`）/ 记录 `Document`。
2. 调用多模态 LLM，Prompt 要求**严格 JSON**，用 JSON Schema 约束输出。
3. 校验 JSON；失败则重试（最多 2 次）；仍失败标记 `status=failed`。
4. 结构化结果存入 `Document.parsedJson`，前端展示可编辑卡片。
5. 患者确认 → 触发 **计划生成**（S2），写入 `MedicationPlan` / `FollowUpPlan` / `FollowUpItem`。

> Prompt 与 Schema 定义放在 `src/lib/ai/extract.ts`，Schema 与 `docs/data-model.md` 字段保持一致。

### 3.2 提醒与升级引擎（S3）★
状态机：

```
        ┌──────────┐ 到时   ┌───────────┐ 患者 ack  ┌────────────┐
新建 ──▶ │ pending  │ ─────▶│  sent(L0) │ ─────────▶│ acked/done │
        └──────────┘       └─────┬─────┘            └────────────┘
                                 │ 超时未 ack (默认30min)
                                 ▼
                        升级 L1 短信 ──超时──▶ L2 家属 ──超时──▶ L3 护士站
                                 │                                   │
                                 └──── 任意时刻 ack → 终止升级 ◀──────┘
```

- 用 `Reminder.status`（`pending/sent/acked/snoozed/skipped/escalated`）+ `escalationLevel`（0–3）表达状态。
- 调度器每分钟扫描 `status IN (pending, sent, escalated) AND nextActionAt <= now()`。
- **幂等**：处理时用乐观锁（`updateMany where status=旧值`）防重复发送。
- 升级间隔、各通道开关放在配置表或环境变量。

### 3.3 症状分诊（S4）★
两级策略：
1. **规则兜底**：红旗关键词/阈值表（如「胸痛」「呼吸困难」「意识模糊」「体温 ≥ 39」「血压 ≥ 180/110」）→ 直接 `red`。
2. **LLM 判断**：无红旗命中时，结合患者基础病与近期用药给出 `green/yellow/red` + `advice`。
3. 结果 `yellow/red` → 生成 `Alert` 并推送医护端。

### 3.4 RAG 问答（P4 / S5）
- 双路检索：① 患者个人医嘱/计划片段（强相关）；② 机构知识库。
- `pgvector` 存 embedding，余弦相似度 Top-K；Prompt 强制「只依据检索内容回答，找不到就说不知道」。
- 流式返回（SSE / Route Handler `ReadableStream`）。

### 3.5 认证与鉴权
- NextAuth（Credentials 或 OAuth），会话含 `userId` 与 `role`。
- 中间件 `middleware.ts`：按路由组限制角色。
- 所有读写患者的 API 必须校验 `patientId` 归属。

---

## 4. 目录与文件职责（映射到骨架）

```
src/
├── app/
│   ├── layout.tsx                   # 根布局（字体、全局样式、Toaster）
│   ├── page.tsx                     # 落地页 / 角色分流入口
│   ├── (auth)/login/page.tsx        # 登录页
│   ├── (patient)/layout.tsx         # 患者端外壳（底部导航）
│   ├── (patient)/dashboard/page.tsx # 今日概览
│   ├── (patient)/medications/...    # 用药与打卡
│   ├── (patient)/plan/...           # 随访时间轴
│   ├── (patient)/assistant/...      # 智能问答
│   ├── (patient)/symptom/...        # 症状自查
│   ├── (patient)/checkin/...        # 健康打卡
│   ├── (patient)/notifications/...  # 消息中心
│   ├── (clinician)/layout.tsx       # 医护端外壳（侧边导航）
│   ├── (clinician)/patients/...     # 患者列表 / 详情
│   ├── (clinician)/alerts/...       # 预警中心
│   ├── (clinician)/reports/...      # 随访报告
│   └── api/
│       ├── health/route.ts          # 健康检查
│       ├── documents/route.ts       # 上传
│       ├── documents/parse/route.ts # 触发解析
│       ├── documents/[id]/route.ts  # 查询状态/确认
│       ├── plans/route.ts           # 计划读写
│       ├── reminders/route.ts       # 提醒列表
│       ├── reminders/[id]/ack/route.ts # 确认/稍后/跳过
│       ├── checkins/route.ts        # 健康打卡
│       ├── assistant/chat/route.ts  # 问答（流式）
│       ├── symptoms/analyze/route.ts# 症状分诊
│       ├── alerts/route.ts          # 预警列表
│       ├── alerts/[id]/handle/route.ts # 处理预警
│       ├── patients/me/route.ts     # 当前患者资料
│       ├── clinician/patients/route.ts # 医护患者列表
│       └── knowledge/route.ts       # 知识库
├── components/
│   ├── ui/                          # shadcn 基础组件（Button/Card/Dialog…）
│   ├── patient/                     # MedicationCard / ReminderItem / RiskBadge…
│   └── clinician/                   # PatientRow / AlertCard / ReportView…
├── lib/
│   ├── db.ts                        # PrismaClient 单例
│   ├── auth.ts                      # NextAuth 配置与 session 工具
│   ├── utils.ts                     # cn() 等
│   ├── ai/
│   │   ├── client.ts                # 模型客户端封装（含重试/超时）
│   │   ├── extract.ts               # 文档抽取 Prompt + Schema
│   │   ├── plan.ts                  # 随访计划生成
│   │   ├── triage.ts                # 症状分诊（规则+LLM）
│   │   └── rag.ts                   # 检索与作答
│   ├── scheduler/
│   │   ├── reminder-engine.ts       # 扫描与发送
│   │   └── escalation.ts            # 升级状态机
│   └── notify/
│       └── index.ts                 # 通道抽象（inApp/sms/email）
├── server/
│   ├── services/                    # document/plan/alert/patient/knowledge
│   └── repositories/                # 各实体 Prisma 封装
├── types/index.ts                   # 全局类型（含 AI 输出类型）
└── styles/globals.css
```

---

## 5. 环境变量（`.env.example`）

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串 | `postgresql://postgres:postgres@localhost:5432/careloop` |
| `NEXTAUTH_SECRET` | 会话密钥 | `please-change-me` |
| `NEXTAUTH_URL` | 站点地址 | `http://localhost:3000` |
| `AI_BASE_URL` | 模型 API 地址 | `https://api.openai.com/v1` |
| `AI_API_KEY` | 模型密钥 | `sk-***` |
| `AI_MODEL` | 主模型 | `gpt-4o-mini` |
| `AI_VISION_MODEL` | 多模态/OCR 模型 | `gpt-4o-mini` |
| `REMINDER_ESCALATION_MINUTES` | 升级间隔（分钟） | `30` |
| `SMS_PROVIDER` / `SMS_KEY` | 短信通道（可留空打桩） | - |
| `UPLOAD_DIR` | 上传目录 | `public/uploads` |

---

## 6. 安全与合规

- **鉴权**：所有 API 校验会话；患者数据按 `patientId` 归属校验。
- **传输**：生产强制 HTTPS；健康数据不落日志明文。
- **最小化**：仅采集随访必需的字段。
- **审计**：`AuditLog` 记录敏感读操作与 AI 调用。
- **合规声明**：前端固定免责声明「本内容不构成医疗诊断，请遵医嘱」。
- **数据**：演示环境使用虚构/脱敏数据。

---

## 7. 部署（本地 Demo）

`docker-compose.yml` 提供 PostgreSQL（启用 `pgvector`）与（可选）Redis。应用可用 `pnpm dev` 直接运行，或构建 Docker 镜像运行 `pnpm start`。调度器在应用内以 node-cron 启动（`scripts/start-scheduler.ts`）。

---

## 8. 可演进方向（备赛加分）

- 家属协同与多角色通知。
- 用药依从性预测（简单 ML/规则打分）。
- 多渠道真实短信/微信模板消息接入。
- 与医院 HIS/LIS 的标准接口预留（本期不做，仅留扩展点）。
