// 机制② 展示组件：CareRisk 随访关注评分卡
// 三端复用：患者（自我觉察）/ 家属（照护对象）/ 医护（360 与列表）。纯展示，数据来自 computeCareRisk。

import { Activity } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CARERISK_META, CareRiskResult, riskTone } from '@/lib/carerisk';

export function CareRiskCard({ result, compact = false }: { result: CareRiskResult; compact?: boolean }) {
  const meta = CARERISK_META[result.level];
  const R = 34;
  const C = 2 * Math.PI * R;
  const offset = C * (1 - result.score / 100);

  return (
    <Card className="rounded-2xl">
      <CardHeader className={compact ? 'pb-2' : 'pb-2'}>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4 shrink-0 text-primary" />
          CareRisk 随访关注评分
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            基于本人近 {result.windowDays} 天轨迹
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-4">
          {/* 环形评分 */}
          <svg width="84" height="84" viewBox="0 0 84 84" className="shrink-0" role="img" aria-label={`随访关注评分 ${result.score}`}>
            <circle cx="42" cy="42" r={R} fill="none" stroke="hsl(var(--border))" strokeWidth="8" />
            <circle
              cx="42"
              cy="42"
              r={R}
              fill="none"
              stroke={meta.ring}
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={C}
              strokeDashoffset={offset}
              transform="rotate(-90 42 42)"
            />
            <text x="42" y="40" textAnchor="middle" className="sig-num" fontSize="22" fontWeight="800" fill="hsl(var(--foreground))">
              {result.score}
            </text>
            <text x="42" y="56" textAnchor="middle" fontSize="10" fill="hsl(var(--muted-foreground))">
              /100
            </text>
          </svg>

          <div className="min-w-0 flex-1">
            <Badge className={meta.cls}>{meta.label}关注度</Badge>
            <p className="mt-2 text-sm leading-relaxed text-foreground/80">{result.forecast}</p>
          </div>
        </div>

        {/* 四维风险条 */}
        <div className="grid grid-cols-2 gap-2">
          {result.dimensions.map((d) => {
            const tone = riskTone(d.risk);
            return (
              <div key={d.key} className="rounded-xl bg-muted/50 p-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{d.label}</span>
                  <span className={`sig-num font-semibold ${tone.text}`}>{Math.round(d.risk * 100)}</span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-border">
                  <div className="h-full rounded-full" style={{ width: `${Math.round(d.risk * 100)}%`, background: tone.ring }} />
                </div>
              </div>
            );
          })}
        </div>

        {/* 驱动因子 */}
        <div className="flex flex-wrap gap-1.5">
          {result.drivers.map((d) => (
            <span key={d} className="rounded-full bg-muted px-2.5 py-1 text-xs text-foreground/70">
              {d}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
