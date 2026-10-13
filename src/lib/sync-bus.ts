// CareLoop 跨端同步总线：基于 Supabase realtime broadcast 的轻量失效通知。
// 设计动机：postgres_changes 需要把表加入 supabase_realtime 发布（要改库），
// 而 broadcast 通道零后端配置、实测可用（tasks/test-realtime.mjs 冒烟通过）。
// 所有"用户动作"（打卡/服药/预警处理/发消息…）由动作发起端广播，
// 其他端的页面收到后自动 refetch；realtime 不可用时静默降级为既有的聚焦刷新。

import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/db/supabase';

/** 参与跨端同步的数据实体（与表名对齐） */
export type SyncEntity =
  | 'medication_logs'
  | 'reminders'
  | 'checkins'
  | 'symptom_checks'
  | 'alerts'
  | 'messages'
  | 'followups'
  | 'patients';

const CHANNEL_NAME = 'careloop-sync';

type Listener = (entities: SyncEntity[]) => void;
const listeners = new Set<Listener>();

let channel: RealtimeChannel | null = null;
let ready: Promise<void> | null = null;

/** 懒建单例通道；返回通道与"已订阅"就绪 Promise */
function ensureChannel(): { ch: RealtimeChannel; ready: Promise<void> } {
  if (channel && ready) return { ch: channel, ready };

  let markReady: () => void = () => {};
  ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  channel = supabase
    .channel(CHANNEL_NAME, { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'invalidate' }, (msg) => {
      const payload = msg?.payload as { entities?: unknown } | null;
      const entities = Array.isArray(payload?.entities)
        ? (payload.entities as unknown[]).filter((e): e is SyncEntity => typeof e === 'string')
        : [];
      if (entities.length === 0) return;
      for (const listener of listeners) listener(entities);
    });
  channel.subscribe((status) => {
    // 一次性标记就绪；断线后 phoenix 会自动重连，重连成功即可继续收发
    if (status === 'SUBSCRIBED') markReady();
  });
  return { ch: channel, ready };
}

/**
 * 写操作成功后广播失效通知。fire-and-forget：
 * 最多等 3s 订阅就绪（页面挂载时 useRealtimeSync 已提前建连，通常瞬时完成），
 * 超时或异常一律静默——同步总线挂了不能影响业务写入本身。
 */
export function broadcastChange(entities: SyncEntity[]): void {
  try {
    const { ch, ready: rdy } = ensureChannel();
    void Promise.race([rdy, new Promise((r) => setTimeout(r, 3000))]).then(() => {
      ch.send({ type: 'broadcast', event: 'invalidate', payload: { entities } });
    });
  } catch {
    /* 静默降级：realtime 不可用时退化为聚焦刷新兜底 */
  }
}

/**
 * 注册失效监听，返回取消函数。首次调用即建立通道订阅（早连接）。
 */
export function onSyncChange(cb: Listener): () => void {
  listeners.add(cb);
  ensureChannel();
  return () => {
    listeners.delete(cb);
  };
}
