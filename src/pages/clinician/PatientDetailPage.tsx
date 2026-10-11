// 患者 360 视图：档案 / 用药 / 随访 / 体征 / 事件 五页签，一次拉取全部数据
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, FileText, Users } from 'lucide-react';
import { toast } from 'sonner';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { clinicianApi } from '@/lib/api';
import { supabase } from '@/db/supabase';
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
interface CheckinRow { id: string; created_at: string; systolic: number | null; diastolic: number | null; heart_rate: number | null; temperature: number | null; }
interface SymptomRow { id: string; chief_complaint: string; level: string; advice: string | null; created_at: string; }
interface AlertRow { id: string; level: 'yellow' | 'red'; source: 'triage' | 'medication' | 'checkin' | 'manual'; detail: string | null; status: 'open' | 'resolved'; created_at: string; }

interface Detail {
  patient: PatientRow | null;
  plans: PlanRow[];
  logs7: LogRow[];
  followups: FollowupRow[];
  checkins30: CheckinRow[];
  symptoms: SymptomRow[];
  alerts: AlertRow[];
}

const SLOT_LABELS = ['早 8:00', '中 12:00', '晚 18:00', '睡前 21:00'];
const ACTION_TEXT = { taken: '已服', snoozed: '稍后', skipped: '跳过' } as const;
const SOURCE_TEXT = { triage: '分诊', medication: '用药', checkin: '打卡', manual: '手动' } as const;

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
        });
        const { data: rel } = await supabase
          .from('care_relations')
          .select('id, family_name, relation, phone, status, authorized_at')
          .eq('patient_id', id);
        if (alive) setFamily((rel ?? []) as FamilyRow[]);
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

      {/* 五页签 */}
      <Tabs defaultValue="vitals" className="w-full min-w-0">
        <TabsList className="grid w-full grid-cols-5 rounded-2xl">
          <TabsTrigger value="profile">档案</TabsTrigger>
          <TabsTrigger value="meds">用药</TabsTrigger>
          <TabsTrigger value="followup">随访</TabsTrigger>
          <TabsTrigger value="vitals">体征</TabsTrigger>
          <TabsTrigger value="events">事件</TabsTrigger>
        </TabsList>

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
                        <Line type="monotone" dataKey="systolic" name="收缩压" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="diastolic" name="舒张压" stroke="hsl(var(--sig-rose))" strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  )}
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
