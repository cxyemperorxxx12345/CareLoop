/* eslint-disable no-restricted-globals */
// CareLoop 手写轻量 Service Worker —— 只在构建产物（PROD）下由 src/main.tsx 注册，dev 不注册。
//
// 缓存策略（按资源类型分流，缓存体积有上限）：
//   1) 页面导航（document）  → network-first，失败回退缓存中的 index.html（修复断网白屏）
//   2) 构建产物 / 字体 / 图片 → cache-first + 后台静默更新（内容哈希命名，可安全长期缓存）
//   3) 接口数据（supabase）  → 完全透传，SW 不缓存：数据带用户身份，跨账号复用有泄漏风险；
//                              离线数据由页面自己从 IndexedDB 快照回读（见 src/lib/offline-cache.ts）
//   4) 非 GET 请求（写操作） → 绝不缓存，直接透传
//
// 一键关闭：控制台执行 __careloopOffline.disable()，或 localStorage['careloop:offline-disabled']='1'，
// 或 postMessage({ type: 'CARELOOP_OFFLINE_DISABLE' })，SW 会清空缓存并自我注销。

const VERSION = 'v1';
const SHELL_CACHE = `careloop-shell-${VERSION}`;
const ASSET_CACHE = `careloop-assets-${VERSION}`;
const KEEP_CACHES = [SHELL_CACHE, ASSET_CACHE];
const NAV_FALLBACK = '/index.html';
const SHELL_URLS = ['/', '/index.html'];
const MAX_ASSET_ENTRIES = 120;
const NETWORK_TIMEOUT_MS = 3000;

const ASSET_PATTERN = /\/(assets|fonts|images)\/|\.(js|mjs|css|woff2?|ttf|otf|png|jpe?g|svg|webp|ico)$/i;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 单个资源失败不影响安装（例如离线首次安装）
      await Promise.allSettled(SHELL_URLS.map((u) => cache.add(new Request(u, { cache: 'reload' }))));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !KEEP_CACHES.includes(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
    return;
  }
  if (event.data?.type === 'CARELOOP_OFFLINE_DISABLE') {
    event.waitUntil(disableAndUnregister());
  }
});

async function disableAndUnregister() {
  const names = await caches.keys();
  await Promise.all(names.map((n) => caches.delete(n)));
  await self.registration.unregister();
}

/** 带超时的 fetch：网络挂住时不让用户一直等，尽快回退缓存 */
function fetchWithTimeout(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('network-timeout')), NETWORK_TIMEOUT_MS);
    fetch(request)
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(request);
  if (hit) {
    // 后台静默更新下一版（内容哈希不同即新条目，旧条目由 trim 淘汰）
    void fetch(request)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') void cache.put(request, res.clone());
      })
      .catch(() => {})
      .finally(() => void trimCache(cache, MAX_ASSET_ENTRIES));
    return hit;
  }
  const res = await fetch(request);
  if (res && res.ok && res.type === 'basic') {
    void cache.put(request, res.clone()).then(() => trimCache(cache, MAX_ASSET_ENTRIES));
  }
  return res;
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetchWithTimeout(request);
    if (res && res.ok) void cache.put(NAV_FALLBACK, res.clone());
    return res;
  } catch {
    const cached = (await cache.match(request)) || (await cache.match(NAV_FALLBACK));
    if (cached) return cached;
    return new Response(
      '<!doctype html><html lang="zh-CN"><body style="font-family:system-ui;padding:2rem">当前网络不可用，且本地暂无缓存，请联网后重试。</body></html>',
      { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }
}

/** 缓存体积上限：超出条目数时按先进先出淘汰最旧的 */
async function trimCache(cache, max) {
  const keys = await cache.keys();
  if (keys.length <= max) return;
  const drop = keys.slice(0, keys.length - max);
  await Promise.all(drop.map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // 写操作（POST/PATCH/DELETE）绝不缓存
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨域（supabase 接口）透传：不缓存用户数据
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(req));
    return;
  }
  if (ASSET_PATTERN.test(url.pathname)) {
    event.respondWith(cacheFirstAsset(req));
  }
});
