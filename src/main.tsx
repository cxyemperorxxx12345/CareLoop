import * as Sentry from "@sentry/react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { AppWrapper } from "./components/common/PageMeta.tsx";
import { applyFontScale, readFontScale } from "./lib/font-scale";
import { clearSnapshots, isOfflineEnabled, setOfflineEnabled } from "./lib/offline-cache";
import "./index.css";

// 启动即应用本地记忆的字号档位（适老化：小/中/大），避免首帧闪回默认字号
applyFontScale(readFontScale());

Sentry.init({
  dsn: import.meta.env['VITE_SENTRY_DSN'] as string | undefined,
  environment: import.meta.env.MODE,
});

// Service Worker 只在构建产物启用：dev 下注册会缓存旧资源、破坏 HMR，干扰调试。
// 关闭方式（任一命中）：__careloopOffline.disable() / localStorage['careloop:offline-disabled']='1' / VITE_OFFLINE_DISABLED=true
const SW_URL = `${import.meta.env.BASE_URL}sw.js`;

async function syncServiceWorker(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const enabled = isOfflineEnabled();
  try {
    if (!import.meta.env.PROD || !enabled) {
      const registration = await navigator.serviceWorker.getRegistration(SW_URL);
      if (registration) await registration.unregister();
      if (enabled) return; // dev 环境：仅确保没有残留注册，到此为止
      // 被一键关闭：清空缓存与快照后退出
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
      await clearSnapshots();
      return;
    }
    await navigator.serviceWorker.register(SW_URL, { scope: import.meta.env.BASE_URL });
  } catch (e) {
    // 注册失败不能影响应用启动
    console.warn('[offline] Service Worker 注册失败：', e);
  }
}

// 控制台一键开关：__careloopOffline.disable() / .enable() / .clear() / .status()
Object.defineProperty(window, '__careloopOffline', {
  configurable: true,
  value: {
    status: () => ({ enabled: isOfflineEnabled(), prod: import.meta.env.PROD }),
    async disable() {
      setOfflineEnabled(false);
      await syncServiceWorker();
      console.info('[offline] 离线兜底已关闭，请刷新页面生效');
    },
    async enable() {
      setOfflineEnabled(true);
      await syncServiceWorker();
      console.info('[offline] 离线兜底已开启，请刷新页面生效');
    },
    async clear() {
      await clearSnapshots();
      console.info('[offline] 本地快照已清空');
    },
  },
});

void syncServiceWorker();

createRoot(document.getElementById("root")!).render(
  <Sentry.ErrorBoundary fallback={<p>应用发生错误，请刷新页面重试</p>}>
    <AppWrapper>
      <App />
    </AppWrapper>
  </Sentry.ErrorBoundary>
);
