// 统一的「退出登录」按钮：患者端与家属端共用，保证图标、文案、交互完全一致。
// 采用「图标 + 文字」而非纯图标——文字标签对老年用户更明确，不易误触也不易误解。

import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface SignOutButtonProps {
  onClick: () => void;
  /** 按钮可见文案，默认「退出」；无障碍标签统一为「退出登录」 */
  label?: string;
  className?: string;
}

export function SignOutButton({ onClick, label = '退出', className }: SignOutButtonProps) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label="退出登录"
      onClick={onClick}
      className={cn(
        'h-10 shrink-0 gap-1.5 rounded-xl border-border px-3 text-sm text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive',
        className,
      )}
    >
      <LogOut className="h-4 w-4" />
      {label}
    </Button>
  );
}
