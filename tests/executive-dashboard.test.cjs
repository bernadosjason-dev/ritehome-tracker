// v4.2 executive dashboard (supabase/migrations/20261129000026_executive_dashboard.sql) on a real local
// PostgreSQL. Figures by hand from what's seeded:
//   Books (October 2026): opening Dr 1020 100,000 / Cr capital; rent Oct 5 Dr 6030 15,000 / Cr 1020; internet bill on
//   credit Oct 6 Dr 6050 2,000 / Cr 2010; P2 "Office partitions" (completed, non-VAT, price 50,000) down payment
//   20,000 received Oct 10 (Dr 1010).
//   => cash 100,000 - 15,000 + 20,000 = 105,000 (1020: 85,000, 1010: 20,000); still to collect 210,000 (2 projects:
//      P1 180,000 with nothing paid yet, P2 30,000);
//      payables 2,000 (tracked); October income 20,000, costs 17,000, cash in 120,000, cash out 15,000.
//   Forecast: 1 month of books before this month -> no forecast, and it says why.
//   Risks: Dina 480 a day < 500 minimum (critical); P2 finished but owes 30,000 (high); Ana kitchen design blocked
//   (high), cutlist 10 days late (high), consultation late since Oct 20; Sam has no rate (moderate); 16 rules waiting (moderate).
//   Calendar Oct 2026: pay days Oct 15 and Oct 29 (Oct 30 a holiday, moved earlier); received Oct 1 100,000 and
//   Oct 10 20,000; paid out Oct 5 15,000.
//   node --test tests/executive-dashboard.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

let db;
const q = (s) => String(s).replace(/'/g, "''");
const j = (v) => `'${q(JSON.stringify(v))}'::jsonb`;
const post = (date, memo, lines) => `select public.acct_post_entry('${date}', '${memo}', '${JSON.stringify(lines)}'::jsonb, '')`;

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
  must('admin', `insert into public.tracker_docs (collection, id, parent_id, data) values
    ('projects', 'P1', null, '{"name":"Ana kitchen","price":180000,"status":"active"}'),
    ('projects', 'P2', null, '{"name":"Office partitions","price":50000,"status":"completed","billing":{"dp":{"received":20000,"receivedDate":"2026-10-10"}}}');
    insert into public.acct_project_vat (project_id, treatment) values ('P2', 'non_vat');`);
  must('admin', post('2026-10-01', 'Opening balance', [{ account: '1020', debit: 100000 }, { account: '3010', credit: 100000 }]));
  must('admin', post('2026-10-05', 'October rent', [{ account: '6030', debit: 15000 }, { account: '1020', credit: 15000 }]));
  must('admin', post('2026-10-06', 'Internet bill', [{ account: '6050', debit: 2000 }, { account: '2010', credit: 2000 }]));
  must('super', `set session_replication_role = replica;
    update public.project_stages set status = 'blocked', planned_end = (now() at time zone 'Asia/Manila')::date + 3 where project_id = 'P1' and stage = 'design';
    update public.project_stages set status = 'in_progress', planned_start = (now() at time zone 'Asia/Manila')::date - 20, planned_end = (now() at time zone 'Asia/Manila')::date - 10 where project_id = 'P1' and stage = 'cutlist';
    update public.project_stages set planned_end = '2026-10-20' where project_id = 'P1' and stage = 'consultation';
    insert into public.project_events (kind, title, starts_at, ends_at, holiday_type) values ('holiday', 'Test holiday', '2026-10-30 00:00+08', '2026-10-30 23:59+08', 'regular');`);
  must('book', `select public.salary_rate_add(${j({ user_id: U.designer, effective_from: '2026-10-01', salary_type: 'daily', rate: '480' })})`);
  must('admin', `select public.salary_rate_add(${j({ user_id: U.book, effective_from: '2026-10-01', salary_type: 'monthly', rate: '25000' })})`);
});
test.after(() => db && db.stop());

test('money in separate boxes: actual cash, owed to us, we owe; no forecast without 6 months', () => {
  const o = JSON.parse(db.must('admin', 'select public.executive_overview()'));
  const f = o.finance;
  assert.equal(f.actual.cash, 105000);
  assert.deepEqual(f.actual.cash_by_account, { 1010: 20000, 1020: 85000 });
  assert.deepEqual(f.owed_to_us, { receivables: 210000, projects: 2 });   // Ana kitchen 180,000 (nothing paid yet) + Office partitions 30,000
  assert.deepEqual([f.we_owe.payables, f.we_owe.liabilities, f.we_owe.loans, f.we_owe.tracked], [2000, 2000, 0, true]);
  const oct = f.months.find((m) => m.month === '2026-10');
  assert.deepEqual([oct.income, oct.costs, oct.cash_in, oct.cash_out], [20000, 17000, 120000, 15000]);
  assert.equal(f.months.length, 12);
  assert.equal(f.forecast.available, false);
  assert.match(f.forecast.reason, /at least 6 full months/);
  assert.equal(f.forecast.months, undefined);
});

test('risks are real records, ranked by severity, each with its reason and where to act', () => {
  const o = JSON.parse(db.must('book', 'select public.executive_overview()'));
  const t = (re) => { const r = o.risks.find((x) => re.test(x.title)); assert.ok(r, 'no risk matching ' + re + ' in: ' + o.risks.map((x) => x.title).join(' | ')); return r; };
  assert.equal(t(/Dina is paid below the minimum wage/).severity, 'critical');
  assert.match(t(/Dina is paid below/).why, /480\.00 against the 500\.00 minimum/);
  assert.equal(t(/Office partitions is finished but still owes 30,000\.00/).severity, 'high');
  assert.equal(t(/Ana kitchen · Design is blocked/).severity, 'high');
  assert.equal(t(/Ana kitchen · Initial cutlist is 10 days late/).severity, 'high');
  assert.equal(t(/1 person has no pay rate/).severity, 'moderate');
  assert.equal(t(/16 statutory rules are waiting/).severity, 'moderate');
  const rank = { critical: 0, high: 1, moderate: 2, low: 3 };
  for (let i = 1; i < o.risks.length; i++) assert.ok(rank[o.risks[i - 1].severity] <= rank[o.risks[i].severity], 'sorted by severity');
  assert.ok(o.risks.every((r) => r.why && r.link && r.area));
  assert.deepEqual([o.org.people, o.org.staff, o.org.projects.open, o.org.pending.stages_blocked, o.org.pending.stages_late], [4, 3, 1, 1, 2]);   // late: cutlist and consultation (Oct 20)
  assert.equal(o.org.trend.length, 14);
  assert.equal(o.payroll.people_without_rate, 1);
  assert.equal(o.payroll.rules_pending, 16);   // 9 rates + 7 deadlines
  assert.ok(o.payroll.forecast_assumption);
});

test('the calendar: pay days moved off holidays, milestones, money that moved', () => {
  const c = JSON.parse(db.must('admin', `select public.executive_calendar('2026-10-01', '2026-10-31')`));
  const on = (d, cat) => c.filter((x) => x.date === d && x.category === cat);
  assert.deepEqual(c.filter((x) => x.title === 'Pay day').map((x) => x.date), ['2026-10-15', '2026-10-29']);
  assert.deepEqual(c.filter((x) => x.title === 'Cutoff ends').map((x) => x.date), ['2026-10-15', '2026-10-31']);
  assert.equal(on('2026-10-30', 'holiday')[0].detail, 'regular holiday');
  assert.deepEqual([on('2026-10-01', 'money_in')[0].amount, on('2026-10-10', 'money_in')[0].amount, on('2026-10-05', 'money_out')[0].amount], [100000, 20000, 15000]);
  assert.match(on('2026-10-20', 'milestone')[0].title, /Ana kitchen · Consultation/);
  db.refused('admin', `select public.executive_calendar('2026-01-01', '2027-06-01')`, /up to 400 days/);
});

test('only the admin and the bookkeeper; read-only by construction', () => {
  const { must, refused } = db;
  for (const who of ['designer', 'sales']) {
    refused(who, 'select public.executive_overview()', /for the admin and the bookkeeper/);
    refused(who, `select public.executive_calendar('2026-10-01', '2026-10-31')`, /for the admin and the bookkeeper/);
  }
  refused('anon', 'select public.executive_overview()', /permission denied/);
  // Both are STABLE functions: Postgres refuses any write inside them.
  assert.equal(must('super', `select string_agg(provolatile::text, '') from pg_proc where proname in ('executive_overview', 'executive_calendar')`), 'ss');
  const before = must('super', 'select count(*) from public.audit_log');
  must('admin', 'select public.executive_overview()');
  assert.equal(must('super', 'select count(*) from public.audit_log'), before, 'reading the dashboard changes nothing');
});
