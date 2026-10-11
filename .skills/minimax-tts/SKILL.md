---
name: minimax-tts
description: 使用 MiniMax 将文本转换为高质量语音音频，支持多音色、情绪、语速等控制，适用于有声内容、语音助手、游戏配音等场景
license: MIT
---

## 能力概述

基于 MiniMax T2A V2 接口，将文本同步合成为语音音频。支持中文、英文、日文等多种语言，提供本包指定的系统音色，可控制语速、音量、语调、情绪等参数，还支持停顿标记、语气词标签、发音字典、LaTeX 朗读、混合音色、声音效果器等高级特性。

| 项目 | 值 |
|------|----|
| Endpoint | `POST https://app-ezvlp6ds1hqa-api-DLEO7Bj0lORa-gateway.miaoda.online/v1/t2a_v2` |
| 认证方式 | platform_managed（`X-Gateway-Authorization: Bearer ${INTEGRATIONS_API_KEY}`） |
| 响应格式 | JSON（`data.audio` 默认为 hex 编码音频；设置 `output_format: "url"` 可获取 CDN URL） |
| 计费 | 按次计费 |

### 平台差异说明

| 平台 | 推荐方案 | 原因 |
|------|---------|------|
| Web | `output_format: "url"` + `supabase.functions.invoke` 或原生 `fetch`，获取 `audioUrl` 后赋给 `new Audio().src` | 通过 Edge Function 返回 CDN URL，直接播放，无需 base64 转换 |
| MiniProgram | `output_format: "url"` + `supabase.functions.invoke`，获取 `audioUrl` 后赋给 `Taro.createInnerAudioContext().src` | weapp 不支持 `btoa`；CDN URL 可直接赋给 `audio.src` |
| App | `output_format: "url"` + `supabase.functions.invoke`，获取 `audioUrl` 后通过 `expo-audio` 的 `useAudioPlayer` 播放 | 使用 `player.replace({ uri: audioUrl })` + `player.play()` 播放，三端一致 |

> 详细参数表、Edge Function 代码、前端代码见 [references/t2a-v2-api.md](references/t2a-v2-api.md)

---

## 生成期用法（Agent 直接调用）

生成期调用请使用内置脚本，脚本会从环境变量读取 INTEGRATIONS_API_KEY，不再现场生成请求/下载代码。

```bash
python3 <skill-path>/scripts/synthesize_speech.py --text "今天天气真不错" --voice-id male-qn-qingse --output /path/to/audio.mp3
```

可指定模型、语速、音量、语调等参数：

```bash
python3 <skill-path>/scripts/synthesize_speech.py --text "..." --model speech-2.8-hd --speed 1.1 --vol 1.2 --pitch 2 --output /path/to/audio.mp3
```

脚本默认以 `output_format=url` 调用上游并立即下载生成的音频到 `--output`（也支持 `--output-format hex` 直接解码保存）。成功时 stdout 输出一行 JSON：

```json
{"file":"/path/to/audio.mp3","url":"https://...","audio_length":3200,"usage_characters":8,"base_resp":{"status_code":0,"status_msg":"success"}}
```

> 完整参数列表、高级用法（混合音色、声音效果器、发音字典等）见 [references/t2a-v2-api.md](references/t2a-v2-api.md)

---

## 生成后用法（应用内通过 Edge Function 调用）

在应用中通过 Supabase Edge Function 调用 MiniMax TTS，平台密钥由 Edge Function 注入，客户端不接触原始 API Key。

**Web 与 MiniProgram 实现存在差异**，请根据目标平台选择对应的 Edge Function 和前端代码：

| 平台 | Edge Function | 返回值 | 前端播放方式 |
|------|--------------|--------|------------|
| Web / MiniProgram 通用 | `tts-minimax` | `{ audioUrl: string }` | 直接将 `audioUrl` 赋给 `<audio>.src` 或 `InnerAudioContext.src` |

> 完整 Edge Function 代码、Web 前端代码、MiniProgram 前端代码见 [references/t2a-v2-api.md](references/t2a-v2-api.md)


## 音色选择硬规则（2026-09-17 精简版）
仅支持 references/system-voices.md / assets/system-voices.json 中指定音色：中文共9个（普通话8、粤语1），英文8个，其他语种各1个。此名单是产品范围，不是可扩展的示例，不展示厂商全量目录。
UI只用名单的 name/language 展示，提交 voice_id 原值，保留大小写和符号。禁止自由输入ID、联网补充音色、按名称拼接ID、自定义/克隆音色或失败后猜ID自动重试。
生成期执行 scripts/synthesize_speech.py --list-voices；脚本及服务端严格校验同一名单。用户要求未支持音色时说明当前范围并请其从名单选择，不偷偷替换。
上游字段为 voice_setting.voice_id，Edge入口的 voice_id 必须映射进去；成功响应不要求回传voice_id。
完整API参数参考 official-tts-parameters.md，但其中出现的音色示例不扩展本产品名单；混合音色也只能引用名单内ID。CLI开关以 --help 为准，当前实现非流式。
