# 秒哒实施与验收
1. 采用已有 Supabase 登录；前端从真实 session 取 access_token，调用本应用 Edge。匿名公开 key 不代替用户会话。服务端 getUser 验证；禁止前端发送上游 Key。服务端配置 INTEGRATIONS_API_KEY、APP_ORIGIN、SUPABASE_URL、SUPABASE_ANON_KEY。
2. 两个接口分别音乐 SSE、歌词 JSON。Edge 收到上游响应后直接转发 response.body，不 await text()/json() 把音乐全量缓存。不要使用会把 SSE 当 JSON 解析的调用封装，前端用 fetch + ReadableStream。
3. 首片可能等待几十秒，总时长可能数分钟。600 秒是参考实现请求预算，不是平台承诺。必须分别测试平台首字节超时、空闲超时和总执行时限。平台时限不足时停止宣称接入完成，不能靠更换客户端 timeout 或发送假心跳假装上游成功。
4. generateMusic 返回完整 Blob 后 showMusic 建立播放器及 download 链接。清理旧 object URL；若自己接 React，finally 结束 loading，取消和卸载阻止旧响应更新。展示接收字节而非编造百分比。
5. 不默认永久保存或历史；需历史时，完成后由用户明确保存到当前应用私有 Storage，配置 RLS 与 owner 校验，签名链接按用户签发。转存失败不触发重新生成，不把其他用户作品混在一起。
6. 同用户按钮防连点不等于跨标签幂等。公开上线前需服务端原子请求占位/用户级次数并发限制，所有计费调用前检查配额。没有上游幂等承诺时，超时/刷新不自动重试。此初版 Edge 未实现数据库级去重及全局限额，不能当作无限开放的生产网关。
7. 生成期脚本需 Node 22+，INTEGRATIONS_API_KEY 放环境，输出位置由用户指定，不覆盖已有文件。音乐流复用同一解析器，歌词保存 UTF-8 JSON。
8. QA 必测：首片先于请求结束；终态音频可播放且时长正确；split UTF-8/CRLF/坏 JSON/业务错误/空结果/非 Hex/无结束帧断流；401/429/5xx；取消、刷新与重复点击；歌词正常创作与 edit；平台网关没有整流缓冲。离线通过不代表 QA 通过。

## 托管路由硬约束
音乐与歌词分别使用 assets/gateway.mjs 中的两个 API ID，不能只替换同一个网关地址的路径。平台凭据只在服务端。同步复制 gateway.mjs；不得把用户登录 JWT 或厂商 API Key 当作平台凭据。生成后检查实际路由映射与流式透传。
