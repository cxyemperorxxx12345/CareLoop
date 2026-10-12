// 离线提示条：只要页面展示的是本地快照数据，就必须显式告知这是「离线数据」+ 更新时间，
// 严禁把旧数据伪装成实时数据。同时提供「重试」入口，联网后用户可立即拉新。
import { RefreshCw, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatSnapshotTime } from '@/lib/offline-cache';
import { cn } from '@/lib/utils';

interface OfflineNoticeProps {
  /** 快照写入时间（毫秒） */
  savedAt: number;
  /** 点击「重新连接」触发的重试回调；不传则只展示提示 */
  onRetry?: () => void;
  /** 重试进行中（按钮转圈） */
  retrying?: boolean;
  className?: string;
}

export function OfflineNotice({ savedAt, onRetry, retrying = false, className }: OfflineNoticeProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-center gap-2.5 rounded-2xl border border-triage-amber/40 bg-triage-amber-bg px-3.5 py-2.5',
        className,
      )}
    >
      <WifiOff className="h-5 w-5 shrink-0 text-triage-amber" aria-hidden />
      <p className="min-w-0 flex-1 text-[15px] leading-snug text-triage-amber">
        <span className="font-semibold">离线数据</span>
        <span className="mx-1">·</span>
        更新于 <span className="sig-num font-semibold">{formatSnapshotTime(savedAt)}</span>
        <span className="mt-0.5 block text-[13px] text-triage-amber/80">
          当前网络不可用，以下为上次联网时的数据，联网后请点击重新连接获取最新
        </span>
      </p>
      {onRetry && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={retrying}
          onClick={onRetry}
          className="h-9 shrink-0 rounded-xl border-triage-amber/50 text-[13px] text-triage-amber hover:bg-triage-amber/10"
        >
          <RefreshCw className={cn('h-4 w-4', retrying && 'animate-spin')} />
          重新连接
        </Button>
      )}
    </div>
  );
}

/** 紧凑版：用于卡片标题右侧的小标注 */
export function OfflineTag({ savedAt, className }: { savedAt: number; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full bg-triage-amber-bg px-2.5 py-1 text-xs font-semibold text-triage-amber',
        className,
      )}
    >
      <WifiOff className="h-3.5 w-3.5" aria-hidden />
      离线 · {formatSnapshotTime(savedAt)}
    </span>
  );
}
