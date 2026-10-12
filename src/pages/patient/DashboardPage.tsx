// 今日概览（患者端首页）：问候 + 今日待办 + 用药进度 + 最近打卡 + 快捷入口

import { BellRing, Bot, CalendarHeart, FileUp, HeartPulse, Stethoscope } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ErrorState, RefreshButton } from '@/components/common/AsyncState';
import { FontScaleSwitch } from '@/components/common/FontScaleSwitch';
import { SignOutButton } from '@/components/common/SignOutButton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useRefetchOnFocus } from '@/hooks/use-refetch-on-focus';
import { getMyPatient, patientApi } from '@/lib/api';
import { cn } from '@/lib/utils';

// 时间槽常量
const SLOT_LABELS = ['早 8:00', '中 12:00', '晚 18:00', '睡前 21:00'];

// 与数据库真实列名一致的本地行类型
interface PlanRow { id: string; medicine_name: string; slots: number[] | null; spec?: string | null; dosage?: string | null; }
interface LogRow { action: string; }
interface ReminderRow { id: string; plan_id: string | null; slot: number; status: string; }
interface CheckinRow { systolic: number | null; diastolic: number | null; heart_rate: number | null; created_at: string; }
interface DashboardData {
  plans: PlanRow[];
  todayLogs: LogRow[];
  followups: unknown[];
  latestCheckin: CheckinRow[] | CheckinRow | null;
  todayReminders: ReminderRow[];
}

const REMINDER_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '待提醒', cls: 'bg-muted text-muted-foreground' },
  sent: { label: '已提醒', cls: 'bg-triage-amber-bg text-triage-amber' },
  snoozed: { label: '稍后', cls: 'bg-triage-amber-bg text-triage-amber' },
  escalated: { label: '已升级', cls: 'bg-triage-red-bg text-triage-red' },
};

const QUICK_LINKS = [
  { to: '/patient/checkin', label: '健康打卡', desc: '血压心率每日一记', icon: HeartPulse },
  { to: '/patient/symptom', label: '症状自查', desc: '不适先自查分诊', icon: Stethoscope },
  { to: '/patient/assistant', label: '智能问答', desc: '照护问题随时问', icon: Bot },
  { to: '/patient/documents', label: '上传资料', desc: '出院单拍照识别', icon: FileUp },
  { to: '/patient/followup', label: '随访计划', desc: '复查安排早知道', icon: CalendarHeart },
];

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

// 出院天数（今天与 discharge_date 的差值 + 1）；术后 = 出院 + 4（陈桂芳 10-03 手术、10-07 出院）
function dischargeDays(dischargeDate: string): number {
  const today = new Date().toISOString().slice(0, 10);
  const diff = Math.round((Date.parse(today) - Date.parse(dischargeDate.slice(0, 10))) / 86400000);
  return diff + 1;
}
function surgeryDays(dischargeDate: string): number {
  return dischargeDays(dischargeDate) + 4;
}

export function DashboardPage() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [patient, setPatient] = useState<{ id: string; name: string; discharge_date: string } | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);

  // 退出登录并回到初始落地页
  const handleSignOut = async () => {
    try {
      await signOut();
      toast.success('已退出登录，期待您再次回来');
      navigate('/');
    } catch {
      toast.error('退出失败，请重试');
    }
  };

  // 拉取数据；isRefresh=true 时为手动/回前台刷新（只转按钮圈，不整体骨架）
  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const p = await getMyPatient();
      setPatient(p);
      if (p) setData((await patientApi.dashboard(p.id)) as unknown as DashboardData);
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

  // 回到前台自动刷新（节流 15s），让 cron 产生的新提醒/消息及时可见
  useRefetchOnFocus(() => void load(true));

  if (status === 'loading') {
    return (
      <div className="p-4 space-y-4">
        <div className="space-y-2 pt-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-4 w-36" />
        </div>
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-24 w-full rounded-2xl" />
        <div className="grid grid-cols-2 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="p-4 pt-10">
        <ErrorState message={errorMsg} onRetry={() => void load()} />
      </div>
    );
  }

  if (!patient) {
    return (
      <div className="p-4 pt-10">
        <Card className="rounded-2xl">
          <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
            <FileUp className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              还没有找到您的患者档案，请先上传出院资料，我们会为您建立专属照护计划。
            </p>
            <Button asChild className="rounded-2xl">
              <Link to="/patient/documents">去上传资料</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const plans = data?.plans ?? [];
  // 下次用药：最早一个尚未服药的时段（时段从低到高，早于当前时段的算过期优先展示）
  const loggedKeySet = new Set(
    (data?.todayLogs ?? []).filter((l) => l.action === 'taken').map((l) => `${(l as unknown as { plan_id?: string }).plan_id ?? ''}-${(l as unknown as { slot?: number }).slot ?? 0}`),
  );
  const nextDoseCandidate = plans
    .flatMap((plan) =>
      (Array.isArray(plan.slots) ? plan.slots : []).map((slot) => ({ plan, slot })),
    )
    .filter((d) => !loggedKeySet.has(`${d.plan.id}-${d.slot}`))
    .sort((a, b) => a.slot - b.slot)[0];
  const nextDose = nextDoseCandidate ?? null;
  // 今日待办：未确认的提醒，按时间槽排序
  const todos = (data?.todayReminders ?? [])
    .filter((r) => r.status !== 'acked')
    .sort((a, b) => a.slot - b.slot);
  // 依从统计：只统计当前时刻已过时段的剂量（避免深夜/早晨分母口径矛盾）
  const nowH = new Date().getHours();
  const SLOT_HOURS = [8, 12, 18, 21];
  const elapsedSlots = [0, 1, 2, 3].filter((i) => nowH >= SLOT_HOURS[i]);
  const totalDoses = plans.reduce(
    (n, p) => n + (Array.isArray(p.slots) ? p.slots.filter((s) => elapsedSlots.includes(s)).length : 0),
    0,
  );
  const takenDoses = (data?.todayLogs ?? []).filter(
    (l) => l.action === 'taken' && elapsedSlots.includes((l as unknown as { slot?: number }).slot ?? -1),
  ).length;
  const percent = totalDoses > 0 ? Math.round((takenDoses / totalDoses) * 100) : 0;
  // 最近一条打卡（接口返回数组，取首条）
  const latestRaw = data?.latestCheckin;
  const latest = Array.isArray(latestRaw) ? latestRaw[0] : latestRaw;
  const todayLabel = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });

  return (
    <div className="p-4 space-y-4">
      {/* 顶部问候 + 退出登录 */}
      <div className="flex items-start justify-between gap-3 pt-2">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{todayLabel}</p>
          <h1 className="mt-1 text-2xl font-bold">
            {greeting()}，{patient.name}
          </h1>
          <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-sm font-semibold text-primary">
            <HeartPulse className="h-4 w-4" />
            术后第 {Math.max(1, surgeryDays(patient.discharge_date))} 天 · 出院第 {Math.max(1, dischargeDays(patient.discharge_date))} 天
          </p>
        </div>
        <div className="flex shrink-0 items-center">
          <RefreshButton onClick={() => void load(true)} spinning={refreshing} />
          <SignOutButton onClick={handleSignOut} />
        </div>
      </div>

      {/* 适老化字号档位：小 / 中 / 大（全局生效，本地记忆） */}
      <FontScaleSwitch />

      {/* 下次用药（P1：最突出卡片） */}
      {nextDose && (
        <Card className="rounded-2xl border-primary/50 bg-primary/5 shadow-card">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base text-primary">
              <BellRing className="h-4 w-4 shrink-0" />
              下一次用药
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0">
                <p className="text-lg font-bold leading-snug">{nextDose.plan.medicine_name}</p>
                <p className="mt-1 text-[15px] text-foreground/75">
                  {[nextDose.plan.spec, nextDose.plan.dosage].filter(Boolean).join(' · ')}
                </p>
              </div>
              <span className="sig-num shrink-0 rounded-full bg-primary px-3.5 py-1.5 text-sm font-bold text-primary-foreground">
                {SLOT_LABELS[nextDose.slot]}
              </span>
            </div>
            <Button asChild className="h-12 w-full rounded-xl text-[15px]">
              <Link to="/patient/medications">去打卡</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* 今日待办 */}
      <Card className="rounded-2xl">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <BellRing className="h-4 w-4 shrink-0 text-primary" />
            今日待办
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {todos.length === 0 ? (
            nextDose ? (
              <p className="text-[15px] text-muted-foreground">
                今日仅剩 {SLOT_LABELS[nextDose.slot]} 的 {nextDose.plan.medicine_name} 待服用
              </p>
            ) : (
              <p className="text-[15px] text-muted-foreground">今日用药已全部完成，好好休息</p>
            )
          ) : (
            todos.map((r) => {
              const plan = plans.find((p) => p.id === r.plan_id);
              const meta = REMINDER_STATUS[r.status] ?? REMINDER_STATUS.pending;
              return (
                <div key={r.id} className="flex items-center gap-2">
                  <span className="sig-num w-16 shrink-0 text-xs text-muted-foreground">
                    {SLOT_LABELS[r.slot] ?? `时段 ${r.slot}`}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[15px]">{plan?.medicine_name ?? '用药提醒'}</span>
                  <Badge variant="secondary" className={cn('shrink-0', meta.cls)}>
                    {meta.label}
                  </Badge>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* 用药进度 */}
      <Card className="rounded-2xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">今日用药进度</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-end justify-between gap-2">
            <p className="min-w-0 text-sm text-muted-foreground">
              已服 <span className="sig-num font-semibold text-foreground">{takenDoses}</span> / {totalDoses} 次
            </p>
            <span className="sig-num shrink-0 text-2xl font-bold text-primary">{percent}%</span>
          </div>
          <Progress value={percent} />
          <Button asChild variant="outline" className="w-full rounded-2xl">
            <Link to="/patient/medications">去用药打卡</Link>
          </Button>
        </CardContent>
      </Card>

      {/* 最近健康打卡 */}
      <Card className="rounded-2xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">最近健康打卡</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {latest ? (
            <>
              <div className="flex gap-4">
                <div className="min-w-0 flex-1">
                  <p className="sig-num text-lg font-semibold">
                    {latest.systolic && latest.diastolic ? `${latest.systolic}/${latest.diastolic}` : '--/--'}{' '}
                    <span className="text-xs font-normal text-muted-foreground">mmHg</span>
                  </p>
                  <p className="text-xs text-muted-foreground">血压</p>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="sig-num text-lg font-semibold">
                    {latest.heart_rate ?? '--'} <span className="text-xs font-normal text-muted-foreground">次/分</span>
                  </p>
                  <p className="text-xs text-muted-foreground">心率</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                上次打卡{' '}
                {new Date(latest.created_at).toLocaleString('zh-CN', {
                  month: 'numeric',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">还没有打卡记录，花一分钟记录今天的状态吧</p>
          )}
          <Button asChild className="w-full rounded-2xl">
            <Link to="/patient/checkin">{latest ? '再次打卡' : '去打卡'}</Link>
          </Button>
        </CardContent>
      </Card>

      {/* 快捷入口 2×2 */}
      <div className="grid grid-cols-2 gap-3">
        {QUICK_LINKS.map((q) => (
          <Link
            key={q.to}
            to={q.to}
            className="flex flex-col gap-1.5 rounded-2xl border border-border bg-card p-4 transition-shadow hover:shadow-card"
          >
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary/10">
              <q.icon className="h-5 w-5 text-primary" />
            </span>
            <span className="text-sm font-medium">{q.label}</span>
            <span className="text-xs text-muted-foreground">{q.desc}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
export default DashboardPage;
