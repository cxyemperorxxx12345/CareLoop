// 随访报告：一键生成、归档管理与补充意见
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { FileText, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { clinicianApi, fnApi } from '@/lib/api';

// ===== 本地类型 =====
interface PatientOption {
  id: string;
  name: string;
  diagnosis?: string | null;
}
interface ReportPatient {
  name?: string;
  diagnosis?: string;
}
interface SymptomItem {
  chief_complaint: string;
  level: string;
  created_at: string;
}
interface ReportStats {
  period_days: number;
  adherence: { taken: number; skipped: number; snoozed: number; answered: number; compliance_rate: number };
  vitals: { records: number; systolic_avg: number; diastolic_avg: number; heart_rate_avg: number; temperature_max: number; note?: string };
  symptoms: SymptomItem[];
  alerts: { total: number; open: number; red: number; yellow: number };
}
interface ReportContent {
  stats?: ReportStats;
  summary?: string;
}
interface ReportRow {
  id: string;
  patient_id: string;
  period_days: number;
  content: ReportContent | null;
  status: 'draft' | 'archived';
  clinician_note?: string | null;
  created_by?: string | null;
  created_at: string;
  patients?: ReportPatient | ReportPatient[] | null;
}

// 症状级别徽章（静态映射）
const LEVEL_BADGE: Record<string, { className: string; label: string }> = {
  red: { className: 'bg-triage-red-bg text-triage-red', label: '红色' },
  yellow: { className: 'bg-triage-amber-bg text-triage-amber', label: '黄色' },
  green: { className: 'bg-triage-green-bg text-triage-green', label: '绿色' },
};

// 相对时间：xx分钟前 / xx小时前 / x天前 / 日期
function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day} 天前`;
  return new Date(t).toLocaleDateString('zh-CN');
}

// 数值兜底：content 来自 jsonb，防御异常数据
function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// 体征这类「可能没采集到」的数值用占位符显示，不要退化成 0 误导医护
function numText(v: unknown, fallback = '—'): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : fallback;
}

function pickPatient(row: ReportRow): ReportPatient | null {
  if (Array.isArray(row.patients)) return row.patients[0] ?? null;
  return row.patients ?? null;
}

export function ReportsPage() {
  const [searchParams] = useSearchParams();

  const [patients, setPatients] = useState<PatientOption[]>([]);
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('all');

  // 生成器状态（URL ?patientId= 预选）
  const [selectedPatient, setSelectedPatient] = useState('');
  const [periodDays, setPeriodDays] = useState('7');
  const [generating, setGenerating] = useState(false);
  // 补充意见本地 state（仅草稿可编辑）
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [archivingId, setArchivingId] = useState('');

  const loadReports = useCallback(async () => {
    setLoading(true);
    try {
      const rows = (await clinicianApi.reports()) as unknown as ReportRow[];
      setReports(rows);
    } catch (e) {
      toast.error(`加载报告失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadReports();
    void (async () => {
      try {
        const rows = (await clinicianApi.patients()) as unknown as PatientOption[];
        setPatients(rows);
      } catch (e) {
        toast.error(`加载患者列表失败：${(e as Error).message}`);
      }
    })();
    // URL 预选患者
    const pid = searchParams.get('patientId');
    if (pid) setSelectedPatient(pid);
  }, [loadReports, searchParams]);

  // 选中患者时过滤列表；未选中显示全部
  const visibleReports = useMemo(() => {
    const filtered = reports.filter(r => {
      if (tab === 'all') return true;
      return r.status === tab;
    });
    if (!selectedPatient || selectedPatient === 'all') return filtered;
    return filtered.filter(r => r.patient_id === selectedPatient);
  }, [reports, tab, selectedPatient]);

  const generateReport = async () => {
    if (!selectedPatient) {
      toast.error('请选择患者');
      return;
    }
    setGenerating(true);
    try {
      const res = await fnApi.generateReport(selectedPatient, Number(periodDays));
      const p = patients.find(x => x.id === selectedPatient);
      const content = res.content as ReportContent | undefined;
      const newRow: ReportRow = {
        id: res.report_id,
        patient_id: selectedPatient,
        period_days: Number(periodDays),
        content: content ?? null,
        status: 'draft',
        created_at: new Date().toISOString(),
        patients: p ? { name: p.name, diagnosis: p.diagnosis ?? undefined } : null,
      };
      setReports(prev => [newRow, ...prev]);
      setTab('all');
      toast.success('报告生成成功');
    } catch (e) {
      toast.error(`生成失败：${(e as Error).message}`);
    } finally {
      setGenerating(false);
    }
  };

  const archiveReport = async (row: ReportRow) => {
    const note = (notes[row.id] ?? row.clinician_note ?? '').trim();
    setArchivingId(row.id);
    try {
      await clinicianApi.archiveReport(row.id, note || undefined);
      toast.success('报告已归档');
      await loadReports();
    } catch (e) {
      toast.error(`归档失败：${(e as Error).message}`);
    } finally {
      setArchivingId('');
    }
  };

  const emptyText = !selectedPatient
    ? tab === 'draft'
      ? '暂无草稿报告，可在上方生成'
      : tab === 'archived'
        ? '暂无已归档报告'
        : '暂无报告，选择患者与周期后点击「生成报告」'
    : '该患者暂无符合筛选的报告';

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto">
      <div>
        <h1 className="text-lg md:text-xl font-bold">随访报告</h1>
        <p className="text-sm text-muted-foreground mt-0.5">汇总患者周期内的依从、体征与预警数据</p>
      </div>

      {/* 报告生成器 */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-bold">生成随访报告</h2>
          </div>
          <div className="grid gap-3 md:grid-cols-[1fr_10rem_auto] md:items-end">
            <div className="space-y-2">
              <Label htmlFor="report-patient">患者</Label>
              <Select value={selectedPatient || undefined} onValueChange={setSelectedPatient}>
                <SelectTrigger id="report-patient" className="w-full">
                  <SelectValue placeholder="选择患者" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部患者</SelectItem>
                  {patients.map(p => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="report-period">统计周期</Label>
              <Select value={periodDays} onValueChange={setPeriodDays}>
                <SelectTrigger id="report-period" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">近 7 天</SelectItem>
                  <SelectItem value="14">近 14 天</SelectItem>
                  <SelectItem value="30">近 30 天</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              onClick={() => void generateReport()}
              disabled={generating || !selectedPatient || selectedPatient === 'all'}
            >
              {generating ? '生成中…' : '生成报告'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 状态筛选 */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-3 md:w-auto">
          <TabsTrigger type="button" value="all">全部</TabsTrigger>
          <TabsTrigger type="button" value="draft">草稿</TabsTrigger>
          <TabsTrigger type="button" value="archived">已归档</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* 报告列表 */}
      {loading ? (
        <p className="text-sm text-muted-foreground text-center py-10">加载中…</p>
      ) : visibleReports.length === 0 ? (
        <Card>
          <CardContent className="p-10 flex flex-col items-center gap-2 text-center">
            <FileText className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{emptyText}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {visibleReports.map(row => {
            const p = pickPatient(row);
            const stats = row.content?.stats;
            const summary = row.content?.summary ?? '';
            const symptoms = Array.isArray(stats?.symptoms) ? stats!.symptoms.slice(0, 5) : [];
            const noteValue = notes[row.id] ?? row.clinician_note ?? '';
            const isDraft = row.status === 'draft';
            return (
              <Card key={row.id}>
                <CardContent className="p-4 space-y-4">
                  {/* 头部：患者 + 周期 + 状态 */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-sm">{p?.name ?? '未知患者'}</span>
                    <Badge variant="secondary" className="bg-secondary">近 {row.period_days} 天</Badge>
                    {isDraft ? (
                      <Badge className="bg-triage-amber-bg text-triage-amber">草稿</Badge>
                    ) : (
                      <Badge className="bg-triage-green-bg text-triage-green">已归档</Badge>
                    )}
                    <span className="text-xs text-muted-foreground ml-auto">
                      {formatRelativeTime(row.created_at)}生成
                    </span>
                  </div>

                  {/* 统计数据 */}
                  {stats ? (
                    <div className="grid gap-3 md:grid-cols-3">
                      {/* 依从率 */}
                      <div className="rounded-xl bg-muted p-3">
                        <p className="text-xs text-muted-foreground">用药依从率</p>
                        <p className="text-2xl font-black mt-1">
                          {num(stats.adherence?.compliance_rate)}%
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          已服 {num(stats.adherence?.taken)} · 跳过 {num(stats.adherence?.skipped)} ·
                          延迟 {num(stats.adherence?.snoozed)}
                        </p>
                      </div>
                      {/* 体征摘要 */}
                      <div className="rounded-xl bg-muted p-3">
                        <p className="text-xs text-muted-foreground">体征摘要</p>
                        <p className="text-sm mt-1.5 leading-relaxed">
                          血压均值 {numText(stats.vitals?.systolic_avg)}/{numText(stats.vitals?.diastolic_avg)} ·
                          心率均值 {numText(stats.vitals?.heart_rate_avg)}
                          <br />
                          体温最高 {numText(stats.vitals?.temperature_max)}℃ · 记录 {num(stats.vitals?.records)} 条
                        </p>
                        {/* 存量扁平报告只有血压文字描述（迁移 00016 回填为 vitals.note） */}
                        {stats.vitals?.note ? (
                          <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                            {stats.vitals.note}
                          </p>
                        ) : null}
                      </div>
                      {/* 预警统计 */}
                      <div className="rounded-xl bg-muted p-3">
                        <p className="text-xs text-muted-foreground">预警统计</p>
                        <p className="text-sm mt-1.5 leading-relaxed">
                          共 {num(stats.alerts?.total)} · 未处理 {num(stats.alerts?.open)}
                          <br />
                          红 {num(stats.alerts?.red)} · 黄 {num(stats.alerts?.yellow)}
                        </p>
                      </div>
                    </div>
                  ) : summary || symptoms.length > 0 ? null : (
                    // 报告已有小结或症状内容时，不再显示「暂无统计数据」——
                    // 存量报告早期是扁平结构（无 stats），会同时出现占位文案和完整小结
                    <p className="text-sm text-muted-foreground">本报告暂无统计数据</p>
                  )}

                  {/* 症状列表（最近 5 条） */}
                  {symptoms.length > 0 ? (
                    <div className="space-y-1.5">
                      <p className="text-xs text-muted-foreground">近期症状主诉</p>
                      <ul className="space-y-1">
                        {symptoms.map((s, i) => {
                          const lv = LEVEL_BADGE[s.level] ?? LEVEL_BADGE.green;
                          return (
                            <li key={`${s.created_at}-${i}`} className="flex items-center gap-2 text-sm">
                              <Badge className={lv.className}>{lv.label}</Badge>
                              <span className="flex-1">{s.chief_complaint}</span>
                              <span className="text-xs text-muted-foreground">
                                {formatRelativeTime(s.created_at)}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}

                  {/* 随访小结 */}
                  {summary ? (
                    <div className="rounded-xl bg-card border border-border p-4">
                      <p className="text-xs text-muted-foreground mb-2">随访小结</p>
                      <p className="text-sm leading-relaxed whitespace-pre-wrap">{summary}</p>
                    </div>
                  ) : null}

                  {/* 底部：医护补充意见 + 归档 */}
                  <div className="space-y-2">
                    <Label htmlFor={`note-${row.id}`}>医护补充意见</Label>
                    <Textarea
                      id={`note-${row.id}`}
                      rows={2}
                      placeholder={isDraft ? '补充随访意见（归档时一并保存）' : '已归档，不可编辑'}
                      value={noteValue}
                      disabled={!isDraft}
                      onChange={e => setNotes(prev => ({ ...prev, [row.id]: e.target.value }))}
                    />
                    <div className="flex justify-end">
                      {isDraft ? (
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => void archiveReport(row)}
                          disabled={archivingId === row.id}
                        >
                          {archivingId === row.id ? '归档中…' : '归档'}
                        </Button>
                      ) : (
                        <Badge variant="secondary" className="bg-secondary">已归档，不可修改</Badge>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default ReportsPage;
