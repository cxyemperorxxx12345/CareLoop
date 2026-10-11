# App WeChat Pay — DB: tables + RLS contract

> Part of the `payment-wechat` skill (App platform). **Read `references/app/app.md` first** — the RLS contract below is only correct because of Payment Required item 8 (true service_role client), which lives there.
> **This file covers**: order shape choice, `orders` / `order_items` / `refunds` tables, the enums, and every RLS policy. The RPCs that write these tables are in `app-db-rpc.md`.

<DB_SCHEMA>
Recommended database schema.

**Pick the order shape FIRST — it changes the whole contract:**

| App shape | orders | Client sends |
|---|---|---|
| One product per order (top-up, single ticket, subscription) | `product_id` + `quantity` on `orders` | `{ product_id, quantity }` |
| Cart / multi-item (any shop-like app) | `orders` + `order_items` child table | `{ items: [{ product_id, quantity }] }` |

Choose the multi-item shape whenever the app has a cart, or lets one order hold more than one product. Do NOT bolt a child table onto the single-product schema and leave `product_id`/`quantity` on `orders` — pick one shape and keep it consistent across schema, RPC, Edge Function and client.

```sql
create type order_status as enum ('pending', 'paid', 'refunded', 'cancelled');

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_no text unique not null,
  user_id uuid not null references auth.users(id),   -- NO `default auth.uid()`: writes come from a
                                                     -- service_role client / SECURITY DEFINER RPC where
                                                     -- auth.uid() is NULL. Always pass it explicitly.
  amount numeric(12,2) not null,
  status order_status not null default 'pending',
  out_trade_no text unique not null,       -- id sent to WeChat; simplest to set = order_no (client polls by order_no, server queries WeChat by out_trade_no)
  transaction_id text,
  refunded_amount numeric(12,2) not null default 0,
  version int default 0,
  paid_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
  -- SINGLE-PRODUCT shape only: add `product_id text not null, quantity int not null default 1` here
  -- and skip the order_items table below.
);

-- MULTI-ITEM shape only: line items, with a price/title snapshot taken at order time
create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null,
  title text not null,                     -- snapshot: the product may be renamed/repriced later
  price numeric(12,2) not null,            -- snapshot unit price, server-calculated
  quantity int not null default 1
);
create index on public.order_items (order_id);
```

**RLS — read it as a contract, not boilerplate.** Both tables get SELECT-only policies for `authenticated`, and NO insert/update/delete policy for anyone. That is correct **only because every write goes through a `SECURITY DEFINER` RPC** (`create_pending_order`, `mark_order_paid` — both in `app-db-rpc.md`) or a **true service_role client** (Required item 8 in `app.md`) — both bypass RLS entirely.

```sql
-- Users read their own orders; NOBODY writes via the client API.
alter table public.orders enable row level security;
create policy "Users can view own orders" on public.orders
  for select to authenticated using (auth.uid() = user_id);

-- MULTI-ITEM shape only: read line items through order ownership
alter table public.order_items enable row level security;
create policy "Users can view own order items" on public.order_items
  for select to authenticated using (
    exists (select 1 from public.orders o where o.id = order_items.order_id and o.user_id = auth.uid())
  );

-- Deliberately NO insert/update/delete policy on either table.
-- With RLS enabled and no INSERT policy, ANY client-API insert fails with
--   42501: new row violates row-level security policy
-- so the write path MUST be a SECURITY DEFINER RPC or a true service_role client.
-- If you ever see "订单创建失败，请重试": the Edge Function is NOT actually service_role
-- (see the ❌ example in Required item 8, in app.md) — fix the client construction. Do NOT "fix" it by
-- adding an INSERT policy for authenticated: that would let a user forge orders and amounts.
```

**Any OTHER table this flow writes follows the SAME rule.** Whatever child/side tables the app adds (`order_items`, `refunds`, inventory ledgers, entitlement grants, …): SELECT-only policy for `authenticated`, no INSERT/UPDATE/DELETE policy, all writes via `SECURITY DEFINER` RPC or the true service_role client. A new table is the most common place this contract gets silently dropped — when you add one to the payment path, re-read Required item 8 in `app.md`.

**Refunds table — ONLY create this if refund is implemented** (per Design Principle 10 in `app.md`; skip entirely for payment-only apps). The refund Edge Functions (`refund_order`, `app_refund_callback`, `query_refund_status` — see `app-refund.md`) read/write this table:
```sql
create type refund_status as enum ('processing', 'success', 'closed', 'abnormal');

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  refund_no text unique not null,          -- out_refund_no sent to WeChat
  order_id uuid not null references public.orders(id),
  amount numeric(12,2) not null,
  status refund_status not null default 'processing',
  reason text,
  version int default 0,                   -- optimistic lock for idempotent callback/query
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- RLS: users read refunds for their own orders; NO write policy — same contract as orders
-- (SECURITY DEFINER RPC or true service_role client only).
alter table public.refunds enable row level security;
create policy "Users can view own refunds" on public.refunds
  for select to authenticated using (
    exists (select 1 from public.orders o where o.id = refunds.order_id and o.user_id = auth.uid())
  );
```
</DB_SCHEMA>
