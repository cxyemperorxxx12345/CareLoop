import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSnapshots,
  enqueue,
  formatSnapshotTime,
  isDryRun,
  isOfflineEnabled,
  readQueue,
  readSnapshot,
  replayQueue,
  saveSnapshot,
  setOfflineEnabled,
} from './offline-cache';

// 真实 IndexedDB 在 jsdom 里不可用（或不可靠），统一走 localStorage 降级路径，
// 这正好覆盖了同一套 read/save 语义中最常用的兜底分支。
beforeEach(async () => {
  localStorage.clear();
  setOfflineEnabled(true);
  await clearSnapshots();
});

describe('offline-cache 快照', () => {
  it('写入后能原样回读，并带 savedAt 时间戳', async () => {
    await saveSnapshot('k1', { hello: '世界', n: 42 });
    const snap = await readSnapshot<{ hello: string; n: number }>('k1');
    expect(snap).not.toBeNull();
    expect(snap?.data).toEqual({ hello: '世界', n: 42 });
    expect(typeof snap?.savedAt).toBe('number');
  });

  it('没有快照时返回 null，而不是抛错', async () => {
    expect(await readSnapshot('missing')).toBeNull();
  });

  it('一键关闭后读写均为空操作（careloop:offline-disabled）', async () => {
    setOfflineEnabled(false);
    expect(isOfflineEnabled()).toBe(false);
    await saveSnapshot('k2', { a: 1 });
    expect(await readSnapshot('k2')).toBeNull();
    expect(localStorage.getItem('careloop:offline:ls:k2')).toBeNull();
  });

  it('重新开启后恢复读写', async () => {
    setOfflineEnabled(false);
    await saveSnapshot('k3', { a: 1 });
    expect(await readSnapshot('k3')).toBeNull();
    setOfflineEnabled(true);
    await saveSnapshot('k3', { a: 2 });
    expect((await readSnapshot<{ a: number }>('k3'))?.data).toEqual({ a: 2 });
  });

  it('超过单条体积上限时拒绝写入（静默跳过，不抛错）', async () => {
    const big = { blob: 'x'.repeat(600 * 1024) };
    await saveSnapshot('k4', big);
    expect(await readSnapshot('k4')).toBeNull();
  });
});

describe('offline-cache 操作队列', () => {
  it('入队后能按顺序读取', async () => {
    const a = await enqueue('medication-log', { planId: 'p1', slot: 0 });
    const b = await enqueue('medication-log', { planId: 'p2', slot: 1 });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const list = readQueue();
    expect(list).toHaveLength(2);
    expect(list[0].payload).toEqual({ planId: 'p1', slot: 0 });
    expect(list[1].payload).toEqual({ planId: 'p2', slot: 1 });
  });

  it('重放：成功即出队，失败保留并累计 attempts', async () => {
    await enqueue('medication-log', { id: 'ok-1' });
    await enqueue('medication-log', { id: 'bad-1' });
    const result = await replayQueue(async (item) => {
      if ((item.payload as { id: string }).id.startsWith('bad')) {
        throw new Error('网络仍不可用');
      }
    });
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    const remaining = readQueue();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].attempts).toBe(1);
    expect(remaining[0].lastError).toBe('网络仍不可用');
  });

  it('演练模式（careloop:offline-dry-run=1）只入队不发送', async () => {
    localStorage.setItem('careloop:offline-dry-run', '1');
    expect(isDryRun()).toBe(true);
    await enqueue('medication-log', { id: 'dry-1' });
    const result = await replayQueue(async () => {
      throw new Error('演练模式不应调用 sender');
    });
    expect(result.sent).toBe(0);
    expect(result.remaining).toBe(1);
  });

  it('一键关闭后入队返回 null（调用方回退网络不可用提示）', async () => {
    setOfflineEnabled(false);
    expect(await enqueue('medication-log', { a: 1 })).toBeNull();
    expect(readQueue()).toHaveLength(0);
  });
});

describe('formatSnapshotTime', () => {
  it('今天的快照只显示 HH:MM', () => {
    const now = new Date();
    const ts = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 5).getTime();
    expect(formatSnapshotTime(ts)).toBe('09:05');
  });

  it('非今天的快照带「M月D日」前缀，避免误读为今天', () => {
    const now = new Date();
    // 取去年同月同日，必然不是今天且不跨年歧义
    const ts = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate(), 14, 30).getTime();
    expect(formatSnapshotTime(ts)).toBe(
      `${now.getMonth() + 1}月${now.getDate()}日 14:30`,
    );
  });
});
