// 健康打卡：今日建议项置顶 + 其余折叠 + 沿用上次 + 提交后人话反馈 + 近14天趋势图

import { Activity, CalendarCheck2, CheckCircle2, ChevronDown, ChevronUp, History, ListChecks, TriangleAlert } from 'lucide-react';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CartesianGrid, Legend, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { toast } from 'sonner';
import { ErrorState, RefreshButton } from '@/components/common/AsyncState';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/db/supabase';
import { useRefetchOnFocus } from '@/hooks/use-refetch-on-focus';
import { getMyPatient, patientApi } from '@/lib/api';
import { type BaselineMetric, loadBaselines } from '@/lib/baseline';
import {
  type CheckinFieldKey,
  type CheckinSnapshot,
  FIELD_LABEL,
  type FeedbackValues,
  buildCheckinFeedback,
  buildCheckinPlan,
  pickLastCheckin,
} from '@/lib/checkin-plan';

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

interface PatientProfile {
  id: string;
  diagnosis?: string | null;
  surgery?: string | null;
  history?: string | null;
  instructions?: string | null;
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

const EMPTY_VALS: Record<VitalRangeKey, string> = {
  heart_rate: '',
  temperature: '',
  systolic: '',
  diastolic: '',
  glucose: '',
  weight: '',
};

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

// 单值输入项的元信息：血压（两个框）和疼痛评分（滑块）单独渲染
const SINGLE_FIELDS: Partial<Record<CheckinFieldKey, { key: VitalRangeKey; id: string; label: string; placeholder: string; inputMode: 'numeric' | 'decimal' }>> = {
  heart_rate: { key: 'heart_rate', id: 'hr', label: '心率（次/分）', placeholder: '72', inputMode: 'numeric' },
  glucose: { key: 'glucose', id: 'glu', label: '血糖（mmol/L）', placeholder: '5.6', inputMode: 'decimal' },
  temperature: { key: 'temperature', id: 'temp', label: '体温（°C）', placeholder: '36.5', inputMode: 'decimal' },
  weight: { key: 'weight', id: 'weight', label: '体重（kg）', placeholder: '60', inputMode: 'decimal' },
};

function VitalInput({
  id,
  label,
  placeholder,
  inputMode,
  value,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  inputMode: 'numeric' | 'decimal';
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode={inputMode}
        step="0.1"
        className="h-12 rounded-xl px-3 text-lg sig-num"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** 一组体征输入：血压渲染成两个框，疼痛评分渲染成滑块，其余各一个框 */
function FieldGrid({
  fields,
  vals,
  setVal,
  pain,
  setPain,
}: {
  fields: CheckinFieldKey[];
  vals: Record<VitalRangeKey, string>;
  setVal: (k: VitalRangeKey, v: string) => void;
  pain: number;
  setPain: (v: number) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {fields.map((f) => {
        if (f === 'blood_pressure') {
          return (
            <Fragment key="blood_pressure">
              <VitalInput id="sys" label="收缩压（mmHg）" placeholder="120" inputMode="numeric" value={vals.systolic} onChange={(v) => setVal('systolic', v)} />
              <VitalInput id="dia" label="舒张压（mmHg）" placeholder="80" inputMode="numeric" value={vals.diastolic} onChange={(v) => setVal('diastolic', v)} />
            </Fragment>
          );
        }
        if (f === 'pain') {
          return (
            <div key="pain" className="col-span-2 space-y-1.5">
              <Label>
                疼痛评分（<span className="sig-num">{pain}</span>/10）
              </Label>
              <Slider value={[pain]} onValueChange={(v) => setPain(v[0] ?? 0)} min={0} max={10} step={1} />
            </div>
          );
        }
        const meta = SINGLE_FIELDS[f];
        if (!meta) return null;
        const { key, ...rest } = meta;
        return <VitalInput key={f} {...rest} value={vals[key]} onChange={(v) => setVal(key, v)} />;
      })}
    </div>
  );
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
  const [patient, setPatient] = useState<PatientProfile | null>(null);
  const [vals, setVals] = useState<Record<VitalRangeKey, string>>(EMPTY_VALS);
  const [pain, setPain] = useState(0);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [chart, setChart] = useState<ChartPoint[]>([]);
  const [chartStatus, setChartStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [chartRefreshing, setChartRefreshing] = useState(false);
  // 个人基线（机制①）：收缩压 7 天中位数 + 偏离带，用于趋势图叠加参照
  // 表无数据时 loadBaselines 会用本人近 7 天打卡现算（source='local'）
  const [baselines, setBaselines] = useState<BaselineMetric[]>([]);
  const sysBaseline = baselines.find((b) => b.metric === 'systolic') ?? null;
  // 今日建议项：按诊断/术式/既往史/医嘱推导，未取到档案前按「全部建议」渲染，避免闪成空表单
  const [plan, setPlan] = useState(() => buildCheckinPlan([]));
  const [moreOpen, setMoreOpen] = useState(false);
  // 今天之前最近一次打卡：用于「沿用」；昨天没记录时退回更早的一次并标注真实日期
  const [lastCheckin, setLastCheckin] = useState<CheckinSnapshot | null>(null);
  const [carried, setCarried] = useState<{ from: string; names: string[] } | null>(null);
  const [savedFeedback, setSavedFeedback] = useState<string | null>(null);

  // 体征即时校验：体温 >37.3 或血压 ≥140/90 黄色提示；≥39 或 ≥180 红色危险
  const tempVal = num(vals.temperature);
  const sysVal = num(vals.systolic);
  const diaVal = num(vals.diastolic);
  const warnVital = (tempVal !== null && tempVal > 37.3) || (sysVal !== null && sysVal >= 140) || (diaVal !== null && diaVal >= 90);
  const dangerVital = (tempVal !== null && tempVal >= 39) || (sysVal !== null && sysVal >= 180);

  const setVal = (k: VitalRangeKey, v: string) => {
    setVals((prev) => ({ ...prev, [k]: v }));
    setSavedFeedback(null);
  };
  const updatePain = (v: number) => {
    setPain(v);
    setSavedFeedback(null);
  };

  // 近 14 天趋势：按天聚合，同一天取最后一条
  const loadChart = useCallback(
    async (pid: string, isRefresh = false) => {
      if (isRefresh) setChartRefreshing(true);
      setChartStatus('loading');
      let rows: CheckinRow[] = [];
      try {
        rows = (await patientApi.checkinHistory(pid, 14)) as CheckinRow[];
        const byDay = new Map<string, ChartPoint>();
        for (const r of rows) {
          const date = r.created_at.slice(5, 10);
          byDay.set(date, { date, systolic: r.systolic, diastolic: r.diastolic, heart_rate: r.heart_rate });
        }
        setChart(Array.from(byDay.values()));
        setChartStatus('ready');
      } catch {
        setChartStatus('error');
      }
      // 同上一次打卡记录：rows 是完整行，趋势取数成功与否都不影响（失败时 rows 为空）
      setLastCheckin(pickLastCheckin(rows));
      // 个人基线：优先读 daily_baseline 表，表无数据时用刚取到的打卡记录现算；样本不足则无基线带
      try {
        setBaselines(await loadBaselines(pid, rows));
      } catch {
        // 基线取数失败不影响趋势图与打卡
      }
      if (isRefresh) setChartRefreshing(false);
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const p = (await getMyPatient()) as PatientProfile | null;
        if (!alive) return;
        setPatient(p);
        if (p) {
          // 建议项依据：诊断 + 术式 + 既往史 + 医嘱，任一命中即算
          setPlan(buildCheckinPlan([p.diagnosis, p.surgery, p.history, p.instructions]));
          // 趋势与基线同批加载：基线优先取 daily_baseline 表，无表时用本人打卡现算
          await loadChart(p.id);
        } else {
          setChartStatus('ready'); // 无档案：趋势区显示空态而非骨架
        }
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

  /** 沿用上一次记录的数值：只填 UI，并明确提示这是沿用、不是今天新测的 */
  const applyLastCheckin = () => {
    if (!lastCheckin) return;
    const pair: { key: VitalRangeKey; value: number | null; label: string }[] = [
      { key: 'systolic', value: lastCheckin.systolic, label: FIELD_LABEL.blood_pressure },
      { key: 'diastolic', value: lastCheckin.diastolic, label: FIELD_LABEL.blood_pressure },
      { key: 'heart_rate', value: lastCheckin.heart_rate, label: FIELD_LABEL.heart_rate },
      { key: 'temperature', value: lastCheckin.temperature, label: FIELD_LABEL.temperature },
      { key: 'glucose', value: lastCheckin.blood_glucose, label: FIELD_LABEL.glucose },
      { key: 'weight', value: lastCheckin.weight, label: FIELD_LABEL.weight },
    ];
    const next = { ...EMPTY_VALS };
    const names: string[] = [];
    for (const item of pair) {
      if (item.value === null) continue;
      next[item.key] = String(item.value);
      if (!names.includes(item.label)) names.push(item.label);
    }
    setVals(next);
    if (lastCheckin.pain_score !== null) {
      setPain(lastCheckin.pain_score);
      names.push(FIELD_LABEL.pain);
    }
    setCarried({ from: lastCheckin.isYesterday ? '昨天' : lastCheckin.dayLabel, names });
    setSavedFeedback(null);
  };

  const doSubmit = async () => {
    if (!patient || submitting) return;
    // 提交入口统一做区间校验，多个字段越界只提示第一条
    const rangeIssue = findVitalRangeIssue({
      heart_rate: num(vals.heart_rate),
      temperature: tempVal,
      systolic: sysVal,
      diastolic: diaVal,
      glucose: num(vals.glucose),
      weight: num(vals.weight),
    });
    if (rangeIssue) {
      toast.error(rangeIssue);
      return;
    }
    setSubmitting(true);
    // 反馈话术只基于本次真实填写值 + 本人基线，基线不足时自动退化
    const submitted: FeedbackValues = {
      systolic: sysVal,
      diastolic: diaVal,
      heart_rate: num(vals.heart_rate),
      temperature: tempVal,
      glucose: num(vals.glucose),
    };
    try {
      // 日粒度幂等写入：同一天重复打卡覆盖当日快照（RPC 优先，未部署时客户端兜底）
      const { error } = await submitDailyCheckin({
        patientId: patient.id,
        systolic: sysVal,
        diastolic: diaVal,
        heart_rate: num(vals.heart_rate),
        temperature: tempVal,
        blood_glucose: num(vals.glucose),
        weight: num(vals.weight),
        pain_score: pain,
        note: note.trim() || null,
      });
      if (error) throw error;
      const feedback = buildCheckinFeedback(submitted, baselines);
      setSavedFeedback(feedback);
      // toast 留久一点，老人看得完
      toast.success(feedback, { duration: 8000 });
      setVals(EMPTY_VALS);
      setPain(0);
      setNote('');
      setCarried(null);
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
  const optionalNames = plan.optional.map((f) => FIELD_LABEL[f]).join('、');

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
            {/* 今日建议测量项：置顶且默认展开，其余折叠在下方「更多（可选）」 */}
            <section className="space-y-2">
              <div className="flex items-start gap-2">
                <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div className="min-w-0">
                  <h2 className="text-[15px] font-semibold leading-6">今天建议您测这几项</h2>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {plan.reasons.length > 0
                      ? `根据您的${plan.reasons.join('、')}情况，先填这几项就够了，别的可以不用填。`
                      : '还没有您的病种信息，下面这些都可以选填。'}
                  </p>
                </div>
              </div>
              <FieldGrid fields={plan.suggested} vals={vals} setVal={setVal} pain={pain} setPain={updatePain} />
            </section>

            {/* 沿用上一次记录：昨天没记录时用更早的一次，并把真实日期写在按钮上 */}
            {lastCheckin ? (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={applyLastCheckin}
                  className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-primary/40 bg-primary/5 px-4 text-[15px] font-medium text-primary"
                >
                  <History className="h-4 w-4 shrink-0" />
                  {lastCheckin.isYesterday ? '沿用昨日数值' : `沿用上次（${lastCheckin.dayLabel}）的数值`}
                </button>
                {carried ? (
                  <p className="rounded-xl bg-triage-amber-bg px-3 py-2 text-xs leading-relaxed text-triage-amber">
                    已填入 {carried.from} 的{carried.names.join('、')}——这是沿用，不是今天新测的。今天重新测过的项目，请改成今天的数字。
                  </p>
                ) : null}
              </div>
            ) : null}

            {/* 更多（可选）：折叠区，点击区域整行 56px，箭头 + 中文「展开/收起」 */}
            {plan.optional.length > 0 ? (
              <div className="space-y-3">
                <button
                  type="button"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen((v) => !v)}
                  className="flex h-14 w-full items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 px-4 text-left"
                >
                  <span className="min-w-0 text-[15px] font-medium">更多（可选）：{optionalNames}</span>
                  <span className="flex shrink-0 items-center gap-1 text-sm text-muted-foreground">
                    {moreOpen ? '收起' : '展开'}
                    {moreOpen ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
                  </span>
                </button>
                {moreOpen ? (
                  <FieldGrid fields={plan.optional} vals={vals} setVal={setVal} pain={pain} setPain={updatePain} />
                ) : null}
              </div>
            ) : null}

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

            {/* 提交后的人话反馈：留在页面上，比一闪而过的提示更好找 */}
            {savedFeedback ? (
              <div className="flex items-start gap-2 rounded-xl bg-primary/5 p-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <p className="text-sm leading-relaxed">{savedFeedback}</p>
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
                  {/* 机制①：叠加个人基线带（中线 + 偏离带），表未应用迁移时无基线自动隐藏 */}
                  {sysBaseline ? (
                    <>
                      <ReferenceArea y1={sysBaseline.bandLow} y2={sysBaseline.bandHigh} fill="hsl(var(--primary))" fillOpacity={0.08} ifOverflow="extendDomain" />
                      <ReferenceLine y={sysBaseline.median} stroke="hsl(var(--primary))" strokeDasharray="4 4" strokeOpacity={0.5} ifOverflow="extendDomain" />
                    </>
                  ) : null}
                  <Line type="monotone" dataKey="systolic" name="收缩压" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="diastolic" name="舒张压" stroke="hsl(var(--sig-rose))" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="heart_rate" name="心率" stroke="hsl(var(--triage-amber))" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
              {/* 基线来源标注：本地现算时说清口径，避免被误认为是已生成的个人基线 */}
              {sysBaseline?.source === 'local' ? (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  基线带基于近 {sysBaseline.sampleDays} 天本人记录现算（个人基线尚未生成）
                </p>
              ) : null}
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
