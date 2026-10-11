// 家属代打卡：复用患者端用药打卡交互，来源标记为家属（operator_type=family），回写患者端与医护端
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Pill, UserCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/db/supabase';
import { getFamilyPatient } from '@/lib/api';
import { cn } from '@/lib/utils';

const SLOT_LABELS = ['早 8:00', '中 12:00', '晚 18:00', '睡前 21:00'];
const SLOT_HOURS = [8, 12, 18, 21];
const ACTION_TEXT = { taken: '已服', snoozed: '稍后', skipped: '已跳过' } as const;
type MedAction = keyof typeof ACTION_TEXT;

interface PlanRow { id: string; medicine_name: string; spec: string | null; dosage: string | null; frequency: string | null; slots: number[] | null; note: string | null; }
interface LogRow { plan_id: string; slot: number; action: MedAction; reason: string | null; operator_type: string | null; operator_name: string | null; }

function currentSlot(): number {
  const h = new Date().getHours();
  if (h < 11) return 0;
  if (h < 16) return 1;
  if (h < 20) return 2;
  return 3;
}

function logBadgeCls(action: MedAction): string {
  if (action === 'taken') return 'bg-triage-green-bg text-triage-green';
  if (action === 'snoozed') return 'bg-triage-amber-bg text-triage-amber';
  return 'bg-muted text-muted-foreground';
}

export function FamilyMedicationsPage() {
  const [loading, setLoading] = useState(true);
  const [pid, setPid] = useState<string | null>(null);
  const [familyName, setFamilyName] = useState('家属');
  const [patientName, setPatientName] = useState('');
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [skipTarget, setSkipTarget] = useState<{ planId: string; slot: number; name: string } | null>(null);
  const [reason, setReason] = useState('');

  const refresh = useCallback(async (patientId: string) => {
    const today = new Date().toISOString().slice(0, 10);
    const [pl, lg] = await Promise.all([
      supabase.from('medication_plans').select('id, medicine_name, spec, dosage, frequency, slots, note').eq('patient_id', patientId),
      supabase.from('medication_logs').select('plan_id, slot, action, reason, operator_type, operator_name').eq('patient_id', patientId).eq('log_date', today),
    ]);
    setPlans((pl.data ?? []) as PlanRow[]);
    setLogs((lg.data ?? []) as LogRow[]);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const fp = await getFamilyPatient();
        if (!alive) return;
        if (fp) {
          setPid(fp.patient.id);
          setPatientName(fp.patient.name);
          setFamilyName(fp.family_name);
          await refresh(fp.patient.id);
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '加载失败，请稍后重试');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  // 家属代打卡：operator_type=family + 来源姓名；taken 同步终止提醒升级链 + 自动闭合对应家属任务
  async function performLog(planId: string, slot: number, action: MedAction, logReason?: string) {
    if (!pid || busy) return;
    setBusy(true);
    const today = new Date().toISOString().slice(0, 10);
    try {
      const { error } = await supabase.from('medication_logs').upsert(
        {
          patient_id: pid,
          plan_id: planId,
          log_date: today,
          slot,
          action,
          reason: logReason ?? null,
          operator_type: 'family',
          operator_name: familyName,
        },
        { onConflict: 'plan_id,log_date,slot' },
      );
      if (error) throw error;
      if (action === 'taken') {
        await supabase
          .from('reminders')
          .update({ status: 'acked', updated_at: new Date().toISOString() })
          .eq('patient_id', pid)
          .eq('remind_date', today)
          .eq('slot', slot)
          .neq('status', 'acked');
        // 漏服升级任务因代打卡而闭合：dosed 响应，链路终止
        const { data: openTasks } = await supabase
          .from('alerts')
          .select('id')
          .eq('patient_id', pid)
          .eq('assignee_role', 'family')
          .eq('status', 'open');
        for (const t of openTasks ?? []) {
          await supabase.rpc('family_respond_alert', { p_alert_id: t.id, p_action: 'dosed', p_family_name: familyName });
        }
        toast.success(`已代为打卡，患者端与医护端均可见（来源：家属 ${familyName}）`);
      } else if (action === 'snoozed') {
        await supabase
          .from('reminders')
          .update({
            status: 'snoozed',
            snooze_until: new Date(Date.now() + 30 * 60000).toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('patient_id', pid)
          .eq('remind_date', today)
          .eq('slot', slot)
          .neq('status', 'acked');
        toast.success('已代为延后 30 分钟');
      } else {
        toast.success('已代为跳过本次服药');
      }
      await refresh(pid);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  function requestLog(plan: PlanRow, slot: number, action: MedAction, logReason?: string) {
    const existing = logs.find((l) => l.plan_id === plan.id && l.slot === slot);
    if (existing) {
      toast(`将覆盖上次「${ACTION_TEXT[existing.action]}」记录`, {
        action: { label: '确认覆盖', onClick: () => void performLog(plan.id, slot, action, logReason) },
      });
      return;
    }
    void performLog(plan.id, slot, action, logReason);
  }

  function submitSkip() {
    if (!skipTarget) return;
    const text = reason.trim();
    if (!text) {
      toast.error('请填写跳过原因');
      return;
    }
    const target = skipTarget;
    setSkipTarget(null);
    setReason('');
    const plan = plans.find((p) => p.id === target.planId);
    if (plan) requestLog(plan, target.slot, 'skipped', text);
  }

  if (loading) {
    return (
      <div className="p-4 space-y-4">
        <div className="space-y-2 pt-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-48" />
        </div>
        <Skeleton className="h-20 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  if (!pid) {
    return (
      <div className="p-4 pt-10">
        <Card className="rounded-2xl">
          <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
            <Pill className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">暂无可照护的患者绑定，请联系患者完成授权。</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const nowSlot = currentSlot();
  const now = new Date();
  const elapsedSlots = SLOT_HOURS.map((h, i) => (now.getHours() >= h ? i : -1)).filter((i) => i >= 0);
  const dueDoses = plans.reduce(
    (n, p) => n + (Array.isArray(p.slots) ? p.slots.filter((s) => elapsedSlots.includes(s)).length : 0),
    0,
  );
  const takenDoses = logs.filter((l) => l.action === 'taken' && elapsedSlots.includes(l.slot)).length;
  const percent = dueDoses > 0 ? Math.round((takenDoses / dueDoses) * 100) : 0;
  const todayLabel = now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });

  return (
    <div className="p-4 space-y-4">
      <div className="pt-2">
        <h1 className="text-2xl font-bold">代为打卡</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {todayLabel} · 正在协助 {patientName}，操作将标注家属来源
        </p>
      </div>

      <Card className="rounded-2xl">
        <CardContent className="space-y-2 p-4">
          <div className="flex items-end justify-between gap-2">
            <p className="min-w-0 text-sm text-muted-foreground">
              今日已服 <span className="sig-num font-semibold text-foreground">{takenDoses}</span> / {dueDoses} 次
            </p>
            <span className="sig-num shrink-0 text-xl font-bold text-primary">{percent}%</span>
          </div>
          <Progress value={percent} />
        </CardContent>
      </Card>

      {plans.length === 0 ? (
        <Card className="rounded-2xl">
          <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
            <Pill className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">患者暂无用药计划</p>
          </CardContent>
        </Card>
      ) : (
        SLOT_LABELS.map((label, slot) => {
          const meds = plans.filter((p) => Array.isArray(p.slots) && p.slots.includes(slot));
          const isCurrent = slot === nowSlot;
          return (
            <Card key={slot} className={cn('rounded-2xl', isCurrent && 'border-primary shadow-card')}>
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <CardTitle className="min-w-0 flex-1 text-base">
                    {label}
                    {isCurrent && <Badge className="ml-2 bg-primary/10 text-primary">当前时段</Badge>}
                  </CardTitle>
                  <span className="shrink-0 text-xs text-muted-foreground">{meds.length} 种药</span>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {meds.length === 0 && <p className="text-sm text-muted-foreground">本时段暂无用药</p>}
                {meds.map((plan) => {
                  const log = logs.find((l) => l.plan_id === plan.id && l.slot === slot);
                  const byFamily = log?.operator_type === 'family';
                  return (
                    <div key={plan.id} className="space-y-2.5 rounded-2xl border border-border bg-background p-3">
                      <div className="flex items-start gap-2">
                        <Pill className="mt-1 h-5 w-5 shrink-0 text-primary" />
                        <div className="min-w-0 flex-1">
                          <p className="text-[15px] font-semibold leading-snug">{plan.medicine_name}</p>
                          <p className="mt-1 text-[15px] leading-snug text-foreground/75">
                            {[plan.spec, plan.dosage, plan.frequency].filter(Boolean).join(' · ') || '详见出院医嘱'}
                          </p>
                          {plan.note && <p className="mt-1 text-[15px] leading-snug text-foreground/75">备注：{plan.note}</p>}
                        </div>
                        {log && (
                          <Badge variant="secondary" className={cn('shrink-0', logBadgeCls(log.action))}>
                            {ACTION_TEXT[log.action]}
                          </Badge>
                        )}
                      </div>
                      {log?.action === 'taken' ? (
                        <div className="flex items-center justify-center gap-2 rounded-xl bg-muted py-2.5 text-[15px] font-medium text-muted-foreground">
                          <CheckCircle2 className="h-4 w-4" />
                          {byFamily ? `已由家属${log.operator_name ?? ''}代打卡` : '患者本人已确认'}
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <Button type="button" className="h-12 flex-1 rounded-xl text-[15px]" disabled={busy} onClick={() => requestLog(plan, slot, 'taken')}>
                            代为打卡已服
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            className="h-10 rounded-xl px-3 text-[15px]"
                            disabled={busy}
                            onClick={() => requestLog(plan, slot, 'snoozed')}
                          >
                            稍后
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            className="h-10 rounded-xl px-3 text-[15px]"
                            disabled={busy}
                            onClick={() => {
                              setReason('');
                              setSkipTarget({ planId: plan.id, slot, name: plan.medicine_name });
                            }}
                          >
                            跳过
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          );
        })
      )}

      <Dialog
        open={skipTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSkipTarget(null);
            setReason('');
          }
        }}
      >
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg">
          <DialogHeader>
            <DialogTitle>代为跳过本次服药</DialogTitle>
            <DialogDescription>
              {skipTarget ? `${SLOT_LABELS[skipTarget.slot]} · ${skipTarget.name}` : ''}，请填写原因，医护团队与患者都会看到由家属提交的记录。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="请描述跳过原因（必填），如：患者反馈服药后恶心"
          />
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              className="rounded-2xl"
              onClick={() => {
                setSkipTarget(null);
                setReason('');
              }}
            >
              取消
            </Button>
            <Button type="button" className="rounded-2xl" onClick={submitSkip}>
              确认跳过
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <UserCheck className="h-3.5 w-3.5" />
        所有代打卡记录会标注「家属来源」，医护端依从统计可区分
      </p>
    </div>
  );
}

export default FamilyMedicationsPage;
