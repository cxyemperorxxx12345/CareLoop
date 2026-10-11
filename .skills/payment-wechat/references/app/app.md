<APP_PAYMENT_REQUIREMENTS>
Design Principles:
1. **IMPORTANT**: Think minimal pages, complete flow for payment (and refund if required).
    - Analyze user requirements to determine the MINIMAL page set needed for complete workflow
    - MUST ensure workflow is complete and closed-loop, but avoid unnecessary pages
2. Required items > User requirements > Recommended items.
3. **Orders written ONLY by Edge Functions on a TRUE service_role client** — user-level write permissions prohibited. The word "true" is load-bearing: injecting the caller's JWT into `global.headers.Authorization` silently downgrades a service_role client to `authenticated`, RLS then applies, and order creation fails. Required item 8 gives the mandatory client-construction pattern — read it before writing any Edge Function.
4. **NO PLACEHOLDER PAGES**: No TODO items—all payment code must be production-complete. NO placeholder content.
5. **Idempotency + atomicity = ONE transaction**: the optimistic-lock status flip AND the business effect it authorizes (credit balance / grant entitlement / convert inventory) MUST run in the SAME DB transaction. Do both inside ONE `SECURITY DEFINER` RPC — do NOT split "flip status" and "apply effect" into two separate statements/RPCs in the Edge Function. The RPC does `UPDATE ... WHERE status='pending'`, and ONLY if that affected a row does it apply the effect, then returns `applied=true`; 0 rows = duplicate callback → apply nothing, return `applied=false` (caller returns SUCCESS). This makes the effect fire **exactly once and never orphaned**: a split ("mark paid" then a separate "credit") can crash between the two → order stuck `paid` with the effect never applied, and the optimistic lock makes the retry skip it → **user paid but got nothing**. (See the `mark_order_paid` RPC in `app-db-rpc.md`.)
6. Transaction atomicity: all mutations for one state change succeed or fail together — enforced via the single RPC in item 5.
7. **Secrets NEVER in client code**: ALL signing, verification, and callback handling MUST be in Edge Functions. Client only invokes Edge Functions and polls for results.
8. **Server-side pricing**: Client sends product identity + quantity only — `{ product_id, quantity }` (single-product shape) or `{ items: [{ product_id, quantity }] }` (cart shape) — and **NEVER** an `amount`, `price`, or `total`. The Edge Function / RPC reads prices from the DB and computes the total. If a request body contains a price-like field, ignore it; do not fall back to it. A third shape exists and is the one most often got wrong: when the payment settles an **existing business row** (a task / booking / service order / dispatch job rather than a catalog product), the body carries ONLY that row's id — the RPC reads the price off that row. Do NOT accept an `amount` for this shape either, and do NOT give the RPC a price parameter to accept one through.
9. **No openid required**: Unlike MiniProgram (JSAPI), App payment does NOT require user openid.
10. **Trigger Conditions**:
    - **Refund trigger**: Do NOT implement refund if user only asks for payment/purchase functionality
11. **NO SIMULATED PAYMENT.** An order becomes `paid` in exactly two ways: WeChat's callback (`app_payment_callback`) or a WeChat active query (`query_order_status`). Prohibited: any request flag that settles an order (`simulate_pay` / `mock_pay` / `is_simulation` / `dev_mode`, or any renamed equivalent); any "模拟支付 / 测试支付" button; hand-built `weixin://wxpay/bizpayurl?pr=...` strings or invented `prepay_id` values (a real one comes only from WeChat's prepay API — anything else scans as expired); and any local "mark paid" fallback when prepay / invoke / SDK fails.
    - **A user answering "密钥未配置" is NOT authorization to build a simulation path.** The only legal product then is the `WECHAT_NOT_CONFIGURED` contract (Required item 7 in `app-server-order.md`): the flow stops there, visibly, with nothing marked paid. Branch on that `code` **specifically** — never read "invoke returned an error" as "WeChat is not configured" and degrade; other errors (out of stock, insufficient balance) must be shown as themselves.
12. **Column names come from the migration, not from memory.** Every column the frontend references in `.select()` / `.eq()` / `.order()` — embedded selects included — must exist in the applied migration. Lint cannot see this: PostgREST returns 42703 at runtime, the list comes back empty, and the pay button that depends on that list does nothing — the most common way a payment flow dies before it ever reaches WeChat. After writing the data-access layer, verify every name against the live schema (`information_schema.columns`) and fix each mismatch. Seed rows those lists need must live in a migration file, not an ad-hoc SQL call.

Edge Functions to create and deploy:
1. `create_app_payment` — Create App prepay order, return invocation params (prepay_id + secondary signature)
2. `app_payment_callback` — Handle WeChat async payment callback, verify signature + update order status
3. `query_order_status` — Client polls order payment result
4. `refund_order` — Create refund request (only if refund required)
5. `app_refund_callback` — Handle WeChat refund result callback (only if refund required)
6. `query_refund_status` — Reconcile refund result via WeChat active query (only if refund required)

Reference files (all in this same `references/app/` directory). **THIS file is always required — read it first and in full.** The rest are NOT a menu to pick from: for ANY App WeChat-Pay task, every file marked REQUIRED below must be read. Read them in this order — DB first, because every Edge Function calls the RPCs defined there:

1. REQUIRED `app-db-schema.md` — `orders` / `order_items` tables, the enums, and the RLS contract (SELECT-only for `authenticated`, no write policy at all).
2. REQUIRED `app-db-rpc.md` — the RPCs the Edge Functions call: `create_pending_order`, `mark_order_paid`, `cancel_order`, plus the refund RPCs if refund is in scope.
3. REQUIRED `app-server-order.md` — config gate + order creation + prepay (`create_app_payment`). Payment Required items 1, 2, 3, 7.
4. REQUIRED `app-server-callback.md` — payment callback (`app_payment_callback`) + `verifyWechatCallback`. Payment Required item 4.
5. REQUIRED `app-server-query.md` — order status polling / WeChat 查单 fallback (`query_order_status`) + Recommended items. Payment Required item 5.
6. REQUIRED `app-client.md` — Expo + React Native side: deps, `app.json`, `registerApp`, `requestPayment`, resume fallback, client prohibitions.
7. CONDITIONAL `app-refund.md` — `refund_order`, `app_refund_callback`, `query_refund_status`. Read ONLY if the user explicitly asked for refund (Design Principle 10); skip it otherwise.

Three rules about reading them:
- Read at most two of these files per shell command. A single command that dumps all of them exceeds the output limit and the middle — where the signing and crypto code is — gets silently cut. So this takes 3-4 commands; do NOT stop after the first one or two because they looked sufficient.
- Do NOT write any payment code until every REQUIRED file above has been read. Each one carries at least one rule that cannot be inferred from the others: the RLS write contract, the exact `Formatter.joinedByLineFeed` argument order for the secondary signature, verify-before-decrypt on the callback, the `reconcile` flag contract, the iOS `LSApplicationQueriesSchemes` entries.
- Payment Required item numbers are global across these files and are deliberately NOT renumbered. A reference to "Required item 8" always means item 8 as written in THIS file.

<PAYMENT_REQUIREMENTS>
Required Items (Payment) — the cross-cutting items, applying to EVERY Edge Function in this skill. Items 1-5 and 7 are in the server files listed above.
6. Use WeChat Pay **APP API** exclusively. Secrets (exact names, configured via Plugin Center): MERCHANT_ID, MERCHANT_APP_ID, MCH_CERT_SERIAL_NO, MCH_PRIVATE_KEY, WECHAT_PAY_PUBLIC_KEY_ID, WECHAT_PAY_PUBLIC_KEY, MCH_API_V3_KEY
8. **Supabase client construction inside Edge Functions (MANDATORY)**: separate **permission** from **identity**. They are two different things and must come from two different places.

   ```typescript
   import { createClient } from "npm:@supabase/supabase-js@2.115.0";

   // PERMISSION — a TRUE service_role client. Never pass `global.headers.Authorization`.
   const admin = createClient(
     Deno.env.get("SUPABASE_URL")!,
     Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
   );

   // IDENTITY — hand the caller's JWT to getUser() as an argument; do NOT bake it into the client.
   const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
   const { data: { user }, error: userErr } = await admin.auth.getUser(jwt);
   if (userErr || !user) {
     return new Response(JSON.stringify({ error: "未登录", code: "UNAUTHORIZED" }), {
       status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
     });
   }
   // From here: `admin` bypasses RLS for writes; `user.id` is the trusted purchaser id.
   // Always pass user.id EXPLICITLY (RPC arg / insert payload / .eq filter).
   ```

   - ❌ **NEVER** do this — it is the exact bug this rule exists to prevent:
     ```typescript
     // BROKEN: service_role key lands only in `apikey`; PostgREST resolves the role from
     // `Authorization`, so this connection runs as `authenticated` and RLS APPLIES.
     // Every read still works and every SECURITY DEFINER RPC still works, so it looks fine —
     // then the order INSERT fails with 42501 "new row violates row-level security policy"
     // and the user sees "订单创建失败，请重试". Do not write this.
     createClient(URL, SERVICE_ROLE_KEY, { global: { headers: { Authorization: authHeader } } });
     ```
   - ❌ **NEVER** rely on `auth.uid()` anywhere reached by a service_role client or a `SECURITY DEFINER` RPC — it is NULL in both. This includes column defaults (`user_id uuid default auth.uid()`), RLS predicates on the write path, and filters inside RPC bodies. Thread `user.id` through as an explicit value.
   - Applies to **every** Edge Function in this skill (`create_app_payment`, `query_order_status`, `refund_order`, …). Callbacks (`app_payment_callback`, `app_refund_callback`) have no caller JWT at all — WeChat is the caller — so they build only `admin` and skip the `getUser` step entirely.
   - **Self-check before deploying any Edge Function**: grep your own source for `global` — if `global.headers.Authorization` appears next to `SERVICE_ROLE_KEY`, the function is broken; fix it before deploying.

9. The helper functions in `app-server-order.md`, `app-server-callback.md`, `app-server-query.md` and `app-refund.md` are grouped by Edge Function as headers/comments (`// create_app_payment Edge Function`, `// app_payment_callback Edge Function`, `// query_order_status Edge Function`, …). Split them into their respective files — each file keeps only its OWN imports; do NOT concatenate every snippet into one file (the repeated `import ... from "npm:wechatpay-axios-plugin"` lines would collide). Within each file, use the signing / verification / crypto logic **unmodified** — the exact signature-string order, `joinedByLineFeed` arguments, key types, and AES-GCM calls are security-critical; do not "improve" or rewrite them.
</PAYMENT_REQUIREMENTS>
</APP_PAYMENT_REQUIREMENTS>
