# 官方接口契约
来源：用户提供的音乐/歌词接口全文；官方 https://platform.minimax.cn/docs/api-reference/music-generation 。以本次明确选择的 music-3.0 为范围。

## POST https://app-ezvlp6ds1hqa-api-Q9KWzK5EmKn9-gateway.miaoda.online/v1/music_generation
Content-Type application/json；托管版本由服务端 X-Gateway-Authorization 携带平台凭据，真实厂商密钥仅在后台鉴权配置。
固定 model=music-3.0、stream=true、output_format=hex、audio_setting={sample_rate:44100,bitrate:256000,format:mp3}。
- prompt：字符串，最多 2000 字符。纯音乐必填；自动歌词且没有 lyrics 时包内要求非空主题；自填歌词时可空。
- lyrics：最多 3500 字符，有人声且未启用自动歌词时必填。换行分隔，支持 Intro/Verse/Pre Chorus/Chorus/Interlude/Bridge/Outro/Post Chorus/Transition/Break/Hook/Build Up/Inst/Solo 结构标签。
- is_instrumental：布尔，默认 false，true 无人声、歌词可省。
- lyrics_optimizer：布尔，默认 false，true 且歌词为空时按 prompt 生成歌词；已有歌词不声称自动重写。
- aigc_watermark：官方说明仅非流式有效，本包不开放该参数，不承诺流式水印。
参考音频、翻唱特征、duration 参数不在当前能力范围。

请求示例（不含鉴权）：
```json
{"model":"music-3.0","prompt":"轻柔钢琴纯音乐","is_instrumental":true,"stream":true,"output_format":"hex","audio_setting":{"sample_rate":44100,"bitrate":256000,"format":"mp3"}}
```
SSE JSON 业务码 base_resp.status_code=0；data.audio 是 Hex 字符串；data.status=1 处理中、2 结束。trace_id 用于定位而非任务查询。extra_info 可含 music_duration（毫秒）、music_sample_rate、music_channel、bitrate、music_size（字节）。实际帧处理以包内已测试解析器为准。

## POST https://app-ezvlp6ds1hqa-api-Q9KWzK5EmKn9-gateway.miaoda.online/v1/lyrics_generation
非流式；mode 必填 write_full_song/edit。prompt 可选、最多 2000 字符，空为随机生成；lyrics 最多 3500 字符，仅 edit 有效；title 可选，输出保持指定标题。返回 song_title/style_tags/lyrics/base_resp，业务码零且歌词非空才成功。返回歌词进入音乐接口前再次检查 3500 字符上限和标签兼容，超限让用户编辑，不静默截断。

## 资格与计费边界
用户提供的公告：2026-08-20 起付费接口停止向新用户开放，历史付费用户可继续；免费接口停服。已有测试账号可用不保证其他账号可用。RPM、价格与平台上线配置另行确认，不从参考实例推断费用。

## 托管路由硬约束
音乐与歌词分别使用 assets/gateway.mjs 中的两个 API ID，不能只替换同一个网关地址的路径。平台凭据只在服务端。同步复制 gateway.mjs；不得把用户登录 JWT 或厂商 API Key 当作平台凭据。生成后检查实际路由映射与流式透传。
