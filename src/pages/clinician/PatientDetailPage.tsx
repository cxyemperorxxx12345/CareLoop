// 患者 360 视图：时间轴 / 档案 / 用药 / 随访 / 体征 / 事件 六页签，一次拉取全部数据

import { ArrowLeft, FileText, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { toast } from 'sonner';
import { CareRiskCard } from '@/components/common/CareRiskCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { supabase } from '@/db/supabase';
import { clinicianApi, getCareRiskInputs } from '@/lib/api';
import { type BaselineMetric, loadBaselines } from '@/lib/baseline';
import { type CareRiskResult, computeCareRisk } from '@/lib/carerisk';
import { cn } from '@/lib/utils';

// 与数据库真实列名一致的本地行类型
interface PatientRow {
  id: string;
  name: string;
  gender: string | null;
  age: number | null;
  phone: string | null;
  emergency_contact: string | null;
  emergency_contact_phone: string | null;
  diagnosis: string | null;
  history: string | null;
  allergy: string | null;
  surgery: string | null;
  instructions: string | null;
  department: string | null;
  discharge_date: string;
  risk_level: string;
}
interface PlanRow { id: string; medicine_name: string; spec: string | null; dosage: string | null; frequency: string | null; slots: number[] | null; note: string | null; }
interface LogRow { plan_id: string; log_date: string; slot: number; action: 'taken' | 'snoozed' | 'skipped'; }
interface FollowupRow { id: string; title: string; category: string; due_date: string; detail: string | null; done: boolean; }
interface CheckinRow { id: string; created_at: string; systolic: number | null; diastolic: number | null; heart_rate: number | null; temperature: number | null; note?: string | null; }
interface SymptomRow { id: string; chief_complaint: string; level: string; advice: string | null; created_at: string; }
interface AlertRow { id: string; level: 'yellow' | 'red'; source: 'triage' | 'medication' | 'checkin' | 'manual'; detail: string | null; status: 'open' | 'resolved'; created_at: string; action?: string | null; resolution_note?: string | null; family_action?: 'dosed' | 'contacted' | 'escalate' | null; family_responded_at?: string | null; }
interface MessageRow { id: string; type: string; title: string; content: string | null; created_at: string; }

interface Detail {
  patient: PatientRow | null;
  plans: PlanRow[];
  logs7: LogRow[];
  followups: FollowupRow[];
  checkins30: CheckinRow[];
  symptoms: SymptomRow[];
  alerts: AlertRow[];
  messages: MessageRow[];
}

const SLOT_LABELS = ['早 8:00', '中 12:00', '晚 18:00', '睡前 21:00'];
const ACTION_TEXT = { taken: '已服', snoozed: '稍后', skipped: '跳过' } as const;
const SOURCE_TEXT = { triage: '分诊', medication: '用药', checkin: '打卡', manual: '手动' } as const;
const FAMILY_ACTION_TEXT: Record<string, string> = {
  dosed: '已代为打卡，链路终止',
  contacted: '已联系患者，维持观察',
  escalate: '反馈无响应，转医护回电',
};
const MESSAGE_LABEL: Record<string, string> = {
  triage: '分诊结论已送达',
  followup: '随访问候已送达',
  escalation: '漏服升级通知已送达',
  clinician_reply: '医护回执已送达',
};

// 风险/级别徽章映射（绿黄红统一）
const LEVEL_META: Record<string, { label: string; cls: string }> = {
  green: { label: '绿', cls: 'bg-triage-green-bg text-triage-green' },
  yellow: { label: '黄', cls: 'bg-triage-amber-bg text-triage-amber' },
  red: { label: '红', cls: 'bg-triage-red-bg text-triage-red' },
};

// 打卡圆点颜色：绿=已服 红=跳过 黄=稍后 灰=未打卡
const DOT_CLS: Record<string, string> = {
  taken: 'bg-triage-green-bg border border-triage-green',
  skipped: 'bg-triage-red-bg border border-triage-red',
  snoozed: 'bg-triage-amber-bg border border-triage-amber',
  none: 'bg-muted border border-border',
};

// 相对时间：刚刚 / n分钟前 / n小时前 / n天前 / MM-DD
function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day} 天前`;
  return iso.slice(0, 10);
}

// 近 7 天日期（YYYY-MM-DD，旧→新）
function last7Days(): string[] {
  const days: string[] = [];
  for (let i = 6; i >= 0; i -= 1) {
    days.push(new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10));
  }
  return days;
}

// 数值均值
function avg(nums: number[]): number | null {
  return nums.length > 0 ? Math.round((nums.reduce((s, n) => s + n, 0) / nums.length) * 10) / 10 : null;
}

// ===== 时间轴：把打卡 / 预警 / 家属响应 / 随访 / 医护通知 拧成一条故事线 =====

type TimelineSource = 'vital' | 'alert' | 'family' | 'followup' | 'clinician';
type TimelineTone = 'blue' | 'red' | 'amber' | 'green' | 'neutral';

interface TimelineEvent {
  id: string;
  at: string; // ISO 时间戳或 YYYY-MM-DD
  source: TimelineSource;
  tab: 'vitals' | 'events' | 'followup';
  tone: TimelineTone;
  title: string; // 一句人话摘要
  extra?: string | null; // 次要补充：处置结论 / 留言
  badgeCls?: string; // 徽章配色覆盖（预警按红黄分级）
  statusLabel?: string;
  abnormalLabel?: string;
  abnormal?: boolean;
  planned?: boolean; // 未到期的计划节点
  repeated?: number; // 同一分钟同类事件合并条数
}

const TIMELINE_SOURCE_META: Record<TimelineSource, { label: string; cls: string }> = {
  vital: { label: '体征', cls: 'bg-triage-blue-bg text-triage-blue' },
  alert: { label: '预警', cls: 'bg-triage-red-bg text-triage-red' },
  family: { label: '家属', cls: 'bg-triage-green-bg text-triage-green' },
  followup: { label: '随访', cls: 'bg-primary text-primary-foreground' },
  clinician: { label: '医护', cls: 'bg-secondary text-secondary-foreground' },
};

// 节点圆点与行底色：静态映射，禁止动态拼类名
const TONE_DOT: Record<TimelineTone, string> = {
  blue: 'bg-triage-blue',
  red: 'bg-triage-red',
  amber: 'bg-triage-amber',
  green: 'bg-triage-green',
  neutral: 'bg-muted-foreground',
};
const ABNORMAL_CLS: Record<string, string> = {
  red: 'border-triage-red bg-triage-red-bg',
  amber: 'border-triage-amber bg-triage-amber-bg',
};

// 时间轴节点时间标签：MM-DD HH:mm（本地时区），纯日期只显示 MM-DD
function absTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
  const pad = (n: number) => String(n).padStart(2, '0');
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (iso.length <= 10) return md;
  return `${md} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function evMs(e: TimelineEvent): number {
  const t = new Date(e.at).getTime();
  return Number.isFinite(t) ? t : 0;
}

function buildTimeline(d: Detail): { past: TimelineEvent[]; upcoming: TimelineEvent[] } {
  const evs: TimelineEvent[] = [];

  // ① 体征打卡：数值偏高/偏低时给出人话标签
  for (const c of d.checkins30) {
    const parts: string[] = [];
    const bads: string[] = [];
    if (typeof c.systolic === 'number' && typeof c.diastolic === 'number') {
      parts.push(`血压 ${c.systolic}/${c.diastolic}`);
      if (c.systolic >= 140 || c.diastolic >= 90) bads.push('血压偏高');
      else if (c.systolic < 90) bads.push('血压偏低');
    } else if (typeof c.systolic === 'number') {
      parts.push(`收缩压 ${c.systolic}`);
    }
    if (typeof c.heart_rate === 'number') {
      parts.push(`心率 ${c.heart_rate}`);
      if (c.heart_rate > 100 || c.heart_rate < 60) bads.push('心率异常');
    }
    if (typeof c.temperature === 'number') {
      parts.push(`体温 ${c.temperature}℃`);
      if (c.temperature >= 37.3) bads.push('发热');
    }
    evs.push({
      id: `vital-${c.id}`,
      at: c.created_at,
      source: 'vital',
      tab: 'vitals',
      tone: bads.length > 0 ? 'amber' : 'blue',
      title: parts.length > 0 ? `本人打卡上报 ${parts.join('，')}` : '完成一次体征打卡',
      extra: c.note ?? null,
      abnormal: bads.length > 0,
      abnormalLabel: bads.length > 0 ? bads.join('、') : undefined,
    });
  }

  // ② 预警 + ③ 家属响应（同一条预警的家属响应单独成一节点，体现 L2 环节）
  for (const a of d.alerts) {
    const resolved = a.status === 'resolved';
    evs.push({
      id: `alert-${a.id}`,
      at: a.created_at,
      source: 'alert',
      tab: 'events',
      tone: a.level === 'red' ? 'red' : 'amber',
      badgeCls:
        a.level === 'red' ? 'bg-triage-red-bg text-triage-red' : 'bg-triage-amber-bg text-triage-amber',
      title: a.detail?.trim() || `${SOURCE_TEXT[a.source] ?? a.source}预警`,
      extra: resolved
        ? `处置措施：${a.action?.trim() || '—'}；处置结论：${a.resolution_note?.trim() || '—'}`
        : '尚未处理，等待医护接手',
      statusLabel: resolved ? '已处理' : '未处理',
      abnormal: true,
      abnormalLabel: a.level === 'red' ? '红色预警' : '黄色预警',
    });
    if (a.family_responded_at) {
      evs.push({
        id: `family-${a.id}`,
        at: a.family_responded_at,
        source: 'family',
        tab: 'events',
        tone: 'green',
        title: `家属已响应：${FAMILY_ACTION_TEXT[a.family_action ?? ''] ?? '已处理'}`,
        extra: a.detail?.trim() || null,
      });
    }
  }

  // ④ 随访：已完成 / 逾期 / 未来待办
  const todayStr = new Date().toISOString().slice(0, 10);
  for (const f of d.followups) {
    const overdue = !f.done && f.due_date < todayStr;
    const planned = !f.done && !overdue;
    evs.push({
      id: `fu-${f.id}`,
      at: f.due_date,
      source: 'followup',
      tab: 'followup',
      tone: f.done ? 'green' : overdue ? 'amber' : 'neutral',
      title: f.done ? `随访已完成：${f.title}` : overdue ? `随访逾期未完成：${f.title}` : `随访待办：${f.title}`,
      extra: f.detail ?? null,
      statusLabel: f.done ? '已完成' : overdue ? '逾期未完成' : '待办',
      abnormal: overdue,
      abnormalLabel: overdue ? '已逾期' : undefined,
      planned,
    });
  }

  // ⑤ 医护发出的通知 / 回执：常规用药提醒噪声不入时间轴，同一分钟同类合并
  const seen = new Map<string, TimelineEvent>();
  for (const m of d.messages) {
    if (m.type === 'reminder') continue;
    const key = `${m.type}|${m.title}|${m.created_at.slice(0, 16)}`;
    const prev = seen.get(key);
    if (prev) {
      prev.repeated = (prev.repeated ?? 1) + 1;
      continue;
    }
    const ev: TimelineEvent = {
      id: `msg-${m.id}`,
      at: m.created_at,
      source: 'clinician',
      tab: m.type === 'followup' ? 'followup' : 'events',
      tone: m.type === 'triage' ? 'amber' : 'neutral',
      title: `${MESSAGE_LABEL[m.type] ?? '医护通知已送达'}：${m.title}`,
      extra: m.content?.replace(/\s+/g, ' ').trim() || null,
    };
    seen.set(key, ev);
    evs.push(ev);
  }

  const now = Date.now();
  return {
    past: evs.filter((e) => evMs(e) <= now).sort((x, y) => evMs(y) - evMs(x)),
    upcoming: evs.filter((e) => evMs(e) > now).sort((x, y) => evMs(x) - evMs(y)),
  };
}

// 单个时间轴节点：点击跳到对应页签，形成「总览 → 细节」动线
function TimelineNode({
  e,
  last,
  onJump,
}: {
  e: TimelineEvent;
  last: boolean;
  onJump: (tab: 'vitals' | 'events' | 'followup') => void;
}) {
  const meta = TIMELINE_SOURCE_META[e.source];
  return (
    <li className="flex gap-3 min-w-0">
      <div className="flex flex-col items-center shrink-0 pt-4">
        <span
          className={cn(
            'h-2.5 w-2.5 rounded-full ring-2 ring-card',
            TONE_DOT[e.tone],
            e.planned && 'opacity-60',
          )}
        />
        {!last && <span className="w-px flex-1 bg-border mt-1" />}
      </div>
      <button
        type="button"
        onClick={() => onJump(e.tab)}
        className={cn(
          'min-w-0 flex-1 mb-3 rounded-xl border border-border bg-card p-3 text-left transition-shadow hover:shadow-hover',
          e.abnormal ? ABNORMAL_CLS[e.tone] : null,
          e.planned && 'border-dashed',
        )}
      >
        <div className="flex items-center gap-2 flex-wrap">
          <Badge className={cn('shrink-0', e.badgeCls ?? meta.cls)}>{e.planned ? '计划' : meta.label}</Badge>
          <span className="text-xs text-muted-foreground sig-num">{absTime(e.at)}</span>
          {e.at.length > 10 && <span className="text-xs text-muted-foreground">{relTime(e.at)}</span>}
          {e.statusLabel && (
            <Badge variant="secondary" className="shrink-0">
              {e.statusLabel}
            </Badge>
          )}
          {e.repeated && <span className="text-xs text-muted-foreground sig-num">同类 ×{e.repeated}</span>}
        </div>
        <p className="text-sm mt-1.5 break-words line-clamp-2">{e.title}</p>
        {e.extra && <p className="text-xs text-muted-foreground mt-1 break-words line-clamp-2">{e.extra}</p>}
        {e.abnormalLabel && (
          <Badge className="mt-2 bg-card text-triage-red border border-triage-red">{e.abnormalLabel}</Badge>
        )}
      </button>
    </li>
  );
}

// 家属绑定行（M5：患者 360 已绑定家属区块）
interface FamilyRow {
  id: string;
  family_name: string;
  relation: string;
  phone: string | null;
  status: string;
  authorized_at: string | null;
}

export function PatientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<Detail | null>(null);
  // 六页签当前选中：默认落在时间轴（先看这段时间的故事，再进细节）
  const [tab, setTab] = useState<'vitals' | 'timeline' | 'profile' | 'meds' | 'followup' | 'events'>('timeline');
  // 个人基线（机制①）：患者本人 7 天滚动中位数 + 偏离带
  const [baselines, setBaselines] = useState<BaselineMetric[]>([]);
  // 机制②：本人履约风险预测
  const [careRisk, setCareRisk] = useState<CareRiskResult | null>(null);
  // 已绑定家属（M5：care_relations 照护协同信息）
  const [family, setFamily] = useState<FamilyRow[]>([]);

  // 一次拉取患者 360 数据
  useEffect(() => {
    if (!id) return;
    let alive = true;
    (async () => {
      try {
        const d = await clinicianApi.patientDetail(id);
        if (!alive) return;
        setData({
          patient: (d.patient ?? null) as unknown as PatientRow | null,
          plans: d.plans as unknown as PlanRow[],
          logs7: d.logs7 as unknown as LogRow[],
          followups: d.followups as unknown as FollowupRow[],
          checkins30: d.checkins30 as unknown as CheckinRow[],
          symptoms: d.symptoms as unknown as SymptomRow[],
          alerts: d.alerts as unknown as AlertRow[],
          messages: (d.messages ?? []) as unknown as MessageRow[],
        });
        const { data: rel } = await supabase
          .from('care_relations')
          .select('id, family_name, relation, phone, status, authorized_at')
          .eq('patient_id', id);
        if (alive) setFamily((rel ?? []) as FamilyRow[]);
        // 个人基线：优先 daily_baseline 表；表缺失时用已拉取的打卡记录现算（source='local'）
        const bs = await loadBaselines(id, (d.checkins30 ?? []) as unknown as CheckinRow[]);
        if (alive) setBaselines(bs);
        // 机制②：本人轨迹预测，独立于基线，失败仅降级
        try {
          const cr = await getCareRiskInputs(id, 14);
          if (alive) setCareRisk(computeCareRisk(cr, 14));
        } catch {
          if (alive) setCareRisk(null);
        }
      } catch (e) {
        if (alive) toast.error(e instanceof Error ? e.message : '加载患者详情失败');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [id]);

  // 近 7 天打卡索引：plan|date|slot → action
  const logMap = useMemo(() => {
    const map = new Map<string, LogRow['action']>();
    data?.logs7.forEach((l) => map.set(`${l.plan_id}|${l.log_date}|${l.slot}`, l.action));
    return map;
  }, [data]);

  // 体征图表数据与统计
  const chartData = useMemo(
    () => (data?.checkins30 ?? []).map((c) => ({
      label: c.created_at.slice(5, 10),
      systolic: c.systolic,
      diastolic: c.diastolic,
      temperature: c.temperature,
      heart_rate: c.heart_rate,
    })),
    [data],
  );
  const vitalsStats = useMemo(() => {
    const rows = data?.checkins30 ?? [];
    const num = (pick: (c: CheckinRow) => number | null) =>
      rows.map(pick).filter((v): v is number => typeof v === 'number');
    const temps = num((c) => c.temperature);
    return {
      bpAvg: (() => {
        const sys = avg(num((c) => c.systolic));
        const dia = avg(num((c) => c.diastolic));
        return sys !== null && dia !== null ? `${sys}/${dia}` : '—';
      })(),
      hrAvg: avg(num((c) => c.heart_rate)),
      tempMax: temps.length > 0 ? Math.max(...temps) : null,
      count: rows.length,
    };
  }, [data]);

  const followupDone = data?.followups.filter((f) => f.done).length ?? 0;
  const followupTotal = data?.followups.length ?? 0;

  const days7 = useMemo(last7Days, []);

  // 时间轴：已发生（倒序，最新在上）+ 未到期计划（正序，最近在前）
  const timeline = useMemo(() => (data ? buildTimeline(data) : { past: [], upcoming: [] }), [data]);
  const timelineCount = timeline.past.length + timeline.upcoming.length;
  const abnormalCount = [...timeline.past, ...timeline.upcoming].filter((e) => e.abnormal).length;

  // 加载态骨架
  if (loading) {
    return (
      <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto w-full min-w-0">
        <Skeleton className="h-44 w-full rounded-2xl" />
        <Skeleton className="h-10 w-full rounded-2xl" />
        <Skeleton className="h-96 w-full rounded-2xl" />
      </div>
    );
  }

  // 患者不存在空态
  if (!data?.patient) {
    return (
      <div className="p-4 md:p-6 max-w-6xl mx-auto w-full min-w-0">
        <Card className="rounded-2xl">
          <CardContent className="p-10 flex flex-col items-center gap-4 text-center">
            <p className="text-sm text-muted-foreground">患者不存在或暂无访问权限</p>
            <Button variant="outline" onClick={() => navigate('/clinician/patients')}>
              返回患者列表
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const p = data.patient;
  const risk = LEVEL_META[p.risk_level] ?? LEVEL_META.green;
  const dischargeDays = Math.max(
    0,
    Math.floor((Date.now() - new Date(p.discharge_date).getTime()) / 86400000),
  );
  const emergency = p.emergency_contact
    ? `${p.emergency_contact}${p.emergency_contact_phone ? ` · ${p.emergency_contact_phone}` : ''}`
    : '—';

  // 档案页签字段
  const profileFields = [
    { label: '诊断', value: p.diagnosis },
    { label: '既往史', value: p.history },
    { label: '过敏史', value: p.allergy },
    { label: '手术', value: p.surgery },
    { label: '出院医嘱', value: p.instructions },
    { label: '联系电话', value: p.phone },
  ];

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto w-full min-w-0">
      {/* 顶部患者卡 */}
      <Card className="rounded-2xl">
        <CardContent className="p-4 md:p-6 flex flex-col md:flex-row md:items-start gap-4">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 -ml-2"
                aria-label="返回患者列表"
                onClick={() => navigate('/clinician/patients')}
              >
                <ArrowLeft className="w-4 h-4" />
              </Button>
              <h1 className="text-xl md:text-2xl font-black truncate">{p.name}</h1>
              <Badge className={risk.cls}>{risk.label}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {p.gender ?? '—'} · {p.age ?? '—'} 岁 · {p.department ?? '—'}
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">诊断：</span>
              {p.diagnosis ?? '—'}
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>已出院 {dischargeDays} 天</span>
              <span>电话：{p.phone ?? '—'}</span>
              <span>紧急联系人：{emergency}</span>
            </div>
          </div>
          <Button
            className="shrink-0"
            onClick={() => navigate(`/clinician/reports?patientId=${p.id}`)}
          >
            <FileText className="w-4 h-4 mr-1" />
            生成随访报告
          </Button>
        </CardContent>
      </Card>

      {/* 机制②：本人履约风险预测（放置在患者卡与六页签之间） */}
      {careRisk && <CareRiskCard result={careRisk} />}

      {/* 六页签：时间轴在前且默认选中 */}
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as typeof tab)}
        className="w-full min-w-0"
      >
        <TabsList className="grid w-full grid-cols-6 rounded-2xl">
          <TabsTrigger value="timeline">时间轴</TabsTrigger>
          <TabsTrigger value="profile">档案</TabsTrigger>
          <TabsTrigger value="meds">用药</TabsTrigger>
          <TabsTrigger value="followup">随访</TabsTrigger>
          <TabsTrigger value="vitals">体征</TabsTrigger>
          <TabsTrigger value="events">事件</TabsTrigger>
        </TabsList>

        {/* ⓪ 时间轴：出院 → 每日照护 → 异常 → 干预 → 转归 一条故事线 */}
        <TabsContent value="timeline">
          {timelineCount === 0 ? (
            <Card className="rounded-2xl">
              <CardContent className="p-10 flex flex-col items-center gap-2 text-center">
                <p className="text-sm font-medium">这位患者目前还没有任何照护事件</p>
                <p className="text-sm text-muted-foreground">
                  打卡、预警、家属响应、随访安排、医护通知一旦产生，就会按时间自动汇成一条线：<br />
                  出院 → 每日照护 → 异常 → 干预 → 转归。
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 min-w-0">
              <Card className="rounded-2xl lg:col-span-2">
                <CardHeader className="space-y-1">
                  <CardTitle className="text-base">照护时间轴</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    近 30 天共 {timelineCount} 个节点，其中 {abnormalCount} 个异常｜最新在最上，点击任一节点可跳到对应页签看细节
                  </p>
                </CardHeader>
                <CardContent className="p-0 md:p-6 md:pt-0">
                  {timeline.upcoming.length > 0 && (
                    <>
                      <p className="px-0 md:px-0 mb-2 text-xs font-medium text-muted-foreground">接下来要做</p>
                      <ul className="min-w-0">
                        {timeline.upcoming.map((e, i) => (
                          <TimelineNode
                            key={e.id}
                            e={e}
                            last={i === timeline.upcoming.length - 1 && timeline.past.length === 0}
                            onJump={setTab}
                          />
                        ))}
                      </ul>
                      {timeline.past.length > 0 && (
                        <p className="mb-2 mt-1 text-xs font-medium text-muted-foreground">已经发生</p>
                      )}
                    </>
                  )}
                  <ul className="min-w-0">
                    {timeline.past.map((e, i) => (
                      <TimelineNode key={e.id} e={e} last={i === timeline.past.length - 1} onJump={setTab} />
                    ))}
                  </ul>
                </CardContent>
              </Card>

              <Card className="rounded-2xl self-start">
                <CardHeader>
                  <CardTitle className="text-base">这段时间发生了什么</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <p className="text-muted-foreground leading-relaxed">
                    从出院到今天，这位患者的照护链路就一条：<b className="text-foreground">每日打卡 → 出现异常 → 触发预警 → 家属或医护介入 → 转归。</b>
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {(['vital', 'alert', 'family', 'followup', 'clinician'] as TimelineSource[]).map((s) => (
                      <Badge key={s} className={cn('shrink-0', TIMELINE_SOURCE_META[s].cls)}>
                        {TIMELINE_SOURCE_META[s].label}
                      </Badge>
                    ))}
                  </div>
                  <ul className="space-y-1.5 text-xs text-muted-foreground">
                    <li>· 体征：本人上报的血压 / 心率 / 体温，偏离即高亮</li>
                    <li>· 预警：系统按规则触发，红色最急</li>
                    <li>· 家属：家属代处置后链路终止或升级</li>
                    <li>· 医护：升级通知与处理回执已送达本人</li>
                    <li>· 随访：出院后的复诊与康复安排</li>
                  </ul>
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>

        {/* ① 档案 */}
        <TabsContent value="profile">
          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle className="text-base">病历档案</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
                {profileFields.map((f) => (
                  <div key={f.label} className="min-w-0 border-b border-border pb-3">
                    <dt className="text-xs text-muted-foreground">{f.label}</dt>
                    <dd className="text-sm mt-1 whitespace-pre-wrap break-words">{f.value ?? '—'}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>

          {/* 已绑定家属（M5）：照护协同信息，来源 care_relations */}
          <Card className="rounded-2xl">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="h-4 w-4 text-primary" />
                已绑定家属
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {family.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground text-center">
                  暂无家属绑定，漏服升级将跳过 L2 直接转护士站
                </p>
              ) : (
                family.map((f) => (
                  <div key={f.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-border p-3">
                    <p className="text-sm font-bold">{f.family_name}</p>
                    <Badge variant="secondary" className="bg-secondary">{f.relation}</Badge>
                    {f.phone ? <span className="text-sm text-muted-foreground">{f.phone}</span> : null}
                    <Badge
                      variant="secondary"
                      className={
                        f.status === 'ACTIVE'
                          ? 'bg-triage-green-bg text-triage-green'
                          : f.status === 'PENDING'
                            ? 'bg-triage-amber-bg text-triage-amber'
                            : 'bg-muted text-muted-foreground'
                      }
                    >
                      {f.status === 'ACTIVE' ? '已授权' : f.status === 'PENDING' ? '待授权' : '已解除'}
                    </Badge>
                    {f.authorized_at ? (
                      <span className="ml-auto text-xs text-muted-foreground">
                        授权于 {new Date(f.authorized_at).toLocaleDateString('zh-CN')}
                      </span>
                    ) : null}
                  </div>
                ))
              )}
              <p className="text-xs text-muted-foreground">家属可在其端内代打卡并响应 L2 升级任务，来源会标注「家属」</p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ② 用药：在服方案 + 近 7 天按槽打卡矩阵 */}
        <TabsContent value="meds">
          <div className="space-y-4 min-w-0">
            <Card className="rounded-2xl">
              <CardHeader>
                <CardTitle className="text-base">在服方案</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.plans.length === 0 ? (
                  <p className="p-6 text-sm text-muted-foreground text-center">暂无在服用药方案</p>
                ) : (
                  <div className="w-full max-w-full overflow-x-auto bg-card">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="whitespace-nowrap">药名</TableHead>
                          <TableHead className="whitespace-nowrap">规格</TableHead>
                          <TableHead className="whitespace-nowrap">剂量</TableHead>
                          <TableHead className="whitespace-nowrap">频次</TableHead>
                          <TableHead className="whitespace-nowrap">时间槽</TableHead>
                          <TableHead className="whitespace-nowrap">备注</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.plans.map((plan) => (
                          <TableRow key={plan.id}>
                            <TableCell className="whitespace-nowrap font-medium">{plan.medicine_name}</TableCell>
                            <TableCell className="whitespace-nowrap text-muted-foreground">{plan.spec ?? '—'}</TableCell>
                            <TableCell className="whitespace-nowrap text-muted-foreground">{plan.dosage ?? '—'}</TableCell>
                            <TableCell className="whitespace-nowrap text-muted-foreground">{plan.frequency ?? '—'}</TableCell>
                            <TableCell className="whitespace-nowrap">
                              <div className="flex flex-wrap gap-1">
                                {(plan.slots ?? []).map((s) => (
                                  <Badge key={s} variant="secondary">{SLOT_LABELS[s] ?? `槽 ${s}`}</Badge>
                                ))}
                              </div>
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-muted-foreground">{plan.note ?? '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="rounded-2xl">
              <CardHeader>
                <CardTitle className="text-base">近 7 天打卡矩阵</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.plans.length === 0 ? (
                  <p className="p-6 text-sm text-muted-foreground text-center">暂无用药方案</p>
                ) : (
                  <div className="w-full max-w-full overflow-x-auto bg-card">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="whitespace-nowrap">药名</TableHead>
                          {SLOT_LABELS.map((s) => (
                            <TableHead key={s} className="whitespace-nowrap">{s}</TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.plans.map((plan) => (
                          <TableRow key={plan.id}>
                            <TableCell className="whitespace-nowrap font-medium">{plan.medicine_name}</TableCell>
                            {SLOT_LABELS.map((_, slot) => {
                              if (!(plan.slots ?? []).includes(slot)) {
                                return <TableCell key={slot} className="whitespace-nowrap text-muted-foreground">—</TableCell>;
                              }
                              return (
                                <TableCell key={slot} className="whitespace-nowrap">
                                  <div className="flex items-center gap-1">
                                    {days7.map((d) => {
                                      const action = logMap.get(`${plan.id}|${d}|${slot}`);
                                      return (
                                        <span
                                          key={d}
                                          title={`${d.slice(5)} ${action ? ACTION_TEXT[action] : '未打卡'}`}
                                          className={cn('inline-block h-2.5 w-2.5 rounded-full', DOT_CLS[action ?? 'none'])}
                                        />
                                      );
                                    })}
                                  </div>
                                </TableCell>
                              );
                            })}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ③ 随访事项 */}
        <TabsContent value="followup">
          <Card className="rounded-2xl">
            <CardHeader className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-base">随访事项</CardTitle>
                <span className="text-sm text-muted-foreground sig-num">{followupDone}/{followupTotal}</span>
              </div>
              {followupTotal > 0 && (
                <Progress value={followupTotal > 0 ? (followupDone / followupTotal) * 100 : 0} />
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              {data.followups.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">暂无随访事项</p>
              ) : (
                data.followups.map((f) => (
                  <div key={f.id} className="flex items-center gap-3 min-w-0 border-b border-border pb-3 last:border-0 last:pb-0">
                    <span className="text-xs text-muted-foreground sig-num shrink-0 w-12">{f.due_date.slice(5)}</span>
                    <div className="min-w-0 flex-1">
                      <p className={cn('text-sm truncate', f.done && 'line-through text-muted-foreground')}>{f.title}</p>
                      {f.detail && <p className="text-xs text-muted-foreground truncate">{f.detail}</p>}
                    </div>
                    <Badge variant="secondary" className="shrink-0">{f.category}</Badge>
                    <Badge className={f.done ? 'bg-triage-green-bg text-triage-green' : 'bg-muted text-muted-foreground'}>
                      {f.done ? '已完成' : '待办'}
                    </Badge>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ④ 体征（默认）：血压折线 + 体温小图 + 统计卡 */}
        <TabsContent value="vitals">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 min-w-0">
            <div className="md:col-span-2 space-y-4 min-w-0">
              <Card className="rounded-2xl">
                <CardHeader>
                  <div className="flex items-center gap-4 flex-wrap">
                    <CardTitle className="text-base">血压走势（mmHg）</CardTitle>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="h-2 w-4 rounded-full" style={{ background: 'hsl(var(--primary))' }} />
                      收缩压
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="h-2 w-4 rounded-full" style={{ background: 'hsl(var(--sig-rose))' }} />
                      舒张压
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="w-full min-w-0 overflow-hidden">
                  {chartData.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-10">近 30 天暂无打卡记录</p>
                  ) : (
                    <ResponsiveContainer width="100%" height={260}>
                      <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="label" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
                        <YAxis tick={{ fontSize: 12 }} tickLine={false} axisLine={false} width={44} domain={['auto', 'auto']} />
                        <Tooltip />
                        {/* 机制①：叠加个人基线带（中线 + 偏离带），无基线时自动隐藏 */}
                        {baselines.find((b) => b.metric === 'systolic') ? (() => {
                          const s = baselines.find((b) => b.metric === 'systolic')!;
                          return (
                            <>
                              <ReferenceArea y1={s.bandLow} y2={s.bandHigh} fill="hsl(var(--primary))" fillOpacity={0.08} ifOverflow="extendDomain" />
                              <ReferenceLine y={s.median} stroke="hsl(var(--primary))" strokeDasharray="4 4" strokeOpacity={0.5} ifOverflow="extendDomain" />
                            </>
                          );
                        })() : null}
                        <Line type="monotone" dataKey="systolic" name="收缩压" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="diastolic" name="舒张压" stroke="hsl(var(--sig-rose))" strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                  {/* 基线带来源标注：现算口径需与"已生成的个人基线"区分开 */}
                  {baselines.find((b) => b.metric === 'systolic' && b.source === 'local') ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      基线带基于近 {baselines.find((b) => b.metric === 'systolic')!.sampleDays} 天本人记录现算（个人基线尚未生成）
                    </p>
                  ) : null}
                </CardContent>
              </Card>

              <Card className="rounded-2xl">
                <CardHeader>
                  <div className="flex items-center gap-4 flex-wrap">
                    <CardTitle className="text-base">体温走势（℃）</CardTitle>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="h-2 w-4 rounded-full" style={{ background: 'hsl(var(--triage-amber))' }} />
                      体温
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="w-full min-w-0 overflow-hidden">
                  {chartData.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-10">近 30 天暂无打卡记录</p>
                  ) : (
                    <ResponsiveContainer width="100%" height={200}>
                      <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="label" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
                        <YAxis tick={{ fontSize: 12 }} tickLine={false} axisLine={false} width={44} domain={['auto', 'auto']} />
                        <Tooltip />
                        <Line type="monotone" dataKey="temperature" name="体温" stroke="hsl(var(--triage-amber))" strokeWidth={2} dot={false} connectNulls />
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* 体征统计卡 */}
            <Card className="rounded-2xl self-start">
              <CardHeader>
                <CardTitle className="text-base">体征统计（近 30 天）</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {[
                  { label: '血压均值', value: vitalsStats.bpAvg, unit: 'mmHg' },
                  { label: '心率均值', value: vitalsStats.hrAvg !== null ? vitalsStats.hrAvg : '—', unit: '次/分' },
                  { label: '体温最高', value: vitalsStats.tempMax !== null ? vitalsStats.tempMax : '—', unit: '℃' },
                  { label: '记录条数', value: vitalsStats.count, unit: '条' },
                ].map((s) => (
                  <div key={s.label} className="min-w-0 border-b border-border pb-3 last:border-0 last:pb-0">
                    <p className="text-xs text-muted-foreground">{s.label}</p>
                    <p className="text-lg font-black sig-num mt-0.5">
                      {s.value}
                      {s.unit && <span className="text-xs font-normal text-muted-foreground ml-1">{s.unit}</span>}
                    </p>
                  </div>
                ))}
                {/* 机制①：个人基线面板（近 7 天滚动中位数 + 偏离带）*/}
                {baselines.length > 0 ? (() => {
                  // 本地现算时标注口径与样本天数，避免与已生成的个人基线混淆
                  const local = baselines.find((b) => b.source === 'local');
                  return (
                  <div className="border-t border-border pt-3 space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">个人基线（近 7 天滚动）</p>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs sig-num">
                      {baselines.map((b) => (
                        <span key={b.metric}>
                          {({ systolic: '收缩压', diastolic: '舒张压', heart_rate: '心率', temperature: '体温', blood_glucose: '血糖' } as Record<string, string>)[b.metric] ?? b.metric}：<b>{b.median}</b>（带 {b.bandLow}–{b.bandHigh}）
                        </span>
                      ))}
                    </div>
                    <p className="text-[11px] text-muted-foreground">我们不盯达标线，我们盯偏离——分级参考他自己过去 7 天的轨道。</p>
                    {local ? (
                      <p className="text-[11px] text-muted-foreground">
                        基于近 {local.sampleDays} 天本人记录现算（个人基线尚未生成）
                      </p>
                    ) : null}
                  </div>
                  );
                })() : null}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ⑤ 事件：预警时间线 + 症状自评 */}
        <TabsContent value="events">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 min-w-0">
            <Card className="rounded-2xl">
              <CardHeader>
                <CardTitle className="text-base">预警时间线</CardTitle>
              </CardHeader>
              <CardContent>
                {data.alerts.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">近 30 天暂无预警</p>
                ) : (
                  <div className="min-w-0">
                    {data.alerts.map((a, i) => {
                      const level = LEVEL_META[a.level] ?? LEVEL_META.yellow;
                      return (
                        <div key={a.id} className="flex gap-3 min-w-0">
                          <div className="flex flex-col items-center shrink-0">
                            <span
                              className={cn(
                                'mt-1.5 h-2.5 w-2.5 rounded-full',
                                a.level === 'red' ? 'bg-triage-red' : 'bg-triage-amber',
                              )}
                            />
                            {i < data.alerts.length - 1 && <span className="w-px flex-1 bg-border" />}
                          </div>
                          <div className="min-w-0 flex-1 pb-4">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge className={level.cls}>{level.label}</Badge>
                              <span className="text-xs text-muted-foreground">{SOURCE_TEXT[a.source] ?? a.source}</span>
                              <span className="text-xs text-muted-foreground">{relTime(a.created_at)}</span>
                              <Badge variant={a.status === 'open' ? 'destructive' : 'secondary'}>
                                {a.status === 'open' ? '未处理' : '已处理'}
                              </Badge>
                            </div>
                            <p className="text-sm mt-1.5 break-words">{a.detail ?? '—'}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="rounded-2xl">
              <CardHeader>
                <CardTitle className="text-base">症状自评</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.symptoms.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">近 30 天暂无症状上报</p>
                ) : (
                  data.symptoms.map((s) => {
                    const level = LEVEL_META[s.level];
                    return (
                      <div key={s.id} className="flex items-start gap-3 min-w-0 border-b border-border pb-3 last:border-0 last:pb-0">
                        <Badge className={level ? level.cls : 'bg-muted text-muted-foreground'}>
                          {level ? level.label : s.level}
                        </Badge>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm break-words">{s.chief_complaint}</p>
                          {s.advice && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2 break-words">{s.advice}</p>}
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">{relTime(s.created_at)}</span>
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default PatientDetailPage;
