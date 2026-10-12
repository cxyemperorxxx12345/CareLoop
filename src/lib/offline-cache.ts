// 离线可读兜底：最近一次成功加载的数据写本地快照，断网时回读，界面强制标注「离线数据」。
// 存储：IndexedDB 优先，失败（隐私模式 / 无 IDB）降级到 localStorage，键名统一 careloop:offline: 前缀。
//
// 一键关闭（任一命中即整体停用，页面退回原本的实时加载 + 错误态）：
//   1) 浏览器控制台执行 __careloopOffline.disable()   （等价于下面两条，立即生效无需改代码）
//   2) localStorage['careloop:offline-disabled'] = '1'
//   3) 环境变量 VITE_OFFLINE_DISABLED=true（用于构建时彻底关闭）

const KEY_PREFIX = 'careloop:offline:';
const DISABLED_FLAG = 'careloop:offline-disabled';
// 演练模式：localStorage['careloop:offline-dry-run'] = '1' 时只入队不发送，
// 用于验证队列与重放逻辑而不往真实库写任何数据。
const DRY_RUN_FLAG = 'careloop:offline-dry-run';
const LS_SNAPSHOT = 'careloop:offline:ls:';
const LS_QUEUE = 'careloop:offline:queue';

const DB_NAME = 'careloop-offline';
const DB_VERSION = 1;
const STORE_SNAPSHOTS = 'snapshots';

// 缓存体积上限：快照条目数与单条序列化体积双重限制，超出则拒绝写入（不抛错）
const MAX_SNAPSHOTS = 24;
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_QUEUE_ITEMS = 200;

/** 离线兜底是否启用（关闭后 save/read 均为空操作，页面行为与改动前一致） */
export function isOfflineEnabled(): boolean {
  try {
    if (localStorage.getItem(DISABLED_FLAG)) return false;
  } catch {
    /* localStorage 不可用时不因此停用 */
  }
  return import.meta.env.VITE_OFFLINE_DISABLED !== 'true';
}

export function setOfflineEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.removeItem(DISABLED_FLAG);
    else localStorage.setItem(DISABLED_FLAG, '1');
  } catch {
    /* 忽略 */
  }
}

/** 当前是否处于离线状态（navigator.onLine 为 false 视为离线） */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** 演练模式：入队但不真正发送（避免验证过程往真实库写数据） */
export function isDryRun(): boolean {
  try {
    return localStorage.getItem(DRY_RUN_FLAG) === '1';
  } catch {
    return false;
  }
}

// ===== IndexedDB =====

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
        db.createObjectStore(STORE_SNAPSHOTS, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const t = db.transaction(STORE_SNAPSHOTS, mode);
          const req = run(t.objectStore(STORE_SNAPSHOTS));
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

// ===== 快照 =====

export interface Snapshot<T> {
  /** 快照数据（上一次成功加载时的服务端返回） */
  data: T;
  /** 写入时间戳（毫秒） */
  savedAt: number;
}

interface SnapshotRecord {
  key: string;
  data: unknown;
  savedAt: number;
}

function safeStringify(data: unknown): string | null {
  try {
    return JSON.stringify(data);
  } catch {
    return null;
  }
}

/** 写入快照；超过体积上限或功能被关闭时静默跳过，绝不影响主流程 */
export async function saveSnapshot<T>(key: string, data: T): Promise<void> {
  if (!isOfflineEnabled()) return;
  const json = safeStringify(data);
  if (json === null) return;
  if (json.length > MAX_SNAPSHOT_BYTES) {
    console.warn(`[offline] 快照 ${key} 体积 ${json.length}B 超过上限，已跳过`);
    return;
  }
  const record: SnapshotRecord = { key: KEY_PREFIX + key, data, savedAt: Date.now() };
  const ok = await tx('readwrite', (s) => s.put(record) as IDBRequest<IDBValidKey>);
  if (ok === null) {
    // IndexedDB 不可用 → 降级 localStorage（写失败同样忽略）
    try {
      localStorage.setItem(LS_SNAPSHOT + key, JSON.stringify({ data, savedAt: record.savedAt }));
    } catch {
      /* 配额不足时放弃 */
    }
    return;
  }
  void pruneSnapshots();
}

/** 回读快照；无快照 / 功能关闭 / 数据损坏时返回 null */
export async function readSnapshot<T>(key: string): Promise<Snapshot<T> | null> {
  if (!isOfflineEnabled()) return null;
  const rec = await tx<SnapshotRecord>('readonly', (s) => s.get(KEY_PREFIX + key) as IDBRequest<SnapshotRecord>);
  if (rec && typeof rec.savedAt === 'number' && rec.data !== undefined) {
    return { data: rec.data as T, savedAt: rec.savedAt };
  }
  try {
    const raw = localStorage.getItem(LS_SNAPSHOT + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data?: T; savedAt?: number };
    if (typeof parsed.savedAt !== 'number' || parsed.data === undefined) return null;
    return { data: parsed.data, savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

/** 清理超出条目上限的旧快照（按 savedAt 升序淘汰最旧的） */
async function pruneSnapshots(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const all = await new Promise<SnapshotRecord[]>((resolve) => {
      const t = db.transaction(STORE_SNAPSHOTS, 'readonly');
      const req = t.objectStore(STORE_SNAPSHOTS).getAll() as IDBRequest<SnapshotRecord[]>;
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => resolve([]);
    });
    if (all.length <= MAX_SNAPSHOTS) return;
    const stale = all
      .filter((r) => typeof r.savedAt === 'number')
      .sort((a, b) => a.savedAt - b.savedAt)
      .slice(0, all.length - MAX_SNAPSHOTS);
    for (const r of stale) {
      await tx('readwrite', (s) => s.delete(r.key) as unknown as IDBRequest<IDBValidKey>);
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/** 清空全部离线快照（排障 / 退出登录时使用） */
export async function clearSnapshots(): Promise<void> {
  try {
    const db = await openDb();
    if (db) await tx('readwrite', (s) => s.clear() as unknown as IDBRequest<undefined>);
  } catch {
    /* 忽略 */
  }
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(LS_SNAPSHOT)) localStorage.removeItem(k);
    }
  } catch {
    /* 忽略 */
  }
}

// ===== 离线操作队列（阶段二：离线打卡入队，恢复网络后重放）=====

export interface QueuedItem<P = Record<string, unknown>> {
  id: string;
  /** 操作类型，如 'medication-log' */
  kind: string;
  payload: P;
  createdAt: number;
  /** 重放失败次数 */
  attempts: number;
  lastError?: string;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readQueueLs(): QueuedItem[] {
  try {
    const raw = localStorage.getItem(LS_QUEUE);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedItem[]) : [];
  } catch {
    return [];
  }
}

function writeQueueLs(items: QueuedItem[]): void {
  try {
    localStorage.setItem(LS_QUEUE, JSON.stringify(items));
  } catch {
    /* 配额不足时放弃 */
  }
}

/**
 * 入队一条离线操作。仅入队，不发送（发送统一由 replayQueue 完成）。
 * 功能被关闭时直接返回 null，调用方应回退到「网络不可用」提示。
 */
export async function enqueue<P>(kind: string, payload: P): Promise<QueuedItem<P> | null> {
  if (!isOfflineEnabled()) return null;
  const item: QueuedItem<P> = { id: newId(), kind, payload, createdAt: Date.now(), attempts: 0 };
  const list = readQueueLs();
  list.push(item as unknown as QueuedItem);
  // 队列同样有上限，超出丢弃最旧的（避免无限堆积）
  while (list.length > MAX_QUEUE_ITEMS) list.shift();
  writeQueueLs(list);
  return item;
}

export function readQueue(): QueuedItem[] {
  if (!isOfflineEnabled()) return [];
  return readQueueLs();
}

export function removeQueued(id: string): void {
  writeQueueLs(readQueueLs().filter((i) => i.id !== id));
}

function markFailed(id: string, error: string): void {
  writeQueueLs(
    readQueueLs().map((i) => (i.id === id ? { ...i, attempts: i.attempts + 1, lastError: error } : i)),
  );
}

export interface ReplayResult {
  sent: number;
  failed: number;
  remaining: number;
}

/**
 * 重放队列：按入队顺序逐条发送，成功即出队，失败保留并累计 attempts。
 * sender 由调用方注入 —— 生产传真实写库函数，验证时传 mock（不写真实库）。
 * 只在 online 时调用才有意义；调用方负责在线检测。
 * 演练模式下（isDryRun）默认不发送；验证时传 { force: true } 可用 mock sender 走通重放。
 */
export async function replayQueue(
  sender: (item: QueuedItem) => Promise<void>,
  opts?: { force?: boolean },
): Promise<ReplayResult> {
  const items = readQueue();
  if (isDryRun() && !opts?.force) {
    console.warn(`[offline] 演练模式开启，队列保留 ${items.length} 条未发送`);
    return { sent: 0, failed: 0, remaining: items.length };
  }
  let sent = 0;
  let failed = 0;
  for (const item of items) {
    try {
      await sender(item);
      removeQueued(item.id);
      sent += 1;
    } catch (e) {
      markFailed(item.id, e instanceof Error ? e.message : String(e));
      failed += 1;
    }
  }
  return { sent, failed, remaining: readQueue().length };
}

// ===== 展示辅助 =====

/** 把快照时间戳格式化为「HH:MM」；非今天则补「M月D日 」前缀，避免误读为今天 */
export function formatSnapshotTime(ts: number): string {
  const d = new Date(ts);
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}
