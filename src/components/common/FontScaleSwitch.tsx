// 适老化字号档位切换器：小 / 中 / 大，全局生效并本地记忆

import { ALargeSmall } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { applyFontScale, FONT_SCALE_OPTIONS, type FontScale, readFontScale, saveFontScale } from '@/lib/font-scale';
import { cn } from '@/lib/utils';

export function FontScaleSwitch({ className }: { className?: string }) {
  const [scale, setScale] = useState<FontScale>(readFontScale);

  // 挂载即应用一次：从其它页面进入时保持已选档位
  useEffect(() => {
    applyFontScale(scale);
  }, [scale]);

  const select = useCallback((next: FontScale) => {
    setScale(next);
    saveFontScale(next);
    applyFontScale(next);
  }, []);

  return (
    <div className={cn('flex items-center gap-2.5 rounded-2xl border border-border bg-card px-3 py-2', className)}>
      <ALargeSmall className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">字号</span>
      <div className="ml-auto flex items-center gap-1 rounded-full bg-muted p-0.5">
        {FONT_SCALE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => select(opt.value)}
            aria-pressed={scale === opt.value}
            className={cn(
              'min-w-[2.75rem] rounded-full px-2.5 py-1.5 text-sm font-medium transition-colors',
              scale === opt.value
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default FontScaleSwitch;
