---
name: deepseek-text-generation
description: 通过百度千帆接入 DeepSeek V4 Pro（默认，可选 DeepSeek V4.1 Flash），完成文本创作、摘要、翻译、润色、推理与结构化内容生成；用于秒哒通用任务（Task），或为 Web、小程序和 App 构建文本 AI 功能。
license: MIT
---

# 文本生成大模型（DeepSeek）

## 接口与当前状态
- 仅一个 POST /v2/chat/completions 接口；默认模型 deepseek-v4-pro-0813，可选 deepseek-v4.1-flash。
- 上游 https://app-ezvlp6ds1hqa-api-ra5E8QRXA0wa-gateway.miaoda.online/v2/chat/completions。
- 飞轮 API ID：api-ra5E8QRXA0wa；只使用本技能接口，不复用其他 Skill 的 ID 或计费配置。
- 包内脚本和 Edge 端已回填 API ID；此 ID 是路由标识，不是鉴权密钥。
- 模型直连曾测试成功；不等同于本包网关、小程序或发布态验证完成。

## 模型选择（所有使用方式）

- 可选 DeepSeek V4 Pro（`deepseek-v4-pro-0813`）和 DeepSeek V4.1 Flash（`deepseek-v4.1-flash`），Pro 是推荐项与界面默认项
- 通用任务（Task）、直接文本生成及其他无选择界面的调用：用户未指定且本任务没有已确认模型时，先询问“本次使用 DeepSeek V4 Pro 还是 DeepSeek V4.1 Flash？默认推荐 Pro”，等待用户答复后再调用；用户回答“默认”视为确认 Pro，未回复不视为确认
- 用户已指定模型时直接使用，同一任务连续追问沿用已确认模型，不重复询问；用户提出切换时使用新选择，模型名称不明确时先确认
- 生成网页应用、小程序、App 等交互界面时，必须在主生成界面提供可见的模型选择入口，显示 Pro 与 Flash，默认选中 Pro；即使业务 Query 未提模型选择也要实现，静态品牌标签不算选择入口
- 保存选中模型并在每次生成请求中显式传递 `model`，不只改显示名称；生成过程中禁用切换，切换本身保留现有内容与会话，不触发请求；失败不自动切换模型
- 仅构建应用、未实际调用文本生成时，不要求用户预先选定唯一模型，应用应提供上述选择入口；构建中如需实际调用，则遵循调用前确认规则
- 脚本与服务端的 Pro 缺省值仅为兼容保护，不替代 Task 的用户确认
- 验收：Task 未指定时先询问且无调用、指定 Flash 时正确传值、连续追问不重复询问；应用入口可见、默认 Pro、切换后的请求值正确且既有内容保留

## 生成期（Agent 直接调用）
按上节完成模型确认后，执行包内脚本并显式传入所选模型：

    python3 scripts/generate_text.py --model deepseek-v4-pro-0813 --prompt "请总结以下内容" --max-tokens 4096

选择 Flash 时传 `--model deepseek-v4.1-flash`；确认 Pro 时传 `--model deepseek-v4-pro-0813`。
脚本采用非流式 JSON；支持错误退出和 429 有限退避。默认不自动重试已经开始输出的付费生成。
仅从环境变量 INTEGRATIONS_API_KEY 读取平台密钥；API ID 缺失时明确退出，不扫描仓库寻找其他凭证。
通用任务（Task）确认模型并调用后直接交付用户要的文本；不强制创建应用、部署 Edge Function 或数据库。

## 生成后（应用内）
必须读 [接口与平台接入](references/chat-completions-api.md)，采用包内实际实现，不复制旧文心调用片段：
- [解析器](assets/chat-runtime.mjs)
- [Edge 核心](assets/server.mjs) + [Deno 入口](assets/index.ts)
- [前端调用](assets/client.mjs)

Edge Function 名称统一 deepseek-text-generation。
应用必须提供模型选择入口，将所选 Pro 或 Flash 的 ID 显式传入 `model`；遵守上节模型选择规则。
服务端明确传 model、stream、max_tokens、thinking:{type:"disabled"}；流式还传 stream_options.include_usage。
普通文本默认显式关闭思考，不允许前端参数覆盖为 enabled；需要深度思考时另行配置并验证预算与正文完整性。
前端通过 Edge Function，不直接持有模型密钥。
Web 与微信小程序默认使用真实流式，结构化内容完整接收后执行 Schema 校验；只有用户明确选择时才用非流式。
App 可注入 expo/fetch；Taro 项目必须使用 [双端流式入口](assets/platform-stream.mjs) 及其 [类型声明](assets/platform-stream.d.mts)，微信真机内部使用 [分块适配器](assets/mini-stream.mjs)，通过 Taro.request/wx.request 的 enableChunked 与 onChunkReceived 接收 SSE，不使用浏览器 fetch 或普通 functions.invoke 冒充流式。
适配器含独立增量 UTF-8 解码，不依赖小程序全局 TextDecoder、ReadableStream 或 AbortController。页面边收边显示原始正文；JSON 成功结束后再生成结构化结果卡片。
环境不支持分块时明确提示，不静默切换非流式、不做打字机假流式。真机分块时序和域名配置仍须验收。

## 完成与错误契约
- UTF-8 增量解码、完整 SSE 事件解析、尾部缓冲、[DONE]、结束原因必须处理。
- length、过滤、坏帧、错误事件、无 DONE 的断流和空内容均失败，不静默跳过。
- reasoning_content 不拼入最终内容。Schema 校验前先完成整段输出，再去 BOM/围栏并解析。
- onText 仅表示增量，不代表完成；停止/卸载取消请求，finally 结束 loading，保留未完成文本并允许重试。
- 长方案限制条目和字段长度，必要时分批；输出预算默认 4096 是应用策略，不是模型上下文规格。
- 确定性业务逻辑由代码处理。应用需测试真实生成、展示及业务要求的保存恢复，禁止仅凭接口 200 宣称功能成功。

## 密钥边界
真实智能云密钥只配置在飞轮后台鉴权字段。本包不保存、展示、搜索或复用其他业务的真实凭证。
Edge Function 仅服务端读取 INTEGRATIONS_API_KEY，并使用 X-Gateway-Authorization。
前端仅用平台公开配置/当前用户会话调用自己的 Edge Function。
上游原始错误和认证头不返回前端，也不记录进日志。


## H5 预览与微信真机分流（强制）
- 小程序项目的浏览器预览运行在 H5，不等于微信真机。禁止无条件调用 generateMiniText/Taro.request 读取 SSE；Taro 4.1.10 H5 请求没有 onChunkReceived，旧实现会发起后立即取消请求。
- 使用 generatePlatformText，依据 Taro.getEnv() 或 TARO_ENV 明确传 platform:h5/weapp。H5 走原生 fetch + ReadableStream；微信真机走 enableChunked/onChunkReceived。两者都是 stream:true，不降级假流式。
- 前端复制 assets 下 client.mjs、chat-runtime.mjs、mini-stream.mjs、mini-stream.d.mts、platform-stream.mjs、platform-stream.d.mts；不要只复制微信适配器。服务端 index.ts/server.mjs 不放前端。
- 采用 [可见增量正文示例](assets/StreamingTextPanel.tsx)，实际接入 onText 更新正文并渲染 Text/View，不能只有 onState 的加载动画。结构化结果卡片在流结束并通过 Schema 后更新。
- 必须独立验收 H5 和微信真机：第一段正文早于请求结束、中文无乱码、取消和错误不误报成功、刷新/退出清理旧请求。离线适配器通过不等于两端验收通过。
