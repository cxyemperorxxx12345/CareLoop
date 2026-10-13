import { businessDate } from '@/lib/business-date';
// 患者管理：筛选栏 + 患者总表（依从率 / 最新打卡 / 未处理预警聚合）
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { supabase } from '@/db/supabase';
import { clinicianApi } from '@/lib/api';
import { CARERISK_META, type CareRiskResult, computeCareRisk } from '@/lib/carerisk';

// 与数据库真实列名一致的本地行类型
interface PatientRow {
  id: string;
  name: string;
  gender: string | null;
  age: number | null;
  diagnosis: string | null;
  department: string | null;
  discharge_date: string;
  risk_level: 'green' | 'yellow' | 'red';
}
interface LogRow { patient_id: string; plan_id: string; slot: number; action: 'taken' | 'snoozed' | 'skipped'; log_date: string; }
interface CheckinRow { patient_id: string; created_at: string; }
interface OpenAlertRow { patient_id: string; }
interface PlanRow { patient_id: string; id: string; slots: number[] | null; }
interface SymptomRow { patient_id: string; level: string; created_at: string; }

// 风险等级徽章映射
const RISK_META: Record<string, { label: string; cls: string }> = {
  green: { label: '绿', cls: 'bg-triage-green-bg text-triage-green' },
  yellow: { label: '黄', cls: 'bg-triage-amber-bg text-triage-amber' },
  red: { label: '红', cls: 'bg-triage-red-bg text-triage-red' },
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
  return iso.slice(5, 10);
}

interface Filters { name: string; diagnosis: string; risk: string; department: string; }

export function PatientsPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<Filters>({ name: '', diagnosis: '', risk: 'all', department: 'all' });
  const [departments, setDepartments] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<PatientRow[]>([]);
  const [logs7, setLogs7] = useState<LogRow[]>([]);
  const [checkins, setCheckins] = useState<CheckinRow[]>([]);
  const [openAlerts, setOpenAlerts] = useState<OpenAlertRow[]>([]);
  // 机制②：在服方案 + 近 7 天症状，用于本地预测每位患者履约风险
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [symptoms, setSymptoms] = useState<SymptomRow[]>([]);

  // 首次挂载：拉取全部科室用于筛选去重
  useEffect(() => {
    let alive = true;
    (async () => {
      // 软隐藏：科室筛选项也排除残留测试档案
      const { data } = await supabase.from('patients').select('department').eq('is_hidden', false);
      if (!alive) return;
      const set = new Set<string>();
      (data ?? []).forEach((d) => {
        const dept = (d as { department?: string | null }).department;
        if (dept) set.add(dept);
      });
      setDepartments(Array.from(set));
    })();
    return () => { alive = false; };
  }, []);

  // 筛选变更即重新查询（含依从率 / 最新打卡 / 未处理预警聚合）
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = (await clinicianApi.patients({
        name: filters.name || undefined,
        diagnosis: filters.diagnosis || undefined,
        risk: filters.risk,
        department: filters.department === 'all' ? undefined : filters.department,
      })) as unknown as PatientRow[];
      setRows(data);
      if (data.length === 0) {
        setLogs7([]); setCheckins([]); setOpenAlerts([]); setPlans([]); setSymptoms([]);
        return;
      }
      const ids = data.map((p) => p.id);
      const since7 = businessDate(Date.now() - 7 * 24 * 3600 * 1000);
      const since7iso = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      // 机制②：方案 + 症状与依从/打卡/预警一并聚合，避免 N+1
      const [logRes, checkinRes, alertRes, planRes, symRes] = await Promise.all([
        supabase.from('medication_logs').select('patient_id, plan_id, slot, action, log_date').in('patient_id', ids).gte('log_date', since7),
        supabase.from('checkins').select('patient_id, created_at').in('patient_id', ids).order('created_at', { ascending: false }).limit(500),
        supabase.from('alerts').select('patient_id').in('patient_id', ids).eq('status', 'open'),
        supabase.from('medication_plans').select('patient_id, id, slots').in('patient_id', ids).eq('active', true),
        supabase.from('symptom_checks').select('patient_id, level, created_at').in('patient_id', ids).gte('created_at', since7iso),
      ]);
      setLogs7((logRes.data ?? []) as unknown as LogRow[]);
      setCheckins((checkinRes.data ?? []) as unknown as CheckinRow[]);
      setOpenAlerts((alertRes.data ?? []) as unknown as OpenAlertRow[]);
      setPlans((planRes.data ?? []) as unknown as PlanRow[]);
      setSymptoms((symRes.data ?? []) as unknown as SymptomRow[]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载患者列表失败');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    let alive = true;
    (async () => {
      // 以 alive 标记防止筛选快速切换时串数据
      if (!alive) return;
      await load();
    })();
    return () => { alive = false; };
  }, [load]);

  // 依从率分子分母：taken / (taken + skipped)
  const complianceMap = useMemo(() => {
    const map = new Map<string, { taken: number; skipped: number }>();
    logs7.forEach((l) => {
      if (l.action !== 'taken' && l.action !== 'skipped') return;
      const cur = map.get(l.patient_id) ?? { taken: 0, skipped: 0 };
      cur[l.action] += 1;
      map.set(l.patient_id, cur);
    });
    return map;
  }, [logs7]);

  // 每位患者最新一次打卡（查询结果已按时间倒序，取首条即可）
  const latestCheckinMap = useMemo(() => {
    const map = new Map<string, string>();
    checkins.forEach((c) => {
      if (!map.has(c.patient_id)) map.set(c.patient_id, c.created_at);
    });
    return map;
  }, [checkins]);

  // 每位患者未处理预警计数
  const openAlertMap = useMemo(() => {
    const map = new Map<string, number>();
    openAlerts.forEach((a) => map.set(a.patient_id, (map.get(a.patient_id) ?? 0) + 1));
    return map;
  }, [openAlerts]);

  // 机制②：本地预测每位患者履约风险（窗口 7 天），无需 N+1 查询
  const careRiskMap = useMemo(() => {
    const map = new Map<string, CareRiskResult>();
    const since = Date.now() - 7 * 86400000;
    rows.forEach((p) => {
      const logs = logs7.filter((l) => l.patient_id === p.id);
      const ck = checkins.filter((c) => c.patient_id === p.id && Date.parse(c.created_at) >= since);
      const sy = symptoms.filter((s) => s.patient_id === p.id);
      const pl = plans.filter((x) => x.patient_id === p.id);
      map.set(p.id, computeCareRisk({ plans: pl, logs, checkins: ck, symptoms: sy, dischargeDate: p.discharge_date }, 7));
    });
    return map;
  }, [rows, logs7, checkins, symptoms, plans]);

  // 默认按预测风险降序：医护一眼先看最该介入的人
  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => (careRiskMap.get(b.id)?.score ?? 0) - (careRiskMap.get(a.id)?.score ?? 0)),
    [rows, careRiskMap],
  );

  const setFilter = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto w-full min-w-0">
      {/* 页头：标题 + 患者总数 */}
      <div className="min-w-0">
        <h1 className="text-xl md:text-2xl font-black">患者管理</h1>
        <p className="text-sm text-muted-foreground mt-1">共 {rows.length} 位患者</p>
      </div>

      {/* 筛选栏 */}
      <Card className="rounded-2xl">
        <CardContent className="p-4">
          <div className="flex flex-col md:flex-row gap-3">
            <Input
              placeholder="搜索姓名"
              value={filters.name}
              onChange={(e) => setFilter({ name: e.target.value })}
              className="md:max-w-[220px]"
            />
            <Input
              placeholder="搜索诊断"
              value={filters.diagnosis}
              onChange={(e) => setFilter({ diagnosis: e.target.value })}
              className="md:max-w-[220px]"
            />
            <Select value={filters.risk} onValueChange={(v) => setFilter({ risk: v })}>
              <SelectTrigger className="md:w-36">
                <SelectValue placeholder="风险等级" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部风险</SelectItem>
                <SelectItem value="green">绿</SelectItem>
                <SelectItem value="yellow">黄</SelectItem>
                <SelectItem value="red">红</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filters.department} onValueChange={(v) => setFilter({ department: v })}>
              <SelectTrigger className="md:w-44">
                <SelectValue placeholder="科室" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部科室</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d} value={d}>{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* 患者表（移动端横向滚动） */}
      {loading ? (
        <Skeleton className="h-72 w-full rounded-2xl" />
      ) : rows.length === 0 ? (
        <Card className="rounded-2xl">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            暂无符合条件的患者
          </CardContent>
        </Card>
      ) : (
        <Card className="rounded-2xl">
          <div className="w-full max-w-full overflow-x-auto bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">姓名</TableHead>
                  <TableHead className="whitespace-nowrap">诊断</TableHead>
                  <TableHead className="whitespace-nowrap">风险</TableHead>
                  <TableHead className="whitespace-nowrap">履约风险</TableHead>
                  <TableHead className="whitespace-nowrap">依从率</TableHead>
                  <TableHead className="whitespace-nowrap">最新打卡</TableHead>
                  <TableHead className="whitespace-nowrap">未处理预警</TableHead>
                  <TableHead className="whitespace-nowrap">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedRows.map((p) => {
                  const risk = RISK_META[p.risk_level] ?? RISK_META.green;
                  const c = complianceMap.get(p.id);
                  const total = c ? c.taken + c.skipped : 0;
                  const compliance = c && total > 0 ? `${Math.round((c.taken / total) * 100)}%` : '—';
                  const latest = latestCheckinMap.get(p.id);
                  const alertCount = openAlertMap.get(p.id) ?? 0;
                  return (
                    <TableRow
                      key={p.id}
                      className="cursor-pointer"
                      onClick={() => navigate(`/clinician/patients/${p.id}`)}
                    >
                      <TableCell className="whitespace-nowrap">
                        <p className="font-medium">{p.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {p.gender ?? '—'} · {p.age ?? '—'} 岁
                        </p>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{p.diagnosis ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        <Badge className={risk.cls}>{risk.label}</Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {(() => {
                          const cr = careRiskMap.get(p.id);
                          if (!cr) return <span className="text-muted-foreground">—</span>;
                          const m = CARERISK_META[cr.level];
                          return <Badge className={m.cls}>{m.label} · {cr.score}</Badge>;
                        })()}
                      </TableCell>
                      <TableCell className="whitespace-nowrap sig-num">{compliance}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {latest ? relTime(latest) : '—'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {alertCount > 0 ? (
                          <Badge className="bg-triage-red-bg text-triage-red">{alertCount}</Badge>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(`/clinician/patients/${p.id}`);
                          }}
                        >
                          查看
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  );
}

export default PatientsPage;
