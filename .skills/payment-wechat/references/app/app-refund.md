# App WeChat Pay — Refund

> Part of the `payment-wechat` skill (App platform). **Read `references/app/app.md` first** — it carries the Design Principles and Payment Required items 6 / 8 / 9 that every rule below depends on; this file is not self-sufficient.
> **Only implement any of this if the user explicitly asks for refund** (Design Principle 10 in `app.md`).
> **This file covers**: `refund_order`, `app_refund_callback`, `query_refund_status` and their helper code. The `refunds` table lives in `app-db-schema.md`; the refund **RPCs** (`create_refund_record`, `apply_refund_success` / `_closed` / `_abnormal`) are in `app-db-rpc.md` — use those bodies as written. Every balance check and every status transition below happens INSIDE those RPCs; an Edge Function that does its own `select`-then-`update` instead is the exact double-refund / double-credit bug they exist to remove.
> Item numbers are global across the App reference files and are deliberately NOT renumbered.

<REFUND_REQUIREMENTS>
Required Items (Refund — only implement if user explicitly requires refund):
1. Edge functions: `refund_order`, `app_refund_callback`, `query_refund_status`
2. **refund_order**:
   - **One call to `create_refund_record` (`app-db-rpc.md`) does the amount validation, the duplicate guard, and the record creation** — under a `for update` lock on the order row, before WeChat is called. It enforces refund ≤ paid `amount` − existing `refunded_amount` (over-refund across multiple partial refunds, NOT merely ≤ paid amount) and rejects an order that already has a `processing` refund, so a double-tap cannot spawn two WeChat refunds (each new `out_refund_no` is a NEW real refund; WeChat is idempotent only on the SAME `out_refund_no`). Do NOT reimplement either check as `.from('refunds').select(...)` in the Edge Function — that check is not atomic and both taps pass it.
   - Generate refund_no (used as `out_refund_no`) and pass it in; sign WeChat with the amount the RPC **returns**, never a client-supplied one. Then call `wxpay.v3.refund.domestic.refunds.post(...)` — record first, WeChat second.
   - **On WeChat API failure — do NOT leave the record stranded `processing`**: if WeChat definitively rejected (4xx business error → no refund created), mark the record `closed`/failed via `apply_refund_closed`; if it was only a lost response, `query_refund_status` (by `out_refund_no`) reconciles the real state later.
3. **app_refund_callback** (TX3 — Atomic):
   - **Step 0 — verify BEFORE decrypt**: same as payment callback — `verifyWechatCallback(...)` on the raw body; on failure log + return a **FAIL** response, do NOT decrypt (exact HTTP status per WeChat spec — do NOT hardcode 401). `verifyWechatCallback` is defined in `app-server-callback.md`; copy it unmodified, do not rewrite the verification.
   - Decrypt refund notification
   - **Map WeChat's `refund_status` (uppercase: `SUCCESS`/`CLOSED`/`ABNORMAL`) to the local `refund_status` enum (lowercase: `success`/`closed`/`abnormal`)** before writing — do NOT store the raw uppercase value into the enum column.
   - **Only `SUCCESS` moves money** — map, then dispatch to the matching RPC in `app-db-rpc.md`; each one is UPDATE-guarded on `status='processing'` and returns false on a duplicate, so the callback just returns `{code:"SUCCESS"}` either way:
     - **SUCCESS** → `apply_refund_success`: marks refund `success`, atomically increments order `refunded_amount`, and sets order `refunded` once it reaches the paid `amount` (else keeps `paid`). Adjust inventory inside that same RPC if needed.
     - **CLOSED** → `apply_refund_closed`: marks refund `closed` only — **no** change to order `refunded_amount` or status (no money was returned).
     - **ABNORMAL** → `apply_refund_abnormal`: marks refund `abnormal` + notify admin — **no** change to order `refunded_amount` or status (stuck, needs manual handling).
4. **query_refund_status** (refund-side 查单兜底, symmetric to query_order_status — refund result must NOT depend on the callback alone):
   - Query WeChat by `out_refund_no` (`GET /v3/refund/domestic/refunds/{out_refund_no}`); if the refund callback is lost/delayed, this pulls the final `refund_status`. Trigger on demand / on resume (refunds settle over minutes–hours, so no 2s polling needed).
   - Map WeChat's uppercase status to the local enum, then call the SAME three RPCs as `app_refund_callback` (`apply_refund_success` / `_closed` / `_abnormal` in `app-db-rpc.md`). They are UPDATE-guarded, so a callback that already landed makes this a no-op returning false — never a double-apply. Do NOT write a second, query-side copy of the status/amount update logic.
   - Reconcile ONLY from WeChat's response; no client-supplied amount/status.
5. The helper functions below are grouped by Edge Function — split them into their respective files, each keeping only its own imports (do NOT concatenate into one file). Use the signing / verification / crypto logic **unmodified** (security-critical, same as payment Required item 9 in `app.md`). Build the Supabase client per payment Required item 8 in `app.md` (`refund_order` resolves the caller; `app_refund_callback` / `query_refund_status` are server-driven and use `admin` only). The `refunds` table and its RLS policy are in `app-db-schema.md`.

```typescript
// refund_order Edge Function
import Wechatpay from "npm:wechatpay-axios-plugin@0.9.4";

// Refund number: Deno built-in only — do NOT add an npm id/uuid package for this.
const generateRefundNo = () => `REF-${new Date().toISOString().slice(2,10).replace(/-/g,"")}-${crypto.randomUUID().slice(0,8)}`;

async function createWechatRefund(MERCHANT_ID: string, MCH_CERT_SERIAL_NO: string, MCH_PRIVATE_KEY: string, WECHAT_PAY_PUBLIC_KEY_ID: string, WECHAT_PAY_PUBLIC_KEY: string, outTradeNo: string, outRefundNo: string, refundAmount: number, totalAmount: number, reason: string | undefined, notifyUrl: string) {
  try {
    const wxpay = new Wechatpay({
      mchid: MERCHANT_ID,
      serial: MCH_CERT_SERIAL_NO,
      privateKey: MCH_PRIVATE_KEY,
      certs: { [WECHAT_PAY_PUBLIC_KEY_ID]: WECHAT_PAY_PUBLIC_KEY },
    });

    const { data } = await wxpay.v3.refund.domestic.refunds.post({
      out_trade_no: outTradeNo,
      out_refund_no: outRefundNo,
      reason: reason || "退款",
      notify_url: notifyUrl,
      amount: {
        refund: Math.round(refundAmount * 100),
        total: Math.round(totalAmount * 100),
        currency: "CNY"
      }
    }, { headers: { "Wechatpay-Serial": WECHAT_PAY_PUBLIC_KEY_ID } });

    if (data.refund_id) {
      return { success: true, refundId: data.refund_id, status: data.status };
    } else {
      return { success: false, error: "发起退款失败" };
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[WeChatRefund ERROR] outRefundNo=${outRefundNo}, error=${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

// app_refund_callback Edge Function
import { Aes } from "npm:wechatpay-axios-plugin@0.9.4";
// Reuse verifyWechatCallback from app_payment_callback — the function body is in
// app-server-callback.md (same signature + timestamp check). Copy it as-is.
// Same wiring: read rawBody → verifyWechatCallback(...) → on !ok log + return FAIL (do NOT decrypt; status per WeChat spec)
// → JSON.parse(rawBody).resource → decryptRefundState(...) → idempotent update → return {code:"SUCCESS"}.

async function decryptRefundState(MCH_API_V3_KEY: string, associatedData: string, nonce: string, ciphertext: string): Promise<{ refundStatus: string; outTradeNo: string; outRefundNo: string }> {
  const plaintext = await Aes.AesGcm.decrypt(ciphertext, MCH_API_V3_KEY, nonce, associatedData);
  const obj = JSON.parse(plaintext);
  return {
    refundStatus: obj.refund_status ?? "",
    outTradeNo: obj.out_trade_no ?? "",
    outRefundNo: obj.out_refund_no ?? ""
  };
}

// query_refund_status Edge Function — refund-side 查单兜底 (call on demand / on resume, not high-frequency)
import Wechatpay from "npm:wechatpay-axios-plugin@0.9.4";

async function queryWechatRefund(MERCHANT_ID: string, MCH_CERT_SERIAL_NO: string, MCH_PRIVATE_KEY: string, WECHAT_PAY_PUBLIC_KEY_ID: string, WECHAT_PAY_PUBLIC_KEY: string, outRefundNo: string) {
  try {
    const wxpay = new Wechatpay({ mchid: MERCHANT_ID, serial: MCH_CERT_SERIAL_NO, privateKey: MCH_PRIVATE_KEY, certs: { [WECHAT_PAY_PUBLIC_KEY_ID]: WECHAT_PAY_PUBLIC_KEY } });
    // GET /v3/refund/domestic/refunds/{out_refund_no}
    const { data } = await wxpay.v3.refund.domestic.refunds[outRefundNo].get();
    return { success: true, refundStatus: data.status ?? "", outTradeNo: data.out_trade_no ?? "", outRefundNo: data.out_refund_no ?? "" };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[WeChatRefundQuery ERROR] outRefundNo=${outRefundNo}, error=${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}
```
</REFUND_REQUIREMENTS>
