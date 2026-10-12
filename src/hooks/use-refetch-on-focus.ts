import { useEffect, useRef } from 'react';

/**
 * 页面重新可见 / 窗口重新获得焦点时触发回调，用于数据保鲜。
 * 典型场景：患者离开 App 一会儿，期间提醒扫描（cron）产生了新消息/新提醒，
 * 回到页面时自动拉一次最新数据；配 minGapMs 节流，避免频繁切换标签时打爆接口。
 *
 * @param cb       要执行的刷新逻辑（内部用 ref 保存，始终调用最新闭包）
 * @param minGapMs 距上次触发不足该毫秒数则跳过，默认 15s
 */
export function useRefetchOnFocus(cb: () => void, minGapMs = 15000): void {
  const lastRun = useRef(0);
  const cbRef = useRef(cb);
  cbRef.current = cb;

  useEffect(() => {
    const run = () => {
      const now = Date.now();
      if (now - lastRun.current < minGapMs) return;
      lastRun.current = now;
      cbRef.current();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') run();
    };
    window.addEventListener('focus', run);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', run);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [minGapMs]);
}
