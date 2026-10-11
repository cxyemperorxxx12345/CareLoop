// 家属端升级任务：L2 待我处理（三动作：代打卡跳转 / 已联系 / 转医护）+ 已响应历史
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ClipboardCheck, PhoneCall, ShieldAlert, Siren } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/db/supabase';
import { getFamilyPatient } from '@/lib/api';
import { cn } from '@/lib/utils';

interface AlertRow {
  id: string;
  level: 'red' | 'yellow';
  detail: string | null;
  status: 'open' | 'resolved';
  family_action: 'dosed' | 'contacted' | 'escalate' | null;
  family_responded_at: string | null;
  created_at: string;
}

const ACTION_TEXT: Record<string, string> = {
  dosed: '已代为打卡，链路终止',
  contacted: '已联系患者，维持观察',
  escalate: '已转医护介入',
};

function waitedLabel(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return `已等待 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `已等待 ${hours} 小时 ${minutes % 60} 分钟`;
}

export function FamilyTasksPage() {
  const [loading, setLoading] = useState(true);
  const [pid, setPid] = useState<string | null>(null);
  const [familyName, setFamilyName] = useState('家属');
  const [busy, setBusy] = useState(false);
  const [openTasks, setOpenTasks] = useState<AlertRow[]>([]);
  const [history, setHistory] = useState<AlertRow[]>([]);

  const refresh = useCallback(async (patientId: string) => {
    const { data } = await supabase
      .from('alerts')
      .select('id, level, detail, status, family_action, family_responded_at, created_at')
      .eq('patient_id', patientId)
      .eq('assignee_role', 'family')
      .order('created_at', { ascending: false });
    const rows = (data ?? []) as AlertRow[];
    setOpenTasks(rows.filter((r) => r.status === 'open').sort((a, b) => (a.level === b.level ? new Date(b.created_at).getTime() - new Date(a.created_at).getTime() : a.level === 'red' ? -1 : 1)));
    setHistory(rows.filter((r) => r.family_responded_at));
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const fp = await getFamilyPatient();
        if (!alive) return;
        if (fp) {
          setPid(fp.patient.id);
          setFamilyName(fp.family_name);
          await refresh(fp.patient.id);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  // 家属响应：contacted 维持观察；escalate 升级红旗交医护
  async function respond(taskId: string, action: 'contacted' | 'escalate') {
    if (!pid || busy) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc('family_respond_alert', {
        p_alert_id: taskId,
        p_action: action,
        p_family_name: familyName,
      });
      if (error) throw error;
      toast.success(action === 'contacted' ? '已记录：您已联系患者，医护端同步可见' : '已转医护介入，护士站将尽快联系');
      await refresh(pid);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="p-4 space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-48 w-full rounded-2xl" />
        <Skeleton className="h-32 w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <div className="pt-2">
        <h1 className="text-2xl font-bold">待我处理</h1>
        <p className="mt-1 text-sm text-muted-foreground">漏服提醒升级到家属时，请您协助确认，响应结果医护端实时可见</p>
      </div>

      {/* 待处理任务 */}
      {openTasks.length === 0 ? (
        <Card className="rounded-2xl">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-triage-green-bg">
              <CheckCircle2 className="h-6 w-6 text-triage-green" />
            </span>
            <p className="text-[15px] font-medium">太好了，暂无待处理任务</p>
            <p className="text-sm text-muted-foreground">患者按时完成了各项用药提醒，无需协助</p>
          </CardContent>
        </Card>
      ) : (
        openTasks.map((t) => (
          <Card
            key={t.id}
            className={cn('rounded-2xl', t.level === 'red' ? 'border-triage-red/40 bg-triage-red-bg/30' : 'border-triage-amber/40')}
          >
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <ShieldAlert className={cn('h-4 w-4 shrink-0', t.level === 'red' ? 'text-triage-red' : 'text-triage-amber')} />
                {t.level === 'red' ? '紧急协助' : '用药协助'}
                <Badge variant="outline" className="text-xs font-normal">{waitedLabel(t.created_at)}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-[15px] leading-relaxed">{t.detail}</p>
              <div className="grid gap-2">
                <Button asChild className="h-12 rounded-xl text-[15px]">
                  <Link to="/family/medications">
                    <span className="inline-flex items-center gap-1.5">
                      <ClipboardCheck className="h-4 w-4" />
                      代患者打卡已服
                    </span>
                  </Link>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-12 rounded-xl text-[15px]"
                  disabled={busy}
                  onClick={() => respond(t.id, 'contacted')}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <PhoneCall className="h-4 w-4" />
                    我已联系患者
                  </span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-12 rounded-xl text-[15px] border-triage-red/50 text-triage-red hover:bg-triage-red-bg/50"
                  disabled={busy}
                  onClick={() => respond(t.id, 'escalate')}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Siren className="h-4 w-4" />
                    仍无响应，转医护介入
                  </span>
                </Button>
              </div>
            </CardContent>
          </Card>
        ))
      )}

      {/* 已响应历史 */}
      <Card className="rounded-2xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">我已处理</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {history.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground text-center">暂无历史响应记录</p>
          ) : (
            history.map((h) => (
              <div key={h.id} className="flex items-start gap-3 rounded-xl border border-border p-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-triage-green" />
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-medium">{h.family_action ? ACTION_TEXT[h.family_action] : '已响应'}</p>
                  <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{h.detail}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {h.family_responded_at ? new Date(h.family_responded_at).toLocaleString('zh-CN') : ''}
                  </p>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default FamilyTasksPage;
