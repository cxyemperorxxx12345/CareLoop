# App WeChat Pay — DB: the required RPCs

> Part of the `payment-wechat` skill (App platform). **Read `references/app/app.md` first** — Design Principle 5 (flip + effect in ONE transaction) and Payment Required item 8 are what these RPCs implement.
> **This file covers**: `create_pending_order`, `mark_order_paid`, `cancel_order`, and (refund only) `create_refund_record` / `apply_refund_*`. The table definitions they write are in `app-db-schema.md`.

<DB_SCHEMA>
**Atomic order-creation RPC (`create_pending_order`) — REQUIRED (Payment Required item 3, in `app-server-order.md`)**: `create_app_payment` calls THIS ONE function to write the order. It validates stock, computes the total **server-side** from the DB, and writes the order + line items in a SINGLE transaction — so a crash can never strand an order row with no line items, and neither table needs an INSERT policy. Below is the multi-item shape; for the single-product shape drop the `order_items` insert and put `product_id`/`quantity` on the order row.

```sql
-- Assumes the app's own product table exposes price / title / stock. Adapt the table and column
-- names to the actual schema — but keep the structure: prices read from the DB, `for update` on the
-- stock check, and one transaction for the order + its items.
-- p_items: [{"product_id":"<uuid>","quantity":2}, ...]  (client-supplied ids/quantities ONLY — never prices)
create or replace function public.create_pending_order(
  p_user_id  uuid,
  p_order_no text,
  p_items    jsonb
)
returns numeric                          -- the server-calculated total; the caller signs WeChat with THIS
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_total    numeric(12,2) := 0;
  v_snap     jsonb := '[]'::jsonb;       -- validated price/title snapshots, built BEFORE the order row
  v_item     jsonb;
  v_qty      int;
  v_product  public.products;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';   -- auth.uid() is NULL in a SECURITY DEFINER body
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_CART';
  end if;

  -- Phase 1: lock, validate, snapshot, total. No rows written yet.
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := greatest(1, coalesce((v_item->>'quantity')::int, 1));

    -- FOR UPDATE: serialize concurrent buyers of the same product so the stock check cannot race
    select * into v_product
      from public.products
     where id = (v_item->>'product_id')::uuid
     for update;

    if not found then
      raise exception 'PRODUCT_NOT_FOUND:%', v_item->>'product_id';
    end if;
    if v_product.stock < v_qty then
      raise exception 'OUT_OF_STOCK:%', v_product.title;
    end if;

    -- price/title snapshot taken from the DB, never from the client
    v_snap := v_snap || jsonb_build_object(
      'product_id', v_product.id, 'title', v_product.title,
      'price', v_product.price, 'quantity', v_qty);
    v_total := v_total + v_product.price * v_qty;
  end loop;

  v_total := round(v_total, 2);

  -- Phase 2: write the order with its FINAL amount, then its items. One transaction.
  insert into public.orders (order_no, out_trade_no, user_id, amount, status)
  values (p_order_no, p_order_no, p_user_id, v_total, 'pending')
  returning id into v_order_id;

  insert into public.order_items (order_id, product_id, title, price, quantity)
  select v_order_id, (s->>'product_id')::uuid, s->>'title',
         (s->>'price')::numeric, (s->>'quantity')::int
    from jsonb_array_elements(v_snap) s;

  return v_total;                        -- any raise above rolls back the order AND its items together
end;
$$;
-- Edge Function usage:
--   const { data: total, error } = await admin.rpc('create_pending_order',
--     { p_user_id: user.id, p_order_no: orderNo, p_items: items });
--   if (error) -> map error.message ('OUT_OF_STOCK:…' / 'PRODUCT_NOT_FOUND:…' / 'EMPTY_CART') to user copy;
--   nothing was written, so there is no order to cancel. Then sign WeChat with `total` (never a client amount).
-- Extra order columns the app needs (receiver_name / receiver_phone / receiver_address / remark …):
--   add them as further `p_*` params on THIS function and insert them with the order row. Do NOT
--   write them in a second `.from('orders').update(...)` call from the Edge Function — that is
--   exactly the RLS-exposed, non-atomic path this RPC exists to remove.
-- SETTLING AN EXISTING BUSINESS ROW (Design Principle 8's third shape — task / booking / service
--   order / dispatch job, no catalog product): replace p_items with `p_<x>_id uuid`, read the price
--   off that row (`select price into v_total from public.<x> where id = p_<x>_id for update`), and
--   drop the order_items insert. The function still takes NO amount parameter — if the signature
--   has a `p_amount`, the client price has just been laundered through the RPC and the check is void.
```

**Atomic settle RPC (`mark_order_paid`) — REQUIRED (Design Principle 5, in `app.md`)**: both `app_payment_callback` and `query_order_status` (reconcile SUCCESS) call THIS ONE function. It flips `pending→paid` AND applies the business effect in a SINGLE transaction, so the effect fires exactly once and can never be orphaned (never a separate "flip then credit" that can crash between the two steps). Keep the `returning` column list in sync with your actual `orders` columns if you rename them:
```sql
create or replace function public.mark_order_paid(p_order_no text, p_transaction_id text)
returns boolean                       -- true = first settle (effect applied); false = duplicate → caller returns SUCCESS
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_amount  numeric(12,2);
begin
  -- optimistic lock: ONLY the first caller matches status='pending', flips it, and gets the row back
  update public.orders
     set status = 'paid', transaction_id = p_transaction_id, paid_at = now(), updated_at = now()
   where order_no = p_order_no and status = 'pending'
   returning user_id, amount into v_user_id, v_amount;

  if not found then
    return false;                     -- 0 rows = duplicate/late callback (already paid) → apply nothing
  end if;

  -- Business effect — SAME transaction as the flip. Adapt to the app's domain, e.g.:
  --   credit balance : update public.profiles set balance = balance + v_amount where id = v_user_id;
  --   grant item     : insert into public.user_backpack (...) ...
  --   convert inventory : update reserved→sold ...
  --   MULTI-ITEM stock deduction (set-based, one statement — do NOT loop per item):
  --     update public.products p set stock = p.stock - oi.quantity
  --       from public.order_items oi
  --      where oi.order_id = v_order_id and oi.product_id = p.id;
  --     (declare v_order_id and add `id` to the `returning` list above. Prefer a plain subtraction
  --      over `greatest(0, ...)`: create_pending_order already validated stock, so a negative result
  --      means a real oversell — let a `stock >= 0` check constraint raise and roll the TX back
  --      rather than silently clamping and losing the signal.)
  -- If this raises, the whole TX (including the pending→paid flip) rolls back → callback retries cleanly.

  return true;
end;
$$;
-- Edge Function usage: const { data: applied } = await admin.rpc('mark_order_paid', { p_order_no, p_transaction_id });
-- applied === true → first settle; applied === false → duplicate. NEVER call a separate credit/business RPC after this.
-- `admin` = the true service_role client from Required item 8 (in app.md).
```

**Cancel RPC (`cancel_order`) — REQUIRED**: called by `create_app_payment` when prepay fails on the new-order branch, by `query_order_status` on a terminal WeChat failure state, and by the optional timeout job. Optimistic-locked so it can never overwrite a `paid` order:
```sql
create or replace function public.cancel_order(p_order_no text)
returns boolean                          -- true = cancelled by this call; false = not pending (already paid/cancelled)
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.orders
     set status = 'cancelled', updated_at = now()
   where order_no = p_order_no and status = 'pending';
  -- release any inventory freeze here, in the SAME transaction, if the app freezes on create
  return found;
end;
$$;
```
**Refund RPCs — CONDITIONAL (only if the user asked for refund; see `app-refund.md`)**. Two rules, both violated by the obvious hand-written version:

(a) **The idempotency guard is the UPDATE's row count, NEVER a preceding SELECT.** `select … where status='processing'` then `update` lets the refund callback and `query_refund_status` both pass the SELECT concurrently and add `refunded_amount` **twice**. Same lock shape as `mark_order_paid`:
```sql
create or replace function public.apply_refund_success(p_refund_no text)
returns boolean                          -- true = first settle; false = duplicate → caller returns SUCCESS
language plpgsql security definer set search_path = public
as $$
declare v_amt numeric(12,2); v_order_id uuid;
begin
  update public.refunds set status = 'success', updated_at = now()
   where refund_no = p_refund_no and status = 'processing'
   returning amount, order_id into v_amt, v_order_id;
  if not found then return false; end if;   -- 0 rows = already settled → move no money

  update public.orders                      -- atomic increment; in SET, the right side reads the OLD value
     set refunded_amount = refunded_amount + v_amt,
         status = case when refunded_amount + v_amt >= amount then 'refunded' else 'paid' end,
         updated_at = now()
   where id = v_order_id;
  return true;
end;
$$;
-- apply_refund_closed / apply_refund_abnormal: identical UPDATE-guarded shape (`where refund_no = …
-- and status = 'processing'`, `return found`), but they touch ONLY the refunds row — never
-- orders.refunded_amount and never orders.status, because no money moved.
```

(b) **Balance check + record creation must happen under one row lock**, or a double-tap spawns two real WeChat refunds (each `out_refund_no` is a new refund; WeChat dedupes only the same one). Do NOT do the `select … status='processing'` pre-check from the Edge Function — it is not atomic and both taps pass it:
```sql
create or replace function public.create_refund_record(
  p_refund_no text, p_order_id uuid, p_user_id uuid, p_amount numeric, p_reason text)
returns numeric                          -- the accepted amount; sign WeChat with THIS, not a client value
language plpgsql security definer set search_path = public
as $$
declare v_total numeric(12,2); v_done numeric(12,2); v_amt numeric(12,2);
begin
  select amount, refunded_amount into v_total, v_done from public.orders
   where id = p_order_id and user_id = p_user_id and status = 'paid'
   for update;                           -- serialises concurrent refund requests on this order
  if not found then raise exception 'ORDER_NOT_REFUNDABLE'; end if;
  if exists (select 1 from public.refunds
              where order_id = p_order_id and status = 'processing') then
    raise exception 'REFUND_IN_PROGRESS'; -- reachable only after the lock → actually exclusive
  end if;
  v_amt := round(coalesce(p_amount, v_total - v_done), 2);  -- null p_amount = full remaining balance
  if v_amt <= 0 or v_amt > v_total - v_done then
    raise exception 'REFUND_AMOUNT_EXCEEDS';                -- ≤ paid − already refunded, not ≤ paid
  end if;
  insert into public.refunds (refund_no, order_id, amount, status, reason)
  values (p_refund_no, p_order_id, v_amt, 'processing', p_reason);
  return v_amt;
end;
$$;
-- Usage: const { data: amt, error } = await admin.rpc('create_refund_record', {...}); on error map
-- ORDER_NOT_REFUNDABLE / REFUND_IN_PROGRESS / REFUND_AMOUNT_EXCEEDS to copy and return — nothing was
-- written, so there is no stranded `processing` row. Only then call WeChat, with `amt`.
```

</DB_SCHEMA>
