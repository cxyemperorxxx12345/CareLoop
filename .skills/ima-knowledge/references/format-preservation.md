# 逐格式保留与验收 r16

## 基线
用户已确认PDF、PNG、TXT正常，保留组件、原始字节入口、鉴权、依赖版本及错误处理。首次版Office不作为原版成功基线；不要仅凭旧截图臆称已完整复用。

## 本轮变更
用户明确接受浏览器兼容预览。DOCX/PPTX采用office-runtime.md的真实浏览器组件，取代独立转换服务器默认依赖。原文件→preview_proxy→Blob→BrowserOfficeView；包内资产复制进入应用public目录，不现场重写解析器、不默认返回下载占位。
页面必须标注字体/分页差异；不宣称严格原版保真。DOC/PPT老格式、Excel和复杂特殊对象没有本轮通过证明，已有已验收实现保留，不谎称新支持。

## 网页
保留web-preview.mjs和web-preview-runtime.md静态HTML实现，不丢弃已获取HTML，不将外链当预览通过。HTML需要清洗与隔离，动态原站功能与静态快照分开说明，不凭iframe load认定原站可用。

## 验收
先校验正常分支文件哈希，再执行test-preview.mjs、test-ima-client.mjs、test-supplemental-preview.mjs、test-reader-source.py。静态检查不替代浏览器检查。
Office按真实文件逐页滚动截图，核对图文、文字可见、原文件下载、切换取消重试。Word浏览器分页不同须标注。PDF/PNG/TXT仍做发布回归，不因代码哈希一致就假称本轮线上全部通过。
正常业务Query即可，技术规则从本Skill读取。记录QA实际加载r16、资产HTTP状态、生成源码采用情况后再称发布验收成功。本地包修改不是QA已生效；用户未要求时不自动新建应用。
