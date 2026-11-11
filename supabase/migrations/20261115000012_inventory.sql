-- Inventory: what's on the shelf, and every time stock was added or taken out.
--
-- Who: the admin and the purchaser (public.can_stock()). Nobody else sees or changes stock.
-- How stock is counted: there is no "quantity" column to overwrite. Every change is one row in
-- inventory_moves (+ in, − out), and stock on hand is the sum. So the page can always say who
-- took what, when, and for which job. A guard on that table refuses any movement that would
-- take an item below zero, whichever way the row arrives.
--
-- The purchaser also gets: the Procurement workspace's own documents (procurement jobs, BOMs and
-- purchase orders; never projects, expenses or fuel), and the Procurement stage on the Schedule.

create function public.can_stock() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('admin', 'purchaser'), false)
$$;

create or replace function public.role_owns_stage(p_role public.staff_role, p_stage text) returns boolean
language sql immutable set search_path = public as $$
  select case p_role
    when 'admin' then true
    when 'designer' then p_stage in ('design', 'cutlist', 'bom', 'final_cutlist')
    when 'purchaser' then p_stage = 'procurement'
    when 'fabrication' then p_stage = 'fabrication'
    when 'installer' then p_stage in ('installation', 'handover')
    else false end
$$;

create policy "tracker data: purchaser on procurement" on public.tracker_docs for all
  using (public.my_role() = 'purchaser' and collection in ('procurementJobs', 'procurement'))
  with check (public.my_role() = 'purchaser' and collection in ('procurementJobs', 'procurement'));

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  category text not null default 'other'
    check (category in ('board', 'edgeband', 'hardware', 'accessory', 'countertop', 'consumable', 'other')),
  unit text not null default 'pc' check (length(btrim(unit)) between 1 and 20),
  spec text not null default '' check (length(spec) <= 200),
  location text not null default '' check (length(location) <= 80),
  reorder_level numeric(12,2) not null default 0 check (reorder_level >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create unique index inventory_items_one_name on public.inventory_items (lower(btrim(name)), lower(btrim(spec))) where active;

create table public.inventory_moves (
  id bigint generated always as identity primary key,
  item_id uuid not null references public.inventory_items (id) on delete restrict,
  qty numeric(12,2) not null check (qty <> 0),
  kind text not null check (kind in ('receive', 'issue', 'adjust')),
  job text not null default '' check (length(job) <= 120),
  note text not null default '' check (length(note) <= 300),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index inventory_moves_item on public.inventory_moves (item_id, created_at desc);

create function public.inventory_on_hand(p_item uuid) returns numeric
language sql stable set search_path = public as $$
  select coalesce(sum(qty), 0) from public.inventory_moves where item_id = p_item
$$;

create function public.inventory_move_guard() returns trigger
language plpgsql set search_path = public as $$
declare v_have numeric; v_unit text; v_name text;
begin
  select name, unit into v_name, v_unit from public.inventory_items where id = new.item_id for update;
  if not found then raise exception 'No such item.' using errcode = 'P0002'; end if;
  if new.kind = 'receive' and new.qty < 0 then raise exception 'Stock received is a plus.' using errcode = '23514'; end if;
  if new.kind = 'issue' and new.qty > 0 then raise exception 'Stock used is a minus.' using errcode = '23514'; end if;
  v_have := public.inventory_on_hand(new.item_id);
  if v_have + new.qty < 0 then
    raise exception 'Only % % of % on hand.', rtrim(to_char(v_have, 'FM999999990.99'), '.'), v_unit, v_name using errcode = '23514';
  end if;
  new.created_by := auth.uid();
  new.created_at := now();
  return new;
end $$;
create trigger inventory_moves_guard before insert on public.inventory_moves
  for each row execute function public.inventory_move_guard();

create function public.inventory_item_save(p jsonb) returns uuid
language plpgsql security invoker set search_path = public as $$
declare v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  if not public.can_stock() then raise exception 'Inventory is for the purchaser and the admin.' using errcode = '42501'; end if;
  if btrim(coalesce(p ->> 'name', '')) = '' then raise exception 'Give the item a name.' using errcode = '23514'; end if;
  if v_id is null then
    insert into public.inventory_items (name, category, unit, spec, location, reorder_level)
    values (btrim(p ->> 'name'), coalesce(nullif(p ->> 'category', ''), 'other'), coalesce(nullif(btrim(p ->> 'unit'), ''), 'pc'),
      btrim(coalesce(p ->> 'spec', '')), btrim(coalesce(p ->> 'location', '')), coalesce(nullif(p ->> 'reorder_level', '')::numeric, 0))
    returning id into v_id;
  else
    if p ? 'active' and not (p ->> 'active')::boolean and public.inventory_on_hand(v_id) <> 0 then
      raise exception 'Bring the stock to zero before removing an item from the list.' using errcode = '23514';
    end if;
    update public.inventory_items set
      name = btrim(p ->> 'name'),
      category = coalesce(nullif(p ->> 'category', ''), category),
      unit = coalesce(nullif(btrim(p ->> 'unit'), ''), unit),
      spec = case when p ? 'spec' then btrim(p ->> 'spec') else spec end,
      location = case when p ? 'location' then btrim(p ->> 'location') else location end,
      reorder_level = case when p ? 'reorder_level' then coalesce(nullif(p ->> 'reorder_level', '')::numeric, 0) else reorder_level end,
      active = case when p ? 'active' then (p ->> 'active')::boolean else active end
    where id = v_id;
    if not found then raise exception 'No such item.' using errcode = 'P0002'; end if;
  end if;
  return v_id;
exception when unique_violation then
  raise exception 'That item is already on the list.' using errcode = '23505';
end $$;

create function public.inventory_move(p_item uuid, p_kind text, p_qty numeric, p_job text default '', p_note text default '')
returns numeric
language plpgsql security invoker set search_path = public as $$
declare v_qty numeric;
begin
  if not public.can_stock() then raise exception 'Inventory is for the purchaser and the admin.' using errcode = '42501'; end if;
  if p_qty is null or p_qty = 0 then raise exception 'Enter a quantity.' using errcode = '23514'; end if;
  if p_kind = 'receive' then v_qty := abs(p_qty);
  elsif p_kind = 'issue' then v_qty := -abs(p_qty);
  elsif p_kind = 'count' then
    if p_qty < 0 then raise exception 'A count can''t be below zero.' using errcode = '23514'; end if;
    v_qty := p_qty - public.inventory_on_hand(p_item);
    if v_qty = 0 then return p_qty; end if;
  else raise exception 'Pick add, use or count.' using errcode = '23514';
  end if;
  insert into public.inventory_moves (item_id, qty, kind, job, note)
  values (p_item, v_qty, case when p_kind = 'count' then 'adjust' else p_kind end, btrim(coalesce(p_job, '')), btrim(coalesce(p_note, '')));
  return public.inventory_on_hand(p_item);
end $$;

-- One call for the page. Definer because it names who moved the stock (profiles) and offers the
-- open jobs to charge stock to (project names only, never prices); both are otherwise admin-only.
create function public.inventory_board() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_stock() then raise exception 'Inventory is for the purchaser and the admin.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'role', public.my_role(),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.id, 'name', i.name, 'category', i.category, 'unit', i.unit, 'spec', i.spec, 'location', i.location,
        'reorder_level', i.reorder_level, 'on_hand', s.on_hand, 'last_move', s.last_move)
        order by i.category, lower(i.name), lower(i.spec))
      from public.inventory_items i
      cross join lateral (select coalesce(sum(m.qty), 0) as on_hand, max(m.created_at) as last_move
        from public.inventory_moves m where m.item_id = i.id) s
      where i.active), '[]'::jsonb),
    'moves', coalesce((select jsonb_agg(x.row order by x.at desc) from (
        select m.created_at as at, jsonb_build_object('id', m.id, 'item_id', m.item_id, 'item', i.name, 'spec', i.spec, 'unit', i.unit,
          'qty', m.qty, 'kind', m.kind, 'job', m.job, 'note', m.note, 'at', m.created_at,
          'by', coalesce(nullif(pr.full_name, ''), 'Someone')) as row
        from public.inventory_moves m
        join public.inventory_items i on i.id = m.item_id
        left join public.profiles pr on pr.id = m.created_by
        order by m.created_at desc, m.id desc limit 60) x), '[]'::jsonb),
    'jobs', coalesce((select jsonb_agg(n order by n) from (
        select distinct coalesce(nullif(btrim(d.data ->> 'clientName'), ''), nullif(btrim(d.data ->> 'name'), '')) as n
        from public.tracker_docs d
        where d.collection = 'projects' and coalesce(d.data ->> 'status', '') <> 'completed') j where n is not null), '[]'::jsonb));
end $$;

alter table public.inventory_items enable row level security;
alter table public.inventory_moves enable row level security;
create policy "inventory items: purchaser and admin read" on public.inventory_items for select using (public.can_stock());
create policy "inventory items: purchaser and admin add" on public.inventory_items for insert with check (public.can_stock());
create policy "inventory items: purchaser and admin change" on public.inventory_items for update
  using (public.can_stock()) with check (public.can_stock());
create policy "inventory moves: purchaser and admin read" on public.inventory_moves for select using (public.can_stock());
create policy "inventory moves: purchaser and admin add" on public.inventory_moves for insert with check (public.can_stock());

revoke all on public.inventory_items, public.inventory_moves from anon;
revoke delete, truncate on public.inventory_items, public.inventory_moves from authenticated;
revoke update on public.inventory_moves from authenticated;
revoke execute on function public.can_stock(), public.inventory_on_hand(uuid), public.inventory_item_save(jsonb),
  public.inventory_move(uuid, text, numeric, text, text), public.inventory_board() from public, anon;
grant execute on function public.can_stock(), public.inventory_on_hand(uuid), public.inventory_item_save(jsonb),
  public.inventory_move(uuid, text, numeric, text, text), public.inventory_board() to authenticated;
revoke execute on function public.inventory_move_guard() from public, anon, authenticated;
