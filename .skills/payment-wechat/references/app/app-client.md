# App WeChat Pay — Client (Expo + React Native)

> Part of the `payment-wechat` skill (App platform). **Read `references/app/app.md` first** — it carries the Design Principles that every rule below depends on; this file is not self-sufficient.
> **This file covers**: dependencies, `app.json`, SDK registration, the payment flow, Universal Link ownership, and the client-side prohibitions.
> Item numbers are global across the App reference files and are deliberately NOT renumbered. Server-side items live in `app-server-order.md`, `app-server-callback.md`, `app-server-query.md`.

<CLIENT_IMPLEMENTATION>
Required Items (Client — Expo + React Native):
1. **Dependencies**: `pnpm exec expo install expo-native-wechat`
   - `expo-linking`: Already included in boilerplate — no install needed
   - `expo-native-wechat`: WeChat OpenSDK wrapper for Expo (supports payment, auth, sharing)
2. **app.json configuration**:
   ```json
   {
     "expo": {
       "plugins": [
         "expo-native-wechat"
       ],
       "ios": {
         "infoPlist": {
           "LSApplicationQueriesSchemes": ["weixin", "weixinULAPI", "weixinURLParamsAPI"]
         }
       }
     }
   }
   ```
   - `plugins` declaration is REQUIRED — `expo-native-wechat` needs native code linking
   - `ios.infoPlist.LSApplicationQueriesSchemes` is REQUIRED on iOS — the `expo-native-wechat` config plugin does NOT write it, and without it the app cannot detect/open the WeChat app (`canOpenURL` fails). These three values are static — write them verbatim.
   - Android: ensure package name and signing config are correct
   - **Do NOT add `ios.associatedDomains` here** — Universal Link config is 100% platform-managed (see item 5)
   - **Do NOT write `ios.scheme`** — the platform/worker injects the `wx{appid}` scheme into `ios.scheme` at build time. Leave the top-level `scheme` (the app's own deep-link scheme) untouched; it is separate.
3. **SDK Registration** (must call before any WeChat API):
   ```typescript
   import { Platform } from "react-native";
   import { registerApp } from "expo-native-wechat";
   // Call once at app startup (e.g., in root _layout.tsx useEffect).
   useEffect(() => {
     const initializeWechat = async () => {
       const WECHAT_APP_ID = process.env.EXPO_PUBLIC_WECHAT_APP_ID || '';
       const UNIVERSAL_LINK = process.env.EXPO_PUBLIC_UNIVERSAL_LINK || '';
       if (!WECHAT_APP_ID) {
         console.warn("[wechat] EXPO_PUBLIC_WECHAT_APP_ID 未配置");
         return;
       }
       if (Platform.OS === "ios" && !UNIVERSAL_LINK) {
         console.warn("[wechat] EXPO_PUBLIC_UNIVERSAL_LINK 未配置");
         return;
       }
       await registerApp({ appid: WECHAT_APP_ID, universalLink: UNIVERSAL_LINK });
     };
     void initializeWechat().catch((error: unknown) => {
       console.error("[wechat] registerApp error:", error);
     });
   }, []);
   ```
   - `EXPO_PUBLIC_WECHAT_APP_ID` and `EXPO_PUBLIC_UNIVERSAL_LINK` are the EXACT, REQUIRED env-var names — the platform/worker injects their values at build time (do NOT rename, hardcode, or invent alternates; the injection matches on these exact names).
   - `WECHAT_APP_ID` is the WeChat Open Platform AppID (same value as the server-side `MERCHANT_APP_ID` secret; AppID is public, NOT a secret).
   - `universalLink` is REQUIRED for iOS payment return. On Android it is ignored (Android returns via package name + signature). Do not treat an empty iOS value as valid configuration; the AppState resume fallback only handles a delayed/lost return after native registration is correctly configured.
   - **Registration is a precondition, not fire-and-forget**: `registerApp` is idempotent (a second call is a no-op) but every other API (`requestPayment` included) throws `Please register SDK before invoking requestPayment` if called before registration resolves. Payment flow item 4 MUST run after this effect has completed — do not call `requestPayment` from a component that could mount/fire before the root-level `registerApp` finishes.
4. **Payment flow**:
   - **Web guard (checked FIRST)**: native SDK doesn't exist on web. `if (Platform.OS === "web") { setError("当前环境无法调试支付功能，请打包安装后再试"); return; }`
   - User taps pay button → call `create_app_payment` via `supabase.functions.invoke('create_app_payment', { body: { product_id, quantity } })`
   - **Surface real error detail + missing-config**: on a non-2xx response `error.message` is only a generic `FunctionsHttpError` — the real body (including the `code`) is in `error.context`. Parse it, branch on `WECHAT_NOT_CONFIGURED` (show the fixed copy, do NOT proceed to payment), and always fall back to the server's error message (`parsed.error`) for any other error. The server side of this contract — the exact body shape and the fixed copy — is Required item 7 in `app-server-order.md`:
     ```typescript
     const { data, error } = await supabase.functions.invoke('create_app_payment', { body: { product_id, quantity } });
     if (error) {
       const body = await error.context?.text?.().catch(() => undefined);
       let parsed: { error?: string; code?: string } = {};
       try { parsed = body ? JSON.parse(body) : {}; } catch { /* body was not JSON */ }
       if (parsed.code === "WECHAT_NOT_CONFIGURED") {
         // Not configured: show the fixed copy, stop here, do NOT proceed to requestPayment
         return { success: false, error: parsed.error || "未完成微信支付配置，请配置后重试" };
       }
       return { success: false, error: parsed.error || error.message };  // any other error (incl. the real WeChat error)
     }
     ```
   - Receive `paymentParams` from the Edge Function — the field names are a fixed wire contract (see the WIRE CONTRACT block at the end of `app-server-order.md`, copy them character-for-character). `payment_params` / `pay_params` yield `undefined` and silently skip the whole payment branch. Assert, do not test: `if (!data.paymentParams) throw new Error("支付参数缺失")` — never `if (data.paymentParams) { ... }` with no else, which turns a broken contract into a dead button.
   - Invoke WeChat SDK:
     ```typescript
     import { requestPayment } from "expo-native-wechat";

     // REQUIRED timeout. On iOS, when WXApi.send fails the wrapper emits a response with
     // no errorCode and this promise NEVER settles — there is no built-in timeout, so the
     // pay button hangs forever. Always race it. (Android settles normally; race never fires.)
     const withTimeout = <T,>(p: Promise<T>, ms = 15000) =>
       Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);

     try {
       const paymentResponse = await withTimeout(requestPayment({
         partnerId: paymentParams.partnerId,
         prepayId: paymentParams.prepayId,
         nonceStr: paymentParams.nonceStr,
         timeStamp: paymentParams.timeStamp,
         sign: paymentParams.sign,
       }));
       // null = timed out. This is NOT a failure — the user may well have paid. Fall through
       // to the result page and let query_order_status decide; never show 支付失败 here.
       if (paymentResponse && paymentResponse.errorCode !== 0) {
         console.warn("[wechat] payment callback was not successful:", paymentResponse.errorCode, paymentResponse.errorStr);
       }
     } catch (error: unknown) {
       // The wrapper rejects for non-zero PayResp codes. Treat -2 as user
       // cancellation and other codes as SDK failures; neither result proves the
       // final order state, so both must be reconciled by the server-side query below.
       console.warn("[wechat] requestPayment did not complete (cancel/failure):", error);
     }
     // Whatever happened above (success / cancel / SDK failure / timeout), navigate to the
     // result page — the server poll is authoritative (see below).
     ```
   - Note: `appId` and `package` are NOT passed to `requestPayment` — SDK handles them internally
   - After payment completes/cancels/fails (or the SDK does not return) → navigate to the result page
   - Result page polls `query_order_status` (2s interval, max 30s timeout). The server contract for that function, including the `reconcile` flag, is Required item 5 in `app-server-query.md`.
   - **REQUIRED response handling**: do not ignore the value returned by `requestPayment`. It is a `PayResp`-like object (`errorCode`, `errorStr`, `data`); inspect `errorCode` (`0` = SDK callback success, `-2` = user cancellation, other non-zero values = SDK failure) and log/surface `errorStr` when useful. The current Expo wrapper may reject instead of returning a non-zero response, so handle both the resolved value and `catch` path.
   - Common OpenSDK codes: `-1` = general error, `-2` = user cancellation, `-3` = send failed, `-4` = authorization denied, `-5` = unsupported, `-6` = banned/restricted. These are SDK-level categories only; do not infer the exact merchant/signature/AppID cause from the numeric code alone—preserve and inspect `errorStr` and server logs.
   - On `status === 'paid'` → show success UI
   - **IMPORTANT**: `requestPayment` result does NOT guarantee payment status. Regardless of `errorCode`, rejection, user cancellation, timeout, or a missing callback, MUST query/poll `query_order_status` and use the server-side order status as the only basis for success UI, entitlement, or fulfillment. A client-side `errorCode === 0` is only evidence that the WeChat SDK callback succeeded.
   - **Resume fallback (REQUIRED)**: iOS return depends on Universal Link and may fail or leave the app backgrounded, so `requestPayment` may never resolve. Subscribe to `AppState`; when it returns to `active`, re-query `query_order_status` **with `reconcile: true`** for any pending order and reconcile the UI. The authoritative result is always the server-side `app_payment_callback` (notify_url); this is the client-side safety net.
     ```typescript
     import { AppState } from "react-native";
     // Result page: the 2s poll uses reconcile:false (local only); the resume re-query uses
     // reconcile:true so a lost/delayed callback gets rescued by a WeChat 查单 (see query_order_status).
     useEffect(() => {
       const sub = AppState.addEventListener("change", (state) => {
         if (state === "active") {
           supabase.functions
             .invoke("query_order_status", { body: { order_no, reconcile: true } })
             .then(({ data }) => { /* update UI from data.status */ });
         }
       });
       return () => sub.remove();
     }, [order_no]);
     ```
5. **Universal Link / AASA — value & domain platform-managed; Agent writes ONLY the registerApp param**:
   - Agent DOES pass `universalLink: process.env.EXPO_PUBLIC_UNIVERSAL_LINK` to `registerApp` (see item 3). The platform/worker injects the value.
   - Agent does NOT generate, write, or configure ANY of: the AASA file (`public/.well-known/apple-app-site-association`), its content, or `ios.associatedDomains`. The platform/sandbox owns all of it — AASA content requires the Apple TeamID, which is only known after signing/packaging, so Agent cannot produce it correctly.
   - Because the iOS payment return relies on Universal Link (which CAN fail: unsupported system/WeChat version, AASA not yet propagated), the client MUST implement the resume fallback in Payment flow item 4.
   - Domain convention (reference only, Agent does NOT write it): `app-{appId}.appmiaoda.com`
6. **PROHIBITED — violations will break the app**:
   - ❌ ANY secret key, private key, or APIv3 key in client code
   - ❌ Client directly calling WeChat Pay API
   - ❌ Client calculating or transmitting payment amount
   - ❌ Client writing to `orders` / `order_items` / `refunds` — BOTH `supabase.from('orders').insert(...)` / `.update(...)` AND `supabase.rpc(...)` on any order / payment / refund function (`mark_order_paid`, `create_pending_order`, `apply_for_refund`, `apply_refund_success`, `create_refund_record`, `cancel_order`, …). They are `SECURITY DEFINER` and grant entitlements: a client that can call `mark_order_paid` hands itself paid orders for free. The client only `invoke`s Edge Functions and SELECTs its own rows.
   - ❌ Swallowing a failure on the payment path: `console.error(...)` then `return` / `return []` / `return null`; `if (!selectedItem) return;` with no message; a `.catch()` whose only body is a log. Every user-triggerable failure MUST show feedback, and it MUST be on screen together with the control that triggered it — state-driven Toast or inline text beside the button, NOT `Alert` from react-native (devkit's `no-rn-alert` rule rejects it). An error rendered at the top of a long scroll while the button sits at the bottom reaches the tester as "点击无反应".
   - ❌ Adding an INSERT/UPDATE policy for `authenticated` on `orders` / `order_items` / `refunds` to "fix" a write failure — that lets users forge orders and amounts; fix the Edge Function's client construction instead (Payment Required item 8 in `app.md`)
   - ❌ Using URL Scheme for iOS return (MUST use Universal Link)
   - ❌ Using `expo-av` for any media (use `expo-video`)
</CLIENT_IMPLEMENTATION>
