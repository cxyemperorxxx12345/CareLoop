// 消息中心：全部/未读筛选 + 一键已读 + 类型徽章 + 点击查看详情弹窗（标记已读）+ 支持按 link_path 跳转
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
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
import { SpeakButton } from '@/components/common/SpeakButton';
import { useRealtimeSync } from '@/hooks/use-realtime-sync';
import { useRefetchOnFocus } from '@/hooks/use-refetch-on-focus';
import { getMyPatient, patientApi } from '@/lib/api';
import { broadcastChange, type SyncEntity } from '@/lib/sync-bus';
import { cn } from '@/lib/utils';

// 跨端同步：消息中心只关心 messages 实体
const SYNC_ENTITIES: SyncEntity[] = ['messages'];

interface MsgRow {
  id: string;
  type: string;
  title: string;
  content: string;
  link_path: string | null;
  read: boolean;
  created_at: string;
}

interface MsgGroup {
  key: string;
  sourceKey: string;
  messages: MsgRow[];
  latestAt: number;
  hasUnread: boolean;
  isReminder: boolean;
}

const REMINDER_TYPES = new Set(['reminder', 'escalation']);
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

function groupMessages(messages: MsgRow[]): MsgGroup[] {
  const byNewest = [...messages].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const groups: MsgGroup[] = [];

  for (const message of byNewest) {
    const createdAt = new Date(message.created_at).getTime();
    const isReminder = REMINDER_TYPES.has(message.type);
    const sourceKey = `${message.type}\u0000${message.title}`;
    const existing = isReminder
      ? groups.find(
          (group) =>
            group.isReminder &&
            group.sourceKey === sourceKey &&
            group.latestAt - createdAt <= DEDUP_WINDOW_MS,
        )
      : undefined;

    if (existing) {
      existing.messages.push(message);
      existing.hasUnread ||= !message.read;
      continue;
    }

    groups.push({
      key: `${sourceKey}\u0000${message.id}`,
      sourceKey,
      messages: [message],
      latestAt: createdAt,
      hasUnread: !message.read,
      isReminder,
    });
  }

  return groups.sort((a, b) => {
    // 第一关键字：未读优先（置顶）
    if (a.hasUnread !== b.hasUnread) return a.hasUnread ? -1 : 1;
    // 第二关键字：紧急度降序（urgency 大的在前）
    const ua = urgencyOf(a.messages[0].type);
    const ub = urgencyOf(b.messages[0].type);
    if (ua !== ub) return ub - ua;
    // 第三关键字：时间倒序（新的在前）
    return b.latestAt - a.latestAt;
  });
}

// 消息类型徽章配色（语义 token）
const TYPE_META: Record<string, { label: string; cls: string }> = {
  reminder: { label: '提醒', cls: 'bg-secondary text-secondary-foreground' },
  escalation: { label: '升级', cls: 'bg-triage-red-bg text-triage-red' },
  triage: { label: '分诊', cls: 'bg-triage-amber-bg text-triage-amber' },
  followup: { label: '随访', cls: 'bg-triage-green-bg text-triage-green' },
  clinician_reply: { label: '回复', cls: 'bg-primary/10 text-primary' },
};

// 紧急度梯度（数值越大越紧急）——让老人一眼分清轻重
// escalation 红色预警=5，triage 琥珀分诊=4，clinician_reply 医护回复=3，
// followup 随访=2，reminder 用药/打卡提醒（属噪音）=1，其余未知类型兜底=1
const URGENCY_BY_TYPE: Record<string, number> = {
  escalation: 5,
  triage: 4,
  clinician_reply: 3,
  followup: 2,
  reminder: 1,
};

const URGENCY_FALLBACK = 1;

function urgencyOf(type: string): number {
  return URGENCY_BY_TYPE[type] ?? URGENCY_FALLBACK;
}

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

function MessageCard({
  message,
  subdued = false,
  hasUnread = !message.read,
  onOpen,
  onMarkRead,
  children,
}: {
  message: MsgRow;
  subdued?: boolean;
  hasUnread?: boolean;
  onOpen: (message: MsgRow) => void;
  onMarkRead: (message: MsgRow) => void;
  children?: ReactNode;
}) {
  const meta = TYPE_META[message.type] ?? TYPE_META.reminder;

  return (
    <div
      data-message-card
      role="button"
      tabIndex={0}
      onClick={() => onOpen(message)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(message);
        }
      }}
      className={cn(
        'w-full cursor-pointer rounded-2xl border p-3.5 text-left transition-shadow hover:shadow-card',
        subdued
          ? hasUnread
            ? 'border-primary/30 bg-primary/[0.03]'
            : 'border-border/70 bg-muted/30'
          : hasUnread
            ? 'border-primary/40 bg-primary/5'
            : 'border-border bg-card',
      )}
    >
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className={cn('shrink-0', meta.cls)}>
          {meta.label}
        </Badge>
        <span className="min-w-0 flex-1" />
        {!message.read ? (
          <button
            type="button"
            className="shrink-0 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onMarkRead(message);
            }}
          >
            标记已读
          </button>
        ) : null}
        <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(message.created_at)}</span>
      </div>
      <p className="mt-1.5 flex items-center gap-1.5">
        {hasUnread ? <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-primary" /> : null}
        <span className={cn('min-w-0 flex-1 truncate text-[15px] font-bold', subdued && 'text-foreground/80')}>
          {message.title}
        </span>
      </p>
      <div className="mt-1 flex items-start gap-2">
        <p className="min-w-0 flex-1 line-clamp-2 text-[15px] text-muted-foreground">{message.content}</p>
        <SpeakButton text={message.content} label="这条消息" className="mt-1" />
      </div>
      {children}
    </div>
  );
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
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());

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

  // 跨端实时刷新：其他端写入新消息（升级通知/医护回执）时列表自动更新
  useRealtimeSync(() => void load(true), SYNC_ENTITIES);

  const markRead = (m: MsgRow) => {
    if (m.read) return;
    setList((prev) => prev.map((x) => (x.id === m.id ? { ...x, read: true } : x)));
    setUnread((n) => Math.max(0, n - 1));
    // 乐观更新 + 写库成功后广播：其他端（家属镜像/角标）同步已读状态
    patientApi
      .markMessageRead(m.id)
      .then(() => broadcastChange(['messages']))
      .catch(() => undefined);
  };

  // 点击整条：标记已读（乐观更新）并打开详情弹窗
  const open = (m: MsgRow) => {
    markRead(m);
    setActiveMsg(m);
  };

  const shown = useMemo(() => {
    const filtered = tab === 'unread' ? list.filter((m) => !m.read) : list;
    return groupMessages(filtered);
  }, [list, tab]);

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
                  // 一键已读成功后广播，让其他端的未读角标同步归零
                  broadcastChange(['messages']);
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
          {shown.map((group) => {
            const latest = group.messages[0];
            const duplicateCount = group.messages.length - 1;
            const expanded = expandedGroups.has(group.key);

            return (
              <div key={group.key} className="space-y-2">
                <MessageCard
                  message={latest}
                  subdued={duplicateCount > 0}
                  hasUnread={group.hasUnread}
                  onOpen={open}
                  onMarkRead={markRead}
                >
                  {duplicateCount > 0 ? (
                    <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/60 pt-2.5">
                      <span className="text-sm text-muted-foreground">另有 {duplicateCount} 条相同提醒</span>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        className="shrink-0 rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                        onKeyDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedGroups((prev) => {
                            const next = new Set(prev);
                            if (next.has(group.key)) next.delete(group.key);
                            else next.add(group.key);
                            return next;
                          });
                        }}
                      >
                        {expanded ? '收起重复提醒' : `展开查看全部（共 ${group.messages.length} 条）`}
                      </button>
                    </div>
                  ) : null}
                </MessageCard>

                {expanded ? (
                  <div className="ml-3 space-y-2 border-l-2 border-border/60 pl-3" aria-label={`${latest.title}的重复提醒`}>
                    <p className="px-1 text-sm font-medium text-muted-foreground">以下是其余 {duplicateCount} 条提醒</p>
                    {group.messages.slice(1).map((message) => (
                      <MessageCard
                        key={message.id}
                        message={message}
                        subdued
                        onOpen={open}
                        onMarkRead={markRead}
                      />
                    ))}
                  </div>
                ) : null}
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

              <div className="flex justify-end">
                <SpeakButton
                  key={activeMsg.id}
                  text={`${activeMsg.title}。${activeMsg.content}`}
                  label="这条消息"
                  size="md"
                />
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
