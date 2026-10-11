# App WeChat Pay — Server: config gate + order creation + prepay

> Part of the `payment-wechat` skill (App platform). **Read `references/app/app.md` first** — it carries the Design Principles and Payment Required items 6 / 8 / 9 that every rule below depends on; this file is not self-sufficient.
> **This file covers**: Payment Required items 1, 2, 3 (`create_app_payment`), item 7 (missing-config contract), and the `create_app_payment` helper code.
> Item numbers are global across the App reference files and are deliberately NOT renumbered. Items 4 / 5 are in `app-server-callback.md` / `app-server-query.md`.

<PAYMENT_REQUIREMENTS>
Required Items (Payment):
1. Frontend: payment button → call `create_app_payment` Edge Function → receive invocation params → call WeChat OpenSDK to launch payment → navigate to result page → poll `query_order_status`.
2. Orders must be associated with the purchaser. Resolve the caller with `admin.auth.getUser(jwt)` and write `user_id` **explicitly** in the INSERT payload — do NOT rely on a `default auth.uid()` column default, which is NULL on a service_role connection (Required item 8 in `app.md`).
3. **create_app_payment** (TX1):
   - Build the service_role client + resolve the caller per Required item 8 (in `app.md`) — do this BEFORE any DB access
   - Validate purchaser info
   - **Two entry branches** — decide from the body, then converge on the same prepay code:
     - **New order** (body carries `product_id`/`items`): [TX1] look up prices, validate stock, inventory freeze (if applicable) + order save (status='pending') + order line items — all in **ONE `SECURITY DEFINER` RPC** (`create_pending_order`, defined in `app-db-rpc.md`), never as multiple `.from(...).insert(...)` calls from the Edge Function. Two reasons: (a) a partial failure otherwise strands a half-written order (order row with no line items) that the client cannot pay and no job cleans up; (b) the RPC owns the row-writing, so the tables need no INSERT policy for `authenticated` and the flow cannot be broken by an RLS gap. Pass `p_user_id` explicitly — the RPC runs as the definer, so `auth.uid()` inside it is NULL. Sign WeChat with the total the RPC returns.
     - **Re-pay** (body carries only `order_no`): load the order filtered by BOTH `order_no` and `user_id = user.id`, require `status='pending'`; reuse its stored `amount` and existing `out_trade_no` — write NOTHING, create no second order, re-price nothing. Reject a terminal order with its real status so the client can navigate instead of paying twice. (Client item 4 in `app-client.md` requires this branch whenever the UI can reach a pending order again.)
   - Call WeChat **APP prepay API** (post-TX1): `POST /v3/pay/transactions/app`
   - Assemble client invocation params with **secondary signature**
   - Return invocation params: `{appId, partnerId, prepayId, nonceStr, timeStamp, package, sign}`
   - **Prepay failure (synchronous)**: the APP prepay call is a synchronous request/response — either it returns a `prepay_id`, or it fails. On failure, no `prepay_id` reaches the client, so the user can NEVER launch payment for this order. Critically, `prepay_id` cannot be re-fetched later (the query-order API returns `trade_state` etc. but NOT `prepay_id`), so even if the failure was only a lost response and WeChat did create the order, that order is unpayable-by-this-client and simply auto-expires (~2h) with no charge. Therefore, in the SAME request: release the inventory freeze + mark the local order `pending→cancelled` (optimistic lock). This is safe (no double-charge — the client retries as a NEW order) and avoids a stranded `pending` that would otherwise depend on the optional timeout job (Recommended item 5 in `app-server-query.md`). Log the WeChat error for diagnostics; the tradeoff is a rare harmless WeChat-side `NOTPAY` phantom that expires on its own.
     - **On the re-pay branch, do NOT cancel**: the order pre-existed this request and the user may retry from the order page. Surface the WeChat error and leave the order `pending` — only the new-order branch cancels what it just created.
7. **Missing-config contract (uniform — do NOT reinvent per app)**: At the TOP of `create_app_payment`, BEFORE building any Supabase client, resolving the caller, inserting an order, or freezing inventory, verify `MERCHANT_ID` is present. This is the pre-payment gate: never let a user pay before the merchant is configured. If it is missing, return a NON-2xx response with this EXACT shape and copy — do NOT return HTTP 200, do NOT invent per-app field names / wording:
   ```typescript
   const MERCHANT_ID = Deno.env.get("MERCHANT_ID");
   if (!MERCHANT_ID) {
     console.error("[create_app_payment] missing secret: MERCHANT_ID");
     return new Response(
       JSON.stringify({ error: "未完成微信支付配置，请配置后重试", code: "WECHAT_NOT_CONFIGURED" }),
       { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
     );
   }
   // The other secrets are platform-injected. Read them with these EXACT names — do NOT rename,
   // abbreviate, or invent alternates (WECHAT_MCHID / WECHAT_APPID / WECHAT_API_V3_KEY are WRONG).
   const MERCHANT_APP_ID = Deno.env.get("MERCHANT_APP_ID")!;
   const MCH_CERT_SERIAL_NO = Deno.env.get("MCH_CERT_SERIAL_NO")!;
   const MCH_PRIVATE_KEY = Deno.env.get("MCH_PRIVATE_KEY")!;
   const WECHAT_PAY_PUBLIC_KEY_ID = Deno.env.get("WECHAT_PAY_PUBLIC_KEY_ID")!;
   const WECHAT_PAY_PUBLIC_KEY = Deno.env.get("WECHAT_PAY_PUBLIC_KEY")!;
   // MCH_API_V3_KEY is not needed here — it is read in app_payment_callback for AES-GCM decryption.
   ```
   - Runs FIRST → no orphan `pending` order when config is absent.
   - The client branches on `code === "WECHAT_NOT_CONFIGURED"` (Client item 4 in `app-client.md`); the numeric status is non-load-bearing (400 = precondition / not configured, not a runtime fault).
   - Check `MERCHANT_ID` only — it is the sole merchant-supplied value; the other secrets listed in Required item 6 (`app.md`) are injected by the platform. Do NOT expand this into an all-secrets check.
   - Supersedes the non-conformant variant seen in the wild: "return 200 + configMissing" (conflicts with the non-2xx client contract).
   A genuine WeChat API failure AFTER config is present (prepay throws) is a DIFFERENT case: keep Required item 3's behavior (release freeze + order pending→cancelled) and surface the WeChat error.

```typescript
// create_app_payment Edge Function
import Wechatpay, { Formatter, Rsa } from "npm:wechatpay-axios-plugin@0.9.4";

// Order number: Deno built-in only — do NOT add an npm id/uuid package for this.
const generateOrderNo = () => `ORD-${new Date().toISOString().slice(2,10).replace(/-/g,"")}-${crypto.randomUUID().slice(0,8)}`;

async function createAppPrepay(MERCHANT_ID: string, MERCHANT_APP_ID: string, MCH_CERT_SERIAL_NO: string, MCH_PRIVATE_KEY: string, WECHAT_PAY_PUBLIC_KEY_ID: string, WECHAT_PAY_PUBLIC_KEY: string, outTradeNo: string, amount: number, notifyUrl: string, description?: string) {
  try {
    const wxpay = new Wechatpay({
      mchid: MERCHANT_ID,
      serial: MCH_CERT_SERIAL_NO,
      privateKey: MCH_PRIVATE_KEY,
      certs: { [WECHAT_PAY_PUBLIC_KEY_ID]: WECHAT_PAY_PUBLIC_KEY },
    });

    const { data } = await wxpay.v3.pay.transactions.app.post({
      mchid: MERCHANT_ID,
      appid: MERCHANT_APP_ID,
      description: description || '商品购买',
      out_trade_no: outTradeNo,
      notify_url: notifyUrl,
      amount: { total: Math.round(amount * 100), currency: 'CNY' },
    }, { headers: { 'Wechatpay-Serial': WECHAT_PAY_PUBLIC_KEY_ID } });

    if (data.prepay_id) {
      // Secondary signature for client invocation
      const nonceStr = Formatter.nonce();
      const timeStamp = '' + Formatter.timestamp();
      const packageStr = 'Sign=WXPay';
      const signStr = Formatter.joinedByLineFeed(MERCHANT_APP_ID, timeStamp, nonceStr, data.prepay_id);
      const sign = Rsa.sign(signStr, Rsa.from(MCH_PRIVATE_KEY));

      return {
        success: true,
        paymentParams: {
          appId: MERCHANT_APP_ID,
          partnerId: MERCHANT_ID,
          prepayId: data.prepay_id,
          nonceStr,
          timeStamp,
          package: packageStr,
          sign,
        }
      };
    } else {
      return { success: false, error: "发起支付失败" };
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[WeChatPay APP ERROR] outTradeNo=${outTradeNo}, error=${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

// Handler wiring — config gate → admin client + identity → branch → prepay:
// (`create_pending_order` and `cancel_order` are defined in app-db-rpc.md; the admin-client
//  construction in step 2 is Required item 8 in app.md — read it before writing this.)
//   1. REQUIRED item 7 secret check (FIRST, before any DB write)
//   2. const admin = createClient(URL, SERVICE_ROLE_KEY);            // NO global.headers.Authorization
//      const { data: { user } } = await admin.auth.getUser(jwt);     // identity via argument
//   3. branch on the body:
//      NEW ORDER  → const orderNo = generateOrderNo();
//                   const { data: total, error } = await admin.rpc('create_pending_order',
//                     { p_user_id: user.id, p_order_no: orderNo, p_items: items });
//                   // error → map OUT_OF_STOCK/PRODUCT_NOT_FOUND/EMPTY_CART to copy; nothing was written
//      RE-PAY     → const { data: o } = await admin.from('orders')
//                     .select('order_no, out_trade_no, amount, status')
//                     .eq('order_no', body.order_no).eq('user_id', user.id).maybeSingle();
//                   // !o → 404-ish; o.status !== 'pending' → return o.status, do NOT prepay
//                   // reuse o.out_trade_no + o.amount; write nothing
//   4. const prepay = await createAppPrepay(..., outTradeNo, total, notifyUrl, description);
//      !prepay.success → NEW ORDER branch only: await admin.rpc('cancel_order', { p_order_no: orderNo });
//                        RE-PAY branch: leave pending, just surface prepay.error
//   5. return { order_no, paymentParams: prepay.paymentParams }   // EXACT shape below
```

**WIRE CONTRACT — `create_app_payment` (EXACT field names, copy verbatim on BOTH sides).** Nothing checks this boundary at build time: a renamed key yields `undefined`, the payment branch is skipped silently, and the button looks dead.

```typescript
// REQUEST body — client → create_app_payment. Pick ONE shape (Design Principle 8 in app.md).
type CreateAppPaymentRequest =
  | { product_id: string; quantity: number }                      // single-product
  | { items: Array<{ product_id: string; quantity: number }> }     // cart
  | { order_no: string };                                          // re-pay an existing pending order

// RESPONSE body — create_app_payment → client, success (HTTP 200)
interface CreateAppPaymentResponse {
  order_no: string;
  paymentParams: {
    appId: string; partnerId: string; prepayId: string;
    nonceStr: string; timeStamp: string; package: string; sign: string;
  };
}
// RESPONSE body — failure (NON-2xx): { error: string; code?: "WECHAT_NOT_CONFIGURED" }
```

- `paymentParams` is camelCase, and so is every key inside it. `payment_params`, `pay_params`, `paymentParam`, `partnerid`, `prepay_id`, `noncestr`, `timestamp` are **WRONG** — do NOT rename, abbreviate, or snake_case any of them.
- The request key for the re-pay branch is `order_no` (text). `order_id`, `orderNo`, and `id` are **WRONG**; a UUID sent as `order_id` lands in no branch at all and the function falls through to new-order creation with undefined items.
- On success `paymentParams` is **always** present. The client asserts it — `if (!data.paymentParams) throw new Error(...)` — and never wraps the payment call in `if (data.paymentParams) { ... }` with no else branch, which converts a broken contract into a dead button.
</PAYMENT_REQUIREMENTS>
