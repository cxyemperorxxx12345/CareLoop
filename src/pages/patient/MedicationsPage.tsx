// 用药打卡：按 4 个时间槽分组，已服/稍后/跳过三种打卡，写 log 并同步提醒状态
// 离线：断网时回读本地快照展示；打卡操作只入队不发送，恢复网络后自动重放补传

import { CheckCircle2, CloudOff, Pill } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { AdaptiveReminderCard } from '@/components/common/AdaptiveReminderCard';
import { ErrorState, RefreshButton } from '@/components/common/AsyncState';
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
import { useRealtimeSync } from '@/hooks/use-realtime-sync';
import { useRefetchOnFocus } from '@/hooks/use-refetch-on-focus';
import { getMyPatient, getReminderAdaptInputs, patientApi } from '@/lib/api';
import {
  enqueue,
  isDryRun,
  isOffline,
  readSnapshot,
  replayQueue,
  readQueue,
  saveSnapshot,
} from '@/lib/offline-cache';
import { businessDate } from '@/lib/business-date';
import { medicationEventTime, queuedMedicationPayload, sendMedicationEvent, type MedicationLogPayload } from '@/lib/medication-log';
import { computeReminderAdapt, type ReminderAdaptResult } from '@/lib/reminder-adapt';
import { broadcastChange, type SyncEntity } from '@/lib/sync-bus';
import { cn } from '@/lib/utils';

const SLOT_LABELS = ['早 8:00', '中 12:00', '晚 18:00', '睡前 21:00'];
const ACTION_TEXT = { taken: '已服', snoozed: '稍后', skipped: '已跳过' } as const;
type MedAction = keyof typeof ACTION_TEXT;

// 跨端同步：本页关心的实体（患者/家属打卡、提醒状态、医护处理联动刷新）
const SYNC_ENTITIES: SyncEntity[] = ['medication_logs', 'reminders', 'checkins', 'messages'];

// 与数据库真实列名一致的本地行类型
interface PlanRow { id: string; medicine_name: string; spec: string | null; dosage: string | null; frequency: string | null; slots: number[] | null; note: string | null; }
interface LogRow { plan_id: string; slot: number; action: MedAction; reason: string | null; operator_type?: string | null; operator_name?: string | null; }

// 当前时间所在的近似时间槽
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

type MedLogPayload = MedicationLogPayload;

// 离线快照内容：患者 id + 用药计划/记录 + 自适应提醒结论
interface MedicationSnapshot {
  patientId: string;
  plans: PlanRow[];
  logs: LogRow[];
  adapt: ReminderAdaptResult | null;
}

export function MedicationsPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [patientId, setPatientId] = useState<string | null>(null);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  // 机制③：本人用药响应轨迹推导的自适应提醒（失败不影响主功能）
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

  // 刷新用药计划/记录；成功后顺带更新本地快照
  const refresh = useCallback(async (pid: string) => {
    const d = await patientApi.medicationDetail(pid);
    const nextPlans = d.plans as unknown as PlanRow[];
    const nextLogs = d.todayLogs as unknown as LogRow[];
    setPlans(nextPlans);
    setLogs(nextLogs);
    const uid = uidRef.current;
    if (uid) {
      void saveSnapshot<MedicationSnapshot>(`medications:${uid}`, {
        patientId: pid,
        plans: nextPlans,
        logs: nextLogs,
        adapt: adaptRef.current,
      });
    }
    return { plans: nextPlans, logs: nextLogs };
  }, []);

  // 完整加载：取患者档案 + 用药详情；isRefresh 时为手动/回前台刷新
  const initLoad = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      const uid = uidRef.current;
      // 断网：直接回读快照。不能只依赖下方 catch 兜底——supabase-js 断网时
      // auth.getUser() 返回 error 而不抛错、PostgREST 查询 resolve {data:null,error}，
      // 整个加载会「成功」返回空数据，快照兜底和离线标注都不会触发。
      if (isOffline()) {
        const snap = uid ? await readSnapshot<MedicationSnapshot>(`medications:${uid}`) : null;
        if (snap?.data?.patientId) {
          setPatientId(snap.data.patientId);
          setPlans(snap.data.plans ?? []);
          setLogs(snap.data.logs ?? []);
          setAdapt(snap.data.adapt ?? null);
          setSource('offline-snapshot');
          setDataAt(snap.savedAt);
          setErrorMsg('');
          setStatus('ready');
        } else {
          setErrorMsg('当前网络不可用，请连接后重试');
          setStatus('error');
        }
        if (isRefresh) setRefreshing(false);
        return;
      }
      try {
        const p = await getMyPatient();
        if (p) {
          setPatientId(p.id);
          const fresh = await refresh(p.id);
          // 机制③：拉取本人近 14 天用药响应，本地推导自适应提醒策略
          let nextAdapt: ReminderAdaptResult | null = null;
          try {
            const raw = await getReminderAdaptInputs(p.id, 14);
            nextAdapt = computeReminderAdapt(raw, 14);
          } catch {
            nextAdapt = null;
          }
          adaptRef.current = nextAdapt;
          setAdapt(nextAdapt);
          const uid = uidRef.current;
          if (uid) {
            void saveSnapshot<MedicationSnapshot>(`medications:${uid}`, {
              patientId: p.id,
              plans: fresh.plans,
              logs: fresh.logs,
              adapt: nextAdapt,
            });
          }
        }
        setSource('network');
        setDataAt(Date.now());
        setErrorMsg('');
        setStatus('ready');
      } catch (e) {
        // 断网兜底：回读上一次成功加载的快照并标注「离线数据」
        const uid = uidRef.current;
        const snap = uid ? await readSnapshot<MedicationSnapshot>(`medications:${uid}`) : null;
        if (snap?.data?.patientId) {
          setPatientId(snap.data.patientId);
          setPlans(snap.data.plans ?? []);
          setLogs(snap.data.logs ?? []);
          setAdapt(snap.data.adapt ?? null);
          setSource('offline-snapshot');
          setDataAt(snap.savedAt);
          setErrorMsg('');
          setStatus('ready');
        } else {
          setErrorMsg(e instanceof Error ? e.message : '加载失败，请稍后重试');
          setStatus('error');
        }
      } finally {
        if (isRefresh) setRefreshing(false);
      }
    },
    [refresh],
  );

  useEffect(() => {
    void initLoad();
  }, [initLoad]);

  // 回到前台自动刷新（节流 15s），让 cron 产生的提醒状态变化及时可见
  useRefetchOnFocus(() => void initLoad(true));

  // 跨端实时刷新：家属代打卡 / 医护处理等动作后，本页无需聚焦即自动更新
  useRealtimeSync(() => void initLoad(true), SYNC_ENTITIES);

  // 执行打卡：联网时直接写库；断网时只入队并本地标记「待补传」，恢复网络后自动重放
  async function performLog(planId: string, slot: number, action: MedAction, logReason?: string) {
    const pid = patientId;
    if (!pid || busy) return;
    const queueKey = `${planId}-${slot}`;

    if (isOffline()) {
      const item = await enqueue<MedLogPayload>('medication-log', {
        pid,
        planId,
        slot,
        action,
        ...medicationEventTime(),
        reason: logReason ?? null,
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
      await sendMedicationEvent({ pid, planId, slot, action, reason: logReason ?? null, ...medicationEventTime() });
      // 写库成功后广播失效：家属端镜像与医护端工作台立刻刷新，无需等聚焦
      broadcastChange(['medication_logs', 'reminders']);
      toast.success(action === 'taken' ? '已记录服药' : action === 'snoozed' ? '已延后 30 分钟，稍后再提醒您' : '已跳过本次服药');
      await refresh(pid);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  // 网络恢复：先重放离线队列补传，再拉新数据覆盖快照
  useEffect(() => {
    const onOnline = async () => {
      await replayQueue(async (item) => {
        await sendMedicationEvent(queuedMedicationPayload(item));
      }, { filter: (item) => item.kind === 'medication-log' && (item.payload as unknown as MedLogPayload).pid === patientId });
      // 离线补传成功后同样广播，让其他端补齐这批打卡数据
      broadcastChange(['medication_logs', 'reminders']);
      setQueuedKeys(readQueue().filter((item) => item.kind === 'medication-log' && (item.payload as unknown as MedLogPayload).pid === patientId).map((item) => {
        const p = item.payload as unknown as MedLogPayload;
        return `${p.planId}-${p.slot}`;
      }));
      void initLoad(true);
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [initLoad, patientId]);

  // 已有记录时先 toast 确认，再覆盖
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

  if (status === 'loading') {
    return (
      <div className="p-4 space-y-4">
        <div className="space-y-2 pt-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-48" />
        </div>
        <Skeleton className="h-20 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="p-4 pt-10">
        <ErrorState message={errorMsg} onRetry={() => void initLoad()} />
      </div>
    );
  }

  if (!patientId) {
    return (
      <div className="p-4 pt-10">
        <Card className="rounded-2xl">
          <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
            <Pill className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">还没有找到您的患者档案，请先登录后再查看用药计划。</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const nowSlot = currentSlot();
  const todayLabel = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  const totalDoses = plans.reduce((n, p) => n + (Array.isArray(p.slots) ? p.slots.length : 0), 0);
  const takenDoses = logs.filter((l) => l.action === 'taken').length;
  const percent = totalDoses > 0 ? Math.round((takenDoses / totalDoses) * 100) : 0;

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-start justify-between gap-2 pt-2">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">用药打卡</h1>
          <p className="mt-1 text-sm text-muted-foreground">{todayLabel}，按时服药有助于康复</p>
        </div>
        <RefreshButton onClick={() => void initLoad(true)} spinning={refreshing} />
      </div>

      {/* 断网兜底提示：数据来自本地快照时必须显式标注，避免误读为实时数据 */}
      {source === 'offline-snapshot' && (
        <OfflineNotice savedAt={dataAt} retrying={refreshing} onRetry={() => void initLoad(true)} />
      )}

      {/* 今日总进度 */}
      <Card className="rounded-2xl">
        <CardContent className="space-y-2 p-4">
          <div className="flex items-end justify-between gap-2">
            <p className="min-w-0 text-sm text-muted-foreground">
              今日已服 <span className="sig-num font-semibold text-foreground">{takenDoses}</span> / {totalDoses} 次
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
            <p className="text-sm text-muted-foreground">暂无用药计划，上传出院资料后可自动生成</p>
            <Button asChild className="rounded-2xl">
              <Link to="/patient/documents">去上传资料</Link>
            </Button>
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
                    {isCurrent && (
                      <Badge className="ml-2 bg-primary/10 text-primary">当前时段</Badge>
                    )}
                  </CardTitle>
                  <span className="shrink-0 text-xs text-muted-foreground">{meds.length} 种药</span>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {meds.length === 0 && <p className="text-sm text-muted-foreground">本时段暂无用药</p>}
                {meds.map((plan) => {
                  const log = logs.find((l) => l.plan_id === plan.id && l.slot === slot);
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
                          {log.operator_type === 'family'
                            ? `已服（由家属${log.operator_name ?? ''}代打卡）`
                            : '本时段已完成打卡'}
                        </div>
                      ) : pendingSync ? (
                        <div className="flex items-center justify-center gap-2 rounded-xl bg-triage-amber-bg py-2.5 text-[15px] font-medium text-triage-amber">
                          <CloudOff className="h-4 w-4" />
                          已记录，联网后自动补传
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <Button type="button" className="h-12 flex-1 rounded-xl text-[15px]" disabled={busy} onClick={() => requestLog(plan, slot, 'taken')}>
                            已服
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

      {/* 机制③：智能提醒已按本人习惯自适应（最小打扰，置于用药列表之后、低优先级） */}
      {adapt && <AdaptiveReminderCard result={adapt} />}

      {/* 跳过原因弹窗 */}
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
            <DialogTitle>跳过本次服药</DialogTitle>
            <DialogDescription>
              {skipTarget ? `${SLOT_LABELS[skipTarget.slot]} · ${skipTarget.name}` : ''}，请填写原因，医护团队会同步看到。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="请描述跳过原因（必填），如：服药后恶心"
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
    </div>
  );
}
export default MedicationsPage;
