# 阅读应用完整接线（r17）

## 登录与原文件请求

复制 scripts/authenticated-preview.mjs 及其 preview-response/preview-request/preview-bytes 依赖到同一前端目录。使用登录界面使用的同一个 Supabase client。列表 JSON 可以用 functions.invoke；原文件预览和下载统一调用 authenticatedPreview。anonKey 只用于 apikey，Authorization 必须是当前 session.access_token。缺会话显示登录提示；保留后端用户身份及文件访问权限校验，不用 anon key 或第三方 ima Key 替代用户会话。不缓存模块初始化时的 token，不加 endpoint 等自定义请求头。

```ts
const blob = await authenticatedPreview({
 supabase, anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
 endpoint: `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ima-reader`,
 mediaId: file.id, signal,
});
```

file.id 在这里指真实 ima media_id；沿用应用已有的正确字段映射。下载也复用该入口，不另写匿名 fetch。错误按401登录/权限、下载失败、渲染失败区分，不自动删除后端鉴权。

## Office 分支：整套复制与挂载

复制 scripts/OfficePreview.tsx、BrowserOfficeView.tsx 和上述 mjs 到同一组件目录；完整复制 assets/office-browser/ 内容到 public/ima-office/。在 DOCX/PPTX 分支挂载：

```tsx
return <OfficePreview supabase={supabase}
 anonKey={import.meta.env.VITE_SUPABASE_ANON_KEY}
 endpoint={`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ima-reader`}
 mediaId={file.id} filename={file.name} />;
```

OfficePreview 已包含原文件请求、Blob 状态、取消、重试和 BrowserOfficeView 挂载；该分支不再先调用旧 loadPreviewBlob。PDF/PNG/TXT 的渲染分支保持原样，仅在它们的原文件请求缺少正确会话时复用 authenticatedPreview。

若保留 supplemental-preview，返回值是 {kind,blob}，必须传给 BrowserOfficeView；不是 pdfData。历史内部路由名 office-service 不代表服务端转换。不要在 Office 分支读取 supplemental.pdfData、挂载 PdfView 或调用 office_preview；不要重新生成 OFFICE_CONVERTER_URL/TOKEN 配置。前端浏览器依赖不得导入 Edge。

## 交付验收

执行 node scripts/test-authenticated-preview.mjs 和原有 test-preview.mjs、test-ima-client.mjs、test-supplemental-preview.mjs。随后核对生成应用实际调用链，而不是仅运行包内示例：
- 登录后原文件请求的 Authorization 来自会话，和 apikey 不同；日志不打印令牌。
- 未登录不发送下载请求；服务端仍拒绝未授权请求。
- Word/PPT 分支实际挂载 OfficePreview 或等价 Blob 链路；public/ima-office 下 render.mjs、paginate.mjs、vendor 与许可证齐全。
- 登录状态下实际打开 DOCX/PPTX，显示图文；缺资源、401和渲染错误分别可见。
- 回归 PDF、PNG、TXT，切换文件、重新登录与下载。

包内模拟测试不等于 QA 登录、部署、静态资源或真实文件验收；没有执行的层级明确标记未测。
