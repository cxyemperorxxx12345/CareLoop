// 就诊准备清单：把一次随访要带的「最近身体情况 + 在用药 + 想问的问题」汇总成一页，
// 打印出来带去医院，解决老人「现场说不清」的痛点。
// 说明：纯信息汇总，不做任何医学判断；问题勾选与自定义问题只存本地 localStorage
// （键前缀 careloop:visit-prep:），不写数据库。
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ClipboardList, Info, Printer, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/db/supabase';
import { patientApi } from '@/lib/api';
import { cn } from '@/lib/utils';

// ===== 本地存储 =====

const LS_PREFIX = 'careloop:visit-prep:';

interface PrepAnswers {
  /** 已勾选的模板问题原文 */
  checked: string[];
  /** 用户自己补充的问题 */
  custom: string;
}

const EMPTY_ANSWERS: PrepAnswers = { checked: [], custom: '' };

function loadAnswers(followupId: string): PrepAnswers {
  try {
    const raw = localStorage.getItem(LS_PREFIX + followupId);
    if (!raw) return EMPTY_ANSWERS;
    const parsed = JSON.parse(raw) as Partial<PrepAnswers> | null;
    if (!parsed || typeof parsed !== 'object') return EMPTY_ANSWERS;
    return {
      checked: Array.isArray(parsed.checked) ? parsed.checked.filter((x): x is string => typeof x === 'string') : [],
      custom: typeof parsed.custom === 'string' ? parsed.custom : '',
    };
  } catch {
    return EMPTY_ANSWERS;
  }
}

// ===== 数据 ====

export interface PrepFollowupItem {
  id: string;
  title: string;
  category: string;
  due_date: string;
  detail: string | null;
}

export interface PrepPatient {
  id: string;
  name?: string | null;
  department?: string | null;
  diagnosis?: string | null;
}

interface CheckinRow {
  created_at: string;
  systolic: number | null;
  diastolic: number | null;
  heart_rate: number | null;
  temperature: number | string | null;
  blood_glucose: number | string | null;
}

interface PlanRow {
  id: string;
  medicine_name: string;
  spec: string | null;
  dosage: string | null;
  frequency: string | null;
  slots: number[] | null;
}

interface VitalRow {
  day: string;
  bp: string;
  hr: string;
  temp: string;
  glucose: string;
}

const SLOT_SHORT = ['早', '中', '晚', '睡前'];

// 常用问题模板：都是「信息确认类」提问，不含任何医学判断
const QUESTION_TEMPLATES = [
  '我最近记的这些身体数据，有没有需要特别注意的？',
  '这次复查需要空腹或者做别的准备吗？',
  '现在吃的这些药还要继续吃吗？剂量要不要调整？',
  '下一次复查安排在什么时间？需要查哪些项目？',
  '平时的饮食、活动和作息，有什么要特别注意的？',
];

// ===== 展示格式化（任何取值缺失都回落到「—」，绝不出现 undefined / NaN）====

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function numText(v: unknown, digits = 0): string {
  const n = toNum(v);
  if (n === null) return '—';
  return digits > 0 ? n.toFixed(digits) : String(Math.round(n * 10) / 10);
}

function bpText(sys: unknown, dia: unknown): string {
  const s = toNum(sys);
  const d = toNum(dia);
  if (s !== null && d !== null) return `${Math.round(s)}/${Math.round(d)}`;
  if (s !== null) return `收缩 ${Math.round(s)}`;
  if (d !== null) return `舒张 ${Math.round(d)}`;
  return '—';
}

function fmtDate(d: string): string {
  if (!d) return '日期待定';
  const p = d.slice(0, 10).split('-');
  if (p.length !== 3 || !/^\d{4}$/.test(p[0])) return d;
  return `${p[0]} 年 ${Number(p[1])} 月 ${Number(p[2])} 日`;
}

function fmtDay(iso: string): string {
  const p = iso.slice(0, 10).split('-');
  return p.length === 3 ? `${Number(p[1])}/${Number(p[2])}` : iso.slice(0, 10);
}

function orDash(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || '—';
}

function slotText(slots: unknown): string {
  if (!Array.isArray(slots) || slots.length === 0) return '—';
  const parts = (slots as number[])
    .filter((n) => Number.isInteger(n) && n >= 0 && n < SLOT_SHORT.length)
    .map((n) => SLOT_SHORT[n]);
  return parts.length ? parts.join('、') : '—';
}

// ===== 打印样式 =====
// 只在本组件挂载时注入：打印时隐藏页面上其余所有内容（含底部导航与按钮），
// 只输出清单本体，A4 纵向、字号放大到老人看得清。
const PRINT_CSS = `
@media print {
  @page { size: A4 portrait; margin: 14mm; }
  html, body {
    width: auto !important;
    max-width: none !important;
    height: auto !important;
    min-height: 0 !important;
    overflow: visible !important;
    background: #fff !important;
  }
  body > *:not(.visit-prep-portal) { display: none !important; }
  .visit-prep-portal {
    position: static !important;
    inset: auto !important;
    display: block !important;
    padding: 0 !important;
    background: #fff !important;
  }
  .visit-prep-no-print { display: none !important; }
  .visit-prep-overlay {
    position: static !important;
    inset: auto !important;
    display: block !important;
    padding: 0 !important;
    background: #fff !important;
  }
  .visit-prep-print {
    position: static !important;
    inset: auto !important;
    width: 100% !important;
    max-width: none !important;
    height: auto !important;
    max-height: none !important;
    margin: 0 !important;
    padding: 0 !important;
    overflow: visible !important;
    border: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    background: #fff !important;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .visit-prep-print .vp-avoid { break-inside: avoid; page-break-inside: avoid; }
  .visit-prep-print .vp-title { font-size: 20pt; line-height: 1.3; }
  .visit-prep-print .vp-h2 { font-size: 14pt; line-height: 1.4; }
  .visit-prep-print .vp-body { font-size: 12pt; line-height: 1.6; }
  .visit-prep-print .vp-small { font-size: 10.5pt; line-height: 1.5; }
  .visit-prep-print table { width: 100%; border-collapse: collapse; }
  .visit-prep-print th,
  .visit-prep-print td { border: 1px solid #333; padding: 5px 7px; font-size: 11pt; text-align: left; }
  .visit-prep-print th { background: #f2f5f7 !important; font-weight: 600; }
}
`;

interface VisitPrepSheetProps {
  patient: PrepPatient;
  item: PrepFollowupItem;
  /** 随访类别的中文名（如「复查」「拆线」），由调用方按页面口径传入 */
  categoryText: string;
  onClose: () => void;
}

export function VisitPrepSheet({ patient, item, categoryText, onClose }: VisitPrepSheetProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [vitals, setVitals] = useState<VitalRow[]>([]);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [answers, setAnswers] = useState<PrepAnswers>(() => loadAnswers(item.id));

  // 打印用挂载点：portal 到 body，便于打印时整页只留清单
  const host = useMemo(() => {
    const el = document.createElement('div');
    el.className = 'visit-prep-portal';
    return el;
  }, []);

  useEffect(() => {
    document.body.appendChild(host);
    return () => {
      host.remove();
    };
  }, [host]);

  // 勾选与自定义问题写本地，不写库
  useEffect(() => {
    try {
      localStorage.setItem(LS_PREFIX + item.id, JSON.stringify(answers));
    } catch {
      // 隐私模式下写入失败不影响展示
    }
  }, [answers, item.id]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [checkins, medRows] = await Promise.all([
          patientApi.checkinHistory(patient.id, 7) as Promise<CheckinRow[]>,
          supabase
            .from('medication_plans')
            .select('id, medicine_name, spec, dosage, frequency, slots')
            .eq('patient_id', patient.id)
            .eq('active', true)
            .order('medicine_name', { ascending: true })
            .then((r) => (Array.isArray(r.data) ? (r.data as PlanRow[]) : [])),
        ]);
        if (!alive) return;
        // 同一天保留最后一次记录（接口按时间升序返回，后者覆盖前者）
        const byDay = new Map<string, VitalRow>();
        for (const r of checkins) {
          const day = (r.created_at ?? '').slice(0, 10);
          if (!day) continue;
          byDay.set(day, {
            day,
            bp: bpText(r.systolic, r.diastolic),
            hr: numText(r.heart_rate),
            temp: numText(r.temperature, 1),
            glucose: numText(r.blood_glucose, 1),
          });
        }
        setVitals(Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? -1 : 1)));
        setPlans(medRows);
        setStatus('ready');
      } catch {
        if (alive) setStatus('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [patient.id]);

  const checkedSet = useMemo(() => new Set(answers.checked), [answers.checked]);

  function toggleQuestion(q: string) {
    setAnswers((cur) => ({
      ...cur,
      checked: cur.checked.includes(q) ? cur.checked.filter((x) => x !== q) : [...cur.checked, q],
    }));
  }

  const generatedAt = new Date();
  const generatedText = `${generatedAt.getFullYear()} 年 ${generatedAt.getMonth() + 1} 月 ${generatedAt.getDate()} 日`;

  const body = (
    <>
      <style>{PRINT_CSS}</style>
      <div
        className="visit-prep-overlay fixed inset-0 z-[60] flex justify-center bg-black/50 p-0 md:items-center md:p-6"
        role="dialog"
        aria-modal="true"
        aria-label="就诊准备清单"
      >
        <div className="visit-prep-print flex h-full w-full max-w-2xl flex-col overflow-y-auto bg-background md:max-h-[calc(100dvh-3rem)] md:rounded-2xl md:shadow-2xl">
          {/* 操作条：屏幕可见，打印隐藏 */}
          <div className="visit-prep-no-print sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-card/95 px-4 py-3 backdrop-blur">
            <ClipboardList className="h-5 w-5 shrink-0 text-primary" />
            <p className="min-w-0 flex-1 truncate text-[15px] font-semibold">就诊准备清单</p>
            <Button type="button" size="sm" className="h-10 rounded-xl text-[15px]" onClick={() => window.print()}>
              <Printer className="mr-1.5 h-4 w-4" />
              打印 / 存为 PDF
            </Button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭就诊准备清单"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="space-y-5 p-5">
            {/* 清单抬头 */}
            <header className="vp-avoid space-y-1">
              <h2 className="vp-title text-xl font-bold">就诊准备清单</h2>
              <p className="vp-body text-sm text-muted-foreground">
                {orDash(patient.name)} · {orDash(patient.department)}
                {' · 生成于 '}
                {generatedText}
              </p>
              <p className="vp-small flex items-start gap-1.5 text-[13px] text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                本清单仅为就诊信息汇总，不构成医疗建议，具体诊疗请以医生当面判断为准。
              </p>
            </header>

            {/* 一、本次随访 */}
            <section className="vp-avoid space-y-2">
              <h3 className="vp-h2 text-base font-semibold">一、本次随访</h3>
              <div className="vp-body rounded-xl border border-border bg-card p-3 text-sm">
                <div className="flex gap-2">
                  <span className="w-20 shrink-0 text-muted-foreground">项目</span>
                  <span className="font-medium">{orDash(item.title)}</span>
                </div>
                <div className="mt-1.5 flex gap-2">
                  <span className="w-20 shrink-0 text-muted-foreground">类别</span>
                  <span>{orDash(categoryText)}</span>
                </div>
                <div className="mt-1.5 flex gap-2">
                  <span className="w-20 shrink-0 text-muted-foreground">就诊日期</span>
                  <span className="sig-num font-medium">{fmtDate(item.due_date)}</span>
                </div>
                <div className="mt-1.5 flex gap-2">
                  <span className="w-20 shrink-0 text-muted-foreground">科室</span>
                  <span>{orDash(patient.department)}</span>
                </div>
                <div className="mt-1.5 flex gap-2">
                  <span className="w-20 shrink-0 text-muted-foreground">备注 / 准备</span>
                  <span>
                    {item.detail && item.detail.trim()
                      ? item.detail
                      : '医生未写明特别准备事项。建议带上：医保卡/就诊卡、既往病历与检查报告、正在吃的药盒或药单。'}
                  </span>
                </div>
              </div>
            </section>

            {/* 二、近 7 天体征摘要 */}
            <section className="vp-avoid space-y-2">
              <h3 className="vp-h2 text-base font-semibold">二、近 7 天身体情况</h3>
              {status === 'loading' ? (
                <p className="vp-body text-sm text-muted-foreground">正在汇总近 7 天的体征记录…</p>
              ) : status === 'error' ? (
                <p className="vp-body text-sm text-muted-foreground">
                  体征记录加载失败，可稍后重新打开本清单；也可在就诊前完成一次健康打卡，方便医生了解近期情况。
                </p>
              ) : vitals.length === 0 ? (
                <p className="vp-body text-sm text-muted-foreground">
                  近 7 天尚无体征记录。建议在就诊前完成一次健康打卡，把血压、心率等记下来带给医生看。
                </p>
              ) : (
                <div className="vp-body overflow-x-auto rounded-xl border border-border">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="bg-muted/60">
                        <th className="whitespace-nowrap px-2.5 py-2 text-left font-medium">日期</th>
                        <th className="whitespace-nowrap px-2.5 py-2 text-left font-medium">血压(mmHg)</th>
                        <th className="whitespace-nowrap px-2.5 py-2 text-left font-medium">心率(次/分)</th>
                        <th className="whitespace-nowrap px-2.5 py-2 text-left font-medium">体温(℃)</th>
                        <th className="whitespace-nowrap px-2.5 py-2 text-left font-medium">血糖(mmol/L)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vitals.map((v) => (
                        <tr key={v.day} className="border-t border-border">
                          <td className="sig-num whitespace-nowrap px-2.5 py-2">{fmtDay(v.day)}</td>
                          <td className="sig-num whitespace-nowrap px-2.5 py-2">{v.bp}</td>
                          <td className="sig-num whitespace-nowrap px-2.5 py-2">{v.hr}</td>
                          <td className="sig-num whitespace-nowrap px-2.5 py-2">{v.temp}</td>
                          <td className="sig-num whitespace-nowrap px-2.5 py-2">{v.glucose}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* 三、当前在用药物 */}
            <section className="vp-avoid space-y-2">
              <h3 className="vp-h2 text-base font-semibold">三、现在在吃的药</h3>
              {status === 'loading' ? (
                <p className="vp-body text-sm text-muted-foreground">正在汇总用药计划…</p>
              ) : plans.length === 0 ? (
                <p className="vp-body text-sm text-muted-foreground">
                  当前没有在用的用药计划。若您正在服药，请把药盒或药单带来给医生核对。
                </p>
              ) : (
                <div className="vp-body overflow-x-auto rounded-xl border border-border">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="bg-muted/60">
                        <th className="whitespace-nowrap px-2.5 py-2 text-left font-medium">药名</th>
                        <th className="whitespace-nowrap px-2.5 py-2 text-left font-medium">剂量</th>
                        <th className="whitespace-nowrap px-2.5 py-2 text-left font-medium">频次</th>
                        <th className="whitespace-nowrap px-2.5 py-2 text-left font-medium">服用时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plans.map((p) => (
                        <tr key={p.id} className="border-t border-border">
                          <td className="px-2.5 py-2 font-medium">{orDash(p.medicine_name)}</td>
                          <td className="px-2.5 py-2">{[p.spec, p.dosage].filter(Boolean).join(' · ') || '—'}</td>
                          <td className="px-2.5 py-2">{orDash(p.frequency)}</td>
                          <td className="px-2.5 py-2">{slotText(p.slots)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* 四、要问医生的问题 */}
            <section className="vp-avoid space-y-2">
              <h3 className="vp-h2 text-base font-semibold">四、想问医生的问题</h3>
              <p className="vp-small text-[13px] text-muted-foreground">
                勾选您想问的（可多选），打印时会一起带过去；没勾选的不会打印。
              </p>
              <ul className="space-y-2">
                {QUESTION_TEMPLATES.map((q) => {
                  const on = checkedSet.has(q);
                  return (
                    <li key={q}>
                      <label
                        className={cn(
                          'flex min-h-[3rem] cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm transition-colors',
                          on ? 'border-primary bg-primary/5' : 'border-border bg-card',
                        )}
                      >
                        <Checkbox
                          checked={on}
                          onCheckedChange={() => toggleQuestion(q)}
                          className="mt-0.5 h-5 w-5"
                          aria-label={q}
                        />
                        <span className={cn('vp-body leading-snug', on && 'font-medium')}>{q}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <div className="space-y-1.5">
                <label htmlFor="visit-prep-custom" className="vp-body block text-sm font-medium">
                  我还想问（自己写）
                </label>
                <Textarea
                  id="visit-prep-custom"
                  value={answers.custom}
                  onChange={(e) => setAnswers((cur) => ({ ...cur, custom: e.target.value }))}
                  placeholder="例如：最近晚上睡不好，要不要调药？"
                  className="vp-body min-h-[5.5rem] resize-none rounded-xl text-sm"
                />
                {answers.custom.trim() ? (
                  <p className="vp-small text-[13px] text-muted-foreground">已记录，打印时会一起带上。</p>
                ) : null}
              </div>
            </section>

            {/* 页脚免责说明 */}
            <footer className="vp-avoid border-t border-border pt-3">
              <p className="vp-small text-[13px] text-muted-foreground">
                本清单仅为就诊信息汇总，不构成医疗建议；体征与用药数据来自您在 CareLoop 的记录，最终请以医生的当面判断为准。
              </p>
            </footer>

            {/* 屏幕端底部再来一次打印入口，打印隐藏 */}
            <div className="visit-prep-no-print pb-2">
              <Button
                type="button"
                variant="outline"
                className="h-12 w-full rounded-xl text-[15px]"
                onClick={() => window.print()}
              >
                <Printer className="mr-1.5 h-4 w-4" />
                打印 / 存为 PDF
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );

  return createPortal(body, host);
}

export default VisitPrepSheet;
