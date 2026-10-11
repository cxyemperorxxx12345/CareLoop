# API 固定契约 r6

/agent-interface 是配置申请入口，不是 API 前缀。严禁从页面地址猜测业务接口。

|操作|POST 路径|请求关键字段|响应 data 字段|
|---|---|---|---|
|知识库列表|/openapi/wiki/v1/search_knowledge_base|query,cursor,limit|info_list；kb_id,kb_name|
|文件列表|/openapi/wiki/v1/get_knowledge_list|knowledge_base_id,folder_id可选,cursor,limit|knowledge_list；media_id,title,media_type|
|媒体信息|/openapi/wiki/v1/get_media_info|media_id|url_info、notebook_ext_info、media_type|
|笔记正文|/openapi/note/v1/get_doc_content|note_id,target_content_format:0|按本包笔记规范处理|

鉴权头必须是 ima-openapi-clientid / ima-openapi-apikey，服务端读取环境变量。缺少预期列表字段应报协议错误，不用空数组掩盖。

服务端复用 scripts/ima-client.mjs。Edge action 与前端配套定义，不改上游契约；添加 CORS、应用用户鉴权与授权范围校验后包装响应。此模块不是独立部署服务器，不能直接发给浏览器。下载结果由 Edge 返回原始字节与 MIME；前端 fetch 应用自身端点获取原始 Response，再交 readPreviewResponse，禁止先 SDK 解码后 new Response(data) 冒充原响应。不要把 ima 密钥放到该前端请求中。

元数据中不要猜测 ext_info/name；标题从 knowledge_list 恢复。网页入口按实际 url_info 确认普通 http(s) 网页地址，不能暴露文件下载签名与 headers；笔记由 notebook_ext_info.notebook_id 映射至 note_id。Markdown=7、TXT=13。PDF worker 采用包内同版本 ?url 导入。

执行 node scripts/test-ima-client.mjs 与 node scripts/test-preview.mjs。前者验证包内模块；生成后必须对生成模块运行同样的模拟请求断言，核对 URL/headers/body/解包字段，不得以包内通过替代生成代码通过。若模型改写模块，应移植并执行测试，而非仅写“复用 r6”的注释。源码扫描仅辅助识别已知错误，不是全量证明。

OfficePendingView 只是未满足依赖状态，不是渲染实现。Office 原版预览未接通前禁止标为全格式通过。r16不新增转换服务，DOCX/PPTX走浏览器兼容预览，按office-runtime.md接线。确认 QA 实际加载版本后再生成回归。
