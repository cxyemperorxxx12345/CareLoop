# 交接说明（给落地方 AI）

> 你将接手 **愈见 CareLoop** —— 出院患者全周期照护助手（2026 iCAN AI 无代码智能体挑战赛参赛项目）。
> 前期策划与骨架已完成，你的任务是**在既有骨架上填充业务逻辑，让项目真正跑起来**。

---

## 1. 这是什么

一套 Next.js + PostgreSQL 的 Web 应用，分**患者端**与**医护端**两端。核心闭环：

`上传出院小结 → AI 结构化 → 生成用药/随访计划 → 定时提醒（未确认自动升级）→ 症状分诊 → 医护预警 → 随访报告`

---

## 2. 必读文档（按此顺序）

| 顺序 | 文件 | 作用 |
| --- | --- | --- |
| 1 | `README.md` | 项目背景、目标、功能总览、快速开始 |
| 2 | `docs/requirements.md` | **要做什么**：模块、用户故事、验收标准 |
| 3 | `docs/architecture.md` | **怎么做**：分层、关键技术方案、目录职责 |
| 4 | `docs/data-model.md` + `prisma/schema.prisma` | 数据结构（schema 已可直接迁移） |
| 5 | `docs/api-spec.md` | 接口契约（请求/响应/错误码） |
| 6 | `docs/dev-plan.md` | **施工顺序**：Phase 0–8 任务拆解与验收 |

---

## 3. 现状（已完成的骨架）

- ✅ 完整策划文档（6 份）
- ✅ `prisma/schema.prisma`：**已通过 `prisma validate`**，全部实体/枚举/索引齐备
- ✅ 目录结构：页面、API 路由、AI 层、调度层、服务层、数据访问层均已建文件
- ✅ 可运行的基础代码：`lib/db.ts`、`lib/utils.ts`、`api/health`、`app/layout.tsx`、`app/page.tsx`、`components/ui/button.tsx`、Tailwind/TS/Next 配置、docker-compose
- ⏳ 其余文件均为**带 `// TODO` 的占位**，标注了实现要点

> 快速核对：`grep -rn "TODO" src prisma scripts` 可以看到所有待实现点。

---

## 4. 启动步骤

```bash
pnpm install
docker compose up -d          # 拉起 PostgreSQL + pgvector
cp .env.example .env          # 填入 DATABASE_URL 与 AI Key
pnpm prisma migrate dev --name init
pnpm prisma db seed
pnpm dev                      # http://localhost:3000
```

验证：`GET /api/health` 应返回 `{ "ok": true, "data": { "status": "up", "db": "up" } }`。

---

## 5. 施工顺序（详见 `docs/dev-plan.md`）

```
Phase 0 脚手架基础
  → Phase 1 数据模型 + 认证
    → Phase 2 文档解析→计划生成（★）
    → Phase 3 提醒调度与升级（★）   ← 与 2 并行
    → Phase 4 RAG 问答（★）        ← 与 2/3 并行
      → Phase 5 症状分诊与预警闭环（★）
        → Phase 6 医护端管理 + 报告
          → Phase 7 患者端打磨
            → Phase 8 联调 + 演示数据
```

★ = 竞赛核心 AI 能力，务必优先且做扎实。

---

## 6. 铁律（实现时必须遵守）

1. **分层**：业务逻辑写进 `src/server/services/**`；路由只做校验/鉴权/转发；数据库只在 `src/server/repositories/**` 或 service 中直接调用 `prisma`。
2. **AI 统一出口**：所有模型调用走 `src/lib/ai/**`，便于替换供应商与加日志。
3. **归属校验**：任何读写患者数据的接口必须校验 `patientId` 属于当前用户。
4. **合规**：AI 输出标注「不构成医疗诊断」；不得输出明确诊断结论；红旗症状强制 `RED`。
5. **幂等**：提醒发送与升级必须幂等（乐观锁），可安全重复执行。
6. **验收**：每个 Phase 完成前，逐条通过 `docs/requirements.md` 与 `docs/dev-plan.md` 中的验收标准。
7. **收尾**：提交前 `pnpm lint && pnpm typecheck && pnpm build` 必须全绿。

---

## 7. 完成定义（Definition of Done）

- [ ] 6 大 Must 功能可用：文档解析 / 用药打卡 / 智能问答 / 症状分诊 / 预警中心 / 提醒升级
- [ ] 三角色登录与权限隔离正常
- [ ] 演示主线（README 第九章 8 步）一气呵成
- [ ] 种子数据一键还原，`pnpm build` 通过
- [ ] 免责声明常驻，无 AI 幻觉越界输出
