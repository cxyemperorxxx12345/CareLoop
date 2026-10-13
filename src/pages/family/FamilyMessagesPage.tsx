// 家属端消息中心：照护对象的提醒类消息（点击查看完整详情弹窗）
import { useCallback, useEffect, useState } from 'react';
import { Bell, CalendarHeart, Clock, MessageCircle, Pill } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/db/supabase';
import { useRealtimeSync } from '@/hooks/use-realtime-sync';
import { getFamilyPatient } from '@/lib/api';
import type { SyncEntity } from '@/lib/sync-bus';
import { cn } from '@/lib/utils';

// 跨端同步：消息中心只关心 messages 实体
const SYNC_ENTITIES: SyncEntity[] = ['messages'];

interface MsgRow {
  id: string;
  type: string;
  title: string;
  content: string;
  created_at: string;
}

const TYPE_META: Record<string, { label: string; cls: string; icon: typeof Pill }> = {
  reminder: { label: '用药提醒', cls: 'bg-primary/10 text-primary', icon: Pill },
  escalation: { label: '升级通知', cls: 'bg-triage-amber-bg text-triage-amber', icon: Bell },
  followup: { label: '随访提醒', cls: 'bg-triage-blue-bg text-triage-blue', icon: CalendarHeart },
};

function timeLabel(iso: string): string {
  const d = new Date(iso);
  const minutes = Math.floor((Date.now() - d.getTime()) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return d.toLocaleDateString('zh-CN');
}

export function FamilyMessagesPage() {
  const [loading, setLoading] = useState(true);
  const [msgs, setMsgs] = useState<MsgRow[]>([]);
  const [activeMsg, setActiveMsg] = useState<MsgRow | null>(null);

  // 拉取消息列表（挂载加载与跨端实时刷新共用）；返回取消函数防卸载后 setState
  const load = useCallback(() => {
    let alive = true;
    void (async () => {
      try {
        const fp = await getFamilyPatient();
        if (!alive) return;
        if (fp) {
          const { data } = await supabase
            .from('messages')
            .select('id, type, title, content, created_at')
            .eq('patient_id', fp.patient.id)
            .in('type', ['reminder', 'escalation', 'followup'])
            .order('created_at', { ascending: false })
            .limit(30);
          if (alive) setMsgs((data ?? []) as MsgRow[]);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const off = load();
    return off;
  }, [load]);

  // 跨端实时刷新：cron 或其他端写入新提醒/升级通知时列表自动更新
  useRealtimeSync(
    () => {
      load();
    },
    SYNC_ENTITIES,
  );

  if (loading) {
    return (
      <div className="p-4 space-y-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-24 w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <div className="pt-2">
        <h1 className="text-2xl font-bold">消息中心</h1>
        <p className="mt-1 text-sm text-muted-foreground">照护对象的提醒与升级通知（只读，经患者授权可见）</p>
      </div>

      {msgs.length === 0 ? (
        <Card className="rounded-2xl">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <MessageCircle className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">暂无提醒消息</p>
            <p className="text-xs text-muted-foreground">用药与随访提醒会同步出现在这里</p>
          </CardContent>
        </Card>
      ) : (
        msgs.map((m) => {
          const meta = TYPE_META[m.type] ?? { label: '通知', cls: 'bg-muted text-muted-foreground', icon: Bell };
          const Icon = meta.icon;
          return (
            <Card
              key={m.id}
              role="button"
              tabIndex={0}
              onClick={() => setActiveMsg(m)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setActiveMsg(m);
                }
              }}
              className="rounded-2xl cursor-pointer transition-shadow hover:shadow-card"
            >
              <CardContent className="flex items-start gap-3 p-4">
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${meta.cls}`}>
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-[15px] font-semibold">{m.title}</p>
                    <span className="shrink-0 text-xs text-muted-foreground">{timeLabel(m.created_at)}</span>
                  </div>
                  <p className="mt-1 text-[15px] leading-relaxed text-foreground/80 line-clamp-2">{m.content}</p>
                </div>
              </CardContent>
            </Card>
          );
        })
      )}

      {/* 消息详情 Dialog */}
      <Dialog open={!!activeMsg} onOpenChange={(open) => !open && setActiveMsg(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg rounded-2xl">
          {activeMsg && (
            <>
              <DialogHeader className="text-left space-y-2">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className={cn('shrink-0', (TYPE_META[activeMsg.type] ?? { cls: 'bg-muted text-muted-foreground' }).cls)}>
                    {(TYPE_META[activeMsg.type] ?? { label: '通知' }).label}
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
                <Button type="button" variant="outline" onClick={() => setActiveMsg(null)}>
                  关闭
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <p className="text-xs text-muted-foreground text-center">消息为患者端提醒的同步副本，已读状态以患者本人操作为准</p>
    </div>
  );
}

export default FamilyMessagesPage;
