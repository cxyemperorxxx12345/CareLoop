import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, Minus, Plus, ScanLine, ZoomIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/components/reader/ErrorBanner';
import { isPdfBinary } from '@/lib/ima-api';
import type { PdfContent } from '@/types/types';

// 配置与库版本一致的本地 worker（随应用部署，不依赖外部 CDN）
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

interface Props {
  pdfData: ArrayBuffer;
  extracted: PdfContent | null;
}

export function PdfView({ pdfData, extracted }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const pdfDocRef = useRef<any>(null);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1.2);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 加载 PDF 文档
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setNumPages(0);
    setPage(1);
    // 校验 PDF 文件头，避免无效数据进入 worker
    if (!isPdfBinary(pdfData)) {
      setError('文件数据无效或不是合法的 PDF 文件');
      return;
    }
    // 传入独立副本，避免 worker 转移缓冲区后再次使用空数据
    const task = pdfjsLib.getDocument({ data: new Uint8Array(pdfData.slice(0)) });
    task.promise
      .then((doc: any) => {
        if (cancelled) {
          doc.destroy();
          return;
        }
        pdfDocRef.current = doc;
        setNumPages(doc.numPages);
      })
      .catch((e: any) => {
        if (!cancelled) setError(e?.message || 'PDF 文档加载失败');
      });
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      pdfDocRef.current?.destroy?.();
      pdfDocRef.current = null;
    };
  }, [pdfData]);

  // 渲染当前页
  useEffect(() => {
    const doc = pdfDocRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas || page < 1) return;
    let cancelled = false;
    setRendering(true);
    const render = async () => {
      try {
        const pageObj = await doc.getPage(page);
        if (cancelled) return;
        const viewport = pageObj.getViewport({ scale });
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        renderTaskRef.current?.cancel();
        const renderTask = pageObj.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = renderTask;
        await renderTask.promise;
      } catch (e: any) {
        if (!cancelled && e?.name !== 'RenderingCancelledException') {
          setError(e?.message || '页面渲染失败');
        }
      } finally {
        if (!cancelled) setRendering(false);
      }
    };
    render();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [page, scale, numPages]);

  if (error) {
    return <ErrorBanner errorType="parse_error" message={`原文预览失败：${error}`} />;
  }

  const currentPageText = extracted?.pages.find((p) => p.index === page);
  const pageNeedsOcr = currentPageText && currentPageText.text.trim().length === 0;

  return (
    <div className="flex flex-col gap-3">
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-border bg-card px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[64px] text-center font-serif text-sm text-foreground">
            {numPages > 0 ? `${page} / ${numPages}` : '加载中'}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setPage((p) => Math.min(numPages, p + 1))}
            disabled={page >= numPages}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setScale((s) => Math.max(0.5, s - 0.2))}>
            <Minus className="h-4 w-4" />
          </Button>
          <span className="min-w-[52px] text-center font-serif text-xs text-muted-foreground">
            {Math.round(scale * 100)}%
          </span>
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setScale((s) => Math.min(3, s + 0.2))}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* 渲染区 */}
      <div className="flex justify-center overflow-auto rounded-sm border border-border bg-muted p-4">
        <div className="relative">
          <canvas ref={canvasRef} className="block bg-background shadow-sm" />
          {rendering && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/60">
              <Loader2 className="h-6 w-6 animate-spin text-seal" />
            </div>
          )}
        </div>
      </div>

      {pageNeedsOcr && (
        <div className="flex items-center gap-2 rounded-sm bg-muted px-3 py-2 text-sm text-muted-foreground">
          <ScanLine className="h-4 w-4 shrink-0" />
          <span>本页未提取到文字，可能需要 OCR；上方为原文页面，可正常查看。</span>
        </div>
      )}
      {extracted && (
        <p className="flex items-center gap-1.5 font-serif text-xs text-muted-foreground">
          <ZoomIn className="h-3.5 w-3.5" />
          {extracted.coverage}
        </p>
      )}
    </div>
  );
}