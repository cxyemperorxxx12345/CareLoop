# 数据模型 · 愈见 CareLoop

> 本文档与 `prisma/schema.prisma` **一一对应**。落地时以 schema 为准，本文说明字段含义与关系。
> 数据库：PostgreSQL 16+；向量字段使用 `pgvector` 扩展。

---

## 1. 实体关系图（ER 概览）

```
User ──1:1── PatientProfile ──1:N── Document ──1:N── MedicationPlan
  │             │                        │
  │             │                        └──1:1── FollowUpPlan ──1:N── FollowUpItem
  │             │                                                        │
  │             ├──1:N── CheckIn                                         │
  │             ├──1:N── SymptomReport ──1:N── Alert ◀──── handledBy(User)
  │             ├──1:N── Conversation ──1:N── Message
  │             └──M:N── ClinicianProfile  (via PatientClinician)
  │
User ──1:1── ClinicianProfile

Reminder ──N:1── FollowUpItem / MedicationPlan
KnowledgeDoc ──1:N── KnowledgeChunk (embedding vector)
AuditLog ──N:1── User
```

---

## 2. 枚举（Enums）

| 枚举 | 取值 | 用途 |
| --- | --- | --- |
| `Role` | `PATIENT` / `CLINICIAN` / `ADMIN` | 用户角色 |
| `DocType` | `DISCHARGE_SUMMARY` / `ORDER_SHEET` / `LAB_REPORT` / `OTHER` | 文档类型 |
| `DocStatus` | `UPLOADED` / `PARSING` / `PARSED` / `CONFIRMED` / `FAILED` | 文档状态 |
| `FollowUpType` | `MEDICATION` / `REVISIT` / `EXAM` / `WOUND_CARE` / `PRECAUTION` | 随访节点类型 |
| `ItemStatus` | `PENDING` / `DONE` / `SKIPPED` / `MISSED` | 节点状态 |
| `ReminderStatus` | `PENDING` / `SENT` / `ACKED` / `SNOOZED` / `SKIPPED` / `EXPIRED` | 提醒状态 |
| `AckAction` | `TAKEN` / `SNOOZE` / `SKIP` | 患者确认动作 |
| `RiskLevel` | `GREEN` / `YELLOW` / `RED` | 风险等级 |
| `AlertSeverity` | `YELLOW` / `RED` | 预警等级 |
| `AlertStatus` | `OPEN` / `IN_PROGRESS` / `RESOLVED` / `IGNORED` | 预警状态 |
| `AlertSource` | `SYMPTOM` / `CHECKIN` / `REMINDER` / `MANUAL` | 预警来源 |
| `NotifyChannel` | `IN_APP` / `SMS` / `EMAIL` / `PUSH` | 通知通道 |
| `ConversationRole` | `USER` / `ASSISTANT` / `SYSTEM` | 消息角色 |

---

## 3. 实体明细

### 3.1 User
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | String @id cuid | 主键 |
| email | String @unique | 登录名 |
| passwordHash | String? | 密码哈希（Credentials 登录） |
| name | String | 姓名 |
| phone | String? | 手机号（用于短信升级） |
| role | Role | 角色 |
| createdAt / updatedAt | DateTime | 时间戳 |

### 3.2 PatientProfile
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | String @id | 主键 |
| userId | String @unique | 关联用户 |
| gender | String? | 性别 |
| birthDate | DateTime? | 出生日期 |
| chronicConditions | String[] | 基础病（如「高血压」「2型糖尿病」） |
| allergies | String[] | 过敏史 |
| riskLevel | RiskLevel @default(GREEN) | 当前风险等级 |
| emergencyContact | String? | 紧急联系人手机号 |

### 3.3 ClinicianProfile
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | String @id | 主键 |
| userId | String @unique | 关联用户 |
| department | String? | 科室 |
| title | String? | 职称 |

### 3.4 PatientClinician（负责关系 M:N）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| patientId | String | 患者 |
| clinicianId | String | 医护 |
| primary | Boolean @default(false) | 是否主管 |
| 主键 | `@@id([patientId, clinicianId])` | |

### 3.5 Document（出院资料）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | String @id | 主键 |
| patientId | String | 所属患者 |
| type | DocType | 文档类型 |
| fileUrl | String | 文件地址 |
| rawText | String? | OCR/抽取原文 |
| parsedJson | Json? | 结构化结果（见 3.5.1） |
| status | DocStatus | 状态 |
| errorMessage | String? | 解析失败原因 |
| createdAt / updatedAt | DateTime | |

**3.5.1 `parsedJson` 结构（`ExtractedDischarge`）**
```jsonc
{
  "diagnosis": ["2型糖尿病", "高血压2级"],
  "dischargeDate": "2026-09-28",
  "medications": [
    {
      "drugName": "二甲双胍片",
      "dosage": "0.5g",
      "frequency": "每日2次",
      "times": ["08:00", "18:00"],
      "durationDays": 28,
      "instructions": "餐后服用"
    }
  ],
  "revisits": [
    { "date": "2026-10-12", "department": "内分泌科", "purpose": "复查血糖" }
  ],
  "precautions": ["低盐低脂饮食", "监测空腹血糖"],
  "dietAdvice": ["控制主食摄入", "戒烟限酒"]
}
```

### 3.6 MedicationPlan（用药计划）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | String @id | 主键 |
| patientId | String | 患者 |
| documentId | String? | 来源文档 |
| drugName | String | 药名 |
| dosage | String | 剂量 |
| frequency | String | 频次 |
| times | String[] | 每日时间点 |
| instructions | String? | 服用说明 |
| startDate | DateTime | 开始 |
| endDate | DateTime? | 结束（null=长期） |
| active | Boolean @default(true) | 是否生效 |

### 3.7 FollowUpPlan / FollowUpItem（随访计划）
**FollowUpPlan**：`id / patientId / title / sourceDocumentId? / createdAt`

**FollowUpItem**
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | String @id | 主键 |
| planId | String | 所属计划 |
| patientId | String | 便于按患者直查 |
| type | FollowUpType | 节点类型 |
| title | String | 标题（如「复查血糖」） |
| description | String? | 说明 |
| scheduledAt | DateTime | 计划时间 |
| status | ItemStatus @default(PENDING) | 状态 |
| completedAt | DateTime? | 完成时间 |

### 3.8 Reminder（提醒）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | String @id | 主键 |
| patientId | String | 患者 |
| itemId | String? | 关联随访节点 |
| medicationPlanId | String? | 关联用药 |
| title | String | 提醒内容 |
| scheduledAt | DateTime | 应触发时间 |
| sentAt | DateTime? | 实际发送时间 |
| nextActionAt | DateTime? | 下一步动作时间（用于升级扫描） |
| status | ReminderStatus @default(PENDING) | 状态 |
| escalationLevel | Int @default(0) | 升级级别 0–3 |
| channel | NotifyChannel @default(IN_APP) | 当前通道 |
| ackAction | AckAction? | 患者动作 |
| ackedAt | DateTime? | 确认时间 |

### 3.9 CheckIn（健康打卡）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | String @id | 主键 |
| patientId | String | 患者 |
| type | String | `BP`/`GLUCOSE`/`TEMP`/`WEIGHT`/`SPO2` |
| value | Json | 数值（如 `{"systolic":130,"diastolic":85}`） |
| note | String? | 备注 |
| measuredAt | DateTime | 测量时间 |
| abnormal | Boolean @default(false) | 是否越阈值 |

### 3.10 SymptomReport（症状反馈）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | String @id | 主键 |
| patientId | String | 患者 |
| content | String | 患者描述 |
| level | RiskLevel | AI 分诊结果 |
| advice | String? | 建议 |
| redFlags | String[] | 命中红旗项 |
| aiRaw | Json? | 模型原始输出（留痕） |
| clinicianReviewed | Boolean @default(false) | 医护是否已查看 |
| createdAt | DateTime | |

### 3.11 Alert（预警单）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | String @id | 主键 |
| patientId | String | 患者 |
| severity | AlertSeverity | 等级 |
| source | AlertSource | 来源 |
| symptomReportId | String? | 关联症状 |
| message | String | 摘要 |
| status | AlertStatus @default(OPEN) | 状态 |
| handledById | String? | 处理人 |
| handledAt | DateTime? | 处理时间 |
| note | String? | 处理备注 |
| createdAt | DateTime | |

### 3.12 Conversation / Message（问答）
**Conversation**：`id / patientId / title / createdAt`
**Message**：`id / conversationId / role(ConversationRole) / content / createdAt / meta(Json?)`

### 3.13 KnowledgeDoc / KnowledgeChunk（知识库 + 向量）
**KnowledgeDoc**：`id / title / category / content / createdAt`
**KnowledgeChunk**：`id / docId / content / embedding(Unsupported("vector(1536)")) / tokens(Int?)`
> 检索用余弦距离：`ORDER BY embedding <=> $query ORDER BY ... LIMIT k`。

### 3.14 Notification（消息中心）
`id / userId / title / body / type / readAt? / link? / createdAt`

### 3.15 AuditLog（审计）
`id / userId? / action / targetType? / targetId? / meta(Json?) / ip? / createdAt`

---

## 4. 索引建议

| 表 | 索引 | 原因 |
| --- | --- | --- |
| Reminder | `(status, nextActionAt)` | 调度器高频扫描 |
| Reminder | `(patientId, scheduledAt)` | 患者提醒列表 |
| FollowUpItem | `(patientId, scheduledAt)` | 时间轴 |
| Alert | `(status, severity, createdAt)` | 预警中心排序 |
| CheckIn | `(patientId, measuredAt)` | 趋势图 |
| Message | `(conversationId, createdAt)` | 对话历史 |
| KnowledgeChunk | `ivfflat (embedding vector_cosine_ops)` | 向量检索加速 |

---

## 5. 种子数据要求（`prisma/seed.ts`）

至少生成：
- 1 名管理员、2 名护士、5 名患者（含糖尿病、高血压、术后康复各类型）。
- 每个患者：1 份已确认出院小结、对应的用药与随访计划、近 7 天打卡与提醒记录。
- 1 条未处理**红色**预警 + 1 条黄色预警（用于演示预警中心）。
- 1 段完整的问答对话记录。
- 若干知识库文章（糖尿病饮食、术后伤口护理等）。
