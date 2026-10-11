# 原文件预览交付契约 r10

先执行 [逐格式保留与验收](format-preservation.md)，正常格式保留，故障分支单独修复。

## 旧版事实与复用范围
基线 app-e6kea3chicch 的 downloadBinary 实际判断 Blob/ArrayBuffer、拒绝空数据；loadPreview 独立于正文加载，使用 AbortController。新生成代码不得丢弃这些修复。
旧版 PDF 曾展示原页面；Office 的文字/表格或素材展示不等于原版页面，不能把旧版当成已验证 Office 渲染器。

## 必须实现的传输契约
- 下载线上JSON仅传 media_id（函数参数仍可叫mediaId），由服务端鉴权并获取 ima url_info.url 与 headers。不要把下载鉴权 headers 返回前端，也不要接收客户端任意 URL/headers 当代理目标。
- ima 上游 HTTP 错误、业务 code、JSON 协议错误、下载错误分开；日志保留脱敏请求标识，不记录密钥或完整签名 URL。
- 原文件响应保留真实 MIME。前端优先读取原始 Response 并调用 readPreviewResponse；fetch 使用应用自身端点及当前用户会话/平台要求的鉴权，不携带 ima 密钥。
- 原文件传输必须使用 `scripts/preview-response.mjs` 的 `fetchPreviewBlob` 原生 fetch 入口，不使用 `functions.invoke()` 下载文件。invoke 仅用于 JSON 元数据接口；不得对其 data 强制检查 Blob，也不得把已解码字符串通过 new Blob/new Response 包装回图片。PDF 可成功并不证明 PNG/TXT/HTML 传输正确。
- 集成参数：endpoint 使用项目实际 Edge Function URL，headers 使用项目现有公开应用 key 和当前用户会话鉴权（按平台规则），signal 传入页面 AbortController。禁止把 ima API Key 放前端。服务端 `preview_proxy` 必须接收 media_id 并鉴权解析下载地址；函数示例不是任意 URL 代理。生成时同时接入调用端和服务端字段，不只复制工具函数。
- HTML 字节读成功只是传输通过，不等于网页预览成功。网页预览必须走实际内嵌或隔离静态快照分支，原网页链接只作后备入口；不把 HTML Blob iframe 当完整原网页（相对资源、嵌入限制仍需验证）。
- Blob→arrayBuffer、ArrayBuffer 副本、TypedArray 偏移切片、空文件与错误对象全部测。PDF 将独立副本交给 PDF.js worker，避免 detach 原始缓存。下载仍保留原文件。
- 超时、取消信号贯穿请求；切换文件取消旧请求并丢弃旧结果，加载和错误状态随文件重置。

## 每个格式都要有实际视图
使用 reader-route.mjs 分流；禁止非 PDF/图片统一 return 不支持。
- PDF：本地同版本 PDF.js/worker，页面渲染、翻页、缩放、加载失败与重试。依赖见 baseline/INTEGRATION.md。
- 图片：真实 MIME 的 Blob URL，onLoad/onError，切换重置状态，卸载释放 URL；不等待 OCR。
- TXT/Markdown：文本显示/安全 Markdown 渲染，不增加“提取正文”工作流。文本解码与文件二进制分开；不执行 HTML/脚本。
- 网页：经 URL 协议校验后实际接入内嵌页面或隔离静态快照，并保留原网页入口；只有实际观察到限制才说明。仅有链接不得登记为预览完成。
- 笔记：按 notebook_ext_info 和既有笔记 API 分支，不因为没有 url_info.url 就拦截所有类型。
- Word/PPT/Excel：实际文档渲染或自有/已批准转换服务。若转 PDF，保留原文件下载；验证字体、图片、表格、分页，Excel 另核对工作表/打印区域。文本卡片/素材列表不算原版。

## Office生成前门槛 r16
DOCX/PPTX复用 [浏览器实现](office-runtime.md)，assets原样进入public并实际挂载BrowserOfficeView，不接入转换服务。保留preview_proxy鉴权和二进制契约，原文件完整传入浏览器；页面明确兼容预览和分页差异。旧DOC/PPT、Excel不在本轮新增实现范围。Edge禁止导入DOMParser/浏览器渲染模块。

## 界面与导航
携带知识库 ID 和文件 ID（界面展示名称而非 ID）；面包屑返回正确列表，不用 # 占位。直接访问预览 URL 时从服务端/列表元数据恢复标题和类型，不仅依赖 location.state。预览与下载错误分开。

## 验收门槛
1. node scripts/test-preview.mjs：离线传输与路由。
2. python3 scripts/check-reader-source.py APP：拦截已知回退，并检查公开页面与服务端用户鉴权是否冲突；检查器不是语义证明，不得绕过模式检查。
3. 真实文件：PDF 多页/扫描页原图、PNG/JPG、TXT/Markdown、网页、Word、PPT、Excel。记录打开、切换、重试、下载和显示内容；Office 未测试不得写“全部通过”。
4. 实际浏览器检查页面图文与原文件，PDF 首次/重复打开、缩放、图片错误状态、直接链接、导航与超时；仅预览时不发 read_file/ask 请求。
5. 确认 QA 实际加载本次 r16（日志或包内容/哈希证据），再确认生成代码使用了本实现。仅本地修改不代表 QA 更新。失败先修原应用和契约，不反复新建规避。

交付列明：已改文件、离线/真实接口/浏览器/发布态各自结果、剩余依赖。实际结果未核验时不承诺“一步到位”或全格式支持。

## r12：本次回退防护
- 不把固定 anon key 等同于用户已登录；不以取消 getUser 校验作为401的通用修复。公开路由与私有数据的冲突必须补齐登录/授权或明确公开范围，而不是放开所有读取。
- 对401先保存脱敏 HTTP 状态、响应体、请求 action、实际部署版本；分别定位平台网关拒绝、应用登录失效、ima 凭据错误、转换器令牌错误。仅凭 unauthorized 字符串不推断来源。
- Office浏览器模块不新增鉴权或转换器令牌；列表和原文件仍使用既有权限校验。
- 页面必须使用 loading/error/success 三态：只有请求成功且返回空数组才能显示“暂无知识库”；错误时不得同时显示空状态。鉴权错误给出登录或配置指引，不建议创建新的知识库。
- 在宣布预览修复之前先回归列表请求，至少验证正常列表、鉴权失败、真实空列表三个场景；原应用已存在的凭据配置入口必须保留。
