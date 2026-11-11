// The in-house books (supabase/migrations/20261111000005_accounting.sql), run
// against a real local PostgreSQL. Every expected figure below was worked out
// by hand from the records seeded here, not read back from the database:
//
//   P1 VATable, price 112,000. Down payment 56,000 cash on Feb 10:
//        Dr cash 56,000 / Cr sales-VATable 50,000 / Cr output VAT 6,000
//      Progress 44,000 cash + 800 withheld on May 5 (settles 44,800):
//        Dr cash 44,000, Dr CWT 800 / Cr sales-VATable 40,000 / Cr output VAT 4,800
//   P2 non-VAT, price 50,000. Down payment 20,000 on Aug 1: Dr cash / Cr sales-non-VAT
//   P3 price 30,000, an old-style `downpayment` of 10,000 with no date: not in the books
//   E1 materials 11,200, VAT invoice: Dr 5010 10,000, Dr input VAT 1,200 / Cr cash
//   E2 labor 5,000 · E3 category "tools" 300 (-> 5090) · E4 amount "abc" · E5 Feb 30
//   E6 dated 2025 (before the books start) · F1 fuel 2,240 with 200 VAT on the invoice
//   Journal: opening Dr bank 100,000 / Cr capital · Mar 31 rent 15,000 from bank
//      Apr 20 Q1 VAT settled: Dr output 6,000 / Cr input 1,200 / Cr VAT payable 4,800
//      Jun 30 drawings 5,000 cash · 2025-06-30 other income 3,000 cash (last year)
//
//   node --test tests/accounting.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const { startLocalPg } = require("./fixtures/local-pg.cjs");

let db;
const rows = (out) => (out ? out.split("\n").map((l) => l.split("|")) : []);
const post = (date, memo, lines, ref = "") =>
  `select public.acct_post_entry('${date}', '${memo}', '${JSON.stringify(lines)}'::jsonb, '${ref}')`;

test.before(() => {
  db = startLocalPg();
  const { U, must } = db;
  must("super", `insert into auth.users (id, email) values ('${U.admin}', 'owner@example.com'),
    ('${U.designer}', 'designer@example.com'), ('${U.inactive}', 'new@example.com');
    update public.profiles set role = 'admin', active = true where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true where id = '${U.designer}';`);
  must("admin", `insert into public.tracker_docs (collection, id, parent_id, data) values
    ('projects', 'P1', null, '{"name":"Ana kitchen","price":112000,"status":"active","billing":{
       "dp":{"received":56000,"withheld":0,"receivedDate":"2026-02-10"},
       "progress":{"received":"44000","withheld":800,"receivedDate":"2026-05-05"},
       "retention":{"received":0,"receivedDate":""}}}'),
    ('projects', 'P2', null, '{"name":"Office partitions","price":50000,"status":"completed","billing":{
       "dp":{"received":20000,"receivedDate":"2026-08-01"}}}'),
    ('projects', 'P3', null, '{"name":"Old wardrobe","price":30000,"downpayment":10000}'),
    ('expenses', 'E1', 'P1', '{"date":"2026-02-12","item":"Marine plywood","category":"materials","amount":11200}'),
    ('expenses', 'E2', 'P1', '{"date":"2026-02-15","item":"Installer wages","category":"labor","amount":5000}'),
    ('expenses', 'E3', 'P2', '{"date":"2026-08-02","item":"Jigsaw blades","category":"tools","amount":300}'),
    ('expenses', 'E4', 'P1', '{"date":"2026-03-01","item":"Hinges","category":"materials","amount":"abc"}'),
    ('expenses', 'E5', 'P1', '{"date":"2026-02-30","item":"Crew lunch","category":"food","amount":500}'),
    ('expenses', 'E6', 'P1', '{"date":"2025-12-20","item":"Old board","category":"materials","amount":2000}'),
    ('companyFuel', 'F1', null, '{"date":"2026-04-03","vehicle":"Van","amount":2240,"liters":35}');
    insert into public.acct_project_vat (project_id, treatment) values ('P2', 'non_vat');
    insert into public.acct_purchase_vat (collection, doc_id, input_vat) values ('expenses', 'E1', null), ('companyFuel', 'F1', 200);`);
  must("admin", post("2026-01-01", "Opening balances", [{ account: "1020", debit: 100000 }, { account: "3010", credit: 100000 }], "OB"));
  must("admin", post("2026-03-31", "March rent", [{ account: "6030", debit: 15000 }, { account: "1020", credit: 15000 }]));
  must("admin", post("2026-04-20", "Q1 VAT", [{ account: "2100", debit: 6000 }, { account: "1300", credit: 1200 }, { account: "2110", credit: 4800 }]));
  must("admin", post("2026-06-30", "Owner drawings", [{ account: "3020", debit: 5000 }, { account: "1010", credit: 5000 }]));
  must("admin", post("2025-06-30", "Scrap sale", [{ account: "1010", debit: "3000.00" }, { account: "4900", credit: 3000 }]));
});
test.after(() => db && db.stop());

test("trial balance: every account, balanced, last year's profit closed to 3900", () => {
  const tb = rows(db.must("admin", "select code, debit, credit from public.acct_trial_balance('2026-12-31')"));
  assert.deepEqual(tb, [
    ["1010", 99260, 0], ["1020", 85000, 0], ["1300", 200, 0], ["1310", 800, 0],
    ["2100", 0, 4800], ["2110", 0, 4800], ["3010", 0, 100000], ["3020", 5000, 0],
    ["3900", 0, 3000], ["4010", 0, 90000], ["4020", 0, 20000],
    ["5010", 10000, 0], ["5020", 5000, 0], ["5090", 300, 0], ["6030", 15000, 0], ["6060", 2040, 0]
  ].map(([c, d, k]) => [c, d.toFixed(2), k.toFixed(2)]));
  assert.equal(db.must("admin", "select sum(debit) || '=' || sum(credit) from public.acct_trial_balance('2026-12-31')"), "222600.00=222600.00");
  // Before last year closes, the 2025 income is still income, not 3900.
  assert.equal(db.must("admin", "select code || ':' || credit from public.acct_trial_balance('2025-12-31') where code in ('3900','4900')"), "4900:3000.00");
});

test("income statement and balance sheet agree with each other", () => {
  const is = rows(db.must("admin", "select code, type, amount from public.acct_income_statement('2026-01-01', '2026-12-31')"));
  const total = (t) => is.filter((r) => r[1] === t).reduce((s, r) => s + Number(r[2]), 0);
  assert.equal(total("revenue"), 110000);
  assert.equal(total("cost_of_sales"), 15300);
  assert.equal(total("expense"), 17040);
  const bs = rows(db.must("admin", "select code, type, amount from public.acct_balance_sheet('2026-12-31')"));
  const sum = (t) => bs.filter((r) => r[1] === t).reduce((s, r) => s + Number(r[2]), 0);
  assert.equal(sum("asset"), 185260);
  assert.equal(sum("liability"), 9600);
  assert.equal(sum("equity"), 175660);
  assert.deepEqual(bs.find((r) => r[0] === ""), ["", "equity", "77660.00"], "net income 110,000 - 15,300 - 17,040");
  assert.deepEqual(bs.find((r) => r[0] === "3020"), ["3020", "equity", "-5000.00"], "drawings reduce equity");
});

test("VAT by quarter: the settlement entry doesn't cancel the figures it settles", () => {
  const q = rows(db.must("admin", "select quarter, vatable_sales, non_vat_sales, output_vat, input_vat, vat_still_due, tax_withheld_by_clients from public.acct_vat_quarters(2026)"));
  assert.deepEqual(q, [
    ["1", "50000.00", "0.00", "6000.00", "1200.00", "4800.00", "0.00"],
    ["2", "40000.00", "0.00", "4800.00", "200.00", "4600.00", "800.00"],
    ["3", "0.00", "20000.00", "0.00", "0.00", "0.00", "0.00"],
    ["4", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00"]
  ]);
});

test("receivables and the data problems the books can't use silently", () => {
  assert.deepEqual(rows(db.must("admin", "select project_id, balance from public.acct_receivables()")),
    [["P2", "30000.00"], ["P3", "20000.00"], ["P1", "11200.00"]]);
  const issues = rows(db.must("admin", "select kind, doc_id from public.acct_data_issues() order by kind, doc_id"));
  assert.deepEqual(issues, [
    ["bad_amount", "E4"], ["before_books_start", "E6"], ["undated_payment", "P3"], ["undated_purchase", "E5"],
    ["unmapped_category", "E3"], ["vat_unconfirmed", "P1"], ["vat_unconfirmed", "P3"]
  ]);
});

test("the tracker is the source: editing or deleting an expense changes the books", () => {
  const { must } = db;
  const cash = () => must("admin", "select debit from public.acct_trial_balance('2026-12-31') where code = '1010'");
  must("admin", `update public.tracker_docs set data = data || '{"amount":6000}' where id = 'E2'`);
  assert.equal(cash(), "98260.00");
  must("admin", `update public.tracker_docs set data = data || '{"amount":5000}' where id = 'E2'`);
  assert.equal(cash(), "99260.00");
  must("admin", `insert into public.tracker_docs (collection, id, parent_id, data) values
    ('expenses', 'E7', 'P1', '{"date":"2026-09-01","item":"Refund","category":"materials","amount":-1120}');
    insert into public.acct_purchase_vat (collection, doc_id) values ('expenses', 'E7');`);
  assert.equal(must("admin", "select string_agg(account_code || ':' || debit || ':' || credit, ' ' order by account_code) from public.acct_gl where source_id = 'E7'"),
    "1010:1120.00:0 1300:0:120.00 5010:0:1000.00", "a negative purchase reverses every side, VAT included");
  must("admin", "delete from public.tracker_docs where id = 'E7'");
  assert.equal(must("admin", "select count(*) from public.acct_purchase_vat where doc_id = 'E7'"), "0", "its VAT tag goes with it");
  assert.equal(cash(), "99260.00");
});

test("entries must balance and are never edited or deleted, only voided", () => {
  const { must, refused } = db;
  refused("admin", post("2026-07-01", "Lopsided", [{ account: "6040", debit: 100 }, { account: "1010", credit: 90 }]), /must be equal/);
  refused("admin", post("2026-07-01", "One line", [{ account: "6040", debit: 0 }]), /at least two lines/);
  refused("admin", post("2026-07-01", "Both sides", [{ account: "6040", debit: 50, credit: 50 }, { account: "1010", credit: 0 }]), /either a debit or a credit/);
  refused("admin", post("2026-07-01", "No such account", [{ account: "9999", debit: 10 }, { account: "1010", credit: 10 }]), /doesn't exist or is inactive/);
  // Going around the function still can't leave an entry unbalanced: checked at commit.
  const raw = (lines) => `with e as (insert into public.acct_entries (entry_date, memo) values ('2026-07-01', 'raw') returning id)
    insert into public.acct_lines (entry_id, account_code, debit, credit) select e.id, l.a, l.d, l.c from e,
    (values ${lines}) l (a, d, c)`;
  refused("admin", raw("('6040', 100, 0)"), /needs at least two lines/);
  refused("admin", raw("('6040', 100, 0), ('1010', 0, 99)"), /doesn't balance/);
  assert.equal(db.must("admin", "select count(*) from public.acct_entries where memo = 'raw'"), "0", "nothing half-posted");

  const id = must("admin", post("2026-07-15", "Power bill", [{ account: "6040", debit: 2500 }, { account: "1010", credit: 2500, memo: "paid at CEPALCO" }], "OR 991"));
  assert.equal(must("admin", "select debit from public.acct_trial_balance('2026-12-31') where code = '1010'"), "96760.00");
  // No policy lets anyone update or delete a line, so these match nothing; the owner (SQL editor) hits the trigger.
  assert.equal(must("admin", `update public.acct_lines set debit = 1 where entry_id = ${id} returning id`), "");
  assert.equal(must("admin", `delete from public.acct_lines where entry_id = ${id} returning id`), "");
  refused("super", `update public.acct_lines set debit = 1 where entry_id = ${id}`, /can't be changed/);
  refused("super", `delete from public.acct_lines where entry_id = ${id}`, /can't be changed/);
  assert.equal(must("admin", `select sum(debit) from public.acct_lines where entry_id = ${id}`), "2500.00");
  refused("admin", `update public.acct_entries set memo = 'edited' where id = ${id}`, /can't be edited/);
  assert.equal(must("admin", `delete from public.acct_entries where id = ${id} returning id`), "", "no delete policy");
  refused("super", `delete from public.acct_entries where id = ${id}`, /never deleted/);
  refused("admin", `select public.acct_void_entry(${id}, '  ')`, /Say why/);
  must("admin", `select public.acct_void_entry(${id}, 'Duplicate of OR 990')`);
  assert.equal(must("admin", `select (voided_by = '${db.U.admin}') || ':' || void_reason from public.acct_entries where id = ${id}`), "true:Duplicate of OR 990");
  assert.equal(must("admin", "select debit from public.acct_trial_balance('2026-12-31') where code = '1010'"), "99260.00", "void entries leave the books");
  refused("admin", `select public.acct_void_entry(${id}, 'again')`, /No open entry/);
  refused("admin", `insert into public.acct_lines (entry_id, account_code, debit) values (${id}, '6040', 1)`, /void entry/);
});

test("locking a period stops back-dated posting and voiding", () => {
  const { must, refused } = db;
  must("admin", "update public.acct_settings set locked_through = '2026-03-31'");
  refused("admin", post("2026-03-15", "Late March bill", [{ account: "6040", debit: 10 }, { account: "1010", credit: 10 }]), /locked through 2026-03-31/);
  const rent = must("admin", "select id from public.acct_entries where memo = 'March rent'");
  refused("admin", `select public.acct_void_entry(${rent}, 'wrong month')`, /locked through/);
  const ok = must("admin", post("2026-04-01", "April bill", [{ account: "6040", debit: 10 }, { account: "1010", credit: 10 }]));
  must("admin", `select public.acct_void_entry(${ok}, 'test')`);
  must("admin", "update public.acct_settings set locked_through = null");
});

test("accounts and settings stay consistent", () => {
  const { must, refused } = db;
  must("admin", "insert into public.acct_accounts (code, name, type) values ('6200', 'Software subscriptions', 'expense')");
  assert.equal(must("admin", "select normal_side from public.acct_accounts where code = '6200'"), "debit");
  must("admin", "update public.acct_accounts set active = false where code = '6200'");
  refused("admin", post("2026-07-01", "Canva", [{ account: "6200", debit: 10 }, { account: "1010", credit: 10 }]), /inactive/);
  refused("admin", "update public.acct_accounts set code = '6201' where code = '1010'", /foreign key/);
  refused("admin", `update public.acct_settings set category_accounts = '{"materials":"5999","other":"5090"}'`, /Unknown account/);
  refused("admin", `update public.acct_settings set category_accounts = '{"materials":"5010"}'`, /"other"/);
  refused("admin", "update public.acct_settings set receipts_account = '9999'", /foreign key/);
});

test("only an active admin sees or touches the books", () => {
  const { must, refused } = db;
  for (const who of ["designer", "inactive"]) {
    assert.equal(must(who, "select count(*) from public.acct_trial_balance('2026-12-31')"), "0", `${who}: empty trial balance`);
    assert.equal(must(who, "select count(*) from public.acct_gl"), "0");
    assert.equal(must(who, "select count(*) from public.acct_entries"), "0");
    assert.equal(must(who, "select count(*) from public.acct_accounts"), "0");
    assert.equal(must(who, "select count(*) from public.acct_receivables()"), "0");
    refused(who, post("2026-07-01", "Sneaky", [{ account: "6040", debit: 1 }, { account: "1010", credit: 1 }]), /Only an admin/);
    refused(who, "insert into public.acct_entries (entry_date, memo) values ('2026-07-01', 'x')", /row-level security/);
    assert.equal(must(who, "update public.acct_settings set locked_through = '2026-12-31' returning id"), "");
    refused(who, "insert into public.acct_project_vat (project_id, treatment) values ('P1', 'non_vat')", /row-level security/);
  }
  for (const q of ["select count(*) from public.acct_entries", "select count(*) from public.acct_gl",
                   "select * from public.acct_trial_balance('2026-12-31')", "select * from public.acct_data_issues()"]) {
    refused("anon", q, /permission denied/);
  }
});

test("the page's API: config, settings, accounts, journal list and VAT tags", () => {
  const { must, refused } = db;
  const cfg = JSON.parse(must("admin", "select public.acct_config()"));
  assert.equal(cfg.settings.books_start, "2026-01-01");
  assert.equal(cfg.accounts.find((a) => a.code === "1590").normal_side, "credit");
  assert.deepEqual(cfg.projects.map((p) => p.id), ["P1", "P2", "P3"], "sorted by name: Ana, Office, Old");
  assert.equal(must("designer", "select public.acct_config() -> 'settings'"), "null", "staff get no settings");

  must("admin", `select public.acct_save_settings('{"locked_through":"2026-01-31","receipts_account":"1020"}')`);
  assert.equal(must("admin", "select books_start || '|' || locked_through || '|' || receipts_account from public.acct_settings"), "2026-01-01|2026-01-31|1020");
  // Client receipts (56,000 + 44,000 + 20,000) now land in the bank: 85,000 + 120,000.
  assert.equal(must("admin", "select debit from public.acct_trial_balance('2026-12-31') where code = '1020'"), "205000.00");
  must("admin", `select public.acct_save_settings('{"locked_through":"","receipts_account":"1010"}')`);
  assert.equal(must("admin", "select coalesce(locked_through::text, 'none') from public.acct_settings"), "none");
  refused("designer", `select public.acct_save_settings('{"locked_through":"2026-12-31"}')`, /Only an admin/);

  must("admin", "select public.acct_save_account('1595', 'Accumulated depreciation - vehicles', 'asset', true, 'credit')");
  must("admin", "select public.acct_save_account('1595', 'Acc. depreciation - vehicles', 'asset', true)");
  assert.equal(must("admin", "select name || '|' || normal_side from public.acct_accounts where code = '1595'"), "Acc. depreciation - vehicles|credit");
  refused("designer", "select public.acct_save_account('6999', 'x', 'expense')", /Only an admin/);

  const journal = JSON.parse(must("admin", "select public.acct_journal('2026-07-01', '2026-07-31')"));
  assert.equal(journal[0].memo, "Power bill");
  assert.equal(journal[0].void_reason, "Duplicate of OR 990");
  assert.deepEqual(journal[0].lines.map((l) => l.account), ["6040", "1010"]);

  must("admin", "select public.acct_tag_project('P3', 'non_vat'); select public.acct_tag_purchase('expenses', 'E2', true, 100)");
  let tags = JSON.parse(must("admin", "select public.acct_vat_tags()"));
  assert.equal(tags.projects.find((p) => p.id === "P3").treatment, "non_vat");
  assert.equal(tags.purchases.find((p) => p.doc_id === "E2").input_vat, 100);
  assert.equal(tags.purchases[0].purchase_date, null, "undated purchases first, so they get fixed");
  must("admin", "select public.acct_tag_project('P3', null); select public.acct_tag_purchase('expenses', 'E2', false)");
  tags = JSON.parse(must("admin", "select public.acct_vat_tags()"));
  assert.equal(tags.projects.find((p) => p.id === "P3").treatment, null);
  assert.equal(tags.purchases.find((p) => p.doc_id === "E2").vat_invoice, false);
  refused("designer", "select public.acct_tag_project('P1', 'non_vat')", /Only an admin/);
});
