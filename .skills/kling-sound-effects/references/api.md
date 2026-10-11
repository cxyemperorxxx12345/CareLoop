# 秒哒网关接口

以下四项以用户提供的后台定义为基线，不新增列表或其他接口。

| 方法 | API ID | 路径 |
|---|---|---|
| POST | api-M9v0OOljObNY | /v1/audio/text-to-audio |
| GET | api-Aa2P88mE81wL | /v1/audio/text-to-audio/{task_id} |
| POST | api-rY7Jzzmqz7KL | /v1/audio/video-to-audio |
| GET | api-oYA6zzxRz1Ea | /v1/audio/video-to-audio/{task_id} |

请求地址采用 `https://<实际API_ID>@app-ezvlp6ds1hqa-api-M9v0OOljObNY-gateway.miaoda.online/<实际路径>`；服务端读取 INTEGRATIONS_API_KEY，使用 X-Gateway-Authorization 请求头。创建与查询分别使用对应 ID。所有路径和参数详见 [文生音效](text-to-audio.md)、[视频生音效](video-to-audio.md)。
查询路径中的 task_id 必须替换成编码后的系统任务 ID；不通过 GET Body 传递，不猜测外部 ID 查询方式。网关带 ID 的 URL 必须使用秒哒支持的网关转发运行环境；普通浏览器 fetch 禁止用户信息 URL，不得在浏览器直接调用。部署时需验证 Edge 的实际网关转发行为，不将离线语法通过当作网关联通。
仅有四个接口：创建文生音效、查询单个文生音效、创建视频生音效、查询单个视频生音效。无账号级列表能力。生成成功读音频 MP3/WAV；视频模式同时读视频结果。凭证原值只留后台，不进入此包。
