// v4.8 sales summary (supabase/migrations/20261204000031_sales_summary.sql) on a real local PostgreSQL.
// Made-up clients and amounts only (the owner's workbooks never go in this repository). Totals by hand:
//   2026: SC 101 Sam Jan 5 250,000 · SC 102 MAE Jan 20 300,000 · SC 104 MAE Feb 3 450,000 · SC 105 KEITH Feb 10 no amount (on hold)
//         · SC 106 KEITH Apr 1 120,000, then cancelled.
//   January 550,000 (2 contracts); February 450,000 (2, one without an amount); April 0 (cancelled); year 1,000,000.
//   By salesperson: MAE 750,000 (Jan 300,000, Feb 450,000); Sam 250,000; KEITH 0. Missing SC: 103. No amount: 105.
//   node --test tests/sales.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

let db;
const q = (s) => String(s).replace(/'/g, "''");
const j = (v) => `'${q(JSON.stringify(v))}'::jsonb`;
const J = (who, sql) => JSON.parse(db.must(who, `select ${sql}`));
const ids = {};

test.before(() => {
  db = startLocalPg();
  const { U, must } = db;
  U.book = '00000000-0000-4000-8000-000000000007';
  U.sales = '00000000-0000-4000-8000-000000000005';
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.book}', 'bea@example.com', '{"full_name":"Bea"}'), ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}'), ('${U.sales}', 'sam@example.com', '{"full_name":"Sam"}');
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'bookkeeper', active = true, full_name = 'Bea' where id = '${U.book}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina' where id = '${U.designer}';
    update public.profiles set role = 'sales', active = true, full_name = 'Sam' where id = '${U.sales}';`);
});
test.after(() => db && db.stop());

test('adding: sales add their own, the admin imports history; SC numbers unique; outsiders refused', () => {
  const { U, refused } = db;
  const c = J('sales', `public.sales_contract_save(${j({ sc_no: '101', contract_date: '2026-01-05', client: ' Client A ', description: 'Modular kitchen', amount: '250000', salesperson: 'MAE', salesperson_id: U.book })})`);
  assert.deepEqual([c.client, c.salesperson, c.salesperson_id, c.status, c.source], ['Client A', 'Sam', U.sales, 'ongoing', 'portal'], 'sales staff add their own sales only');
  ids[101] = c.id;
  refused('sales', `select public.sales_contract_save(${j({ sc_no: '101', contract_date: '2026-01-06', client: 'Client Z', amount: '1' })})`, /SC 101 is already in the register/);
  refused('designer', `select public.sales_contract_save(${j({ sc_no: '150', client: 'X', amount: '1' })})`, /admin, the bookkeeper and sales/);
  refused('sales', `select public.sales_contract_save(${j({ sc_no: '151', client: 'X', amount: '1,000' })})`, /pesos/);
  refused('sales', `select public.sales_contract_save(${j({ sc_no: '152', client: '', amount: '1' })})`, /Check the contract/);
  refused('sales', `insert into public.sales_contracts (sc_no, client) values (999, 'X')`, /permission denied/);
  for (const [sc, date, client, amount, who, status] of [['102', '2026-01-20', 'Client B', '300000', 'MAE'], ['104', '2026-02-03', 'Client C', '450000', 'MAE'],
    ['105', '2026-02-10', 'Client D', '', 'KEITH', 'on_hold'], ['106', '2026-04-01', 'Client E', '120000', 'KEITH']]) {
    ids[sc] = J('admin', `public.sales_contract_save(${j({ sc_no: sc, contract_date: date, client, amount, salesperson: who, status, source: 'import' })})`).id;
  }
  assert.equal(db.must('super', `select string_agg(source, ',' order by sc_no) from public.sales_contracts`), 'portal,import,import,import,import');
});

test('changing: the admin anything; the bookkeeper and the salesperson only status and notes; cancel, never delete', () => {
  const { refused, must } = db;
  assert.equal(J('book', `public.sales_contract_save(${j({ id: ids[101], status: 'paid', status_note: 'Full payment received' })})`).status, 'paid');
  refused('book', `select public.sales_contract_save(${j({ id: ids[101], amount: '260000' })})`, /Only the admin changes the SC number, date, client, amount or salesperson/);
  assert.equal(J('sales', `public.sales_contract_save(${j({ id: ids[101], status_note: 'Installed Jan 30' })})`).status_note, 'Installed Jan 30');
  refused('sales', `select public.sales_contract_save(${j({ id: ids[101], amount: '999' })})`, /Only the admin changes/);
  refused('sales', `select public.sales_contract_save(${j({ id: ids[102], status: 'paid' })})`, /only your own/);
  assert.equal(J('admin', `public.sales_contract_save(${j({ id: ids[102], amount: '300000.00', description: 'TV console' })})`).description, 'TV console');
  refused('sales', `select public.sales_contract_cancel('${ids[106]}', 'client backed out')`, /Only the admin cancels/);
  refused('admin', `select public.sales_contract_cancel('${ids[106]}', '')`, /Say why/);
  must('admin', `select public.sales_contract_cancel('${ids[106]}', 'Client backed out')`);
  refused('admin', `select public.sales_contract_cancel('${ids[106]}', 'again')`, /isn't open/);
  refused('book', `select public.sales_contract_save(${j({ id: ids[106], status: 'ongoing' })})`, /cancelled contract is changed only by the admin/);
  refused('super', `delete from public.sales_contracts where id = '${ids[106]}'`, /cancel it instead/);
});

test('quotas: the admin sets them from a date; sales and the bookkeeper read', () => {
  const { refused, must } = db;
  refused('sales', `select public.sales_quota_save(${j({ effective_from: '2025-01-01', amount: '500000' })})`, /Only the admin sets sales quotas/);
  refused('admin', `select public.sales_quota_save(${j({ effective_from: '2025-01-01', amount: '0' })})`, /above zero/);
  must('admin', `select public.sales_quota_save(${j({ effective_from: '2025-01-01', scope: 'person_month', amount: '500000' })})`);
  must('admin', `select public.sales_quota_save(${j({ effective_from: '2024-01-01', scope: 'team_quarter', amount: '7000000' })})`);
  must('admin', `select public.sales_quota_save(${j({ effective_from: '2024-01-01', scope: 'team_quarter', amount: '7500000', note: 'corrected' })})`);
  assert.equal(db.must('super', `select count(*) from public.sales_quotas`), '2', 'the same start date replaces, not duplicates');
});

test('the year, by hand: months, salespeople against the quota, what to check', () => {
  const { refused } = db;
  refused('designer', `select public.sales_summary(2026)`, /admin, the bookkeeper and sales/);
  refused('anon', `select public.sales_summary(2026)`, /permission denied/);
  const s = J('sales', `public.sales_summary(2026)`);
  assert.deepEqual(s.months.slice(0, 4).map((m) => [m.count, m.total]), [[2, 550000], [2, 450000], [0, 0], [0, 0]]);
  assert.equal(s.total, 1000000);
  assert.equal(s.cancelled, 1);
  assert.deepEqual(s.people.map((p) => [p.salesperson, p.total, p.count]), [['MAE', 750000, 2], ['Sam', 250000, 1], ['KEITH', 0, 1]]);
  assert.deepEqual(s.people[0].months.slice(0, 3), [300000, 450000, 0]);
  assert.deepEqual([s.quota.person_month[0], s.quota.team_quarter[0]], [500000, 7500000]);
  assert.deepEqual([s.check.missing_sc, s.check.no_amount, s.check.no_salesperson], [[103], [105], []]);
  assert.equal(s.next_sc_no, 107);
  assert.equal(s.can_admin, false);
  assert.equal(db.must('super', `select string_agg(distinct module, ',') from public.audit_log where table_name in ('sales_contracts', 'sales_quotas')`), 'Sales');
});

test('import: admin only, existing SC numbers skipped, all or nothing', () => {
  const { refused } = db;
  const rows = [{ sc_no: 102, contract_date: '2025-01-03', client: 'Should be skipped', amount: '1' },
    { sc_no: 201, contract_date: '2025-03-04', client: 'Client F', description: 'Closet', amount: '80000', salesperson: 'FAE', status: 'paid' },
    { sc_no: 202, contract_date: '2025-03-09', client: 'Client G', amount: '20000.50', salesperson: '', status: 'paid' }];
  refused('book', `select public.sales_contract_import(${j(rows)})`, /Only the admin imports/);
  refused('admin', `select public.sales_contract_import(${j([...rows, { sc_no: 203, client: '', amount: '1' }])})`, /SC 203: Check the contract/);
  assert.equal(db.must('super', `select count(*) from public.sales_contracts where sc_no in (201, 202)`), '0', 'nothing saved when one row is wrong');
  const r = J('admin', `public.sales_contract_import(${j(rows)})`);
  assert.deepEqual([r.added, r.skipped], [2, [102]]);
  const y = J('book', `public.sales_summary(2025)`);
  assert.deepEqual([y.total, y.months[2].total, y.check.no_salesperson], [100000.50, 100000.50, [202]]);
  assert.equal(db.must('super', `select client from public.sales_contracts where sc_no = 102`), 'Client B');
});
