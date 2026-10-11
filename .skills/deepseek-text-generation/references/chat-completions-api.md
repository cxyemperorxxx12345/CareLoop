# DeepSeek 文本生成接口与可复用实现

## 接口边界
仅一个 POST 接口，上游为 https://app-ezvlp6ds1hqa-api-ra5E8QRXA0wa-gateway.miaoda.online/v2/chat/completions。
默认模型 deepseek-v4-pro-0813，可选 deepseek-v4.1-flash。API ID 为 api-ra5E8QRXA0wa，不复用文心 Plugin ID、API ID 或计费关系。
无任务轮询接口；返回 id 仅用于排错。

## 参数
- model：上游请求必填；传入已确认/界面选中的 deepseek-v4-pro-0813 或 deepseek-v4.1-flash。包内服务端缺省 Pro 仅为兼容保护，模型选择与 Task 询问流程以 [SKILL.md](../SKILL.md#模型选择所有使用方式) 为准。
- messages：必填，非空 role/content 数组；当前实现支持 system/user/assistant 文本。
- stream：明确传 true（SSE）或 false（JSON），不依赖默认值。
- max_tokens：示例默认 4096。应用模板允许 128–16384，这是应用保护范围，不是模型最大上下文声明。
- stream_options.include_usage：流式传 true。
- thinking：普通文本请求显式传 {"type":"disabled"}，不要依赖上游默认值。已有非流式关闭思考对照测试，不代表流式/平台/真机全部验证通过。当前模板不开放前端启用思考；工具调用、联网、response_format 等参数不默认启用。
- 千帆通用文档将 max_tokens 定义为最终回答额度；此前短测观察到输出和 reasoning 用量共同达到小额度时答案不完整，因此留足预算并验证结束状态，不把短测推断当通用规格。

## 可直接采用的文件
- [流式与 JSON 解析器](../assets/chat-runtime.mjs)：Web、服务端、支持 Web Streams 的 App 共用。
- [Edge 核心](../assets/server.mjs) 与 [Deno 入口](../assets/index.ts)。
- [前端调用](../assets/client.mjs)。

部署：将 index.ts、server.mjs、chat-runtime.mjs 一起复制到应用 supabase/functions/deepseek-text-generation/。
前端将 client.mjs、chat-runtime.mjs 一起复制到 src/lib/deepseek/。
TypeScript 项目为 .mjs 配置声明或按项目类型约束转换，禁止通过删除类型检查掩盖构建错误。

包内调用地址：https://app-ezvlp6ds1hqa-api-ra5E8QRXA0wa-gateway.miaoda.online/v2/chat/completions。缺少平台环境密钥时明确失败，不搜索或硬编码真实凭证。
网关只使用服务端 INTEGRATIONS_API_KEY 和 X-Gateway-Authorization；智能云原始密钥仅保存在飞轮后台。

## 流式契约
1. 按 Content-Type 分流：application/json 读取最终 message.content；text/event-stream 增量读取 delta.content。
2. 增量 UTF-8 解码，处理中文拆字节、CR/LF/CRLF、跨 chunk 半帧、多行 data、注释、无尾部换行。
3. 遇到 [DONE] 才确认流结束；EOF 无 [DONE] 报 incomplete_stream。允许在 EOF 刷新完整尾帧，但拒绝坏帧。
4. finish_reason=length/content_filter/tool_calls、空输出、错误事件、坏 JSON 均失败；禁止静默丢帧后宣称成功。
5. reasoning_content 不作为结果正文。usage 空 choices 帧正常处理。
6. 客户端停止、超时、网络错误均结束 loading 并可重试。禁止收到第一帧后就设置 success。
7. Edge 在流中出错发送已脱敏 error 事件，不透传上游原始错误/认证头。
8. 输出达到本地 100 万字符保护阈值时明确终止，不无限占用内存。

## 前端集成
调用 generateText，传入应用公开 Supabase URL、publicAnonKey、实际用户 sessionAccessToken（如有）、messages。
这些公开/用户会话凭证不是模型服务端密钥。
onText 增量更新文本；onState 更新 loading/streaming/success/error/canceled。
React 外层用 try/catch/finally，finally 结束 busy，卸载时 abort；重复点击需禁用或取消上一请求。
失败时保留部分文本但标记“未完成”，不要自动保存成完整方案。重试默认用户主动触发，避免重复计费。
生成成功后按业务需要保存结果；纯对话不强加数据库。

## JSON 方案输出
前端默认 stream:true，传 validate(value) => boolean 业务 Schema 校验器；用户明确选择非流式时才使用 stream:false。
若用 SSE，也在完整成功后才 parseStructured；去 BOM/首尾 JSON 围栏、一次 JSON.parse，再 Schema 校验。
解析失败保留原文，展示重试；不截取半截数组、不强行补括号伪造成功。
按业务限制字段长度、条目数；长方案分批生成并分别校验，不宣称“更长 token 一定解决”。

## 小程序与 App
Web 使用 client.mjs 默认 fetch。
React Native 若使用 expo/fetch，则通过 fetchImpl 注入；须验证 Response.body/getReader 实际可用。
Taro 小程序工程的 H5 预览与微信真机必须分开选择传输实现。统一使用 [platform-stream.mjs](../assets/platform-stream.mjs)，禁止在 H5 调用 generateMiniText。复制 client.mjs、chat-runtime.mjs、mini-stream.mjs、mini-stream.d.mts、platform-stream.mjs、platform-stream.d.mts 到 src/lib/deepseek，保留类型声明。

完整可见 UI 示例：[StreamingTextPanel.tsx](../assets/StreamingTextPanel.tsx)。它包含平台判断、实际 onText 正文更新、停止、重复请求隔离、卸载清理与错误保留。按业务替换 messages、validate、onResult；凭据仅用平台公开配置和当前用户会话。

```ts
const env = Taro.getEnv();
const platform = env === Taro.ENV_TYPE.WEB ? 'h5'
  : env === Taro.ENV_TYPE.WEAPP ? 'weapp' : null;
// platform 为 null 时显示不支持，不猜测为微信。
// generatePlatformText({platform, request: options => Taro.request(options), ...})
// H5 分支不会调用传入的 Taro.request，而使用原生 fetch；微信分支不会调用浏览器 fetch。
```

页面不允许并发重复点击；卸载时使用 useUnload/组件清理执行 run.abort()。新请求开始前取消旧请求并使用请求序号隔离回调。大量分块时可按50–100ms节流UI更新，最终成功/失败/取消要刷新缓存，禁止每块执行 JSON.parse 或把半成品当结果。
传 validate 时仅在 [DONE]、stop、正文非空后调用 parseStructured 和业务 Schema 校验；流式期间展示纯文本进度。
请求始终发往本应用 Edge Function，data.stream=true；配置微信 request 合法域名为实际 Edge Function 域名，不能靠开发工具“不校验合法域名”代替上线配置。Edge 和网关不得缓冲整段 SSE 后一次返回。
平台运行时需要支持 RequestTask.onChunkReceived/onHeadersReceived；缺能力明确报 streaming_not_supported，不静默改非流式。仅接受 SSE 内容类型；只有最终 success 回调且收到 [DONE]、stop、非空正文后才成功。无分块、断流、错误事件、超时和取消都不能标成成功。
success 回调的 data 可能重复已收到的所有分块，不能二次拼接。微信真机不使用 EventSource（此接口是POST），不依赖浏览器 fetch/ReadableStream 或 TextDecoder；H5 预览则必须采用原生 fetch 流式读取。
参考：https://docs.taro.zone/docs/apis/network/request/ 与 https://docs.taro.zone/docs/apis/network/request/RequestTask/ 。当前适配器针对微信小程序，不推定支付宝/百度等其他运行时等价支持。
保留 Taro 平台公开构建变量；不添加匿名登录依赖或 index.html 安全头 meta。

## 上线前
API ID 已回填；上线前仍须测试网关 JSON、SSE、长中文、结构化输出、停止、超时、坏帧与长度截断；再实测生成应用完整功能。
本地模拟通过不等于平台集成、真机或发布态验收通过。

## 后台定义同步的接口说明

以下同步自本次飞轮定义，仅包含非敏感 context，不包含后台鉴权值或计费配置。

# DeepSeek 文本生成接口

## 接口
DeepSeek V4 Pro 文本生成与推理。仅一个 POST 接口，无任务轮询接口。
POST https://app-ezvlp6ds1hqa-api-ra5E8QRXA0wa-gateway.miaoda.online/v2/chat/completions
请求内容类型：application/json
返回 id 用于排查请求，不是异步任务 ID。

## 参数
| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| model | string | 是 | 默认 deepseek-v4-pro-0813，可选 deepseek-v4.1-flash |
| messages | array | 是 | 非空消息数组；基础文本流程使用 system/user/assistant |
| messages[].role | string | 是 | 消息角色 |
| messages[].content | string | 是 | 文本；多轮按顺序携带必要历史 |
| stream | boolean | 否 | 上游默认 false；本技能明确传 true 或 false |
| max_tokens | integer | 否 | 本技能示例为 4096；具体限制语义依模型而定，不保证正文长度或总计费上限 |
| thinking | object | 否 | 普通文本流程显式传 {"type":"disabled"}，避免依赖供应商默认值 |
| thinking.type | string | 否 | 普通文本用 disabled；enabled 为显式选择的深度思考模式，需单独验证预算与完成情况 |
| stream_options | object | 否 | stream=true 时生效 |
| stream_options.include_usage | boolean | 否 | 流式记录用量时设 true |

128–16384 是当前应用模板的预算保护范围，不是模型官方范围或接口必填限制。
通用文档将 max_tokens 定义为最终回答长度，max_completion_tokens 为含推理的总输出长度；具体支持性依模型而定，不将短测现象推广为统一规格。普通写作、摘要、翻译和结构化内容流程显式设置 thinking.type=disabled；本模型此前非流式关闭思考对照已返回非空正文，但不代表所有场景的质量、长度或流式兼容性已验证。深度思考仅按明确业务需要启用，不把不传参数等同于关闭思考。工具调用、联网等高级参数不默认启用。

## JSON 请求示例
```json
{
  "model": "deepseek-v4-pro-0813",
  "messages": [
    {
      "role": "system",
      "content": "你是一个文本写作助手。"
    },
    {
      "role": "user",
      "content": "用三点概括团队每周复盘的好处。"
    }
  ],
  "stream": false,
  "max_tokens": 4096,
  "thinking": {
    "type": "disabled"
  }
}
```

## JSON 响应示例
以下是结构示意，不是本次实测输出。
```json
{
  "id": "example-response-id",
  "object": "chat.completion",
  "model": "deepseek-v4-pro-0813",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "及时发现问题、共享经验、明确改进事项。"
      },
      "finish_reason": "stop",
      "flag": 0
    }
  ],
  "usage": {
    "prompt_tokens": 40,
    "completion_tokens": 30,
    "total_tokens": 70
  }
}
```
正文读取 choices[0].message.content；reasoning_content 若存在，不混入最终正文。
JSON 模式没有 [DONE]。usage 记录上游用量，不等于平台已启用按 Token 结算；后台按次计费与上游 Token 成本分开处理。completion_tokens_details.reasoning_tokens 若返回，是 completion_tokens 的明细，不重复相加。

## SSE 请求示例
```json
{
  "model": "deepseek-v4-pro-0813",
  "messages": [
    {
      "role": "user",
      "content": "写一段简短项目介绍。"
    }
  ],
  "stream": true,
  "max_tokens": 4096,
  "stream_options": {
    "include_usage": true
  },
  "thinking": {
    "type": "disabled"
  }
}
```

## SSE 响应示例
事件之间以空行分隔：
```text
data: {"choices":[{"index":0,"delta":{"content":"项目介绍"},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":10,"total_tokens":30}}

data: [DONE]

```
实际用量帧和结束帧以服务响应为准。usage 帧可有空 choices；仅累加 delta.content。
增量 UTF-8 解码并解析 SSE 事件，处理中文拆字节、CR/LF、跨块半帧、多行 data 和 EOF 尾部缓冲。
按实际响应内容类型区分 JSON 与 SSE，不强行将普通 JSON 标记为流。
第一帧只表示生成中；本技能基础文本流程在正常结束且收到 [DONE] 后才标记流式结果完成。

## 完成与失败
- stop：上游报告结束，但不保证完整或可用；仍需非空正文、任务要求及适用的业务 Schema 校验。
- 空正文：即使 HTTP 200 且 finish_reason=stop 也标记失败，不把 reasoning_content 当正文。此前出现 completion_tokens=reasoning_tokens=4096 且正文为空的实测，应检查思考开关、预算和供应商结束语义；该现象不构成所有模型统一截断规则。不得无限提高预算或自动循环重试。
- length：可能截断，提示缩小单次输出或调整预算。
- content_filter 或非零 flag：按受限内容处理，不标记成功。
- tool_calls：工具调用分支，当前基础文本流程不执行；这不是模型官方不支持工具调用的结论。
- 坏帧、错误事件、无 [DONE] 的流式断流、超时：保留未完成内容，结束 loading，提供重试，不静默跳帧。
- HTTP 400 检查参数；401/403 检查访问验证与权限；402 检查余额/配额；429 按 Retry-After 有限退避。
- 已开始输出的失败请求不自动重复生成，避免重复成本；上游原始错误不直接返回用户。

## 结构化内容
要求紧凑 JSON，限制条目及字段长度；默认流式完整接收后再解析，勿逐块解析。
流式完整合并后去开头 U+FEFF、去首尾 JSON 围栏、一次 JSON.parse，再业务 Schema 校验。
Schema 失败保留输入和生成文本，明确原因并允许重试；不补括号或截取半截数组伪造成功。
长方案必要时分批生成并分别验证。

## 秒哒使用
通用任务直接交付文本；应用运行期通过自身 Edge Function 调用平台能力，前端不直连上游。
函数名统一 deepseek-text-generation；页面区分生成中、成功、失败和取消。
Web/App/微信小程序均采用对应运行时的真实流式读取；微信小程序使用包内 mini-stream.mjs。真机兼容、域名和中间链路不缓冲仍需实测。

## 本次小程序流式验收边界
新增适配器已用离线 RequestTask 回调模拟测试；不表示微信真机或 QA 应用实测通过。验收需确认第一段正文早于网络请求结束、中文/emoji无乱码、持续增量显示、结束完整、取消有效、断流不误报成功。
