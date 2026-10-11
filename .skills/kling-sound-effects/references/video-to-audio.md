# 创建视频生音效任务

- Source: https://klingai.com/document-api/api/video/audio-generation/video-to-audio
- 描述: 为输入视频配音效和背景音乐，支持 ASMR 模式。
- Method: POST
- Endpoint: `https://app-ezvlp6ds1hqa-api-rY7Jzzmqz7KL-gateway.miaoda.online/v1/audio/video-to-audio`

## 请求头

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| Content-Type | string | 是 | application/json |

## 请求参数 (Body)

| 字段路径 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| video_id | string | 否 | - | 可灵 AI 生成视频的 ID（30 天内生成，3–20 秒），与 video_url 二选一 |
| video_url | string | 否 | - | 上传视频的获取链接（MP4/MOV，≤100M，3–20 秒），与 video_id 二选一 |
| sound_effect_prompt | string | 否 | - | 音效生成提示词，不超过 200 字符 |
| bgm_prompt | string | 否 | - | 配乐生成提示词，不超过 200 字符 |
| asmr_mode | boolean | 否 | false | 是否开启 ASMR 模式以增强细节音效 |
| external_task_id | string | 否 | - | 用户自定义任务 ID，单用户下需唯一 |
| callback_url | string | 否 | - | 任务状态变更回调通知地址 |

## 响应结构

```json
{
  "code": 0,
  "message": "string",
  "request_id": "string",
  "data": {
    "task_id": "string",
    "task_info": {
      "external_task_id": "string"
    },
    "task_status": "string",
    "created_at": 1722769557708,
    "updated_at": 1722769557708
  }
}
```

## 请求示例

```bash
curl --request POST \
  --url https://app-ezvlp6ds1hqa-api-rY7Jzzmqz7KL-gateway.miaoda.online/v1/audio/video-to-audio \
  --header 'Content-Type: application/json' \
  --data '{
    "video_url": "https://p1-kling.klingai.com/kcdn/cdn-kcdn112452/kling-qa-test/20fps-7s.mov"
  }'
```

## 创建约束

提交前校验输入。external_task_id 由应用服务端生成并保存，保证共享上游账号下唯一；它仅为标识，不承担权限校验。创建响应不是媒体结果，保存 data.task_id 后查询同一任务。创建响应超时可能已受理，不自动重复创建计费任务；回调地址仅使用服务端配置的可信地址，未接入官方回调校验协议时采用轮询。

## 状态与结果处理

同时检查 HTTP 状态和业务 code；code=0 仅表示本次接口调用成功。data.task_status 枚举为 submitted、processing、succeed、failed。submitted/processing 继续有限轮询；succeed 才进入结果校验；failed 展示 task_status_msg 并停止。未知状态、task_id 不匹配或成功但媒体为空均不得当作生成完成。
音频结果遍历 data.task_result.audios，读取 url_mp3、url_wav，duration_mp3/duration_wav 为秒数字符串；视频生音效同时读取 data.task_result.videos 的 url、duration。尚未生成结果时允许 task_result 缺失。不要将创建响应中的任务 ID 当作播放地址。
前端完成后显示实际播放器及下载/保存入口；媒体将在 30 天后清理，及时转存。转存失败仅重试转存，不重新创建生成任务。轮询应防重入、设置超时、终态停止；刷新恢复原任务。

## 共享凭证下的用户隔离

上游不负责区分本应用登录用户。应用后端验证真实登录会话，以服务端确认的用户身份保存任务归属；单任务查询、下载链接签发、保存及本地历史记录读取均先检查归属。不得相信前端传入的 user_id，不得仅凭知道 task_id 或 external_task_id 放行。
“我的记录”只查本应用按用户隔离的数据库，不新增或透传共享上游账号的任务列表。采用数据库行级访问控制及私有媒体存储；后端高权限访问仍须显式检查用户归属。其他用户的任务拒绝返回。上述规则须由应用代码实现，技能定义文字本身不会自动隔离数据。


---

# 查询视频生音效任务（单个）

- Source: https://klingai.com/document-api/api/video/audio-generation/video-to-audio
- 描述: 查询指定视频生音效任务的状态和生成结果。
- Method: GET
- Endpoint: `https://app-ezvlp6ds1hqa-api-oYA6zzxRz1Ea-gateway.miaoda.online/v1/audio/video-to-audio/{task_id}`

## 请求头

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| Content-Type | string | 是 | application/json |

## 路径参数 (Path Params)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| task_id | string | 是 | 当前接口路径中的系统任务 ID，取自创建响应 data.task_id；调用前校验属于当前用户 |

## 响应结构

```json
{
  "code": 0,
  "message": "string",
  "request_id": "string",
  "data": {
    "task_id": "string",
    "task_status": "string",
    "task_status_msg": "string",
    "task_info": {
      "external_task_id": "string",
      "parent_video": {
        "id": "string",
        "url": "string",
        "duration": "string"
      }
    },
    "task_result": {
      "videos": [
        {
          "id": "string",
          "url": "string",
          "duration": "string"
        }
      ],
      "audios": [
        {
          "id": "string",
          "url_mp3": "string",
          "url_wav": "string",
          "duration_mp3": "string",
          "duration_wav": "string"
        }
      ]
    },
    "final_unit_deduction": "string",
    "final_balance_deduction": {
      "quota": "string",
      "list_price": "string"
    },
    "created_at": 1722769557708,
    "updated_at": 1722769557708
  }
}
```

## 请求示例

```bash
curl --request GET \
  --url https://app-ezvlp6ds1hqa-api-oYA6zzxRz1Ea-gateway.miaoda.online/v1/audio/video-to-audio/{task_id} \
```

## 查询约束

本接口按系统 task_id 精确查询。上游文档另提及 external_task_id 查询，但未明确该方式的路径编码，本定义不将其当作第二个路径参数，不猜测调用方式。GET 请求不使用 JSON 请求体替代路径参数。构造请求时对 task_id 作路径编码；网关路径变量替换需单独实测。

## 状态与结果处理

同时检查 HTTP 状态和业务 code；code=0 仅表示本次接口调用成功。data.task_status 枚举为 submitted、processing、succeed、failed。submitted/processing 继续有限轮询；succeed 才进入结果校验；failed 展示 task_status_msg 并停止。未知状态、task_id 不匹配或成功但媒体为空均不得当作生成完成。
音频结果遍历 data.task_result.audios，读取 url_mp3、url_wav，duration_mp3/duration_wav 为秒数字符串；视频生音效同时读取 data.task_result.videos 的 url、duration。尚未生成结果时允许 task_result 缺失。不要将创建响应中的任务 ID 当作播放地址。
前端完成后显示实际播放器及下载/保存入口；媒体将在 30 天后清理，及时转存。转存失败仅重试转存，不重新创建生成任务。轮询应防重入、设置超时、终态停止；刷新恢复原任务。

## 共享凭证下的用户隔离

上游不负责区分本应用登录用户。应用后端验证真实登录会话，以服务端确认的用户身份保存任务归属；单任务查询、下载链接签发、保存及本地历史记录读取均先检查归属。不得相信前端传入的 user_id，不得仅凭知道 task_id 或 external_task_id 放行。
“我的记录”只查本应用按用户隔离的数据库，不新增或透传共享上游账号的任务列表。采用数据库行级访问控制及私有媒体存储；后端高权限访问仍须显式检查用户归属。其他用户的任务拒绝返回。上述规则须由应用代码实现，技能定义文字本身不会自动隔离数据。

