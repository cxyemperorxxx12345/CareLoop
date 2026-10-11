# API 接口定义 · 愈见 CareLoop

> 所有接口位于 Next.js Route Handlers（`src/app/api/**/route.ts`）。
> 统一约定见下，落地时必须遵守。

---

## 0. 通用约定

- **基础路径**：`/api`
- **数据格式**：JSON（文件上传除外）；字段命名 `camelCase`。
- **鉴权**：除 `/api/health`、`/api/auth/*` 外，均需登录会话；按角色与归属校验。
- **时间**：ISO 8601 字符串（如 `2026-10-12T08:00:00+08:00`）。
- **成功响应**：
  ```json
  { "ok": true, "data": { } }
  ```
- **失败响应**：
  ```json
  { "ok": false, "error": { "code": "FORBIDDEN", "message": "无权访问该患者数据" } }
  ```
- **错误码**：`UNAUTHORIZED`(401) / `FORBIDDEN`(403) / `NOT_FOUND`(404) / `VALIDATION`(422) / `AI_FAILED`(502) / `INTERNAL`(500)。

---

## 1. 系统

### GET `/api/health`
健康检查。`200 { "ok": true, "data": { "status": "up", "db": "up" } }`

---

## 2. 文档（患者资料承接）

### POST `/api/documents/upload`
上传出院资料（`multipart/form-data`）。
- 字段：`file`（图片/PDF）、`type`（DocType）。
- 返回：`{ ok: true, data: { documentId, status: "UPLOADED" } }`
- 说明：上传成功后**异步**触发解析；前端轮询 `GET /api/documents/:id`。

### POST `/api/documents/parse`
显式触发解析。
- Body：`{ "documentId": "..." }`
- 返回：`{ ok: true, data: { status: "PARSING" } }`

### GET `/api/documents/:id`
查询文档与解析结果。
- 返回：`{ ok: true, data: { id, status, parsedJson, errorMessage } }`

### PATCH `/api/documents/:id`
患者校对结构化结果。
- Body：`{ "parsedJson": { ...ExtractedDischarge } }`
- 返回：更新后的文档。

### POST `/api/documents/:id/confirm`
确认结构 → 生成计划。
- 返回：`{ ok: true, data: { planId, medicationCount, itemCount } }`

---

## 3. 计划与用药（患者）

### GET `/api/patients/me/plan`
获取当前患者随访计划与节点。
- Query：`?group=today|all|history`
- 返回：`{ ok: true, data: { plan, items: FollowUpItem[] } }`

### GET `/api/patients/me/medications`
当前用药计划。
- 返回：`{ ok: true, data: { medications: MedicationPlan[], adherence: { today: 0.75, week: 0.82 } } }`

### PATCH `/api/plans/items/:id`
更新节点状态（完成/跳过）。
- Body：`{ "status": "DONE" }`

---

## 4. 提醒与确认

### GET `/api/reminders`
提醒列表。
- Query：`?date=2026-10-12&status=pending`
- 返回：`{ ok: true, data: { reminders: Reminder[] } }`

### POST `/api/reminders/:id/ack`
患者确认提醒。
- Body：`{ "action": "TAKEN" | "SNOOZE" | "SKIP", "snoozeMinutes": 30? }`
- 规则：`TAKEN/SKIP` 终止升级；`SNOOZE` 设定 `nextActionAt = now + snoozeMinutes`。
- 返回：更新后的提醒。

---

## 5. 健康打卡

### POST `/api/checkins`
新增记录。
- Body：`{ "type": "BP", "value": { "systolic": 130, "diastolic": 85 }, "note": "", "measuredAt": "..." }`
- 规则：越阈值置 `abnormal=true`，可选触发预警。
- 返回：`{ ok: true, data: { checkIn } }`

### GET `/api/checkins`
- Query：`?type=BP&from=&to=`
- 返回：`{ ok: true, data: { items: CheckIn[], trend: { ... } } }`

---

## 6. 智能问答（流式）

### POST `/api/assistant/chat`
对话（Server-Sent Events 流式）。
- Body：`{ "conversationId"?: "...", "message": "我的降压药什么时候吃？" }`
- 响应：`text/event-stream`，逐段返回 `delta`；结束后写入 `Message`。
- 越界问题：返回拒答文案并附 `suggestContactClinician: true`。

### GET `/api/assistant/conversations`
历史会话列表。
### GET `/api/assistant/conversations/:id`
某会话消息历史。

---

## 7. 症状分诊

### POST `/api/symptoms/analyze`
- Body：`{ "content": "伤口红肿有渗液，发烧38.5度", "symptomTags": ["fever","wound"]? }`
- 返回：
  ```json
  { "ok": true, "data": {
      "level": "RED",
      "advice": "建议立即联系主治医生或前往急诊",
      "redFlags": ["发热≥38.5°C", "伤口渗出"],
      "suggestContactClinician": true
  }}
  ```
- 说明：`level ∈ {GREEN,YELLOW,RED}`。规则命中红旗强制 RED。

### POST `/api/symptoms/report`
患者确认后提交（黄色/红色需二次确认）。
- Body：`{ "content": "...", "level": "RED", "advice": "...", "redFlags": [...] }`
- 副作用：生成 `SymptomReport` + 对应 `Alert`（YELLOW/RED）。
- 返回：`{ ok: true, data: { symptomReportId, alertId } }`

---

## 8. 预警（医护端）

### GET `/api/alerts`
- Query：`?status=OPEN&severity=RED&page=1`
- 返回：`{ ok: true, data: { items: Alert[], openCount: 3 } }`

### POST `/api/alerts/:id/handle`
- Body：`{ "action": "CONTACTED" | "REFERRED" | "IGNORED", "note": "已电话联系，嘱其明日复诊" }`
- 返回：更新后的预警（`status=RESOLVED` 或 `IGNORED`）。

---

## 9. 患者管理（医护端）

### GET `/api/clinician/patients`
- Query：`?q=&risk=RED&page=1`
- 返回：`{ ok: true, data: { items: [{ id, name, chronicConditions, riskLevel, adherence, lastFollowUpAt }] } }`

### GET `/api/clinician/patients/:id`
患者 360 视图聚合。
- 返回：`{ ok: true, data: { profile, plan, adherence, checkIns, symptoms, aiSummary } }`

### GET `/api/clinician/patients/:id/report`
生成随访报告。
- Query：`?format=json|pdf`
- 返回：报告数据或 PDF 流（内容全部来自真实数据）。

---

## 10. 知识库

### GET `/api/knowledge`
- 返回：`{ ok: true, data: { docs: KnowledgeDoc[] } }`

### POST `/api/knowledge`
- Body：`{ "title": "...", "category": "糖尿病饮食", "content": "..." }`
- 副作用：自动切片 + 向量化入 `KnowledgeChunk`。

### DELETE `/api/knowledge/:id`

---

## 11. 内部任务（调度器）

> 非公开接口，仅供 `node-cron` / worker 调用（可用内部密钥保护）。

### POST `/api/internal/reminders/tick`
扫描到期提醒并发送；处理升级状态机。幂等。
- 返回：`{ ok: true, data: { sent: 5, escalated: 2 } }`

### POST `/api/internal/reports/weekly`
生成周报（可选）。
