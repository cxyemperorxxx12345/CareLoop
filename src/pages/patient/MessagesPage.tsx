// 消息中心：全部/未读筛选 + 一键已读 + 类型徽章 + 点击查看详情弹窗（标记已读）+ 支持按 link_path 跳转
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, CheckCheck, Clock, Inbox } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorState, RefreshButton } from '@/components/common/AsyncState';
import { useRefetchOnFocus } from '@/hooks/use-refetch-on-focus';
import { getMyPatient, patientApi } from '@/lib/api';
import { cn } from '@/lib/utils';

interface MsgRow {
  id: string;
  type: string;
  title: string;
  content: string;
  link_path: string | null;
  read: boolean;
  created_at: string;
}

// 消息类型徽章配色（语义 token）
const TYPE_META: Record<string, { label: string; cls: string }> = {
  reminder: { label: '提醒', cls: 'bg-secondary text-secondary-foreground' },
  escalation: { label: '升级', cls: 'bg-triage-red-bg text-triage-red' },
  triage: { label: '分诊', cls: 'bg-triage-amber-bg text-triage-amber' },
  followup: { label: '随访', cls: 'bg-triage-green-bg text-triage-green' },
  clinician_reply: { label: '回复', cls: 'bg-primary/10 text-primary' },
};

// 相对时间：xx 分钟/小时/天前
function relativeTime(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export function MessagesPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [list, setList] = useState<MsgRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [tab, setTab] = useState('all');
  const [activeMsg, setActiveMsg] = useState<MsgRow | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const p = await getMyPatient();
      if (p) {
        const pid = (p as { id: string }).id;
        const [msgs, count] = await Promise.all([patientApi.messages(pid), patientApi.unreadCount(pid)]);
        setList(msgs as MsgRow[]);
        setUnread(count);
      }
      setErrorMsg('');
      setStatus('ready');
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : '加载失败，请稍后重试');
      setStatus('error');
    } finally {
      if (isRefresh) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 回到前台自动刷新（节流 15s）：提醒扫描 cron 可能已产生新消息
  useRefetchOnFocus(() => void load(true));

  // 点击整条：标记已读（乐观更新）并打开详情弹窗
  const open = (m: MsgRow) => {
    if (!m.read) {
      setList((prev) => prev.map((x) => (x.id === m.id ? { ...x, read: true } : x)));
      setUnread((n) => Math.max(0, n - 1));
      patientApi.markMessageRead(m.id).catch(() => undefined);
    }
    setActiveMsg(m);
  };

  const shown = tab === 'unread' ? list.filter((m) => !m.read) : list;

  if (status === 'loading') {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-9 w-full rounded-xl" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 w-full rounded-2xl" />
        ))}
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="p-4 pt-6">
        <ErrorState message={errorMsg} onRetry={() => void load()} />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between gap-3 pt-2">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="text-2xl font-bold truncate">消息中心</h1>
          {unread > 0 ? <Badge variant="secondary">未读 {unread} 条</Badge> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <RefreshButton onClick={() => void load(true)} spinning={refreshing} />
          {unread > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 gap-1.5 text-muted-foreground"
              onClick={async () => {
                try {
                  const pid = (await getMyPatient())?.id;
                  if (!pid) return;
                  const n = await patientApi.markAllMessagesRead(pid);
                  setList((prev) => prev.map((x) => ({ ...x, read: true })));
                  setUnread(0);
                  toast.success(`已将 ${n} 条消息标记为已读`);
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : '操作失败，请稍后重试');
                }
              }}
            >
              <CheckCheck className="h-4 w-4" />
              一键已读
            </Button>
          ) : null}
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="all" type="button">
            全部
          </TabsTrigger>
          <TabsTrigger value="unread" type="button">
            未读
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {shown.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-muted">
            <Inbox className="h-6 w-6 text-muted-foreground" />
          </span>
          <p className="text-sm text-muted-foreground">{tab === 'unread' ? '没有未读消息，一切安心' : '暂无消息，医护的提醒会出现在这里'}</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {shown.map((m) => {
            const meta = TYPE_META[m.type] ?? TYPE_META.reminder;
            return (
              <div
                key={m.id}
                role="button"
                tabIndex={0}
                onClick={() => open(m)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    open(m);
                  }
                }}
                className={cn(
                  'w-full cursor-pointer rounded-2xl border p-3.5 text-left transition-shadow hover:shadow-card',
                  m.read ? 'border-border bg-card' : 'border-primary/40 bg-primary/5',
                )}
              >
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className={cn('shrink-0', meta.cls)}>
                    {meta.label}
                  </Badge>
                  <span className="min-w-0 flex-1" />
                  {!m.read ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        setList((prev) => prev.map((x) => (x.id === m.id ? { ...x, read: true } : x)));
                        setUnread((n) => Math.max(0, n - 1));
                        patientApi.markMessageRead(m.id).catch(() => undefined);
                      }}
                    >
                      标记已读
                    </button>
                  ) : null}
                  <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(m.created_at)}</span>
                </div>
                <p className="mt-1.5 flex items-center gap-1.5">
                  {!m.read ? <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-primary" /> : null}
                  <span className="min-w-0 flex-1 truncate text-[15px] font-bold">{m.title}</span>
                </p>
                <p className="mt-1 line-clamp-2 text-[15px] text-muted-foreground">{m.content}</p>
              </div>
            );
          })}
        </div>
      )}

      {/* 消息详情 Dialog */}
      <Dialog open={!!activeMsg} onOpenChange={(open) => !open && setActiveMsg(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg rounded-2xl">
          {activeMsg && (
            <>
              <DialogHeader className="text-left space-y-2">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className={cn('shrink-0', (TYPE_META[activeMsg.type] ?? TYPE_META.reminder).cls)}>
                    {(TYPE_META[activeMsg.type] ?? TYPE_META.reminder).label}
                  </Badge>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {new Date(activeMsg.created_at).toLocaleString('zh-CN', {
                      month: 'numeric',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                <DialogTitle className="text-lg font-bold leading-snug">{activeMsg.title}</DialogTitle>
                <DialogDescription className="sr-only">消息详细内容</DialogDescription>
              </DialogHeader>

              <div className="rounded-xl bg-muted/50 p-4 text-[15px] leading-relaxed text-foreground whitespace-pre-wrap">
                {activeMsg.content}
              </div>

              <DialogFooter className="flex-row justify-end gap-2 sm:justify-end">
                {activeMsg.link_path && (
                  <Button
                    type="button"
                    onClick={() => {
                      const path = activeMsg.link_path!;
                      setActiveMsg(null);
                      navigate(path);
                    }}
                    className="gap-1.5"
                  >
                    前往处理
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                )}
                <Button type="button" variant="outline" onClick={() => setActiveMsg(null)}>
                  关闭
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
export default MessagesPage;
