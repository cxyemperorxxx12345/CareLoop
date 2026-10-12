// 家属端首页：照护对象今日状态卡（只读）+ 待我处理升级任务（红色优先）+ 近期随访

import { CalendarHeart, ChevronRight, ClipboardCheck, HeartPulse, LogOut, Pill, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { CareRiskCard } from '@/components/common/CareRiskCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/db/supabase';
import { getCareRiskInputs, getFamilyPatient } from '@/lib/api';
import { type CareRiskResult, computeCareRisk } from '@/lib/carerisk';

const SLOT_LABELS = ['早 8:00', '中 12:00', '晚 18:00', '睡前 21:00'];
const SLOT_HOURS = [8, 12, 18, 21];

interface PatientRow { id: string; name: string; discharge_date: string; risk_level: string | null; }
interface PlanRow { id: string; medicine_name: string; slots: number[] | null; }
interface LogRow { plan_id: string; slot: number; action: string; }
interface FollowupRow { id: string; title: string; due_date: string; done: boolean; }
interface AlertRow { id: string; level: 'red' | 'yellow'; detail: string | null; created_at: string; }

// 风险徽章：颜色 + 图标 + 文字三重编码（家属视角脱敏：只显示等级与关怀提示，不含医护处置内容）
const RISK_VIEW: Record<string, { label: string; cls: string; hint: string }> = {
  red: { label: '需多关注', cls: 'bg-triage-red-bg text-triage-red', hint: '今日有不适记录，请多留意休息与用药' },
  yellow: { label: '指标波动', cls: 'bg-triage-amber-bg text-triage-amber', hint: '近期指标有波动，建议多陪伴观察' },
  green: { label: '状态平稳', cls: 'bg-triage-green-bg text-triage-green', hint: '整体平稳，按时服药即可' },
};

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return '凌晨好';
  if (h < 12) return '早上好';
  if (h < 18) return '下午好';
  return '晚上好';
}

export function FamilyDashboardPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [patient, setPatient] = useState<PatientRow | null>(null);
  const [relation, setRelation] = useState<{ family_name: string; relation: string } | null>(null);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [followups, setFollowups] = useState<FollowupRow[]>([]);
  const [familyAlerts, setFamilyAlerts] = useState<AlertRow[]>([]);
  // 机制②：照护对象履约风险预测（展示层）
  const [careRisk, setCareRisk] = useState<CareRiskResult | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const fp = await getFamilyPatient();
        if (!alive) return;
        if (!fp) {
          setLoading(false);
          return;
        }
        setPatient(fp.patient);
        setRelation({ family_name: fp.family_name, relation: fp.relation });
        const today = new Date().toISOString().slice(0, 10);
        const [pl, lg, fu, al] = await Promise.all([
          supabase.from('medication_plans').select('id, medicine_name, slots').eq('patient_id', fp.patient.id),
          supabase.from('medication_logs').select('plan_id, slot, action').eq('patient_id', fp.patient.id).eq('log_date', today),
          supabase.from('followup_items').select('id, title, due_date, done').eq('patient_id', fp.patient.id).eq('done', false).gte('due_date', today).order('due_date').limit(3),
          supabase.from('alerts').select('id, level, detail, created_at').eq('patient_id', fp.patient.id).eq('assignee_role', 'family').eq('status', 'open'),
        ]);
        if (!alive) return;
        setPlans((pl.data ?? []) as PlanRow[]);
        setLogs((lg.data ?? []) as LogRow[]);
        setFollowups((fu.data ?? []) as FollowupRow[]);
        setFamilyAlerts((al.data ?? []) as AlertRow[]);
        // 机制②：照护对象本人轨迹预测
        try {
          const cr = await getCareRiskInputs(fp.patient.id, 14);
          if (alive) setCareRisk(computeCareRisk(cr, 14));
        } catch {
          if (alive) setCareRisk(null);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="p-4 space-y-4">
        <div className="space-y-2 pt-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Skeleton className="h-44 w-full rounded-2xl" />
        <Skeleton className="h-32 w-full rounded-2xl" />
      </div>
    );
  }

  if (!patient) {
    return (
      <div className="p-4 pt-10">
        <Card className="rounded-2xl">
          <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
            <HeartPulse className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">暂无可照护的患者绑定，请联系患者完成授权。</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // 依从进度：只统计当前时刻已过时段（与患者端口径一致，深夜不出现矛盾数字）
  const now = new Date();
  const elapsedSlots = SLOT_HOURS.map((h, i) => (now.getHours() >= h ? i : -1)).filter((i) => i >= 0);
  const dueDoses = plans.reduce(
    (n, p) => n + (Array.isArray(p.slots) ? p.slots.filter((s) => elapsedSlots.includes(s)).length : 0),
    0,
  );
  const takenDoses = logs.filter((l) => l.action === 'taken' && elapsedSlots.includes(l.slot)).length;
  const percent = dueDoses > 0 ? Math.round((takenDoses / dueDoses) * 100) : 0;

  // 术后天数口径：手术日 = 出院日 - 4（与患者端一致）
  const dischargeDays = Math.max(1, Math.floor((Date.now() - new Date(patient.discharge_date).getTime()) / 86400000) + 1);
  const surgeryDays = dischargeDays + 4;

  // 下一次用药：未打卡且未过时段的最早槽
  const nextDose = (() => {
    for (let i = 0; i < SLOT_HOURS.length; i++) {
      if (now.getHours() >= SLOT_HOURS[i]) continue;
      const med = plans.find(
        (p) => Array.isArray(p.slots) && p.slots.includes(i) && !logs.some((l) => l.plan_id === p.id && l.slot === i && l.action === 'taken'),
      );
      if (med) return { slot: i, name: med.medicine_name };
    }
    return null;
  })();

  const risk = RISK_VIEW[patient.risk_level ?? 'green'] ?? RISK_VIEW.green;
  const sortedAlerts = [...familyAlerts].sort((a, b) =>
    a.level === b.level ? new Date(b.created_at).getTime() - new Date(a.created_at).getTime() : a.level === 'red' ? -1 : 1,
  );
  const todayLabel = now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });

  const handleLogout = async () => {
    try {
      await supabase.auth.signOut();
      toast.success('已退出登录');
      navigate('/login?role=family');
    } catch {
      navigate('/login?role=family');
    }
  };

  return (
    <div className="p-4 space-y-4">
      <div className="pt-2 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted-foreground">{todayLabel}</p>
          <h1 className="mt-1 text-2xl font-bold">{greeting()}，我正在照护 {patient.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {relation ? `${relation.relation}视角，` : ''}以下信息经患者授权可见
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleLogout}
          className="shrink-0 h-9 rounded-xl border-border text-xs text-muted-foreground hover:text-destructive hover:border-destructive/40 gap-1.5"
        >
          <LogOut className="h-3.5 w-3.5" />
          退出
        </Button>
      </div>

      {/* 照护对象今日状态卡（只读镜像） */}
      <Card className="rounded-2xl border-primary/40 bg-primary/5">
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center gap-2">
            <HeartPulse className="h-5 w-5 text-primary shrink-0" />
            <p className="min-w-0 flex-1 text-[15px] font-semibold truncate">
              {patient.name} · 术后第 {surgeryDays} 天 / 出院第 {dischargeDays} 天
            </p>
            <Badge className={`shrink-0 ${risk.cls}`}>{risk.label}</Badge>
          </div>
          <div className="flex items-end justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              今日已服 <span className="sig-num font-semibold text-foreground">{takenDoses}</span> / {dueDoses} 次
            </p>
            <span className="sig-num shrink-0 text-xl font-bold text-primary">{percent}%</span>
          </div>
          <Progress value={percent} />
          {nextDose ? (
            <div className="flex items-center gap-2 rounded-xl bg-background p-3">
              <Pill className="h-5 w-5 text-primary shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">下一次用药：{SLOT_LABELS[nextDose.slot]}</p>
                <p className="mt-0.5 text-[15px] font-semibold truncate">{nextDose.name}</p>
              </div>
            </div>
          ) : (
            <p className="rounded-xl bg-background p-3 text-[15px] font-medium text-triage-green">
              今日各时段用药均已确认
            </p>
          )}
          <p className="text-xs text-muted-foreground">{risk.hint}</p>
        </CardContent>
      </Card>

      {/* 机制②：照护对象履约风险预测 */}
      {careRisk && <CareRiskCard result={careRisk} />}

      {/* 待我处理：升级任务（红色优先） */}
      <Card className="rounded-2xl">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardCheck className="h-4 w-4 shrink-0 text-primary" />
            待我处理
            <span className="ml-auto text-xs font-normal text-muted-foreground">{sortedAlerts.length} 条</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {sortedAlerts.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-triage-green-bg">
                <HeartPulse className="h-6 w-6 text-triage-green" />
              </span>
              <p className="text-sm text-muted-foreground">暂无升级任务，患者按时完成了各项提醒</p>
            </div>
          ) : (
            sortedAlerts.map((a) => (
              <Link
                key={a.id}
                to="/family/tasks"
                className={`flex items-start gap-3 rounded-2xl border p-3.5 transition-shadow hover:shadow-card ${
                  a.level === 'red' ? 'border-triage-red/30 bg-triage-red-bg/40' : 'border-border bg-card'
                }`}
              >
                <ShieldAlert className={`h-5 w-5 shrink-0 ${a.level === 'red' ? 'text-triage-red' : 'text-triage-amber'}`} />
                <p className="min-w-0 flex-1 line-clamp-2 text-[15px] leading-snug">{a.detail}</p>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
              </Link>
            ))
          )}
        </CardContent>
      </Card>

      {/* 近期随访（只读） */}
      <Card className="rounded-2xl">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarHeart className="h-4 w-4 shrink-0 text-primary" />
            近期随访安排
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {followups.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground text-center">暂无待完成的随访安排</p>
          ) : (
            followups.map((f) => {
              const days = Math.ceil((new Date(f.due_date).getTime() - Date.now()) / 86400000);
              return (
                <div key={f.id} className="flex items-center gap-3 rounded-xl border border-border p-3">
                  <p className="min-w-0 flex-1 text-[15px] truncate">{f.title}</p>
                  <Badge variant="secondary" className="shrink-0 bg-triage-blue-bg text-triage-blue">
                    {days <= 0 ? '已到期' : `还有 ${days} 天`}
                  </Badge>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* 快捷入口 */}
      <div className="grid grid-cols-2 gap-3">
        <Button asChild className="h-12 rounded-xl text-[15px]">
          <Link to="/family/medications">代为打卡</Link>
        </Button>
        <Button asChild variant="outline" className="h-12 rounded-xl text-[15px]">
          <Link to="/family/tasks">处理任务</Link>
        </Button>
      </div>
    </div>
  );
}

export default FamilyDashboardPage;
