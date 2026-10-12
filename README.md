# 愈见 CareLoop

> 出院患者全周期照护助手 —— 无代码创新应用比赛（医疗健康赛道）参赛作品。
> 患者端 / 家属端 / 医护端三端协同，覆盖出院后 2–8 周过渡期的用药依从性与异常处置闭环。
> 演示数据均为虚构脱敏，产品内所有医疗建议均标注「不构成诊断」。

## 演示账号（登录页可一键填入）

| 角色 | 账号 | 密码 | 说明 |
|---|---|---|---|
| 患者 | `guifang@miaoda.com` | `GuiFang@CareLoop2026` | 陈桂芳，68 岁，冠脉搭桥术后第 9 天 |
| 患者 | `jianguo@miaoda.com` | `JianGuo@CareLoop2026` | 周建国，59 岁，高血压 3 级 |
| 家属 | `chenming@miaoda.com` | `ChenMing@CareLoop2026` | 陈明，陈桂芳之子（ACTIVE 绑定） |
| 医护 | `doctor_wang@miaoda.com` | `DrWang@CareLoop2026` | 王心怡，心外科随访护士 |

> 演示账号密码由迁移 `00018` 与登录页口径对齐；重建数据库后无需手工改密码。

## 技术栈

- **前端**：Vite + React 18 + TypeScript + Tailwind CSS + shadcn/ui + Recharts + Streamdown
- **后端**：托管 Supabase（Postgres + Edge Functions（Deno）+ pg_cron 定时任务 + RLS 行级权限）
- **无本地数据库**：前后端都直接连托管 Supabase，本地不需要起 Postgres/Docker
- **包管理**：pnpm（经 corepack），registry 需走 npmmirror（国内网络）

## 快速开始

```bash
corepack pnpm install        # 安装依赖（本机无全局 pnpm，必须经 corepack）
corepack pnpm dev            # 开发服务器 http://127.0.0.1:5173
corepack pnpm typecheck      # tsgo 全量类型检查
corepack pnpm lint           # tsgo + biome + ast-grep + tailwind + vite build
```

环境要求：Node.js ≥ 20（本机开发用 22/24），pnpm 9.x。若 `pnpm install` 拉包失败，确认 registry 指向 `https://registry.npmmirror.com`。

## 环境变量

项目根目录 `.env`（已随仓库提交，仅含**可公开的 anon key**，敏感数据由 RLS 保护）：

| 变量 | 说明 |
|---|---|
| `VITE_SUPABASE_URL` | 托管 Supabase 项目 URL |
| `VITE_SUPABASE_ANON_KEY` | anon（publishable）key，前端专用 |
| `VITE_APP_ID` | Miaoda 应用 ID |

Edge Function 侧密钥（Supabase 后台配置，不进仓库）：`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY`（平台自动注入）+ `INTEGRATIONS_API_KEY`（MiniMax 大模型调用，需手工配置）。

## 目录结构

```
├── src/
│   ├── pages/
│   │   ├── patient/      # 患者端：今日/用药/打卡/症状自查/助手/消息/资料/随访
│   │   ├── family/       # 家属端：首页/代打卡/待办任务/消息
│   │   └── clinician/    # 医护端：工作台/患者管理/预警中心/随访报告/知识库
│   ├── components/
│   │   ├── layouts/      # 三端布局 + MobileShell（移动端外壳/桌面设备框）
│   │   └── common/       # FontScaleSwitch（适老化字号）等通用组件
│   ├── lib/api.ts        # 全部 Supabase 查询与 Edge Function 调用唯一入口
│   ├── lib/font-scale.ts # 字号档位（小/中/大）持久化
│   └── index.css         # 设计 token + 字号档位 + 签名样式
├── supabase/
│   ├── migrations/       # 00001–00018，按序号在 SQL Editor 依次应用
│   ├── functions/        # Edge Functions（Deno），见下
│   └── ops/              # full_schema_0001_0018.sql：全新库一次性全量合集
├── docs/                 # 项目文档（见下方文档导航）
├── tasks/                # 比赛过程资产：需求/设计/截图脚本/评审截图（handoff.md 已过期）
└── dist/                 # 构建产物（gitignore，勿手改）
```

## 后端结构（Supabase）

**数据表**：profiles / patients / documents / medication_plans / medication_logs / followup_items / reminders / checkins / symptom_checks / alerts / messages / care_relations / reports / knowledge_docs。

**Edge Functions**（改动后必须在 Supabase 后台重新部署才生效）：

| 函数 | 职责 |
|---|---|
| `reminder-scan` | pg_cron 每分钟调用：L0→L3 漏服升级链，同时段多种药合并 |
| `triage-symptom` | 症状三级分诊：红旗规则兜底 + MiniMax 综合分级 |
| `assistant-chat` | 智能问答（RAG，SSE 流式输出） |
| `parse-document` | 出院小结图片 AI 解析 |
| `confirm-plan` | 用药计划确认 |
| `generate-report` | 随访报告统计生成 |
| `auth-register` | 注册 |

**定时任务**：`pg_cron` 每分钟调 `reminder-scan`（迁移 00004 注册，依赖 vault 里的 project_url / publishable_key）。

**应用迁移 / 重建数据库 / 部署函数的完整步骤见 [`docs/部署清单.md`](docs/部署清单.md)。**

## 文档导航

| 文档 | 内容 |
|---|---|
| [`docs/交接手册.md`](docs/交接手册.md) · [HTML 排版版](docs/handbook.html) | **新协作者先读这个**：架构决策、关键机制、已知坑、待办 |
| [`docs/部署清单.md`](docs/部署清单.md) · [HTML 排版版](docs/deploy.html) | Supabase 迁移应用、函数部署、全新库重建、验证方法 |
| [`docs/prd.md`](docs/prd.md) | 产品需求文档 |
| [`docs/DESIGN.md`](docs/DESIGN.md) | UI 设计基准（色彩/字号/视觉语言） |
| [`docs/答辩防御一页纸.md`](docs/答辩防御一页纸.md) · [HTML 排版版](docs/defense.html) | 比赛答辩问答脚本 + 60 秒演示动线 |
| [`docs/T1-执行简报.md`](docs/T1-执行简报.md) | 评审报告 P0/P1 修复执行记录（历史存档） |
| `tasks/` | 比赛过程资产（handoff.md 已过期，以 docs/交接手册.md 为准） |

> HTML 排版版（`docs/*.html`）为阅读友好版，可直接用浏览器打开或发给队友；内容以同名 `.md` 源文件为准。

## 当前状态与待办

- 代码侧：评审报告 13 项问题已全部修复（P0×3 / P1×4 / P2×4 + 附加项），详见交接手册「评审修复台账」
- **待办（Supabase 后台操作，共 3 项）**：① 应用迁移 00017 + 00018；② 重新部署 `triage-symptom`；③ 重新部署 `reminder-scan`。步骤见部署清单

## 协作约定

- 分支：功能开发从 `main` 切 `feature/*`，完成后 PR 合回；`backup/*` 为快照分支，只读
- 提交：约定式提交（`feat/fix/chore/docs/refactor`），中文说明写清动机
- 提交前必须 `corepack pnpm lint` 全绿
- 数据库变更只加迁移（`supabase/migrations/` 递增序号），**禁止直接改线上库后不补迁移**；改完同步进 `supabase/ops/full_schema_*.sql` 合集
- Edge Function 改完在 `docs/部署清单.md` 的待办区登记，提醒团队重新部署
