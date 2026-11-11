-- The office whiteboard's words, so the Schedule can read like it (see 20261113000008_schedule.sql).
--   final_cutlist   the board's "Final cutlist": the cutlist re-checked after the BOM, printed and
--                   approved for the workshop. Sits between the BOM and procurement.
--   waiting_client  "Design proposal, no feedback yet": the ball is in the client's court.
--   submitted       "Submitted" / "For review": done by the person in charge, waiting for approval.
-- On its own on purpose: Postgres can't use a new enum value in the transaction that adds it, and
-- the next migration seeds and compares these values.
alter type public.stage_key add value if not exists 'final_cutlist' after 'bom';
alter type public.stage_status add value if not exists 'waiting_client' after 'in_progress';
alter type public.stage_status add value if not exists 'submitted' after 'waiting_client';
