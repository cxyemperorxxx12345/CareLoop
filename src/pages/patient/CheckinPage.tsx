// 健康打卡：每日体征记录 + 异常即时校验 + 近14天趋势图
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, CalendarCheck2, TriangleAlert } from 'lucide-react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ErrorState, RefreshButton } from '@/components/common/AsyncState';
import { useRefetchOnFocus } from '@/hooks/use-refetch-on-focus';
import { supabase } from '@/db/supabase';
import { getMyPatient, patientApi } from '@/lib/api';

interface CheckinRow {
  systolic: number | null;
  diastolic: number | null;
  heart_rate: number | null;
  created_at: string;
}

interface ChartPoint {
  date: string;
  systolic: number | null;
  diastolic: number | null;
  heart_rate: number | null;
}

// 字符串转数字，空值/非法返回 null
function num(v: string): number | null {
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

/**
 * 体征合理区间表：集中管理，便于后续按临床口径统一调整。
 * 未填写（null）一律放行，保持「可留空」语义，只在填了值时做区间校验。
 */
const VITAL_RANGES = {
  heart_rate: { min: 30, max: 200, label: '心率', unit: '次/分' },
  temperature: { min: 33, max: 42, label: '体温', unit: '℃' },
  systolic: { min: 60, max: 260, label: '收缩压', unit: 'mmHg' },
  diastolic: { min: 30, max: 180, label: '舒张压', unit: 'mmHg' },
  // 任务包未指定，取值待确认：血糖（mmol/L）保守取 2.0–30.0
  glucose: { min: 2, max: 30, label: '血糖', unit: 'mmol/L' },
  // 任务包未指定，取值待确认：体重（kg）保守取 20–200
  weight: { min: 20, max: 200, label: '体重', unit: 'kg' },
} as const;

type VitalRangeKey = keyof typeof VITAL_RANGES;

/** 提交前统一校验：返回第一条不合规提示（温和归因式文案），全部合规返回 null */
function findVitalRangeIssue(values: Record<VitalRangeKey, number | null>): string | null {
  for (const key of Object.keys(VITAL_RANGES) as VitalRangeKey[]) {
    const v = values[key];
    if (v === null) continue; // 未填写：可留空，不校验
    const { min, max, label, unit } = VITAL_RANGES[key];
    if (v < min || v > max) {
      return `${label}一般在 ${min}–${max} ${unit}之间，您填的是 ${v}，麻烦再核对一下～`;
    }
  }
  return null;
}

/**
 * 日粒度幂等写入当日体征：
 * 1) 优先走后端 RPC `upsert_daily_checkin`（迁移 00014，按 created_at::date 当日唯一快照）；
 * 2) 若后端尚未部署该函数（PGRST202 / 404），退化为客户端兜底：
 *    按本机当天 00:00–次日 00:00 查当日记录，有则 UPDATE、无则 INSERT，
 *    同样保证同一天只有一条快照，绝不裸 insert 造成堆积。
 * 兜底只在「函数不存在」时触发；RPC 的其他错误照实返回，避免静默双写。
 */
async function submitDailyCheckin(args: {
  patientId: string;
  systolic: number | null;
  diastolic: number | null;
  heart_rate: number | null;
  temperature: number | null;
  blood_glucose: number | null;
  weight: number | null;
  pain_score: number;
  note: string | null;
}): Promise<{ error: { message: string } | null }> {
  const payload = {
    patient_id: args.patientId,
    systolic: args.systolic,
    diastolic: args.diastolic,
    heart_rate: args.heart_rate,
    temperature: args.temperature,
    blood_glucose: args.blood_glucose,
    weight: args.weight,
    pain_score: args.pain_score,
    note: args.note,
  };

  // 1) RPC 优先
  const rpc = await supabase.rpc('upsert_daily_checkin', {
    p_patient_id: args.patientId,
    p_systolic: args.systolic,
    p_diastolic: args.diastolic,
    p_heart_rate: args.heart_rate,
    p_temperature: args.temperature,
    p_blood_glucose: args.blood_glucose,
    p_weight: args.weight,
    p_pain_score: args.pain_score,
    p_note: args.note,
    p_created_at: new Date().toISOString(),
  });
  if (!rpc.error) return { error: null };
  const code = (rpc.error as { code?: string }).code;
  if (code !== 'PGRST202' && code !== '404') return { error: rpc.error };

  // 2) 客户端日粒度兜底（后端未部署 upsert_daily_checkin 时）
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  const { data: existing, error: selErr } = await supabase
    .from('checkins')
    .select('id')
    .eq('patient_id', args.patientId)
    .gte('created_at', dayStart.toISOString())
    .lt('created_at', dayEnd.toISOString())
    .order('created_at', { ascending: false })
    .limit(1);
  if (selErr) return { error: selErr };

  if (existing && existing.length > 0) {
    const { error: updErr } = await supabase.from('checkins').update(payload).eq('id', existing[0].id);
    return { error: updErr };
  }
  const { error: insErr } = await supabase.from('checkins').insert(payload);
  return { error: insErr };
}

export function CheckinPage() {
  const navigate = useNavigate();
  const [patient, setPatient] = useState<{ id: string } | null>(null);
  const [systolic, setSystolic] = useState('');
  const [diastolic, setDiastolic] = useState('');
  const [heartRate, setHeartRate] = useState('');
  const [temperature, setTemperature] = useState('');
  const [glucose, setGlucose] = useState('');
  const [weight, setWeight] = useState('');
  const [pain, setPain] = useState(0);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [chart, setChart] = useState<ChartPoint[]>([]);
  const [chartStatus, setChartStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [chartRefreshing, setChartRefreshing] = useState(false);

  // 体征即时校验：体温 >37.3 或血压 ≥140/90 黄色提示；≥39 或 ≥180 红色危险
  const tempVal = num(temperature);
  const sysVal = num(systolic);
  const diaVal = num(diastolic);
  const warnVital = (tempVal !== null && tempVal > 37.3) || (sysVal !== null && sysVal >= 140) || (diaVal !== null && diaVal >= 90);
  const dangerVital = (tempVal !== null && tempVal >= 39) || (sysVal !== null && sysVal >= 180);

  // 近 14 天趋势：按天聚合，同一天取最后一条
  const loadChart = useCallback(
    async (pid: string, isRefresh = false) => {
      if (isRefresh) setChartRefreshing(true);
      setChartStatus('loading');
      try {
        const rows = (await patientApi.checkinHistory(pid, 14)) as CheckinRow[];
        const byDay = new Map<string, ChartPoint>();
        for (const r of rows) {
          const date = r.created_at.slice(5, 10);
          byDay.set(date, { date, systolic: r.systolic, diastolic: r.diastolic, heart_rate: r.heart_rate });
        }
        setChart(Array.from(byDay.values()));
        setChartStatus('ready');
      } catch {
        setChartStatus('error');
      } finally {
        if (isRefresh) setChartRefreshing(false);
      }
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const p = await getMyPatient();
        if (!alive) return;
        setPatient(p);
        if (p) await loadChart((p as { id: string }).id);
        else setChartStatus('ready'); // 无档案：趋势区显示空态而非骨架
      } catch {
        // 取患者档案失败不影响打卡表单；趋势区保留当前态
      }
    })();
    return () => {
      alive = false;
    };
  }, [loadChart]);

  // 回到前台自动刷新趋势（节流 15s）
  useRefetchOnFocus(() => {
    if (patient) void loadChart(patient.id, true);
  });

  const doSubmit = async () => {
    if (!patient || submitting) return;
    // 提交入口统一做区间校验，多个字段越界只提示第一条
    const rangeIssue = findVitalRangeIssue({
      heart_rate: num(heartRate),
      temperature: tempVal,
      systolic: sysVal,
      diastolic: diaVal,
      glucose: num(glucose),
      weight: num(weight),
    });
    if (rangeIssue) {
      toast.error(rangeIssue);
      return;
    }
    setSubmitting(true);
    try {
      // 日粒度幂等写入：同一天重复打卡覆盖当日快照（RPC 优先，未部署时客户端兜底）
      const { error } = await submitDailyCheckin({
        patientId: patient.id,
        systolic: sysVal,
        diastolic: diaVal,
        heart_rate: num(heartRate),
        temperature: tempVal,
        blood_glucose: num(glucose),
        weight: num(weight),
        pain_score: pain,
        note: note.trim() || null,
      });
      if (error) throw error;
      toast.success('打卡成功');
      setSystolic('');
      setDiastolic('');
      setHeartRate('');
      setTemperature('');
      setGlucose('');
      setWeight('');
      setPain(0);
      setNote('');
      await loadChart(patient.id);
    } catch {
      toast.error('打卡失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmitClick = () => {
    // 危险指标先弹确认，可选择跳转症状自查或继续提交
    if (dangerVital) setConfirmOpen(true);
    else doSubmit();
  };

  const todayLabel = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });

  return (
    <div className="space-y-4 p-4">
      <div className="pt-2">
        <h1 className="text-2xl font-bold">健康打卡</h1>
        <p className="mt-1 text-sm text-muted-foreground">今天是 {todayLabel}</p>
      </div>

      {!patient ? (
        <Card className="rounded-2xl">
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">还没有找到您的患者档案，暂时无法打卡。</p>
          </CardContent>
        </Card>
      ) : (
        <Card className="rounded-2xl">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarCheck2 className="h-4 w-4 shrink-0 text-primary" />
              记录今日体征
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="sys">收缩压（mmHg）</Label>
                <Input id="sys" type="number" inputMode="numeric" className="h-12 rounded-xl px-3 text-lg sig-num" placeholder="120" value={systolic} onChange={(e) => setSystolic(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dia">舒张压（mmHg）</Label>
                <Input id="dia" type="number" inputMode="numeric" className="h-12 rounded-xl px-3 text-lg sig-num" placeholder="80" value={diastolic} onChange={(e) => setDiastolic(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="hr">心率（次/分）</Label>
                <Input id="hr" type="number" inputMode="numeric" className="h-12 rounded-xl px-3 text-lg sig-num" placeholder="72" value={heartRate} onChange={(e) => setHeartRate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="temp">体温（°C）</Label>
                <Input id="temp" type="number" inputMode="decimal" className="h-12 rounded-xl px-3 text-lg sig-num" placeholder="36.5" value={temperature} onChange={(e) => setTemperature(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="glu">血糖（mmol/L）</Label>
                <Input id="glu" type="number" inputMode="decimal" className="h-12 rounded-xl px-3 text-lg sig-num" placeholder="5.6" value={glucose} onChange={(e) => setGlucose(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="weight">体重（kg）</Label>
                <Input id="weight" type="number" inputMode="decimal" className="h-12 rounded-xl px-3 text-lg sig-num" placeholder="60" value={weight} onChange={(e) => setWeight(e.target.value)} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>
                疼痛评分（<span className="sig-num">{pain}</span>/10）
              </Label>
              <Slider value={[pain]} onValueChange={(v) => setPain(v[0] ?? 0)} min={0} max={10} step={1} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="note">备注（选填）</Label>
              <Textarea
                id="note"
                placeholder="今天的睡眠、饮食、不适情况…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="resize-none rounded-2xl text-sm"
              />
            </div>

            {/* 体征即时校验提示 */}
            {dangerVital ? (
              <div className="flex items-start gap-2 rounded-xl bg-triage-red-bg p-3 text-triage-red">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="text-sm">体温或收缩压已达危险范围，建议先完成症状自查或立即就医。</p>
              </div>
            ) : warnVital ? (
              <div className="flex items-start gap-2 rounded-xl bg-triage-amber-bg p-3 text-triage-amber">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="text-sm">体温或血压偏高，请注意休息并持续观察。</p>
              </div>
            ) : null}

            <Button type="button" className="h-12 w-full rounded-xl text-[15px]" disabled={submitting} onClick={onSubmitClick}>
              {submitting ? '提交中…' : '完成打卡'}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* 近 14 天趋势 */}
      <Card className="rounded-2xl">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <CardTitle className="flex min-w-0 flex-1 items-center gap-2 text-base">
              <Activity className="h-4 w-4 shrink-0 text-primary" />
              近 14 天趋势
            </CardTitle>
            {patient && <RefreshButton onClick={() => void loadChart(patient.id, true)} spinning={chartRefreshing} />}
          </div>
        </CardHeader>
        <CardContent>
          {chartStatus === 'error' ? (
            <ErrorState
              message="趋势加载失败，不妨点右下角刷新试试"
              onRetry={patient ? () => void loadChart(patient.id) : undefined}
            />
          ) : chart.length === 0 ? (
            chartStatus === 'loading' ? (
              <Skeleton className="h-60 w-full rounded-2xl" />
            ) : (
              <p className="text-sm text-muted-foreground">近 14 天还没有打卡记录，完成第一次打卡后，这里会显示您的体征变化趋势。</p>
            )
          ) : (
            <div className="w-full min-w-0 overflow-hidden">
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={chart} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="date" tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={{ stroke: 'hsl(var(--border))' }} />
                  <YAxis tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} width={44} />
                  <Tooltip
                    contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 12, fontSize: 12 }}
                    labelStyle={{ color: 'hsl(var(--foreground))' }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="systolic" name="收缩压" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="diastolic" name="舒张压" stroke="hsl(var(--sig-rose))" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="heart_rate" name="心率" stroke="hsl(var(--triage-amber))" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 危险指标确认弹窗 */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg">
          <DialogHeader>
            <DialogTitle>指标异常，建议先完成症状自查</DialogTitle>
            <DialogDescription>
              您填写的体温或血压已达到危险范围。为了您的安全，建议先完成一次症状自查，智能分诊会给出更合适的处置建议。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:flex-col">
            <Button
              type="button"
              className="w-full rounded-2xl"
              onClick={() => {
                setConfirmOpen(false);
                navigate('/patient/symptom');
              }}
            >
              去症状自查
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full rounded-2xl"
              onClick={() => {
                setConfirmOpen(false);
                doSubmit();
              }}
            >
              继续提交打卡
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
export default CheckinPage;
