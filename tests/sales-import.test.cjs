// v4.8 sales workbook reader (sales-import.js): the extraction rules on made-up sheets laid out like the office's
// SALES SUMMARY workbook (never the real one: it's business data and this repository is public).
//   node --test tests/sales-import.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../sales-import.js');

const monthly = {name: 'MNTHLY SALES', rows: [
  ['SALES SUMMARY 2026'], [], ['500,000.00 INDIVIDUAL QUOTA PER MONTH'], [],
  ['JANUARY'], ['DATE', 'SC NO.', 'CUSTOMER', 'PROJECT ', 'AMOUNT'],
  ['01.05.26', 501, 'Client A', 'Kitchen Cabinet', 100000],
  ['01.12.26', 502, 'Client B', 'Modular closet', '=243979+3047.75'],
  [null, 503, 'Client C', 'Office table', 15000],
  ['1..20.26', 504, 'Client D', 'TV console', 20000],
  ['FEBRUARY'], ['DATE', 'SC NO.', 'CUSTOMER', 'PROJECT ', 'AMOUNT'],
  ['2.9.25', 506, 'Client E', 'Partition', 50000, null, null, 'Paid/completed'],
  ['02.10.26', 507, 'Client F', 'Countertop', null, null, null, 'Undecided/hold'],
  ['03.02.26', 508, 'cancelled', '', 0],
  ['02.20.26', 509, 'Client G', 'Island', 30000, null, null, 'for full payment/cabinet repair'],
  ['02.21.26', 510, 'Client H', 'Shoe rack', 9000],
  [null, 511], [null, 512]]};
const split = {name: 'Total Individual Sales', rows: [
  ['JANUARY'], [null, null, 'MAE', null, null, 'KEITH'],
  ['DATE', 'SC NO.', 'CLIENT', 'AMOUNT', null, 'DATE', 'SC NO.', 'CLIENT', 'AMOUNT'],
  ['01.05.26', 501, 'A', 100000, null, '01.12.26', 502, 'B', 247026.75],
  [null, 503, 'C', 15000, null, '1.20.26', 504, 'D', 20000],
  ['FEBRUARY'], [null, null, 'MAE', null, null, 'KEITH'],
  ['DATE', 'SC NO.', 'CLIENT', 'AMOUNT', null, 'DATE', 'SC NO.', 'CLIENT', 'AMOUNT'],
  ['2.9.26', 506, 'E', 50000, null, '02.20.26', 509, 'G', 30000],
  [null, null, null, null, null, '02.21.26', 509, 'H', 9000],
  ['02.10.26', 507, 'F', null],
  [], ['TOTAL', null, null, '=SUM(D4:D9)']]};
const extra = {name: 'Sheet1', rows: [[null, 'MONICO'], ['DATE', 'SC NO.', 'CLIENT', 'AMOUNT'], ['01.12.26', 503, 'C', 15000]]};

test('dates, amounts and statuses as the office writes them', () => {
  assert.deepEqual(S.parseDate('1.6.24'), {y: 2024, m: 1, d: 6});
  assert.deepEqual(S.parseDate('01.05.26'), {y: 2026, m: 1, d: 5});
  assert.deepEqual(S.parseDate('1..20.24'), {y: 2024, m: 1, d: 20});
  assert.deepEqual(S.parseDate(46028), {y: 2026, m: 1, d: 6}, 'an Excel date number (46023 = Jan 1 2026)');
  assert.equal(S.parseDate('2.30.26'), null, 'no February 30');
  assert.equal(S.parseDate('=+Sales!K99'), null);
  assert.equal(S.amountOf('=243979+3047.75'), 247026.75);
  assert.equal(S.amountOf('=250000+10000+7425'), 267425);
  assert.equal(S.amountOf('1,234.50'), 1234.5);
  assert.equal(S.amountOf("='MNTHLY SALES'!E155"), null, 'a reference is not a number');
  assert.deepEqual(['Paid/completed', 'Ongoing/fabrication, waiting for collection for 19 units', 'completed/ waiting for payment', 'for full payment/cabinet repair',
    'Full payment/Paid', 'Undecided/hold', 'deployed 10.12.26', ''].map((n) => S.statusOf(n, '')),
    ['paid', 'awaiting_payment', 'awaiting_payment', 'awaiting_payment', 'paid', 'on_hold', 'ongoing', null]);
  assert.equal(S.statusOf('', 'cancelled'), 'cancelled');
});

test('the monthly list, attributed to salespeople only when the split agrees', () => {
  const r = S.extract([split, monthly, extra]);
  assert.equal(r.year, 2026);
  assert.equal(r.sheet, 'MNTHLY SALES');
  assert.deepEqual(r.reserved, [511, 512], 'SC numbers with no customer are reserved, not contracts');
  assert.deepEqual(r.missing, [505]);
  const by = Object.fromEntries(r.contracts.map((c) => [c.sc_no, c]));
  assert.deepEqual([by[501].contract_date, by[501].salesperson, by[501].flags], ['2026-01-05', 'MAE', []]);
  assert.deepEqual([by[502].amount, by[502].salesperson, by[502].flags], [247026.75, 'KEITH', []], 'the saved sum matches the split');
  assert.deepEqual([by[503].contract_date, by[503].salesperson], ['2026-01-01', '']);
  assert.deepEqual(by[503].flags, ['no date: set to the 1st of january', 'salesperson unclear: MAE / MONICO']);
  assert.deepEqual([by[504].contract_date, by[504].salesperson, by[504].flags], ['2026-01-20', 'KEITH', []]);
  assert.deepEqual([by[506].contract_date, by[506].status, by[506].salesperson], ['2026-02-09', 'paid', 'MAE']);
  assert.deepEqual(by[506].flags, ['date "2.9.25" says 2025 in the 2026 workbook: year set to 2026']);
  assert.deepEqual([by[507].amount, by[507].status, by[507].flags], [null, 'on_hold', ['no amount']]);
  assert.deepEqual([by[508].status, by[508].flags], ['cancelled', ['dated march but listed under february', 'not in the split by salesperson']]);
  assert.deepEqual([by[509].status, by[509].salesperson, by[509].flags], ['awaiting_payment', '', ['salesperson unclear: SC 509 typed more than once in the split']]);
  assert.deepEqual([by[510].salesperson, by[510].flags], ['', ['not in the split by salesperson']], 'the split typed 509 where it meant 510');
  assert.equal(r.total, 100000 + 247026.75 + 15000 + 20000 + 50000 + 30000 + 9000);
  assert.equal(r.flagged, 6);
});

test('a workbook without a monthly list is refused with what to look for', () => {
  assert.throws(() => S.extract([split]), /no monthly sales list/);
});
