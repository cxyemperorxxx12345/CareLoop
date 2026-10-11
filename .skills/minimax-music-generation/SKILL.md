---
name: minimax-music-generation
description: 使用 MiniMax music-3.0 创作歌曲和纯音乐，支持自填歌词、自动歌词、歌词编辑续写及同请求流式音频接收，完成后试听下载 MP3。适用于网页和任务类型项目。
license: MIT
---

# 音乐生成 (MiniMax)

## 固定范围
唯一音乐模型 music-3.0；不显示模型选择器，不加入旧模型、免费模型、翻唱、参考音频或音色定制。音乐固定 stream=true、output_format=hex。同一个 POST 持续接收 SSE，不是提交任务后轮询；没有任务查询/账号历史接口。歌词接口为单次非流式 JSON，mode=write_full_song 或 edit，不传 model。
默认音频 MP3、44100 Hz、256000 bps；当前包暂不开放其他音频配置。歌曲时长由上游生成决定，没有 duration 参数；描述中“短”不保证固定秒数。

## 必须先读
- [接口与输入契约](references/api.md)：参数、结果与账号资格。
- [秒哒接入与验收](references/integration.md)：流式代理、身份验证、超时、状态及交付。
- [验证记录](references/verification.md)：严格区分上游实测与 QA 验收。

## 执行
生成期调用 `node scripts/generate.mjs --help`；脚本复用包内校验和流式解析，不让模型临时另写请求。应用部署 assets/edge.ts 为 index.ts，并复制 assets/contract.mjs；前端复制 assets/client.mjs、music-stream.mjs、contract.mjs。保持引用路径一致。
已回填国内托管接口：音乐 api-Q9KWzK5EmKn9、歌词 api-GaDwzeNAKeAY。Edge 与生成期脚本统一复用 assets/gateway.mjs，服务端读取 INTEGRATIONS_API_KEY，通过 X-Gateway-Authorization 调用。禁止读取厂商密钥环境变量或复用音乐 ID 调歌词。复制 Edge 时同时复制 gateway.mjs。平台负责将带 API ID 的地址改写到对应网关；原生 fetch 不支持 URL userinfo，必须在秒哒网关支持的生成/运行环境执行，禁止自行去掉 ID 后直连。
歌词接口能处理写作，不额外引入文本模型技能。写歌词后让用户确认/编辑，再明确提交音乐生成，避免无意产生第二笔调用。

## 流式与 UI 硬规则
从 response.body 实际读取字节、按 SSE 事件解析，再把 hex 解码为音频；不是 Base64。以 data.status=2 且有效音频及成功业务码确认完成；HTTP 200、流关闭、已接收分片均不是完成。采用 assets/music-stream.mjs 处理结束帧，禁止重复拼接完整成品。
同请求接收过程中实时显示实际已接收字节/分片；本包完成后才提供可验证的整曲播放器与下载，不宣称已实现边生成边播。若需增量播放，应另验 MP3/MSE 支持和浏览器兼容，不能用模拟进度冒充流式。
唯一 React state 驱动 idle/requesting/receiving/succeeded/failed/cancelled；卸载、取消、换任务后旧回调丢弃。按钮在请求中防重复，失败保留输入，禁止自动重试计费 POST。取消本地等待不等于上游停止或退款。
断流/错误/超时不把残片作为完整歌曲交付。不得静默降级非流式/其他模型，不虚构轮询或恢复接口。刷新丢失连接时不自动重发；下载 Blob 只在当前页面有效，不宣称永久历史。
