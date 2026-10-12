// 移动优先外壳：患者端 / 家属端共用。
// 移动端 = 全屏窄列（max-w-md + 底部 Tab，行为与旧版完全一致）；
// 桌面（md+）= 居中的「设备框」+ 品牌化柔光背景 + 框下说明——
// 比赛投屏 16:9 大屏下避免移动端页面只是一条空窄列，
// 同时强化「患者/家属用手机、医护用 Web 工作台」的产品叙事。
import type { ReactNode } from 'react';

interface MobileShellProps {
  /** 桌面框下方说明文案（如「愈见 CareLoop · 患者端」）；移动端不展示 */
  caption?: string;
  /** 头部区域（可选，如家属端照护横幅） */
  header?: ReactNode;
  /** 底部导航内容（Tab 栅格） */
  nav: ReactNode;
  children: ReactNode;
}

export function MobileShell({ caption, header, nav, children }: MobileShellProps) {
  return (
    <div className="relative flex min-h-screen justify-center bg-background md:items-center md:bg-gradient-to-br md:from-sig-soft-bg md:via-background md:to-sig-mid-bg md:p-6">
      {/* 桌面演示装饰：柔光斑，移动端不渲染 */}
      <div aria-hidden className="pointer-events-none hidden md:block absolute inset-0 overflow-hidden">
        <div className="absolute -top-24 left-1/4 h-72 w-72 rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute -bottom-24 right-1/4 h-80 w-80 rounded-full bg-triage-green/10 blur-3xl" />
      </div>

      <div className="relative z-10 flex w-full max-w-md flex-col items-center">
        {/* 设备框：移动端通栏；md+ 圆角边框 + 投影，内容内部滚动 */}
        <div className="relative flex w-full min-h-screen flex-col overflow-hidden border-x border-border/60 bg-background md:min-h-0 md:h-[calc(100dvh-5rem)] md:rounded-[2.5rem] md:border md:shadow-2xl">
          {header}
          <main className="min-w-0 flex-1 pb-24 md:overflow-y-auto">{children}</main>
          {/* 底部导航：移动端固定视口底部；桌面吸附设备框底部 */}
          <div className="fixed bottom-0 left-1/2 z-40 w-full max-w-md -translate-x-1/2 border-t border-border bg-card md:absolute md:inset-x-0 md:bottom-0 md:left-0 md:translate-x-0">
            {nav}
          </div>
        </div>
        {caption ? <p className="hidden md:block mt-3 text-xs text-muted-foreground">{caption}</p> : null}
      </div>
    </div>
  );
}

export default MobileShell;
