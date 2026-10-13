import { businessDate } from '@/lib/business-date';
// 医护工作台概览：4 指标卡（大字号）+ 待办列表（红色优先，按严重度+时间排序）
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  CalendarClock,
  ChevronRight,
  FileWarning,
  HeartPulse,
  Users,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/db/supabase';
import { useRealtimeSync } from '@/hooks/use-realtime-sync';
import type { SyncEntity } from '@/lib/sync-bus';

// 跨端同步：工作台指标数据来源（预警/打卡/消息/今日依从/随访），宁可多订阅
const SYNC_ENTITIES: SyncEntity[] = [
  'alerts',
  'checkins',
  'messages',
  'medication_logs',
  'followups',
];

interface PatientRow {
  id: string;
  name: string;
  risk_level: string | null;
}

interface AlertRow {
  id: string;
  patient_id: string;
  level: 'red' | 'yellow';
  source: string | null;
  detail: string | null;
  status: string;
  created_at: string;
}

interface FollowupRow {
  id: string;
  patient_id: string;
  title: string;
  due_date: string;
  done: boolean;
}

// 风险徽章：颜色 + 图标 + 文字 三重编码
const RISK_META: Record<string, { label: string; cls: string; icon: typeof HeartPulse }> = {
  red: { label: '高危', cls: 'bg-triage-red-bg text-triage-red', icon: FileWarning },
  yellow: { label: '关注', cls: 'bg-triage-amber-bg text-triage-amber', icon: FileWarning },
  green: { label: '正常', cls: 'bg-triage-green-bg text-triage-green', icon: HeartPulse },
};

const SOURCE_LABEL: Record<string, string> = {
  triage: '症状分诊',
  checkin: '健康打卡',
  medication: '依从性预警',
  system: '系统',
};

function relativeTime(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

function todayStr(): string {
  return businessDate();
}

export function ClinicianDashboardPage() {
  const [loading, setLoading] = useState(true);
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [openAlerts, setOpenAlerts] = useState<AlertRow[]>([]);
  const [todayFollowups, setTodayFollowups] = useState<FollowupRow[]>([]);
  const [adherence, setAdherence] = useState<number | null>(null);

  // 拉取工作台四类指标（挂载加载与跨端实时刷新共用）；返回取消函数防卸载后 setState
  const load = useCallback(() => {
    let alive = true;
    void (async () => {
      try {
        const today = todayStr();
        // 并行拉取四类数据
        const [pRes, aRes, fRes, mlRes, mpRes] = await Promise.all([
          // 软隐藏：统计口径排除残留测试档案
          supabase.from('patients').select('id, name, risk_level').eq('is_hidden', false),
          supabase.from('alerts').select('id, patient_id, level, source, detail, status, created_at').eq('status', 'open'),
          supabase.from('followup_items').select('id, patient_id, title, due_date, done').eq('done', false),
          // 今日用药打卡：依从率 = 今日已服 / 今日总应服
          supabase.from('medication_logs').select('action').gte('log_date', today),
          supabase.from('medication_plans').select('id, medicine_name, slots'),
        ]);
        if (!alive) return;
        setPatients(pRes.data ?? []);
        setOpenAlerts((aRes.data ?? []) as AlertRow[]);
        setTodayFollowups((fRes.data ?? []).filter((f) => f.due_date?.slice(0, 10) === today));
        // 依从率：今日应服次数（活跃计划 × 时段）
        const plans = (mpRes.data ?? []).filter((p) => Array.isArray(p.slots));
        const totalDoses = plans.reduce((n, p) => n + ((p.slots as string[]).length ?? 0), 0);
        const taken = (mlRes.data ?? []).filter((l) => l.action === 'taken').length;
        setAdherence(totalDoses > 0 ? Math.round((taken / totalDoses) * 100) : null);
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

  // 跨端实时刷新：患者打卡、家属代打卡、医护处理预警后，指标卡与待办自动更新（静默，不回骨架）
  useRealtimeSync(
    () => {
      load();
    },
    SYNC_ENTITIES,
  );

  // 待办排序：红色优先，同级按时间倒序
  const sortedAlerts = [...openAlerts].sort((a, b) => {
    if (a.level !== b.level) return a.level === 'red' ? -1 : 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
  const patientName = (pid: string) => patients.find((p) => p.id === pid)?.name ?? '未知患者';

  if (loading) {
    return (
      <div className="p-6 space-y-6 max-w-6xl mx-auto">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold">工作台</h1>
          <p className="text-sm text-muted-foreground mt-0.5">今日全景概览，红色待办优先处理</p>
        </div>
      </div>

      {/* 4 指标卡（C1：数值 28-32px） */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="rounded-2xl">
          <CardContent className="p-4 md:p-5">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Users className="h-4 w-4" />
              <p className="text-sm">在管患者</p>
            </div>
            <p className="sig-num mt-2 text-[28px] leading-none font-bold text-foreground">{patients.length}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              高危 {patients.filter((p) => p.risk_level === 'red').length} · 关注{' '}
              {patients.filter((p) => p.risk_level === 'yellow').length}
            </p>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardContent className="p-4 md:p-5">
            <div className="flex items-center gap-2 text-muted-foreground">
              <CalendarClock className="h-4 w-4" />
              <p className="text-sm">今日待随访</p>
            </div>
            <p className="sig-num mt-2 text-[28px] leading-none font-bold text-foreground">{todayFollowups.length}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {todayFollowups.length > 0 ? '点击下方待办处理' : '今日无到期随访'}
            </p>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardContent className="p-4 md:p-5">
            <div className="flex items-center gap-2 text-muted-foreground">
              <FileWarning className="h-4 w-4" />
              <p className="text-sm">未处理预警</p>
            </div>
            <p
              className={`sig-num mt-2 text-[28px] leading-none font-bold ${
                openAlerts.length > 0 ? 'text-triage-red' : 'text-foreground'
              }`}
            >
              {openAlerts.length}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              红 {openAlerts.filter((a) => a.level === 'red').length} · 黄{' '}
              {openAlerts.filter((a) => a.level === 'yellow').length}
            </p>
          </CardContent>
        </Card>
        <Card className="rounded-2xl">
          <CardContent className="p-4 md:p-5">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Activity className="h-4 w-4" />
              <p className="text-sm">今日依从率</p>
            </div>
            <p className="sig-num mt-2 text-[28px] leading-none font-bold text-foreground">
              {adherence === null ? '--' : `${adherence}%`}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">全院患者今日服药完成度</p>
          </CardContent>
        </Card>
      </div>

      {/* 待办列表（红色排最前，按严重度+时间排序） */}
      <Card className="rounded-2xl">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileWarning className="h-4 w-4 shrink-0 text-primary" />
            预警待办
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              共 {sortedAlerts.length} 条 · 红色优先
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {sortedAlerts.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-triage-green-bg">
                <HeartPulse className="h-6 w-6 text-triage-green" />
              </span>
              <p className="text-sm text-muted-foreground">太好了，当前没有待处理预警</p>
            </div>
          ) : (
            sortedAlerts.map((a) => {
              const meta = RISK_META[a.level] ?? RISK_META.yellow;
              const Icon = meta.icon;
              return (
                <Link
                  key={a.id}
                  to="/clinician/alerts"
                  className={`flex items-center gap-3 rounded-2xl border p-3.5 transition-shadow hover:shadow-card ${
                    a.level === 'red' ? 'border-triage-red/30 bg-triage-red-bg/40' : 'border-border bg-card'
                  }`}
                >
                  <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${meta.cls}`}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-bold">{patientName(a.patient_id)}</p>
                      <Badge variant="secondary" className={meta.cls}>
                        {meta.label}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {SOURCE_LABEL[a.source ?? 'system'] ?? a.source}
                      </Badge>
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{a.detail}</p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(a.created_at)}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </Link>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* 快捷入口 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Button asChild variant="outline" className="h-12 rounded-xl">
          <Link to="/clinician/patients">患者管理</Link>
        </Button>
        <Button asChild variant="outline" className="h-12 rounded-xl">
          <Link to="/clinician/alerts">预警中心</Link>
        </Button>
        <Button asChild variant="outline" className="h-12 rounded-xl">
          <Link to="/clinician/reports">随访报告</Link>
        </Button>
        <Button asChild variant="outline" className="h-12 rounded-xl">
          <Link to="/clinician/knowledge">知识库</Link>
        </Button>
      </div>
    </div>
  );
}

export default ClinicianDashboardPage;
