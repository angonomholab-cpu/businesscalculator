-- =========================================================
-- BizStore PH — Supabase schema
-- Patakbuhin ito ng isang beses sa Supabase → SQL Editor → New query → Run
-- =========================================================

create extension if not exists pgcrypto;

-- ---------- CATEGORIES ----------
create table if not exists public.categories (
    id          uuid primary key default gen_random_uuid(),
    name        text not null unique,
    created_at  timestamptz not null default now()
);

insert into public.categories (name)
values ('Skincare'), ('Cosmetics'), ('Apparel'), ('General')
on conflict (name) do nothing;

-- ---------- PRODUCTS ----------
create table if not exists public.products (
    id           uuid primary key default gen_random_uuid(),
    name         text not null,
    category     text not null default 'General',
    barcode      text not null unique,
    cost         numeric(12,2) not null default 0,
    qty          integer not null default 0 check (qty >= 0),
    date_in      date,
    expiry_date  date,
    image_url    text,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

-- ---------- STOCK LOGS (history + sales) ----------
create table if not exists public.stock_logs (
    id            uuid primary key default gen_random_uuid(),
    product_id    uuid references public.products(id) on delete set null,
    product_name  text,
    action        text not null,
    qty_change    integer not null default 0,
    revenue       numeric(12,2) not null default 0,
    note          text,
    created_at    timestamptz not null default now()
);

create index if not exists stock_logs_product_idx on public.stock_logs (product_id);
create index if not exists stock_logs_action_date_idx on public.stock_logs (action, created_at);

-- ---------- MONTHLY SETUP / EXPENSES ----------
create table if not exists public.setup_configs (
    month       text primary key check (month ~ '^\d{4}-\d{2}$'),
    data        jsonb not null default '{}'::jsonb,
    updated_at  timestamptz not null default now()
);

-- ---------- ATOMIC CHECKOUT ----------
-- p_items: [{ "id": "<uuid>", "qty": 2, "revenue": 199.50 }, ...]
create or replace function public.process_checkout(p_items jsonb)
returns void
language plpgsql
security invoker
as $$
declare
    it      jsonb;
    v_qty   integer;
    v_name  text;
    v_sold  integer;
    v_rev   numeric;
begin
    for it in select * from jsonb_array_elements(p_items) loop
        v_sold := (it->>'qty')::integer;
        v_rev  := coalesce((it->>'revenue')::numeric, 0);

        select qty, name into v_qty, v_name
        from public.products
        where id = (it->>'id')::uuid
        for update;

        if not found then
            raise exception 'Product not found';
        end if;
        if v_sold > v_qty then
            raise exception 'Kulang ang stock ng %: % na lang', v_name, v_qty;
        end if;

        update public.products
        set qty = qty - v_sold, updated_at = now()
        where id = (it->>'id')::uuid;

        insert into public.stock_logs (product_id, product_name, action, qty_change, revenue, note)
        values ((it->>'id')::uuid, v_name, 'Sold (Checkout)', -v_sold, v_rev,
                'Total Revenue: ₱' || to_char(v_rev, 'FM999,999,990.00'));
    end loop;
end;
$$;

grant execute on function public.process_checkout(jsonb) to anon, authenticated;

-- ---------- ROW LEVEL SECURITY ----------
-- WALANG LOGIN ang app, kaya bukas ang access gamit ang anon key.
-- Kung ilalagay online, magdagdag ng Supabase Auth at higpitan ang mga policy na ito.
alter table public.categories    enable row level security;
alter table public.products      enable row level security;
alter table public.stock_logs    enable row level security;
alter table public.setup_configs enable row level security;

drop policy if exists "bizstore_all_categories" on public.categories;
create policy "bizstore_all_categories" on public.categories
    for all to anon, authenticated using (true) with check (true);

drop policy if exists "bizstore_all_products" on public.products;
create policy "bizstore_all_products" on public.products
    for all to anon, authenticated using (true) with check (true);

drop policy if exists "bizstore_all_logs" on public.stock_logs;
create policy "bizstore_all_logs" on public.stock_logs
    for all to anon, authenticated using (true) with check (true);

drop policy if exists "bizstore_all_setup" on public.setup_configs;
create policy "bizstore_all_setup" on public.setup_configs
    for all to anon, authenticated using (true) with check (true);

-- ---------- STORAGE (product photos) ----------
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

drop policy if exists "bizstore_read_images" on storage.objects;
create policy "bizstore_read_images" on storage.objects
    for select using (bucket_id = 'product-images');

drop policy if exists "bizstore_upload_images" on storage.objects;
create policy "bizstore_upload_images" on storage.objects
    for insert to anon, authenticated with check (bucket_id = 'product-images');

drop policy if exists "bizstore_delete_images" on storage.objects;
create policy "bizstore_delete_images" on storage.objects
    for delete to anon, authenticated using (bucket_id = 'product-images');
