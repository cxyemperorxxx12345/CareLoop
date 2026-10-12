// 家属代打卡：复用患者端用药打卡交互，来源标记为家属（operator_type=family），回写患者端与医护端
// 离线：断网时回读本地快照展示；打卡操作只入队不发送，恢复网络后自动重放补传

import { CheckCircle2, CloudOff, Pill, UserCheck } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AdaptiveReminderCard } from '@/components/common/AdaptiveReminderCard';
import { OfflineNotice } from '@/components/common/OfflineNotice';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/db/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { getFamilyPatient, getReminderAdaptInputs } from '@/lib/api';
import {
  enqueue,
  isDryRun,
  isOffline,
  readSnapshot,
  replayQueue,
  saveSnapshot,
} from '@/lib/offline-cache';
import { computeReminderAdapt, type ReminderAdaptResult } from '@/lib/reminder-adapt';
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

// 家属代填来源标注：复用 medication_logs 已有的 reason 文本列承载（不加列、不加迁移）。
// 结构化标注走 operator_type='family' + operator_name（迁移 00005）；reason 是文本冗余，
// 保证只展示文本的地方也能识别来源。跳过原因属临床语义，标注以括号后缀追加，
// 不前置、不覆盖，避免污染原始描述。
function attributedReason(userReason: string | undefined, familyName: string): string {
  const tag = `由家属${familyName}代填`;
  const text = userReason?.trim();
  return text ? `${text}（${tag}）` : tag;
}

function logBadgeCls(action: MedAction): string {
  if (action === 'taken') return 'bg-triage-green-bg text-triage-green';
  if (action === 'snoozed') return 'bg-triage-amber-bg text-triage-amber';
  return 'bg-muted text-muted-foreground';
}

// 离线入队的代打卡载荷（联网重放时原样提交）
interface FamilyLogPayload {
  pid: string;
  planId: string;
  slot: number;
  action: MedAction;
  reason: string | null;
  familyName: string;
}

// 真实写库：家属代打卡，operator_type=family + 来源姓名；taken 同步终止提醒升级链 + 闭合家属任务
async function sendFamilyMedicationLog(p: FamilyLogPayload): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const { error } = await supabase.from('medication_logs').upsert(
    {
      patient_id: p.pid,
      plan_id: p.planId,
      log_date: today,
      slot: p.slot,
      action: p.action,
      reason: p.reason,
      operator_type: 'family',
      operator_name: p.familyName,
    },
    { onConflict: 'plan_id,log_date,slot' },
  );
  if (error) throw error;
  if (p.action === 'taken') {
    await supabase
      .from('reminders')
      .update({ status: 'acked', updated_at: new Date().toISOString() })
      .eq('patient_id', p.pid)
      .eq('remind_date', today)
      .eq('slot', p.slot)
      .neq('status', 'acked');
    // 漏服升级任务因代打卡而闭合：dosed 响应，链路终止
    const { data: openTasks } = await supabase
      .from('alerts')
      .select('id')
      .eq('patient_id', p.pid)
      .eq('assignee_role', 'family')
      .eq('status', 'open');
    for (const t of openTasks ?? []) {
      await supabase.rpc('family_respond_alert', { p_alert_id: t.id, p_action: 'dosed', p_family_name: p.familyName });
    }
  } else if (p.action === 'snoozed') {
    await supabase
      .from('reminders')
      .update({
        status: 'snoozed',
        snooze_until: new Date(Date.now() + 30 * 60000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('patient_id', p.pid)
      .eq('remind_date', today)
      .eq('slot', p.slot)
      .neq('status', 'acked');
  }
}

// 离线快照内容：照护对象信息 + 用药计划/记录 + 自适应提醒结论
interface FamilyMedicationSnapshot {
  pid: string;
  patientName: string;
  patientGender: string | null;
  familyName: string;
  plans: PlanRow[];
  logs: LogRow[];
  adapt: ReminderAdaptResult | null;
}

export function FamilyMedicationsPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [pid, setPid] = useState<string | null>(null);
  const [familyName, setFamilyName] = useState('家属');
  const [patientName, setPatientName] = useState('');
  const [patientGender, setPatientGender] = useState<string | null>(null);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  // 机制③：照护对象用药响应轨迹推导的自适应提醒
  const [adapt, setAdapt] = useState<ReminderAdaptResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [skipTarget, setSkipTarget] = useState<{ planId: string; slot: number; name: string } | null>(null);
  const [reason, setReason] = useState('');
  // 数据来源：network = 实时拉取成功；offline-snapshot = 断网回读本地快照（界面必须标注）
  const [source, setSource] = useState<'network' | 'offline-snapshot'>('network');
  const [dataAt, setDataAt] = useState<number>(Date.now());
  // 离线期间已入队、等待补传的打卡（planId-slot）
  const [queuedKeys, setQueuedKeys] = useState<string[]>([]);
  const uidRef = useRef<string | null>(user?.id ?? null);
  uidRef.current = user?.id ?? null;
  const adaptRef = useRef<ReminderAdaptResult | null>(null);
  adaptRef.current = adapt;
  // 快照回写需要的最新照护对象信息（state 在闭包里拿不到最新值，用 ref 镜像）
  const patientNameRef = useRef(patientName);
  patientNameRef.current = patientName;
  const patientGenderRef = useRef(patientGender);
  patientGenderRef.current = patientGender;
  const familyNameRef = useRef(familyName);
  familyNameRef.current = familyName;

  const refresh = useCallback(async (patientId: string) => {
    const today = new Date().toISOString().slice(0, 10);
    const [pl, lg] = await Promise.all([
      supabase.from('medication_plans').select('id, medicine_name, spec, dosage, frequency, slots, note').eq('patient_id', patientId),
      supabase.from('medication_logs').select('plan_id, slot, action, reason, operator_type, operator_name').eq('patient_id', patientId).eq('log_date', today),
    ]);
    const nextPlans = (pl.data ?? []) as PlanRow[];
    const nextLogs = (lg.data ?? []) as LogRow[];
    setPlans(nextPlans);
    setLogs(nextLogs);
    const uid = uidRef.current;
    if (uid) {
      void saveSnapshot<FamilyMedicationSnapshot>(`family-medications:${uid}`, {
        pid: patientId,
        patientName: patientNameRef.current,
        patientGender: patientGenderRef.current,
        familyName: familyNameRef.current,
        plans: nextPlans,
        logs: nextLogs,
        adapt: adaptRef.current,
      });
    }
    return { plans: nextPlans, logs: nextLogs };
  }, []);

  // 完整加载：取绑定患者 + 用药详情；成功后写快照，断网失败则回读快照并标注离线
  const initLoad = useCallback(async () => {
    const uid = uidRef.current;
    setLoading(true);
    try {
      const fp = await getFamilyPatient();
      if (fp) {
        setPid(fp.patient.id);
        setPatientName(fp.patient.name);
        setPatientGender(fp.patient.gender);
        setFamilyName(fp.family_name);
        const fresh = await refresh(fp.patient.id);
        // 机制③：拉取照护对象近 14 天用药响应，本地推导自适应提醒
        let nextAdapt: ReminderAdaptResult | null = null;
        try {
          const raw = await getReminderAdaptInputs(fp.patient.id, 14);
          nextAdapt = computeReminderAdapt(raw, 14);
        } catch {
          nextAdapt = null;
        }
        adaptRef.current = nextAdapt;
        setAdapt(nextAdapt);
        if (uid) {
          void saveSnapshot<FamilyMedicationSnapshot>(`family-medications:${uid}`, {
            pid: fp.patient.id,
            patientName: fp.patient.name,
            patientGender: fp.patient.gender,
            familyName: fp.family_name,
            plans: fresh.plans,
            logs: fresh.logs,
            adapt: nextAdapt,
          });
        }
      }
      setSource('network');
      setDataAt(Date.now());
    } catch (e) {
      const snap = uid ? await readSnapshot<FamilyMedicationSnapshot>(`family-medications:${uid}`) : null;
      if (snap?.data?.pid) {
        setPid(snap.data.pid);
        setPatientName(snap.data.patientName ?? '');
        setPatientGender(snap.data.patientGender ?? null);
        setFamilyName(snap.data.familyName ?? '家属');
        setPlans(snap.data.plans ?? []);
        setLogs(snap.data.logs ?? []);
        setAdapt(snap.data.adapt ?? null);
        setSource('offline-snapshot');
        setDataAt(snap.savedAt);
      } else {
        toast.error(e instanceof Error ? e.message : '加载失败，请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  useEffect(() => {
    void initLoad();
  }, [initLoad]);

  // 网络恢复：先重放离线队列补传，再拉新数据覆盖快照
  useEffect(() => {
    const onOnline = async () => {
      await replayQueue(async (item) => {
        await sendFamilyMedicationLog(item.payload as unknown as FamilyLogPayload);
      });
      setQueuedKeys([]);
      void initLoad();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [initLoad]);

  // 家属代打卡：联网时直接写库；断网时只入队并本地标记「待补传」，恢复网络后自动重放
  async function performLog(planId: string, slot: number, action: MedAction, logReason?: string) {
    if (!pid || busy) return;
    const queueKey = `${planId}-${slot}`;

    if (isOffline()) {
      const item = await enqueue<FamilyLogPayload>('family-medication-log', {
        pid,
        planId,
        slot,
        action,
        reason: attributedReason(logReason, familyName),
        familyName,
      });
      if (item) {
        setQueuedKeys((keys) => (keys.includes(queueKey) ? keys : [...keys, queueKey]));
        toast.success(
          isDryRun()
            ? '已记录到离线队列（演练模式，不会上传）'
            : '已记录到离线队列，联网后自动补传',
        );
        return;
      }
      toast.error('当前网络不可用，请联网后再打卡');
      return;
    }

    setBusy(true);
    try {
      await sendFamilyMedicationLog({
        pid,
        planId,
        slot,
        action,
        reason: attributedReason(logReason, familyName),
        familyName,
      });
      if (action === 'taken') {
        toast.success(`已记录，并标注为由你代填（家属 ${familyName}），患者端与医护端同步可见`);
      } else if (action === 'snoozed') {
        toast.success('已代为延后 30 分钟，记录已标注为由你代填');
      } else {
        toast.success('已记录跳过本次服药，并标注为由你代填');
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
          {todayLabel}，正在协助 {patientName}，操作将标注家属来源
        </p>
      </div>

      {/* 断网兜底提示：数据来自本地快照时必须显式标注，避免误读为实时数据 */}
      {source === 'offline-snapshot' && <OfflineNotice savedAt={dataAt} onRetry={() => void initLoad()} />}

      {/* 机制③：智能提醒已按照护对象（他/她）习惯自适应（最小打扰） */}
      {adapt && <AdaptiveReminderCard result={adapt} subject={patientGender === '女' ? '她' : patientGender === '男' ? '他' : '其'} />}

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
                  const pendingSync = queuedKeys.includes(`${plan.id}-${slot}`);
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
                      ) : pendingSync ? (
                        <div className="flex items-center justify-center gap-2 rounded-xl bg-triage-amber-bg py-2.5 text-[15px] font-medium text-triage-amber">
                          <CloudOff className="h-4 w-4" />
                          已记录，联网后自动补传
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
              {skipTarget ? `${SLOT_LABELS[skipTarget.slot]} · ${skipTarget.name}` : ''}，请填写原因。提交后将标注为由你代填，医护团队与患者都会看到。
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
