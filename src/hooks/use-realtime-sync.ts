import { useEffect, useRef } from 'react';

import { type SyncEntity, onSyncChange } from '@/lib/sync-bus';

/**
 * 跨端实时刷新：任一端广播的数据变化命中本页关心的实体时，自动执行 refetch。
 * 与 useRefetchOnFocus 互补——本钩子管"别的端动了数据"，聚焦刷新管"服务端
 * 定时任务（cron）产生的变化"（cron 无前端动作发起端，广播覆盖不到）。
 *
 * @param refetch  刷新逻辑（ref 保存，始终调用最新闭包，无需稳定引用）
 * @param entities 关心的实体；省略表示任何变化都刷新。请传模块级常量数组
 *                 （本钩子只读一次语义，不随数组引用变化重订阅）
 */
export function useRealtimeSync(refetch: () => void, entities?: SyncEntity[]): void {
  const cbRef = useRef(refetch);
  cbRef.current = refetch;

  const keyRef = useRef(entities ? entities.join('|') : '*');
  // entities 约定为常量，不响应其变化；若未来需要动态实体，再演进为受控依赖

  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      // 400ms 合并窗口：一次动作可能连续广播多条（如打卡+发消息），只刷一次
      window.clearTimeout(timer);
      timer = window.setTimeout(() => cbRef.current(), 400);
    };
    const off = onSyncChange((incoming) => {
      const watched = keyRef.current;
      if (watched === '*' || watched === '') {
        schedule();
        return;
      }
      const watchedSet = watched.split('|');
      if (incoming.some((e) => watchedSet.includes(e))) schedule();
    });
    return () => {
      window.clearTimeout(timer);
      off();
    };
  }, []);
}
