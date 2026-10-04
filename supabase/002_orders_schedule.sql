-- =========================================================
-- BizStore PH — Migration 002
-- Selling price, Orders (pre-order / paid-unpaid), Appointments (calendar)
-- Patakbuhin ito ng isang beses sa Supabase → SQL Editor → New query → Run
-- (Ligtas ulitin — idempotent)
-- =========================================================

-- ---------- PRODUCTS: manual selling price ----------
alter table public.products add column if not exists selling_price numeric(12,2);

-- ---------- ORDERS ----------
create table if not exists public.orders (
    id              uuid primary key default gen_random_uuid(),
    customer_name   text,
    order_type      text not null default 'regular'  check (order_type in ('regular', 'preorder')),
    status          text not null default 'released' check (status in ('pending', 'released', 'cancelled')),
    payment_status  text not null default 'paid'     check (payment_status in ('paid', 'unpaid')),
    total           numeric(12,2) not null default 0,
    note            text,
    created_at      timestamptz not null default now(),
    released_at     timestamptz,
    paid_at         timestamptz
);

create table if not exists public.order_items (
    id            uuid primary key default gen_random_uuid(),
    order_id      uuid not null references public.orders(id) on delete cascade,
    product_id    uuid references public.products(id) on delete set null,
    product_name  text not null,
    qty           integer not null check (qty > 0),
    unit_price    numeric(12,2) not null default 0,
    unit_cost     numeric(12,2) not null default 0,
    line_total    numeric(12,2) not null default 0
);

create index if not exists orders_created_idx on public.orders (created_at desc);
create index if not exists order_items_order_idx on public.order_items (order_id);

-- ---------- APPOINTMENTS (calendar) ----------
create table if not exists public.appointments (
    id           uuid primary key default gen_random_uuid(),
    client_name  text not null,
    contact      text,
    service      text not null default 'Gluta Drip',
    appt_date    date not null,
    appt_time    time,
    notes        text,
    status       text not null default 'scheduled' check (status in ('scheduled', 'done', 'cancelled', 'no_show')),
    created_at   timestamptz not null default now()
);

create index if not exists appointments_date_idx on public.appointments (appt_date);

-- ---------- CREATE ORDER (checkout) ----------
-- p_items: [{ "id": "<uuid>", "qty": 2, "price": 150.00 }, ...]
-- Regular  → ibabawas agad ang stock + itatala ang benta
-- Preorder → pending; ibabawas ang stock kapag ni-release
create or replace function public.create_order(
    p_customer text, p_type text, p_paid boolean, p_note text, p_items jsonb
) returns uuid
language plpgsql
security invoker
as $$
declare
    v_id     uuid;
    it       jsonb;
    v_qty    integer;
    v_name   text;
    v_cost   numeric;
    v_sold   integer;
    v_price  numeric;
    v_total  numeric := 0;
    v_cust   text := nullif(trim(coalesce(p_customer, '')), '');
begin
    if p_items is null or jsonb_array_length(p_items) = 0 then
        raise exception 'Walang laman ang cart';
    end if;
    if p_type not in ('regular', 'preorder') then
        raise exception 'Invalid order type';
    end if;

    insert into public.orders (customer_name, order_type, status, payment_status, note, paid_at, released_at)
    values (
        v_cust, p_type,
        case when p_type = 'preorder' then 'pending' else 'released' end,
        case when p_paid then 'paid' else 'unpaid' end,
        nullif(trim(coalesce(p_note, '')), ''),
        case when p_paid then now() end,
        case when p_type = 'preorder' then null else now() end
    )
    returning id into v_id;

    for it in select * from jsonb_array_elements(p_items) loop
        v_sold  := (it->>'qty')::integer;
        v_price := coalesce((it->>'price')::numeric, 0);

        if (it->>'id') is null then
            v_name := it->>'name';
            v_cost := coalesce((it->>'cost')::numeric, 0);
            
            insert into public.order_items (order_id, product_id, product_name, qty, unit_price, unit_cost, line_total)
            values (v_id, null, v_name, v_sold, v_price, v_cost, round(v_sold * v_price, 2));

            insert into public.stock_logs (product_id, product_name, action, qty_change, revenue, note)
            values (null, v_name, case when p_type = 'preorder' then 'Pre-order (Checkout)' else 'Sold (Checkout)' end, -v_sold, case when p_type = 'preorder' then 0 else round(v_sold * v_price, 2) end,
                    'Order #' || left(v_id::text, 8) || coalesce(' · ' || v_cust, ''));

            v_total := v_total + v_sold * v_price;
            continue;
        end if;

        select qty, name, cost into v_qty, v_name, v_cost
        from public.products where id = (it->>'id')::uuid
        for update;

        if not found then
            raise exception 'Product not found';
        end if;

        if p_type = 'regular' and v_sold > v_qty then
            raise exception 'Kulang ang stock ng %: % na lang', v_name, v_qty;
        end if;
        update public.products set qty = qty - v_sold, updated_at = now()
        where id = (it->>'id')::uuid;

        insert into public.stock_logs (product_id, product_name, action, qty_change, revenue, note)
        values ((it->>'id')::uuid, v_name, case when p_type = 'preorder' then 'Pre-order (Checkout)' else 'Sold (Checkout)' end, -v_sold, case when p_type = 'preorder' then 0 else round(v_sold * v_price, 2) end,
                'Order #' || left(v_id::text, 8) || coalesce(' · ' || v_cust, ''));

        insert into public.order_items (order_id, product_id, product_name, qty, unit_price, unit_cost, line_total)
        values (v_id, (it->>'id')::uuid, v_name, v_sold, v_price, v_cost, round(v_sold * v_price, 2));

        v_total := v_total + v_sold * v_price;
    end loop;

    update public.orders set total = round(v_total, 2) where id = v_id;
    return v_id;
end;
$$;

-- ---------- RELEASE PRE-ORDER ----------
create or replace function public.release_order(p_order_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
    v_order  public.orders%rowtype;
    r        public.order_items%rowtype;
    v_qty    integer;
begin
    select * into v_order from public.orders where id = p_order_id for update;
    if not found then raise exception 'Order not found'; end if;
    if v_order.status <> 'pending' then raise exception 'Hindi pending ang order na ito'; end if;

    for r in select * from public.order_items where order_id = p_order_id loop
        insert into public.stock_logs (product_id, product_name, action, qty_change, revenue, note)
        values (r.product_id, r.product_name, 'Sold (Released)', 0, r.line_total,
                'Pre-order released #' || left(p_order_id::text, 8) || coalesce(' · ' || v_order.customer_name, ''));
    end loop;

    update public.orders set status = 'released', released_at = now() where id = p_order_id;
end;
$$;

-- ---------- CANCEL ORDER ----------
-- Pending  → cancelled lang
-- Released → ibabalik ang stock + babawasin ang revenue
create or replace function public.cancel_order(p_order_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
    v_order  public.orders%rowtype;
    r        public.order_items%rowtype;
begin
    select * into v_order from public.orders where id = p_order_id for update;
    if not found then raise exception 'Order not found'; end if;
    if v_order.status = 'cancelled' then raise exception 'Cancelled na ang order na ito'; end if;

    for r in select * from public.order_items where order_id = p_order_id loop
        if r.product_id is not null then
            update public.products set qty = qty + r.qty, updated_at = now() where id = r.product_id;
        end if;
        insert into public.stock_logs (product_id, product_name, action, qty_change, revenue, note)
        values (r.product_id, r.product_name, 'Order Cancelled (Return)', r.qty, 
                case when v_order.status = 'released' then -r.line_total else 0 end,
                'Cancelled #' || left(p_order_id::text, 8) || coalesce(' · ' || v_order.customer_name, ''));
    end loop;

    update public.orders set status = 'cancelled' where id = p_order_id;
end;
$$;

grant execute on function public.create_order(text, text, boolean, text, jsonb) to anon, authenticated;
grant execute on function public.release_order(uuid) to anon, authenticated;
grant execute on function public.cancel_order(uuid) to anon, authenticated;

-- ---------- ROW LEVEL SECURITY ----------
-- WALANG LOGIN ang app — bukas ang access gamit ang anon key.
alter table public.orders       enable row level security;
alter table public.order_items  enable row level security;
alter table public.appointments enable row level security;

drop policy if exists "bizstore_all_orders" on public.orders;
create policy "bizstore_all_orders" on public.orders
    for all to anon, authenticated using (true) with check (true);

drop policy if exists "bizstore_all_order_items" on public.order_items;
create policy "bizstore_all_order_items" on public.order_items
    for all to anon, authenticated using (true) with check (true);

drop policy if exists "bizstore_all_appointments" on public.appointments;
create policy "bizstore_all_appointments" on public.appointments
    for all to anon, authenticated using (true) with check (true);

-- I-refresh ang API schema cache
notify pgrst, 'reload schema';
