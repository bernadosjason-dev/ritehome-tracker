// v4.3 compliance records and calendar (supabase/migrations/20261130000027_compliance.sql) on a real local PostgreSQL.
// By hand. October 2026, two approved payroll runs (figures from tests/payroll-runs.test.cjs):
//   Dina: run 2 SSS 925 + 1,850 + EC 30, PhilHealth 404.38 + 404.37, Pag-IBIG 200 + 200, tax 0.
//   Bea: tax 2,220.71 (run 1) + 1,973.68 (run 2); run 2 SSS 1,750 + 3,500 + 30, PhilHealth 1,202.08 + 1,202.07, Pag-IBIG 200 + 200.
//   => 1601-C 4,194.39 · SSS 2,805 + 5,280 = 8,085.00 · PhilHealth 3,212.90 · Pag-IBIG 800.00.
// Due dates for October: 1601-C Nov 10; PhilHealth Nov 15 (no PEN: the earlier window), Nov 20 once the PEN ends in 7;
// SSS Nov 30 (last day of the next month); Pag-IBIG Nov 30 ("Ritehome": R-Z, 25th to the month's end).
// December's 1601-C: Jan 15 2027. 2026's 13th month: Dec 24 2026; 2316 and 1604-C: Jan 31 2027.
//   node --test tests/compliance.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

let db;
const q = (s) => String(s).replace(/'/g, "''");
const j = (v) => `'${q(JSON.stringify(v))}'::jsonb`;
const list = (who, a = '2026-11-01', z = '2027-01-31') => JSON.parse(db.must(who, `select public.compliance_list('${a}', '${z}')`)).items;
const find = (items, code, period) => items.find((x) => x.code === code && x.period === period);

test.before(() => {
  db = startLocalPg();
  const { U, must } = db;
  U.book = '00000000-0000-4000-8000-000000000007';
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.book}', 'bea@example.com', '{"full_name":"Bea"}'), ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}');
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'bookkeeper', active = true, full_name = 'Bea' where id = '${U.book}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina' where id = '${U.designer}';`);
  const L = (run, who, name, v) => `('${run}', '${who}', '${name}', 'x', 'regular', 'daily', 600, 13, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ${v.slice(0, 7).join(', ')}, false, ${v[7]}, 0, '{}', '[]')`;
  must('super', `set session_replication_role = replica;
    insert into public.payroll_runs (id, period_start, period_end, release_date, status, contributions_timing, prepared_by) values
      ('00000000-0000-4000-8000-0000000000a1', '2026-10-01', '2026-10-15', '2026-10-15', 'released', 'second', '${U.book}'),
      ('00000000-0000-4000-8000-0000000000a2', '2026-10-16', '2026-10-31', '2026-10-29', 'approved', 'second', '${U.book}');
    insert into public.payroll_lines (run_id, user_id, name, role, employment_type, salary_type, daily_rate, days_worked, worked_minutes, deducted_minutes,
      unaccounted_days, basic_pay, premium, overtime_pay, allowance, adj_taxable, adj_nontaxable, adj_deductions, gross, taxable,
      sss_ee, sss_er, sss_ec, ph_ee, ph_er, pi_ee, pi_er, mwe, tax, net, basis, days) values
      ${L('00000000-0000-4000-8000-0000000000a1', U.designer, 'Dina', [0, 0, 0, 0, 0, 0, 0, 0])},
      ${L('00000000-0000-4000-8000-0000000000a1', U.book, 'Bea', [0, 0, 0, 0, 0, 0, 0, 2220.71])},
      ${L('00000000-0000-4000-8000-0000000000a2', U.designer, 'Dina', [925, 1850, 30, 404.38, 404.37, 200, 200, 0])},
      ${L('00000000-0000-4000-8000-0000000000a2', U.book, 'Bea', [1750, 3500, 30, 1202.08, 1202.07, 200, 200, 1973.68])};`);
});
test.after(() => db && db.stop());

test('settings: the admin sets when tracking starts; employer numbers checked', () => {
  const { must, refused } = db;
  refused('book', `select public.compliance_settings_save('{"tracking_from":"2026-10-01"}')`, /Only the admin changes when tracking starts/);
  refused('designer', `select public.compliance_settings_save('{"bir_rdo":"099"}')`, /Only the admin and the bookkeeper/);
  must('admin', `select public.compliance_settings_save('{"tracking_from":"2026-10-15"}')`);
  assert.equal(must('super', `select tracking_from from public.compliance_settings`), '2026-10-01');
  refused('book', `select public.compliance_settings_save('{"philhealth_pen":"123"}')`, /PhilHealth PEN \(12 digits\)/);
  refused('book', `select public.compliance_settings_save('{"bir_filing":"carrier pigeon"}')`, /Check the numbers/);
});

test('every obligation, its due date by rule, and the amount from approved payroll (by hand)', () => {
  const items = list('book');
  const due = (c, p) => find(items, c, p).due;
  assert.deepEqual(['deadline_1601c', 'deadline_philhealth', 'deadline_sss', 'deadline_pagibig'].map((c) => due(c, '2026-10')), ['2026-11-10', '2026-11-15', '2026-11-30', '2026-11-30']);
  assert.equal(due('deadline_1601c', '2026-12'), '2027-01-15');
  assert.equal(due('deadline_1601c', '2026-11'), '2026-12-10');
  assert.deepEqual([due('deadline_13th_month', '2026'), due('deadline_2316', '2026'), due('deadline_1604c', '2026')], ['2026-12-24', '2027-01-31', '2027-01-31']);
  const amt = (c) => find(items, c, '2026-10').amount;
  assert.deepEqual(['deadline_1601c', 'deadline_sss', 'deadline_philhealth', 'deadline_pagibig'].map(amt), [4194.39, 8085, 3212.9, 800]);
  assert.equal(find(items, 'deadline_sss', '2026-11').amount, null, 'no approved payroll for November yet: no amount, not zero');
  assert.equal(find(items, 'deadline_philhealth', '2026-10').weekend, true, 'Nov 15 2026 is a Sunday');
  assert.ok(items.every((x) => x.rule_status === 'pending_review' && x.source_title));
  assert.equal(items.filter((x) => x.period === '2026-09').length, 0, 'nothing before tracking starts');
  // With the PEN (ending in 7) PhilHealth moves to the 16th-20th window.
  db.must('book', `select public.compliance_settings_save('{"philhealth_pen":"12-345678901-7"}')`);
  assert.equal(find(list('book'), 'deadline_philhealth', '2026-10').due, '2026-11-20');
});

test('done only when someone records the reference: filed is not paid; never edited, voided with a reason', () => {
  const { must, refused } = db;
  const rec = (who, p) => `select public.compliance_record_add(${j(p)})`;
  must('book', rec('book', { code: 'deadline_1601c', period: '2026-10', kind: 'filed', reference: 'eBIRForms 2026-11-09-001', on_date: '2026-11-09' }));
  assert.notEqual(find(list('book'), 'deadline_1601c', '2026-10').status, 'done', 'a 1601-C is done when it is paid, not just filed');
  refused('book', rec('book', { code: 'deadline_1601c', period: '2026-10', kind: 'paid', reference: 'LBP 778812', on_date: '2026-11-09' }), /amount paid/);
  refused('book', rec('book', { code: 'deadline_1601c', period: '2026-10', kind: 'paid', reference: '', on_date: '2026-11-09', amount: '4194.39' }), /reference number/);
  refused('book', rec('book', { code: 'deadline_1601c', period: '2026-10', kind: 'paid', reference: 'LBP 1', on_date: '2099-01-01', amount: '1' }), /not in the future/);
  refused('designer', rec('designer', { code: 'deadline_sss', period: '2026-10', kind: 'paid', reference: 'PRN 1', on_date: '2026-11-09', amount: '1' }), /Only the admin and the bookkeeper/);
  const id = JSON.parse(must('book', rec('book', { code: 'deadline_1601c', period: '2026-10', kind: 'paid', reference: 'LBP 778812', on_date: '2026-11-09', amount: '4194.39' }))).id;
  const it = find(list('book'), 'deadline_1601c', '2026-10');
  assert.equal(it.status, 'done');
  assert.deepEqual(it.records.map((r) => r.kind), ['filed', 'paid']);
  refused('super', `update public.compliance_records set amount = 1 where id = '${id}'`, /aren't edited/);
  refused('super', `delete from public.compliance_records where id = '${id}'`, /void it instead/);
  refused('book', `select public.compliance_record_void('${id}', 'typo')`, /Only the admin voids/);
  refused('admin', `select public.compliance_record_void('${id}', '')`, /why it's void/);
  must('admin', `select public.compliance_record_void('${id}', 'Wrong bank reference')`);
  assert.notEqual(find(list('book'), 'deadline_1601c', '2026-10').status, 'done');
  refused('designer', `select public.compliance_list('2026-11-01', '2026-12-31')`, /Compliance is for the admin and the bookkeeper/);
  assert.equal(must('designer', `select count(*) from public.compliance_records`), '0');
  assert.equal(must('super', `select count(*) > 0 from public.audit_log where module = 'Compliance'`), 't');
});
