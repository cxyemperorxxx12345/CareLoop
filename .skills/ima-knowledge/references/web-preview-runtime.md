# Office 与静态网页增量接线 r15

只补未通过分支；不要重写PDF/PNG/TXT、知识库列表和鉴权。本页不新增上游API或凭据。

## 在通用原文件请求前分派
复制 scripts/supplemental-preview.mjs，保持模块相对路径；preview-response/request/bytes 为已验证的原模块，不改实现。
```js
const result = await loadSupplementalPreview({kind: route.preview, endpoint, mediaId, headers, signal});
if (result?.kind === 'office-service') {
  // result.pdfData 是转换PDF，不是DOCX/PPTX；交给现有PdfView。
  setPdfData(result.pdfData);
  return; // 此分支不要继续调用通用preview_proxy
}
if (result?.kind === 'web-link') {
  // 将result.blob交给下面静态网页模块；不要进入Office、正文提取或PDF解析。
  setWebBlob(result.blob);
  return;
}
// null：继续调用原先已验证的PDF/图片/TXT/笔记路径，不改该路径。
```
上述状态setter按项目实际组件适配。文件切换时AbortController取消旧请求，并使用请求序号或清理标志防止旧成功/失败覆盖新文件；错误态与成功态互斥，重试调用相同加载函数。原Office文件下载继续用已校验的fetchPreviewBlob，不下载转换PDF冒充原文件。

## 网页HTML不是错误二进制
实际ima网页样本返回text/html原字节，无需假设只有application/octet-stream才是文件。fetchPreviewBlob已保留HTML MIME；不要新增会拒绝text/html的通用校验。
前端依赖 `dompurify@3.4.15`，按项目包管理器安装并纳入锁文件。复制 `scripts/web-preview.mjs`，DOMPurify从项目本地依赖导入，不运行时从CDN取库：
```jsx
import DOMPurify from 'dompurify';
import {readWebBlob, webSnapshot} from './web-preview.mjs';
// 在加载effect内执行；清理/取消后不再setState。
const html = await readWebBlob(blob);
const srcDoc = webSnapshot(html, {purify:DOMPurify});
// 保存srcDoc到状态，并清空上次文档内容。
// 渲染：<iframe title="网页静态预览" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={srcDoc} />
```
禁止给这个iframe添加allow-same-origin或allow-scripts；禁止把HTML放进应用主DOM。webSnapshot移除脚本、事件、表单和嵌套框架，设置CSP；保留正文、表格、内联样式及允许的图片。
有经核验、不含签名凭据的原站URL时可作为独立“打开原网页”入口，HTML预览不依赖它。相对资源可传baseUrl；默认不加载远程图片，只有确认的资源来源才传allowedResourceOrigins。禁止把ima签名下载URL/headers暴露为baseUrl。

## 范围和测试
本轮真实Example Domain原HTML的文字、内联CSS、链接在浏览器可见。另测中文静态HTML、经批准的相对图片、脚本隔离、无效输入。静态快照不支持脚本交互、登录态、外部样式表或任意动态网站；不要把这些写成已通过。原站嵌入与受限站点仍独立验收。
执行 `node scripts/test-supplemental-preview.mjs`：Office只发preview_proxy获取原文件，HTML MIME被保留，其他格式零额外请求，错误原样传播。
浏览器回归使用 `scripts/test-web-preview.browser.mjs` 的 `testWebPreview(page,{moduleUrl,purifyUrl})`，由项目Playwright runner传入实际页面和本地已构建ESM地址；它会真正创建隔离iframe检查中文/样式、输入拒绝和脚本隔离。不要用静态源码扫描代替此测试。
真实文件还要在最终应用逐一检查全部页、下载字节、切换/取消、失败重试；本地测试页面不是QA应用。
