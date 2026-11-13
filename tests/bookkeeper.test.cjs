// Phase 5b, the bookkeeper keeps the books (supabase/migrations/20261124000021_bookkeeper_books.sql) on a
// real local PostgreSQL. The bookkeeper reads exactly the books the admin reads (journal entries and the
// tracker's payments, expenses and fuel posted through the views), posts and voids entries, and changes
// the settings, while every other role still sees nothing and the tracker records stay read-only to them.
//   node --test tests/bookkeeper.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

let db;
const post = (date, memo, lines) => `select public.acct_post_entry('${date}', '${memo}', '${JSON.stringify(lines)}'::jsonb, '')`;
const tb = (who) => db.must(who, `select string_agg(code || ':' || debit || ':' || credit, ',' order by code) from public.acct_trial_balance('2026-12-31')`);

test.before(() => {
  db = startLocalPg();
  const { U, must } = db;
  U.book = '00000000-0000-4000-8000-000000000007';
  U.sales = '00000000-0000-4000-8000-000000000005';
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.book}', 'bea@example.com', '{"full_name":"Bea"}'), ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}'),
    ('${U.sales}', 'sam@example.com', '{"full_name":"Sam"}'), ('${U.purchaser}', 'pia@example.com', '{"full_name":"Pia"}'),
    ('${U.inactive}', 'old@example.com', '{"full_name":"Old"}');
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'bookkeeper', active = true, full_name = 'Bea' where id = '${U.book}';
    update public.profiles set role = 'designer', active = true where id = '${U.designer}';
    update public.profiles set role = 'sales', active = true where id = '${U.sales}';
    update public.profiles set role = 'purchaser', active = true where id = '${U.purchaser}';
    update public.profiles set role = 'bookkeeper', active = false where id = '${U.inactive}';`);
  // A payment, an expense, company fuel: the books post these themselves.
  must('admin', `insert into public.tracker_docs (collection, id, parent_id, data) values
    ('projects', 'P1', null, '{"name":"Test kitchen","price":112000,"status":"active","billing":{"dp":{"received":56000,"withheld":0,"receivedDate":"2026-02-10"}}}'),
    ('expenses', 'E1', 'P1', '{"date":"2026-02-12","item":"Marine plywood","category":"materials","amount":11200}'),
    ('companyFuel', 'F1', null, '{"date":"2026-04-03","vehicle":"Van","amount":2240,"liters":35}'),
    ('procurementJobs', 'pj_1', null, '{"name":"Hinges order"}');
    insert into public.leads (source, name, phone) values ('website', 'Test Lead', '09170000001');`);
  must('admin', post('2026-01-01', 'Opening balances', [{ account: '1020', debit: 100000 }, { account: '3010', credit: 100000 }]));
});
test.after(() => db && db.stop());

test('the bookkeeper reads the same books as the admin, tracker postings included', () => {
  const admin = tb('admin');
  // Worked out by hand: cash = 56,000 down payment - 11,200 plywood - 2,240 fuel = 42,560; sales
  // 50,000 + output VAT 6,000 (112,000 VATable); materials 11,200; fuel 2,240.
  assert.match(admin, /1010:42560\.00:0\.00/, 'cash: the payment in, the expense and the fuel out');
  assert.match(admin, /4010:0\.00:50000\.00/); assert.match(admin, /5010:11200\.00/); assert.match(admin, /6060:2240\.00/);
  assert.equal(tb('book'), admin, 'not a smaller set of books');
  assert.equal(db.must('book', `select count(*) from public.acct_auto_lines`), db.must('admin', `select count(*) from public.acct_auto_lines`));
});

test('the bookkeeper posts and voids entries, changes settings and the chart of accounts', () => {
  const { must, refused } = db;
  const id = must('book', post('2026-03-31', 'March rent', [{ account: '6030', debit: 15000 }, { account: '1020', credit: 15000 }]));
  assert.equal(must('super', `select created_by from public.acct_entries where id = ${id}`), db.U.book, 'credited to the bookkeeper');
  refused('book', post('2026-03-31', 'Unbalanced', [{ account: '6030', debit: 10 }, { account: '1020', credit: 9 }]), /must be equal/);
  must('book', `select public.acct_void_entry(${id}, 'Posted twice')`);
  must('book', `delete from public.acct_entries where id = ${id}`);   // no rule allows it, so nothing goes
  assert.equal(must('super', `select count(*) || ':' || (voided_at is not null) from public.acct_entries where id = ${id} group by voided_at`), '1:true', 'voided, never deleted');
  must('book', `select public.acct_save_account('6095', 'Bank charges', 'expense')`);
  assert.equal(must('admin', `select name from public.acct_accounts where code = '6095'`), 'Bank charges');
});

test('everyone else still sees no books and can\'t post', () => {
  const { must, refused } = db;
  for (const who of ['designer', 'sales', 'purchaser', 'inactive']) {
    assert.equal(must(who, `select count(*) from public.acct_entries`), '0', who);
    assert.equal(tb(who) || '', '', who + ' gets an empty trial balance');
    refused(who, post('2026-05-01', 'x', [{ account: '6030', debit: 1 }, { account: '1020', credit: 1 }]), /Only the admin and the bookkeeper post/);
  }
});

test('the bookkeeper reads the books\' sources only, and only reads them', () => {
  const { must, refused } = db;
  assert.equal(must('book', `select string_agg(distinct collection, ',' order by collection) from public.tracker_docs`), 'companyFuel,expenses,projects');
  assert.equal(must('book', `select count(*) from public.leads`), '0', 'no leads');
  refused('book', `insert into public.tracker_docs (collection, id, data) values ('expenses', 'E9', '{"amount":1}')`, /row-level security/);
  assert.equal(must('book', `with u as (update public.tracker_docs set data = data || '{"price":1}' where id = 'P1' returning 1) select count(*) from u`), '0', 'no edits');
  assert.equal(must('book', `with d as (delete from public.tracker_docs where id = 'E1' returning 1) select count(*) from d`), '0', 'no deletes');
});

test('the bookkeeper\'s entries are in the activity log and reach the admin\'s bell', () => {
  const { must } = db;
  assert(Number(must('super', `select count(*) from public.audit_log where module = 'Accounting' and actor = '${db.U.book}'`)) >= 2);
  assert(Number(must('super', `select count(*) from public.notify_events where module = 'Accounting'`)) >= 1);
});
