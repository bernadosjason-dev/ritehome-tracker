-- A fifth role: the purchaser, who buys materials and keeps the inventory (one person, one role).
-- On its own because Postgres can't use a new enum value in the transaction that adds it.
alter type public.staff_role add value if not exists 'purchaser' after 'designer';
