# PDF 基线接入
来源：旧 app-e6kea3chicch 的 PdfView；截图曾确认真实页面显示，本包集成后仍须实测。
依赖：React、lucide-react、pdfjs-dist 4.10.38、Vite ?url；同版本 pdf.worker.min.mjs 随构建发布。
项目别名依赖：@/components/ui/button 的 Button；@/components/reader/ErrorBanner 的 ErrorBanner；@/lib/ima-api 的 isPdfBinary；@/types/types 的 PdfContent（pages: {index:number,text:string}[], coverage:string）。按目标项目适配这些明确接口，不复制旧应用凭证或后端地址。
preview-only 使用 <PdfView pdfData={buffer} extracted={null}/>，直接从有权限的下载取得 buffer，不等待 read_file。
isPdfBinary 校验非空和 %PDF- 文件头；preview-bytes.mjs 提供二进制转换及 PDF 头检查参考。
独立维护文件下载错误，禁止用空 buffer 掩盖 JSON 响应。加载、切换、缩放、资源清理均须浏览器验收。
