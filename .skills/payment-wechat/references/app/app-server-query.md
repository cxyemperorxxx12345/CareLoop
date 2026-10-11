# App WeChat Pay — Server: order status query + reconciliation

> Part of the `payment-wechat` skill (App platform). **Read `references/app/app.md` first** — it carries the Design Principles and Payment Required items 6 / 8 / 9 that every rule below depends on; this file is not self-sufficient.
> **This file covers**: Payment Required item 5 (`query_order_status`), its helper code (`queryWechatOrder`, `closeWechatOrder`), and all Recommended items (Payment).
> Item numbers are global across the App reference files and are deliberately NOT renumbered.

<PAYMENT_REQUIREMENTS>
5. **query_order_status** (local-first, WeChat active-query fallback):
   - Read the local order by `order_no`, scoped to the caller resolved via Required item 8 (in `app.md`) — `.eq("user_id", user.id)` on the service_role client, NOT `auth.uid()`, which is NULL there. If already terminal (`paid`/`refunded`/`cancelled`) → return local status directly, NO WeChat call.
   - If still `pending`: **do NOT call WeChat on every poll**. Make the WeChat active query an explicit, opt-in contract via a request flag:
     - `reconcile=false` (default, the client's every-2s poll) → return the LOCAL status only, never touch WeChat. Polling every 2s hammers WeChat's query API and hits rate limits.
     - `reconcile=true` (client sends it only when reconciling: on `AppState`→active resume, or after the 30s client-poll window elapses) → allowed to fall back to a WeChat active query. This is WeChat's recommended 查单兜底 for lost/delayed callbacks.
     - **Server-side throttle regardless of the flag**: enforce at most one WeChat query per order per N seconds (the flag is client-supplied and cannot be trusted to self-limit).
   - WeChat query by `out_trade_no` (we always hold it locally; the helper implements this path) → branch on `trade_state`, reconcile ONLY from WeChat's response (never a client-supplied amount/status):
     - `SUCCESS` → verify `amountTotal` matches, then apply the result by calling the **SAME single atomic RPC as the callback** (`mark_order_paid`, defined in `app-db-rpc.md`) — flip + business effect in one TX; do NOT reimplement the flip and the effect as two separate steps here either.
     - `NOTPAY`/`USERPAYING` → still payable, **LEAVE pending — do NOT cancel** (the user may be mid-payment within the order's validity window).
     - `CLOSED`/`REVOKED`/`PAYERROR` → terminal failure → mark `pending→cancelled` (optimistic lock).
     - `REFUND` → already refunded on WeChat side → sync accordingly.
   - Client still polls every 2s, max 30s, for the in-session result.

**WIRE CONTRACT — `query_order_status` (EXACT field names, copy verbatim).** Same reason as `create_app_payment`: nothing checks this boundary at build time, so a renamed key is a silent dead end.

```typescript
// REQUEST body — client → query_order_status
interface QueryOrderStatusRequest {
  order_no: string;         // the same text order_no returned by create_app_payment
  reconcile?: boolean;      // default false; true ONLY on AppState resume / after the 30s window
}

// RESPONSE body — query_order_status → client (HTTP 200)
interface QueryOrderStatusResponse {
  status: 'pending' | 'paid' | 'refunded' | 'cancelled';   // the LOCAL order status
  order?: { order_no: string; amount: number; paid_at?: string | null };
}
```

- The client-facing key is **`status`** (the local order status) and the client branches on `status === 'paid'` only. `trade_state` / `tradeState` / `order_status` / `is_paid` are **WRONG** as response keys — `tradeState` is WeChat's vocabulary, used by the internal helper below, and must not leak out; nor may WeChat's raw values (`SUCCESS` / `NOTPAY` / …) be returned. Map them to the four statuses above.
- The request key is `order_no` (text). `order_id` / `orderNo` / `id` are **WRONG**.

```typescript
// query_order_status Edge Function — WeChat active-query fallback.
// CALL ONLY WHEN RECONCILING (resume / after poll window / throttled), NOT on every 2s poll.
import Wechatpay from "npm:wechatpay-axios-plugin@0.9.4";

async function queryWechatOrder(MERCHANT_ID: string, MCH_CERT_SERIAL_NO: string, MCH_PRIVATE_KEY: string, WECHAT_PAY_PUBLIC_KEY_ID: string, WECHAT_PAY_PUBLIC_KEY: string, outTradeNo: string) {
  try {
    const wxpay = new Wechatpay({ mchid: MERCHANT_ID, serial: MCH_CERT_SERIAL_NO, privateKey: MCH_PRIVATE_KEY, certs: { [WECHAT_PAY_PUBLIC_KEY_ID]: WECHAT_PAY_PUBLIC_KEY } });
    // GET /v3/pay/transactions/out-trade-no/{out_trade_no}?mchid=...  (outTradeNo → out-trade-no auto-mapped)
    const { data } = await wxpay.v3.pay.transactions.outTradeNo[outTradeNo].get({ params: { mchid: MERCHANT_ID } });
    return { success: true, tradeState: data.trade_state ?? "", amountTotal: data.amount?.total ?? -1, transactionId: data.transaction_id ?? "" };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[WeChatQuery ERROR] outTradeNo=${outTradeNo}, error=${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

// OPTIONAL timeout-close helper (see Recommended item 5). Call from a SCHEDULED job, after
// confirming local is still 'pending'. WeChat prepay orders also expire natively (~2h).
async function closeWechatOrder(MERCHANT_ID: string, MCH_CERT_SERIAL_NO: string, MCH_PRIVATE_KEY: string, WECHAT_PAY_PUBLIC_KEY_ID: string, WECHAT_PAY_PUBLIC_KEY: string, outTradeNo: string) {
  try {
    const wxpay = new Wechatpay({ mchid: MERCHANT_ID, serial: MCH_CERT_SERIAL_NO, privateKey: MCH_PRIVATE_KEY, certs: { [WECHAT_PAY_PUBLIC_KEY_ID]: WECHAT_PAY_PUBLIC_KEY } });
    // POST /v3/pay/transactions/out-trade-no/{out_trade_no}/close  (204 No Content on success)
    await wxpay.v3.pay.transactions.outTradeNo[outTradeNo].close.post({ mchid: MERCHANT_ID });
    return { success: true };
  } catch (err) {
    // WeChat errors if already paid/closed — inspect + reconcile (query first / do not cancel a paid order), do NOT crash
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[WeChatClose ERROR] outTradeNo=${outTradeNo}, error=${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}
```

Recommended Items (Payment):
1. **Polling mechanism**: Implement polling every 2 seconds on order result page to check order status. If payment is successful, display success UI and navigate to next business flow.
2. For inventory management, encapsulate all data mutations in RPC functions as atomic transactions to maintain consistency.
3. Missing-config is a REQUIRED uniform contract — see Required item 7 in `app-server-order.md` (server shape + fixed copy) + Client item 4 in `app-client.md` (frontend branch). For a WeChat API failure after config is present, surface the returned error message.
4. Suggested order number format: `ORD-YYMMDD-XXXXXXXX` (8-char random suffix).
5. **Timeout close order (OPTIONAL — needs a scheduled trigger, e.g. Supabase cron / pg_cron)**: WeChat prepay orders expire natively (default ~2h; set `time_expire` to tune) and CANNOT be paid after expiry, so a stale local `pending` row is not a correctness/security risk. Add active close ONLY when you must release an inventory freeze promptly or keep order state clean — do NOT bloat the minimal flow with it otherwise.
   - Scheduled job, for orders `pending` past expiry: confirm local is STILL `pending` → `closeWechatOrder(...)` → set local `pending→cancelled` via optimistic lock (`WHERE status='pending'`) — use the `cancel_order` RPC in `app-db-rpc.md`, do not hand-write the UPDATE.
   - **Idempotent / race-safe**: if WeChat says already-paid → do NOT cancel; reconcile to `paid` (a callback/query raced). Already-closed → treat as success. Never overwrite a `paid` order — same state machine as create_app_payment.
   - Note: query_order_status's WeChat fallback (Required item 5) already rescues *paid-but-stranded* orders; close-order only handles the *unpaid-timed-out* case, which WeChat's native expiry mostly covers — hence OPTIONAL.
</PAYMENT_REQUIREMENTS>
