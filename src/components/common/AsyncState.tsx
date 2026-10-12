// 异步态通用组件：错误态（带重试）+ 手动刷新按钮。
// 用于把「加载失败」与「确实没有数据」区分开，避免网络错误被误渲染成空态。
import { AlertCircle, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
  className?: string;
}

/** 加载失败态： AlertCircle + 文案 + 「重新加载」按钮（有 onRetry 时） */
export function ErrorState({ message, onRetry, className }: ErrorStateProps) {
  return (
    <Card className={cn('rounded-2xl border-destructive/30', className)}>
      <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
        <AlertCircle className="h-10 w-10 text-destructive/70" />
        <p className="text-sm text-muted-foreground">{message ?? '加载失败，请稍后重试'}</p>
        {onRetry && (
          <Button type="button" variant="outline" className="rounded-2xl" onClick={onRetry}>
            <RotateCw className="h-4 w-4" />
            重新加载
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

interface RefreshButtonProps {
  onClick: () => void;
  spinning?: boolean;
  className?: string;
}

/** 手动刷新按钮：刷新中转圈 */
export function RefreshButton({ onClick, spinning = false, className }: RefreshButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="刷新"
      disabled={spinning}
      className={cn('h-11 w-11 shrink-0 text-muted-foreground hover:text-foreground', className)}
      onClick={onClick}
    >
      <RotateCw className={cn('h-5 w-5', spinning && 'animate-spin')} />
    </Button>
  );
}
