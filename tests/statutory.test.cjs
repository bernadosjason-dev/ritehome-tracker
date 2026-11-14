// v4.0 statutory rules engine (supabase/migrations/20261127000024_statutory_rules.sql) on a real local
// PostgreSQL. Every peso was worked out by hand from the official tables in the seeded rules:
//
//   SSS 2025: MSC = 5,000 below 5,250; then 500 bands; 35,000 from 34,750. EE 5%, ER 10% + EC (10, or 30 from MSC 15,000).
//     5,249.99 -> MSC 5,000: EE 250, ER 510 · 5,250 -> 5,500: 275 / 560
//     15,650 (600 a day x 313 / 12) -> band 15,250-15,749.99 -> MSC 15,500: EE 775, ER 1,550 + 30 = 1,580
//     50,000 -> MSC 35,000 (SS 20,000 + MPF 15,000): EE 1,000 + 750 = 1,750, ER 2,000 + 1,500 + 30 = 3,530
//   PhilHealth 5%, floor 10,000, ceiling 100,000, half each: 8,000 -> 500 (250 each) · 15,650 -> 782.50 (391.25 each)
//     150,000 -> 5,000 (2,500 each)
//   Pag-IBIG: fund salary up to 10,000; EE 1% at 1,500 or less, else 2%; ER 2%: 1,000 -> 10 / 20 · 15,650 -> 200 / 200
//   BIR semi-monthly: 10,417 -> 0 · 16,666 -> 15% x 6,249 = 937.35 · 20,000 -> 937.50 + 20% x 3,333 = 1,604.10
//   BIR daily: 21,918 -> 6,034.30. Monthly 50,000 paid monthly: EE 1,750 + 1,250 + 200 = 3,200; taxable 46,800
//     -> 1,875 + 20% x (46,800 - 33,333) = 4,568.40
//   Minimum wage (RX-24): 486 from 2026-01-16, 500 from 2026-05-01; none before.
//   node --test tests/statutory.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

let db;
const q = (s) => String(s).replace(/'/g, "''");
const j = (v) => `'${q(JSON.stringify(v))}'::jsonb`;
const J = (who, sql) => JSON.parse(db.must(who, `select ${sql}`));
const D = "'2026-11-13'";

test.before(() => {
  db = startLocalPg();
  const { U, must } = db;
  U.book = '00000000-0000-4000-8000-000000000007';
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.book}', 'bea@example.com', '{"full_name":"Bea"}'), ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}');
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'bookkeeper', active = true, full_name = 'Bea' where id = '${U.book}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina' where id = '${U.designer}';`);
});
test.after(() => db && db.stop());

test('SSS follows the 2025 schedule, bracket by bracket', () => {
  const s = (c) => J('designer', `public.stat_sss(${c}, ${D})`);
  assert.deepEqual([s(5249.99).msc, s(5249.99).employee, s(5249.99).employer], [5000, 250, 510]);
  assert.deepEqual([s(5250).msc, s(5250).employee, s(5250).employer], [5500, 275, 560]);
  assert.deepEqual([s(15650).msc, s(15650).employee, s(15650).employer, s(15650).ec], [15500, 775, 1580, 30]);
  const top = s(50000);
  assert.deepEqual([top.msc, top.msc_ss, top.msc_mpf, top.ee_ss, top.ee_mpf, top.employee, top.employer], [35000, 20000, 15000, 1000, 750, 1750, 3530]);
  assert.equal(s(14000).ec, 10);
  assert.equal(top.rule_status, 'pending_review');
  // Before the 2025 schedule there is no rule here: an error, never a guess.
  assert.match(J('designer', `public.stat_sss(15000, '2024-06-01')`).error, /No SSS rule/);
});

test('PhilHealth, Pag-IBIG and withholding tax by hand', () => {
  const ph = (b) => J('designer', `public.stat_philhealth(${b}, ${D})`);
  assert.deepEqual([ph(8000).premium, ph(8000).employee, ph(8000).employer], [500, 250, 250]);
  assert.deepEqual([ph(15650).premium, ph(15650).employee, ph(15650).employer], [782.5, 391.25, 391.25]);
  assert.deepEqual([ph(150000).basis, ph(150000).employee], [100000, 2500]);
  const pi = (c) => J('designer', `public.stat_pagibig(${c}, ${D})`);
  assert.deepEqual([pi(1000).employee, pi(1000).employer], [10, 20]);
  assert.deepEqual([pi(15650).employee, pi(15650).employer, pi(15650).fund_salary], [200, 200, 10000]);
  const wt = (t, per) => J('designer', `public.stat_withholding(${t}, '${per}', ${D})`).tax;
  assert.equal(wt(10417, 'semi_monthly'), 0);
  assert.equal(wt(16666, 'semi_monthly'), 937.35);
  assert.equal(wt(20000, 'semi_monthly'), 1604.1);
  assert.equal(wt(21918, 'daily'), 6034.3);
  assert.equal(wt(46800, 'monthly'), 4568.4);
  db.refused('designer', `select public.stat_withholding(1000, 'yearly', ${D})`, /daily, weekly, semi_monthly or monthly/);
  assert.equal(db.must('designer', `select public.stat_minimum_wage('2026-03-01')`), '486');
  assert.equal(db.must('designer', `select public.stat_minimum_wage('2026-06-01')`), '500');
  assert.equal(db.must('designer', `select coalesce(public.stat_minimum_wage('2025-12-31')::text, 'none')`), 'none');
});

test('rules: admin and bookkeeper read and propose; only the admin approves (naming who checked); never edited or deleted', () => {
  const { U, must, refused } = db;
  refused('designer', `select public.statutory_rules_list()`, /Only the admin and the bookkeeper/);
  assert.equal(must('designer', `select count(*) from public.statutory_rules`), '0');
  const list = J('book', 'public.statutory_rules_list()');
  assert.equal(list.can_approve, false);
  assert.equal(list.rules.length, 18);   // 9 rates (24) + 7 deadlines (27) + 13th month (28) + annual tax table (29)
  assert.equal(list.rules.filter((r) => !r.code.startsWith('deadline_')).length, 11);
  assert.ok(list.rules.every((r) => r.status === 'pending_review' && r.source_title && r.verified_on));
  const sss = list.rules.find((r) => r.code === 'sss_contribution');
  refused('book', `select public.statutory_rule_decide('${sss.id}', 'approved', 'Checked by our accountant')`, /Only the admin approves/);
  refused('admin', `select public.statutory_rule_decide('${sss.id}', 'approved', '')`, /who checked it/);
  must('admin', `select public.statutory_rule_decide('${sss.id}', 'approved', 'Checked against the SSS PDF by A. Cruz, CPA')`);
  assert.equal(J('designer', `public.stat_sss(15650, ${D})`).rule_status, 'approved');
  refused('admin', `select public.statutory_rule_decide('${sss.id}', 'approved', 'again')`, /waiting for review/);
  refused('super', `update public.statutory_rules set params = '{}' where id = '${sss.id}'`, /isn't edited/);
  refused('super', `delete from public.statutory_rules where id = '${sss.id}'`, /retire it instead/);
  refused('book', `insert into public.statutory_rules (agency, code, name, params, effective_from, source_title, verified_on, verified_by) values ('SSS', 'x_rule', 'x', '{}', now(), 'src', now(), 'me')`, /permission denied/);
  // A law change is a new version from its date: the bookkeeper proposes, the old months keep the old rule.
  const proposal = { agency: 'PhilHealth', code: 'philhealth_premium', name: 'PhilHealth premium (test change)', params: { rate: 0.06, floor: 10000, ceiling: 100000, employee_part: 0.5 },
    effective_from: '2027-01-01', source_title: 'Made-up circular for this test', source_url: 'https://example.com/x' };
  must('book', `select public.statutory_rule_propose(${j(proposal)})`);
  assert.equal(J('designer', `public.stat_philhealth(20000, '2027-02-01')`).premium, 1200);
  assert.equal(J('designer', `public.stat_philhealth(20000, ${D})`).premium, 1000);
  refused('book', `select public.statutory_rule_propose(${j({ ...proposal, source_title: '' })})`, /official source/);
  refused('designer', `select public.statutory_rule_propose(${j(proposal)})`, /Only the admin and the bookkeeper/);
  const newer = J('admin', 'public.statutory_rules_list()').rules.find((r) => r.effective_from === '2027-01-01');
  must('admin', `select public.statutory_rule_decide('${newer.id}', 'retired', 'Test rule, not real')`);
  assert.equal(J('designer', `public.stat_philhealth(20000, '2027-02-01')`).premium, 1000);
  refused('admin', `select public.statutory_rule_decide('${newer.id}', 'approved', 'Undo')`, /waiting for review/);
  assert.ok(U);
});

test('government numbers: formatted, checked, private; the minimum-wage check flags a low rate', () => {
  const { U, must, refused } = db;
  const save = (who, p) => `select public.employee_statutory_save(${j(p)})`;
  const r = J('book', `public.employee_statutory_save(${j({ user_id: U.designer, tin: '123456789', sss_no: '3412345678', philhealth_no: '123456789012', pagibig_no: '121234567890' })})`);
  assert.deepEqual([r.tin, r.sss_no, r.philhealth_no, r.pagibig_no], ['123-456-789', '34-1234567-8', '12-345678901-2', '1212-3456-7890']);
  refused('book', save('book', { user_id: U.designer, sss_no: '12345' }), /Check the numbers/);
  refused('book', save('book', { user_id: U.book, tin: '111222333' }), /Only the admin changes your own/);
  refused('designer', save('designer', { user_id: U.designer, tin: '111222333' }), /Only the admin and the bookkeeper keep/);
  assert.equal(must('designer', `select sss_no from public.employee_statutory`), '34-1234567-8');
  assert.equal(must('designer', `select count(*) from public.employee_statutory where user_id <> '${U.designer}'`), '0');
  // Dina at 480 a day is below the 500 minimum: flagged, and treated as a minimum-wage earner (no tax).
  must('book', `select public.salary_rate_add(${j({ user_id: U.designer, effective_from: '2026-01-01', salary_type: 'daily', rate: '480' })})`);
  must('admin', `select public.salary_rate_add(${j({ user_id: U.book, effective_from: '2026-01-01', salary_type: 'monthly', rate: '50000' })})`);
  const o = J('book', `public.statutory_overview(${D})`);
  assert.equal(o.minimum_wage, 500);
  const dina = o.people.find((p) => p.name === 'Dina'), bea = o.people.find((p) => p.name === 'Bea');
  assert.deepEqual([dina.below_minimum, dina.mwe, dina.monthly], [true, true, 12520]);   // 480 x 313 / 12
  assert.deepEqual([bea.below_minimum, bea.mwe, bea.daily], [false, false, 1916.93]);    // 50,000 x 12 / 313
  const est = J('book', `public.statutory_month_estimate('${U.book}', ${D})`);
  assert.deepEqual([est.employee_contributions, est.taxable, est.withholding.tax], [3200, 46800, 4568.4]);
  assert.equal(J('book', `public.statutory_month_estimate('${U.designer}', ${D})`).withholding.tax, 0);
  refused('designer', `select public.statutory_overview(${D})`, /Only the admin and the bookkeeper/);
  refused('designer', `select public.statutory_month_estimate('${U.book}', ${D})`, /Only the admin and the bookkeeper/);
  assert.equal(must('super', `select count(*) > 0 from public.audit_log where module = 'Payroll' and table_name = 'employee_statutory'`), 't');
});
