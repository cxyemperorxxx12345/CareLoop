// 预警中心：分级预警列表、处理闭环

import { BellOff, CheckCircle2, ChevronDown, ChevronUp, RotateCcw, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { useAuth } from '@/contexts/AuthContext';
import { clinicianApi } from '@/lib/api';
import { cn } from '@/lib/utils';

// ===== 本地类型 =====
interface AlertPatient {
  name?: string;
  department?: string;
  diagnosis?: string;
}
interface AlertRow {
  id: string;
  patient_id: string;
  level: 'red' | 'yellow';
  source: 'triage' | 'medication' | 'checkin' | 'manual';
  detail: string;
  status: 'open' | 'resolved';
  action?: string | null;
  resolution_note?: string | null;
  handled_by?: string | null;
  handled_at?: string | null;
  family_action?: 'dosed' | 'contacted' | 'escalate' | null;
  family_responded_at?: string | null;
  created_at: string;
  patients?: AlertPatient | AlertPatient[] | null;
}

// 家属响应动作文案（M6：护士站避免重复电话）
const FAMILY_ACTION_TEXT: Record<string, string> = {
  dosed: '已代为打卡，链路终止',
  contacted: '已联系患者，维持观察',
  escalate: '反馈无响应，转医护回电',
};

// 级别徽章样式（静态映射，禁止动态拼类名）
const LEVEL_BADGE: Record<'red' | 'yellow', { className: string; label: string }> = {
  red: { className: 'bg-triage-red-bg text-triage-red', label: '红色·立即就医' },
  yellow: { className: 'bg-triage-amber-bg text-triage-amber', label: '黄色·电话随访' },
};
const SOURCE_LABEL: Record<AlertRow['source'], string> = {
  triage: '分诊',
  medication: '用药',
  checkin: '体征打卡',
  manual: '手动',
};
const ACTION_OPTIONS = ['电话沟通', '调整用药方案', '通知线下就诊', '其他随访'];

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

// 关联患者对象（supabase 嵌套返回可能是对象或数组）
function pickPatient(row: AlertRow): AlertPatient | null {
  if (Array.isArray(row.patients)) return row.patients[0] ?? null;
  return row.patients ?? null;
}

// 按患者聚合的分组（告警疲劳对策：同一患者的多条预警合并展示，不反复刷屏）
interface AlertGroup {
  patientId: string;
  name: string;
  department?: string;
  level: 'red' | 'yellow';
  openCount: number;
  sources: Array<{ source: AlertRow['source']; count: number }>;
  alerts: AlertRow[];
  latestAt: string;
}

// 单条预警卡片（聚合视图与平铺视图共用）
function AlertItem({
  row,
  expanded,
  onToggleExpanded,
  onResolve,
}: {
  row: AlertRow;
  expanded: boolean;
  onToggleExpanded: (id: string) => void;
  onResolve: (row: AlertRow) => void;
}) {
  const navigate = useNavigate();
  const p = pickPatient(row);
  const level = LEVEL_BADGE[row.level] ?? LEVEL_BADGE.yellow;
  return (
    <Card className="rounded-2xl">
      <CardContent className="p-4 space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className={level.className}>{level.label}</Badge>
          <Badge variant="secondary" className="bg-secondary">
            {SOURCE_LABEL[row.source] ?? row.source}
          </Badge>
          <span className="text-xs text-muted-foreground ml-auto">
            {formatRelativeTime(row.created_at)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <button
            type="button"
            className="font-bold underline-offset-2 hover:underline"
            onClick={() => navigate(`/clinician/patients/${row.patient_id}`)}
          >
            {p?.name ?? '未知患者'}
          </button>
          {p?.department ? <span className="text-muted-foreground">{p.department}</span> : null}
          {row.status === 'resolved' ? (
            <Badge variant="secondary" className="bg-secondary ml-auto">已处理</Badge>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">{row.detail}</p>
        {row.family_responded_at ? (
          <p className="flex items-center gap-1.5 text-xs font-medium text-triage-green">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            家属已响应：{FAMILY_ACTION_TEXT[row.family_action ?? ''] ?? '已处理'}（
            {new Date(row.family_responded_at).toLocaleString('zh-CN')}）
          </p>
        ) : null}
        <div className="flex items-center gap-2 pt-1">
          {row.status === 'open' ? (
            <Button type="button" size="sm" onClick={() => onResolve(row)}>
              处理
            </Button>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={() => onToggleExpanded(row.id)}>
              {expanded ? (
                <>
                  <ChevronUp className="h-4 w-4 mr-1" /> 收起处理详情
                </>
              ) : (
                <>
                  <ChevronDown className="h-4 w-4 mr-1" /> 展开处理详情
                </>
              )}
            </Button>
          )}
        </div>
        {row.status === 'resolved' && expanded ? (
          <div className="rounded-xl bg-muted p-3 space-y-1.5 text-sm">
            <p>
              <span className="text-muted-foreground">处置措施：</span>
              {row.action ?? '—'}
            </p>
            <p>
              <span className="text-muted-foreground">处置结论：</span>
              {row.resolution_note ?? '—'}
            </p>
            <p>
              <span className="text-muted-foreground">处理时间：</span>
              {row.handled_at ? formatRelativeTime(row.handled_at) : '—'}
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function AlertsPage() {
  const { profile } = useAuth();

  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState('all');

  // 处理弹窗状态
  const [resolveTarget, setResolveTarget] = useState<AlertRow | null>(null);
  const [resolveAction, setResolveAction] = useState('');
  const [resolveNote, setResolveNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // 已处理条目展开详情
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // 视图模式：按患者聚合（默认，告警疲劳对策）/ 按时间平铺
  const [viewMode, setViewMode] = useState<'grouped' | 'flat'>('grouped');
  // 聚合分组展开状态（patient_id 集合）
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // 首次加载自动展开最紧急分组，让「聚合 → 明细」层级一眼可见
  const autoExpandedRef = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    try {
      const rows = (await clinicianApi.alerts()) as unknown as AlertRow[];
      setAlerts(rows);
    } catch (e) {
      toast.error(`加载预警失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 统计：未处理红/黄
  const stats = useMemo(() => {
    let red = 0;
    let yellow = 0;
    for (const a of alerts) {
      if (a.status !== 'open') continue;
      if (a.level === 'red') red += 1;
      else yellow += 1;
    }
    return { red, yellow };
  }, [alerts]);

  // 排序：红在前黄在后，同级未处理在前、时间新的在前
  const visibleAlerts = useMemo(() => {
    const filtered = alerts.filter(a => tab === 'all' || a.status === tab);
    return [...filtered].sort((a, b) => {
      const levelRank = (l: AlertRow['level']) => (l === 'red' ? 0 : 1);
      const lr = levelRank(a.level) - levelRank(b.level);
      if (lr !== 0) return lr;
      const sr = (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1);
      if (sr !== 0) return sr;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [alerts, tab]);

  // 未处理 / 已处理拆分（聚合视图只对未处理预警分组）
  const openVisible = useMemo(() => visibleAlerts.filter(a => a.status === 'open'), [visibleAlerts]);
  const resolvedVisible = useMemo(() => visibleAlerts.filter(a => a.status === 'resolved'), [visibleAlerts]);

  // 按患者聚合：同一患者的多条未处理预警合并为一组，组内红在前、时间新的在前
  const groups = useMemo<AlertGroup[]>(() => {
    const byPatient = new Map<string, AlertRow[]>();
    for (const a of openVisible) {
      const arr = byPatient.get(a.patient_id) ?? [];
      arr.push(a);
      byPatient.set(a.patient_id, arr);
    }
    const result: AlertGroup[] = [];
    for (const [patientId, rows] of byPatient) {
      const sorted = [...rows].sort((a, b) => {
        const levelRank = (l: AlertRow['level']) => (l === 'red' ? 0 : 1);
        const lr = levelRank(a.level) - levelRank(b.level);
        if (lr !== 0) return lr;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
      const p = pickPatient(sorted[0]);
      const srcCount = new Map<AlertRow['source'], number>();
      for (const r of sorted) srcCount.set(r.source, (srcCount.get(r.source) ?? 0) + 1);
      result.push({
        patientId,
        name: p?.name ?? '未知患者',
        department: p?.department,
        level: sorted.some(r => r.level === 'red') ? 'red' : 'yellow',
        openCount: sorted.length,
        sources: [...srcCount.entries()].map(([source, count]) => ({ source, count })),
        alerts: sorted,
        latestAt: sorted[0]?.created_at ?? '',
      });
    }
    // 组间：红在前，同级最新动态在前
    return result.sort((a, b) => {
      const lr = (a.level === 'red' ? 0 : 1) - (b.level === 'red' ? 0 : 1);
      if (lr !== 0) return lr;
      return new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime();
    });
  }, [openVisible]);

  // 首次加载自动展开最紧急分组（只做一次，用户手动收起后不强行展开）
  useEffect(() => {
    if (!autoExpandedRef.current && groups.length > 0) {
      autoExpandedRef.current = true;
      setExpandedGroups(new Set([groups[0].patientId]));
    }
  }, [groups]);

  const toggleGroup = (patientId: string) =>
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(patientId)) next.delete(patientId);
      else next.add(patientId);
      return next;
    });

  // 是否走聚合视图：非「已处理」Tab 且有未处理预警
  const showGrouped = viewMode === 'grouped' && tab !== 'resolved' && openVisible.length > 0;

  const openResolveDialog = (row: AlertRow) => {
    setResolveTarget(row);
    setResolveAction('');
    setResolveNote('');
  };

  const submitResolve = async () => {
    if (!resolveTarget) return;
    if (!resolveAction) {
      toast.error('请选择处置措施');
      return;
    }
    if (resolveNote.trim().length < 5) {
      toast.error('请填写至少 5 个字的处置结论');
      return;
    }
    setSubmitting(true);
    try {
      await clinicianApi.resolveAlert(resolveTarget.id, resolveAction, resolveNote.trim(), profile?.id ?? '');
      toast.success('预警已处理');
      setResolveTarget(null);
      await load(true);
    } catch (e) {
      toast.error(`处理失败：${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleExpanded = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const emptyText =
    tab === 'open'
      ? '暂无未处理预警，患者状态平稳'
      : tab === 'resolved'
        ? '暂无已处理的预警记录'
        : '暂无预警记录';

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto">
      {/* 页头 + 手动刷新 */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg md:text-xl font-bold">预警中心</h1>
          <p className="text-sm text-muted-foreground mt-0.5">分级处理出院患者的异常预警</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void load(true)}
          disabled={refreshing}
        >
          <RotateCcw className={refreshing ? 'h-4 w-4 mr-1.5 animate-spin' : 'h-4 w-4 mr-1.5'} />
          刷新
        </Button>
      </div>

      {/* 统计头条 */}
      <div className="grid grid-cols-2 gap-3">
        <Card className="bg-triage-red-bg border-transparent">
          <CardContent className="p-4 md:p-5">
            <p className="text-sm text-triage-red font-medium">未处理红色预警</p>
            <p className="text-2xl md:text-3xl font-black text-triage-red mt-1">{stats.red} 条</p>
          </CardContent>
        </Card>
        <Card className="bg-triage-amber-bg border-transparent">
          <CardContent className="p-4 md:p-5">
            <p className="text-sm text-triage-amber font-medium">未处理黄色预警</p>
            <p className="text-2xl md:text-3xl font-black text-triage-amber mt-1">{stats.yellow} 条</p>
          </CardContent>
        </Card>
      </div>

      {/* 状态筛选 */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-3 md:w-auto">
          <TabsTrigger type="button" value="all">全部</TabsTrigger>
          <TabsTrigger type="button" value="open">未处理</TabsTrigger>
          <TabsTrigger type="button" value="resolved">已处理</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* 预警列表 */}
      {loading ? (
        <p className="text-sm text-muted-foreground text-center py-10">加载中…</p>
      ) : visibleAlerts.length === 0 ? (
        <Card>
          <CardContent className="p-10 flex flex-col items-center gap-2 text-center">
            <BellOff className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{emptyText}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {/* 视图切换：按患者聚合（默认）/ 按时间平铺 */}
          {openVisible.length > 0 && tab !== 'resolved' ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="text-xs text-muted-foreground">同一患者的多条预警可合并展示，避免告警疲劳</span>
              <div className="flex items-center gap-1 rounded-full bg-muted p-0.5">
                <button
                  type="button"
                  onClick={() => setViewMode('grouped')}
                  className={cn(
                    'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                    viewMode === 'grouped' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Users className="mr-1 inline h-3.5 w-3.5" />
                  按患者聚合
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('flat')}
                  className={cn(
                    'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                    viewMode === 'flat' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  按时间
                </button>
              </div>
            </div>
          ) : null}

          {showGrouped ? (
            groups.map(g => {
              const open = expandedGroups.has(g.patientId);
              const sourceText = g.sources.map(s => `${SOURCE_LABEL[s.source] ?? s.source} ×${s.count}`).join(' · ');
              return (
                <Card key={g.patientId} className="rounded-2xl">
                  <CardContent className="p-4 space-y-2.5">
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.patientId)}
                      className="flex w-full flex-wrap items-center gap-2 text-left"
                    >
                      <Badge className={g.level === 'red' ? LEVEL_BADGE.red.className : LEVEL_BADGE.yellow.className}>
                        {g.level === 'red' ? '红色' : '黄色'} · {g.openCount} 条未处理
                      </Badge>
                      <span className="text-sm font-bold">{g.name}</span>
                      {g.department ? <span className="text-xs text-muted-foreground">{g.department}</span> : null}
                      <span className="text-xs text-muted-foreground">{sourceText}</span>
                      <ChevronDown className={cn('ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
                    </button>
                    <p className="text-xs text-muted-foreground">
                      该患者 {g.openCount} 条未处理预警已合并展示{open ? '，点击标题收起明细' : '，点击标题展开明细'}
                    </p>
                    {open ? (
                      <div className="space-y-2.5 border-t border-border pt-2.5">
                        {g.alerts.map(row => (
                          <AlertItem
                            key={row.id}
                            row={row}
                            expanded={expandedIds.has(row.id)}
                            onToggleExpanded={toggleExpanded}
                            onResolve={openResolveDialog}
                          />
                        ))}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              );
            })
          ) : (
            visibleAlerts.map(row => (
              <AlertItem
                key={row.id}
                row={row}
                expanded={expandedIds.has(row.id)}
                onToggleExpanded={toggleExpanded}
                onResolve={openResolveDialog}
              />
            ))
          )}

          {/* 「全部」Tab 的聚合视图下，已处理预警以平铺方式展示在分组下方 */}
          {showGrouped && tab === 'all' && resolvedVisible.length > 0 ? (
            <div className="space-y-3 pt-2">
              <p className="text-xs font-medium text-muted-foreground">已处理 · {resolvedVisible.length} 条</p>
              {resolvedVisible.map(row => (
                <AlertItem
                  key={row.id}
                  row={row}
                  expanded={expandedIds.has(row.id)}
                  onToggleExpanded={toggleExpanded}
                  onResolve={openResolveDialog}
                />
              ))}
            </div>
          ) : null}
        </div>
      )}

      {/* 处理弹窗 */}
      <Dialog open={resolveTarget !== null} onOpenChange={open => !open && setResolveTarget(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] md:max-w-lg">
          <DialogHeader>
            <DialogTitle>处理预警</DialogTitle>
            <DialogDescription>
              {resolveTarget ? `${pickPatient(resolveTarget)?.name ?? '未知患者'} · ${resolveTarget.detail}` : ''}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={e => {
              e.preventDefault();
              void submitResolve();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="resolve-action">处置措施</Label>
              <Select value={resolveAction} onValueChange={setResolveAction} required>
                <SelectTrigger id="resolve-action" className="w-full">
                  <SelectValue placeholder="请选择处置措施" />
                </SelectTrigger>
                <SelectContent>
                  {ACTION_OPTIONS.map(opt => (
                    <SelectItem key={opt} value={opt}>
                      {opt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="resolve-note">处置结论</Label>
              <Textarea
                id="resolve-note"
                rows={4}
                required
                minLength={5}
                placeholder="请填写至少 5 个字的处置结论"
                value={resolveNote}
                onChange={e => setResolveNote(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setResolveTarget(null)}
                disabled={submitting}
              >
                取消
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? '提交中…' : '确认处理'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default AlertsPage;
