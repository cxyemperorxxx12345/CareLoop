# DOCX/PPTX 浏览器兼容预览 r16

本实现不使用独立API、Python、LibreOffice或Docker。用户已确认接受兼容预览，页面必须显示“字体、特殊图形及分页可能与 Office 原生显示不同”，不可宣称严格原版或像素级一致。旧转换服务不再是本包默认或必需依赖。

## 生成期落地（不可只生成占位组件）
1. 把 assets/office-browser 整个目录原样复制为生成应用的 public/ima-office。包括 render.mjs、paginate.mjs、vendor中的固定浏览器构建与许可证。
2. 复制 scripts/BrowserOfficeView.tsx 到应用组件目录。它仅依赖现有React；静态模块通过 /ima-office/render.mjs 动态导入，不要把浏览器模块放进Edge Function。
3. 原文件继续由既有、经过权限校验的 preview_proxy 获取：前端复用 fetchPreviewBlob，body固定media_id，保留现有应用鉴权；ima密钥仍只在后端。不得新增office_preview接口，也不得配置OFFICE_CONVERTER_URL。
4. 使用真实文件列表title保留后缀。Office分支挂载 `<BrowserOfficeView blob={blob} filename={file.title}/>`；blob就是原DOCX/PPTX，不是转换PDF，不传给PDF.js。不在每次render中重建Blob对象。
5. scripts/supplemental-preview.mjs 对office-service返回{kind,blob}；路由名仅历史内部标识，不表示需要服务器。网页仍返回blob给原静态网页组件。PDF/PNG/TXT/笔记保持原组件、依赖、请求与状态机，不因Office修改升级PDF.js。
6. 原文件下载继续使用同一原始Blob。预览失败不禁用原文件下载。下载错误在原加载层重试，渲染错误由组件重试；切换文件清理旧视图、取消信号并阻止旧结果覆盖新文件。
7. 发布构建后检查 /ima-office/render.mjs、paginate.mjs、vendor各文件均返回JS而非SPA HTML兜底。子路径部署按应用真实BASE_URL调整组件moduleUrl；保持模块之间相对路径不变。

## 运行实现与限制
- @aiden0z/pptx-renderer 1.2.4 浏览器standalone构建：全部PPTX页按顺序渲染HTML/SVG和内嵌图片，未接入可选PDF.js特殊EMF回退，不改现有PDF依赖。不是pptxgenjs生成器，不使用无作用域的同名pptx-renderer包。
- docx-preview 0.3.7 + JSZip 3.10.1：渲染原DOCX的样式/表格；paginate.mjs在浏览器按现有纸张和块级元素分页，缺页面设置时用A4及默认边距。不是Word原生排版引擎。超高单块保留完整显示并给出警告，不裁内容、不假装完全分页。
- 25MiB输入、2500 ZIP项、100MiB声明解压体积限制；格式主XML校验。带外部非超链接资源的文件明确报错，不暗中外传文件，不抓取文档外链。普通https链接保留新窗口且noopener。
- DOMParser只在浏览器使用。Node只用于生成/测试，不作为应用转换后端。
- DOC/PPT旧二进制、Excel、复杂SmartArt/EMF、分栏、跨页合并表格与精确Office分页未在本轮验收；已有可用实现保留，不将这些格式伪装为DOCX/PPTX或一概宣称支持。

## 已完成与未完成验收
本机独立浏览器模型模拟：三份此前ima原文件，PPTX9页/3图，DOCX1页、PRD5页；所有源文本在DOM，逐页截图检查。PRD此前转换6页，所以“兼容预览”提示是实际边界，不可隐藏。PPT长截图曾产生正文缺失假象，滚动到页后逐页截图确认正文完整；不用长截图缩略图直接下丢字结论。
取消、销毁、连续切换旧结果保护、坏ZIP、404、空数据、扩展名冲突、体积上限、重试已测；390px PPT视口基础加载通过。浏览器无外部请求，无转换程序。
这不等于QA构建/网关/CSP/线上鉴权验收。生成后仍需实际逐格式确认，尤其静态资源路径和当前会话；不要宣称重新生成必然成功。
