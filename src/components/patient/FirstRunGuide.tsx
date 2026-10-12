// 首次使用引导（患者端首页顶部）：告诉刚出院的患者「现在最该做的三件事」。
// 仅在患者确实没有任何数据（无打卡 / 无用药记录 / 无消息）时出现，且可关闭；
// 完成任一步或手动关闭后写入 localStorage，之后不再出现。

import { HeartPulse, Pill, ShieldAlert, Stethoscope, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

const STEPS = [
  {
    to: '/patient/checkin',
    icon: HeartPulse,
    title: '记录今天的体征',
    desc: '血压、心率填一次就好，之后才能看出变化',
    cta: '去打卡',
  },
  {
    to: '/patient/medications',
    icon: Pill,
    title: '确认今天的用药',
    desc: '吃过就在对应时段点一下，医护能看到',
    cta: '去确认',
  },
  {
    to: '/patient/symptom',
    icon: Stethoscope,
    title: '不舒服就先自查',
    desc: '说说哪里不舒服，系统会告诉您下一步该怎么做',
    cta: '去自查',
  },
];

// localStorage 键名统一前缀，按患者隔离
const KEY_PREFIX = 'careloop:onboarding:';

// 读取记忆：手动关闭过、或已完成任一步 → 不再展示
export function isOnboardingDone(patientId: string): boolean {
  try {
    const s = window.localStorage;
    return (
      s.getItem(`${KEY_PREFIX}dismissed:${patientId}`) === '1' ||
      s.getItem(`${KEY_PREFIX}done:${patientId}`) === '1'
    );
  } catch {
    return false;
  }
}

function remember(patientId: string, kind: 'dismissed' | 'done') {
  try {
    window.localStorage.setItem(`${KEY_PREFIX}${kind}:${patientId}`, '1');
  } catch {
    /* 隐私模式下写入失败不影响使用 */
  }
}

interface Props {
  patientId: string;
  onDismiss: () => void;
}

export function FirstRunGuide({ patientId, onDismiss }: Props) {
  return (
    <section
      id="first-run-guide"
      className="rounded-2xl border border-dashed border-border bg-muted/40 p-4"
      aria-label="首次使用引导"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">刚开始使用？先做完这三件事</p>
          <p className="mt-0.5 text-xs text-muted-foreground">都是一分钟的事，做完首页就会有内容了</p>
        </div>
        <button
          type="button"
          onClick={() => {
            remember(patientId, 'dismissed');
            onDismiss();
          }}
          className="-mr-1 -mt-1 shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="关闭首次使用引导"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <ol className="mt-3 space-y-2">
        {STEPS.map((s, i) => (
          <li key={s.to} className="flex items-center gap-3 rounded-xl bg-card px-3 py-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10">
              <s.icon className="h-4 w-4 text-primary" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                <span className="sig-num text-muted-foreground">{i + 1}. </span>
                {s.title}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{s.desc}</p>
            </div>
            <Button
              asChild
              size="sm"
              variant="outline"
              className="h-8 shrink-0 rounded-xl text-xs"
              onClick={() => remember(patientId, 'done')}
            >
              <Link to={s.to}>{s.cta}</Link>
            </Button>
          </li>
        ))}
      </ol>

      <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>遇到紧急情况（胸痛、呼吸困难、意识不清等）请直接联系随访科室或就近就医，不要等这里的结果。</span>
      </p>
    </section>
  );
}
