/**
 * 愈见 CareLoop 品牌标记（图形版）
 *
 * 开口环 + 心 + 脉搏线：环是照护闭环，心是照护对象，脉搏线自缺口穿出、指向「持续监测」。
 * 断口留在右下（约 85°），环上的心跳线正好落在这个缺口里，不与环重叠。
 *
 * 说明：整站配色走「医疗青绿」，标记用 currentColor，浅色主题传 text-primary、
 * 深色底传 text-primary-foreground 即可，不需要维护两份资源。
 * 网格：64×64，描边 7（=33px 下的 3.6px，缩到 24px 仍清晰）。
 */
export interface BrandMarkProps {
  className?: string;
  /** 无障碍名称；纯装饰场景（如旁边已有「愈见 CareLoop」文字）可传空字符串 */
  title?: string;
}

export function BrandMark({ className, title = '愈见 CareLoop' }: BrandMarkProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      fill="none"
    >
      {/* 闭环：开口环，断口 -67°→10°（外径 58、描边 7.2，比例取自原图实测：描边 = 外径 12.3%） */}
      <path
        d="M 57.01 27.59 A 25.4 25.4 0 1 0 41.92 55.38"
        stroke="currentColor"
        strokeWidth="7.2"
        strokeLinecap="round"
      />
      {/* 心：被环护住的核心（实测原图：宽 = 外径 34.5%、高 = 27.3%，水平居中、下移 2%） */}
      <path
        d="M 32 41.2 C 32 41.2 22 35.4 22 30.2 C 22 27.2 24.4 25.2 26.8 25.2 C 29 25.2 30.8 26.9 32 29.6 C 33.2 26.9 35 25.2 37.2 25.2 C 39.6 25.2 42 27.2 42 30.2 C 42 35.4 32 41.2 32 41.2 Z"
        fill="currentColor"
      />
      {/* 脉搏：比环细一半（实测 6.7% vs 12.3% 外径），尖峰升至心的底缘，尾端穿出环外 */}
      <path
        d="M 35 48 H 43 L 46.5 40.5 L 50.5 56 L 53.5 48 H 61"
        stroke="currentColor"
        strokeWidth="4.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default BrandMark;
