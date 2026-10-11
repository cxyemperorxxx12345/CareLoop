# App WeChat Pay — Server: payment callback (notify_url)

> Part of the `payment-wechat` skill (App platform). **Read `references/app/app.md` first** — it carries the Design Principles and Payment Required items 6 / 8 / 9 that every rule below depends on; this file is not self-sufficient.
> **This file covers**: Payment Required item 4 (`app_payment_callback`) and its helper code, including `verifyWechatCallback` — which `app-refund.md` also depends on.
> Item numbers are global across the App reference files and are deliberately NOT renumbered.

<PAYMENT_REQUIREMENTS>
4. **app_payment_callback** (TX2):
   - **Step 0 — verify BEFORE decrypt**: read the raw request body, then `verifyWechatCallback(headers, rawBody, WECHAT_PAY_PUBLIC_KEY_ID, WECHAT_PAY_PUBLIC_KEY)`. On failure → log the reason and return a **FAIL** response — do NOT decrypt, do NOT touch the order. (Fix only the FAIL semantics + no-decrypt/no-write rule; the exact HTTP status is the implementation's call per WeChat callback spec — do NOT hardcode 401.)
   - Decrypt + verify payment (check: trade_state='SUCCESS', AND `amountTotal` matches the order — compare decrypted `amount.total` in fen against `Math.round(order.amount * 100)`; mismatch → log + return `{code:"FAIL"}`, do NOT mark paid)
   - [TX2 — ONE atomic RPC] Perform the status flip (pending→paid) AND the business effect (credit balance / grant entitlement / inventory convert) inside a SINGLE `SECURITY DEFINER` RPC — NOT as two steps in the Edge Function (see Design Principle 5 in `app.md` + the `mark_order_paid` implementation in `app-db-rpc.md`).
   - **State change**: the RPC's UPDATE MUST constrain current state in WHERE clause (`WHERE status = 'pending'`) — the optimistic lock.
   - **Idempotency**: the RPC checks affected rows internally and returns `applied` (true/false). `applied=false` (0 rows) = duplicate callback → Edge Function returns SUCCESS. `applied=true` = the effect was already applied in the same TX. The Edge Function NEVER calls a separate "credit"/business RPC after the flip.
   - **Response body**: HTTP 200 + `{"code":"SUCCESS"}` for duplicate or successful; `{"code":"FAIL","message":...}` only for retriable errors

```typescript
// app_payment_callback Edge Function
import { Aes, Formatter, Rsa } from "npm:wechatpay-axios-plugin@0.9.4";

const MAX_CLOCK_OFFSET = 300; // seconds; older than this = stale/replayed → reject

// Verify callback signature + timestamp BEFORE decrypting. `rawBody` MUST be the exact raw
// request text (do NOT pass a re-stringified parsed object, or verification always fails).
// Shared by app_payment_callback and app_refund_callback.
function verifyWechatCallback(
  headers: Headers,
  rawBody: string,
  WECHAT_PAY_PUBLIC_KEY_ID: string,
  WECHAT_PAY_PUBLIC_KEY: string,
): { ok: boolean; reason?: string } {
  const timestamp = headers.get("Wechatpay-Timestamp") ?? "";
  const nonce = headers.get("Wechatpay-Nonce") ?? "";
  const signature = headers.get("Wechatpay-Signature") ?? "";
  const serial = headers.get("Wechatpay-Serial") ?? "";

  if (Math.abs(Formatter.timestamp() - Number(timestamp)) > MAX_CLOCK_OFFSET) {
    return { ok: false, reason: "clock offset too large (possible replay)" };
  }
  // Public-key mode: the callback's serial must match the configured WeChat Pay public key id
  if (serial !== WECHAT_PAY_PUBLIC_KEY_ID) {
    return { ok: false, reason: `unexpected serial: ${serial}` };
  }
  const verified = Rsa.verify(
    Formatter.joinedByLineFeed(timestamp, nonce, rawBody),
    signature,
    Rsa.from(WECHAT_PAY_PUBLIC_KEY, Rsa.KEY_TYPE_PUBLIC),
  );
  return verified ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

async function decryptTradeState(MCH_API_V3_KEY: string, associatedData: string, nonce: string, ciphertext: string): Promise<{ tradeState: string; outTradeNo: string; transactionId: string; amountTotal: number }> {
  const plaintext = await Aes.AesGcm.decrypt(ciphertext, MCH_API_V3_KEY, nonce, associatedData);
  const obj = JSON.parse(plaintext);
  return {
    tradeState: (obj.trade_state ?? "") === "SUCCESS" ? "SUCCESS" : "OTHERS",
    outTradeNo: obj.out_trade_no ?? "",
    transactionId: obj.transaction_id ?? "",
    amountTotal: obj.amount?.total ?? -1  // fen; compare against Math.round(order.amount * 100) before marking paid
  };
}

// Handler wiring — verify → decrypt → idempotent update → ack:
//   const rawBody = await req.text();          // raw text FIRST, before JSON.parse
//   const check = verifyWechatCallback(req.headers, rawBody, WECHAT_PAY_PUBLIC_KEY_ID, WECHAT_PAY_PUBLIC_KEY);
//   if (!check.ok) {
//     console.error(`[WeChat callback REJECTED] ${check.reason}`);   // log loudly; false-rejects are diagnosable here
//     return failWechatCallback(check.reason);   // FAIL response (no decrypt, no order write); pick the HTTP status per WeChat spec — do NOT hardcode 401
//   }
//   const { resource } = JSON.parse(rawBody);
//   const { tradeState, outTradeNo, transactionId, amountTotal } =
//     await decryptTradeState(MCH_API_V3_KEY, resource.associated_data, resource.nonce, resource.ciphertext);
//   // amount check: load order by outTradeNo, verify amountTotal === Math.round(order.amount * 100) before paid
//   // ... optimistic-lock idempotent order update (unchanged) ...
//   return new Response(JSON.stringify({ code: "SUCCESS" }), { status: 200 });
```
</PAYMENT_REQUIREMENTS>
