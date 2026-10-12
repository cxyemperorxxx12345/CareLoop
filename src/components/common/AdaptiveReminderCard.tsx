import { AlertTriangle, BellOff, ShieldCheck } from 'lucide-react';
import type { ReminderAdaptResult } from '@/lib/reminder-adapt';

const TONE: Record<ReminderAdaptResult['rules'][number]['tone'], { icon: typeof BellOff; cls: string }> = {
  calm: { icon: BellOff, cls: 'text-emerald-600 bg-emerald-50 border-emerald-200' },
  watch: { icon: AlertTriangle, cls: 'text-amber-600 bg-amber-50 border-amber-200' },
  shield: { icon: ShieldCheck, cls: 'text-sky-600 bg-sky-50 border-sky-200' },
};

export function AdaptiveReminderCard({ result, subject = '你' }: { result: ReminderAdaptResult; subject?: string }) {
  const idx = result.disturbanceIndex;
  const color = idx <= 40 ? '#10b981' : idx >= 75 ? '#ef4444' : '#f59e0b';
  const R = 34;
  const C = 2 * Math.PI * R;
  const dash = (idx / 100) * C;

  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <BellOff className="h-5 w-5 text-primary" />
        <h3 className="font-semibold">智能提醒 · 已按{subject}的习惯自适应</h3>
      </div>

      <div className="flex items-center gap-4">
        <div className="relative shrink-0">
          <svg width="92" height="92" viewBox="0 0 92 92" role="img" aria-label={`打扰指数 ${idx}`}>
            <circle cx="46" cy="46" r={R} fill="none" stroke="#e5e7eb" strokeWidth="9" />
            <circle
              cx="46"
              cy="46"
              r={R}
              fill="none"
              stroke={color}
              strokeWidth="9"
              strokeLinecap="round"
              strokeDasharray={`${dash} ${C}`}
              transform="rotate(-90 46 46)"
            />
            <text x="46" y="44" textAnchor="middle" className="fill-foreground" fontSize="20" fontWeight="700">
              {idx}
            </text>
            <text x="46" y="60" textAnchor="middle" className="fill-muted-foreground" fontSize="9">
              打扰指数
            </text>
          </svg>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">{result.summary}</p>
      </div>

      {result.rules.length > 0 && (
        <ul className="mt-3 space-y-2">
          {result.rules.map((r, i) => {
            const t = TONE[r.tone];
            const Icon = t.icon;
            return (
              <li key={i} className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-sm ${t.cls}`}>
                <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{r.text}</span>
              </li>
            );
          })}
        </ul>
      )}

      {!result.hasData && (
        <p className="mt-3 text-xs text-muted-foreground">随着{subject}开始打卡，系统会逐步学习{subject}的服药节奏并自动减扰。</p>
      )}
    </section>
  );
}
