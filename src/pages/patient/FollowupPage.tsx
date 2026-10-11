// 随访时间轴：按 due_date 升序的垂直时间线，支持乐观更新完成状态
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarHeart, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { supabase } from '@/db/supabase';
import { getMyPatient, patientApi } from '@/lib/api';
import { cn } from '@/lib/utils';

// 与数据库真实列名一致的本地行类型
interface FollowupRow { id: string; title: string; category: string; due_date: string; detail: string | null; done: boolean; }

const CATEGORY_LABELS: Record<string, string> = {
  review: '复查',
  recheck: '复查',
  med_change: '换药',
  suture: '拆线',
  visit: '复诊',
  followup: '复诊',
};

function categoryLabel(c: string): string {
  return CATEGORY_LABELS[c] ?? (c || '随访');
}

// MM-DD 等宽数字展示，跨年追加年份
function fmtDue(d: string, todayYear: string): string {
  const p = d.slice(0, 10).split('-');
  if (p.length !== 3) return d;
  return p[0] === todayYear ? `${p[1]}-${p[2]}` : `${p[0].slice(2)}-${p[1]}-${p[2]}`;
}

export function FollowupPage() {
  const [loading, setLoading] = useState(true);
  const [patientId, setPatientId] = useState<string | null>(null);
  const [items, setItems] = useState<FollowupRow[]>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const p = await getMyPatient();
        if (!alive) return;
        if (p) {
          setPatientId(p.id);
          const rows = (await patientApi.followupItems(p.id)) as unknown as FollowupRow[];
          if (alive) setItems(rows);
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '加载失败，请稍后重试');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 乐观更新完成状态，失败回滚
  async function toggleDone(item: FollowupRow) {
    if (!patientId) return;
    const prev = items;
    setItems((cur) => cur.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)));
    const { error } = await supabase.from('followup_items').update({ done: !item.done }).eq('id', item.id);
    if (error) {
      setItems(prev);
      toast.error('更新失败，请重试');
    } else {
      toast.success(item.done ? '已重新打开待办' : '已完成，真棒');
    }
  }

  if (loading) {
    return (
      <div className="p-4 space-y-4">
        <div className="space-y-2 pt-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-48" />
        </div>
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-24 w-full rounded-2xl" />
      </div>
    );
  }

  if (!patientId) {
    return (
      <div className="p-4 pt-10">
        <Card className="rounded-2xl">
          <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
            <CalendarHeart className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">还没有找到您的患者档案，请先登录后再查看随访计划。</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const todayYear = today.slice(0, 4);
  const doneCount = items.filter((i) => i.done).length;

  return (
    <div className="p-4 space-y-4">
      <div className="pt-2">
        <h1 className="text-2xl font-bold">随访计划</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          共 {items.length} 项 · 已完成 {doneCount} 项
        </p>
      </div>

      {items.length === 0 ? (
        <Card className="rounded-2xl">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <CalendarHeart className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              暂无随访计划。上传出院资料后，会为您自动生成复查、换药、拆线等随访时间轴。
            </p>
            <Button asChild className="rounded-2xl">
              <Link to="/patient/documents">去上传资料</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="rounded-2xl p-4">
          {/* 垂直时间线：左侧竖线 + 圆点节点 */}
          <div className="relative">
            <div aria-hidden className="absolute bottom-3 left-[7px] top-2 w-px bg-border" />
            <ul className="space-y-5">
              {items.map((item) => {
                const overdue = !item.done && item.due_date.slice(0, 10) < today;
                return (
                  <li key={item.id} className="relative pl-7">
                    <span
                      className={cn(
                        'absolute left-0 top-1 flex h-4 w-4 items-center justify-center rounded-full border-2',
                        item.done
                          ? 'border-triage-green bg-triage-green'
                          : overdue
                            ? 'border-triage-amber bg-triage-amber-bg'
                            : 'border-border bg-card',
                      )}
                    >
                      {item.done && <Check className="h-2.5 w-2.5 text-triage-green-bg" />}
                    </span>
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={cn(
                              'sig-num text-sm font-semibold',
                              overdue && 'text-triage-amber',
                              item.done && 'text-muted-foreground',
                            )}
                          >
                            {fmtDue(item.due_date, todayYear)}
                          </span>
                          <Badge variant="secondary">{categoryLabel(item.category)}</Badge>
                          {overdue && (
                            <Badge className="bg-triage-amber-bg text-triage-amber">已逾期</Badge>
                          )}
                        </div>
                        <p className={cn('text-sm font-medium', item.done && 'text-muted-foreground line-through')}>
                          {item.title}
                        </p>
                        {item.detail && <p className="text-sm text-muted-foreground">{item.detail}</p>}
                      </div>
                      <label
                        className="flex h-11 w-11 shrink-0 items-center justify-center"
                        aria-label="打勾标记完成"
                      >
                        <Checkbox
                          checked={item.done}
                          onCheckedChange={() => void toggleDone(item)}
                          className="h-5 w-5"
                        />
                      </label>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </Card>
      )}
    </div>
  );
}
export default FollowupPage;
