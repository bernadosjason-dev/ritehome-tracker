// schedule-plan.js: working days, the default plan, the forecast and the workshop load.
// Every expected date here is worked out by hand on a calendar (2026-11-16 is a Monday).
//   node --test tests/schedule-plan.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../schedule-plan.js');

const HOLIDAYS = new Set(['2026-11-30', '2026-12-25']);   // Bonifacio Day, Christmas

test('working days skip Sundays and holidays', () => {
  assert.equal(S.weekday('2026-11-16'), 1);
  assert.equal(S.isWorkday('2026-11-21', HOLIDAYS), true, 'Saturday is a working day');
  assert.equal(S.isWorkday('2026-11-22', HOLIDAYS), false, 'Sunday');
  assert.equal(S.isWorkday('2026-11-30', HOLIDAYS), false, 'holiday');
  assert.equal(S.nextWorkday('2026-11-29', HOLIDAYS), '2026-12-01', 'Sunday then a holiday');
  assert.equal(S.addWorkdays('2026-11-16', 1), '2026-11-16');
  assert.equal(S.addWorkdays('2026-11-18', 7), '2026-11-25', 'Wed..Sat is 4, Mon..Wed is 3');
  assert.equal(S.addWorkdays('2026-11-22', 2), '2026-11-24', 'a Sunday start begins Monday');
  assert.equal(S.workdaysBetween('2026-11-16', '2026-11-28'), 12);
  assert.equal(S.workdaysBetween('2026-11-16', '2026-11-30', HOLIDAYS), 12);
  assert.equal(S.workdaysBetween('2026-11-20', '2026-11-19'), 0);
});

test('the default plan from a Monday, and the same plan around two holidays', () => {
  const plain = S.plan('2026-11-16').map((r) => `${r.stage} ${r.planned_start} ${r.planned_end}`);
  assert.deepEqual(plain, [
    'consultation 2026-11-16 2026-11-17',
    'design 2026-11-18 2026-11-25',
    'cutlist 2026-11-26 2026-11-27',
    'bom 2026-11-28 2026-11-28',
    'final_cutlist 2026-11-30 2026-11-30',
    'procurement 2026-12-01 2026-12-07',
    'fabrication 2026-12-08 2026-12-24',
    'installation 2026-12-25 2026-12-30',
    'handover 2026-12-31 2026-12-31']);
  // Initial cutlist to handover: Nov 26 to Dec 31 is 36 calendar days, inside the website's 30-45.
  assert.equal(S.diffDays('2026-11-26', '2026-12-31'), 35);
  // Bonifacio Day pushes the final cutlist to Tue Dec 1; Christmas falls inside fabrication (15 working days
  // Dec 9-26: 9-12, 14-19, 21-24, 26); installation Dec 28-Jan 1; handover Sat Jan 2.
  const hol = S.plan('2026-11-16', HOLIDAYS).slice(4).map((r) => `${r.stage} ${r.planned_start} ${r.planned_end}`);
  assert.deepEqual(hol, [
    'final_cutlist 2026-12-01 2026-12-01',
    'procurement 2026-12-02 2026-12-08',
    'fabrication 2026-12-09 2026-12-26',
    'installation 2026-12-28 2027-01-01',
    'handover 2027-01-02 2027-01-02']);
  // Planning from a later stage, with a longer fabrication.
  assert.deepEqual(S.plan('2026-11-26', null, { from: 'cutlist', days: { fabrication: 10 } }).map((r) => r.stage + ' ' + r.planned_end),
    ['cutlist 2026-11-27', 'bom 2026-11-28', 'final_cutlist 2026-11-30', 'procurement 2026-12-07', 'fabrication 2026-12-18', 'installation 2026-12-24', 'handover 2026-12-25']);
});

const planned = (overrides) => S.plan('2026-11-16').map((r) => Object.assign({ status: 'not_started' }, r, overrides[r.stage] || {}));

test('forecast: on plan, behind plan, and never planned', () => {
  const done = { status: 'done' };
  const onPlan = { target: '2026-12-31', stages: planned({ consultation: done, design: done, cutlist: done, bom: done, final_cutlist: done,
    procurement: done, fabrication: { status: 'in_progress', actual_start: '2026-12-08' } }) };
  let s = S.status(onPlan, '2026-12-10');
  assert.deepEqual([s.current, s.forecast, s.slip, s.label, s.severity, s.overdue, s.hold], ['fabrication', '2026-12-31', 0, 'On track', 'good', [], null]);

  // Fabrication was due Dec 8 and isn't done on Dec 10. Installation (planned Dec 9-14, 5 days) can start Dec 11:
  // Dec 11, 12, 14, 15, 16. Handover Dec 17, two days past the planned Dec 15.
  const late = { stages: [
    { stage: 'consultation', status: 'done' }, { stage: 'design', status: 'done' }, { stage: 'cutlist', status: 'done' },
    { stage: 'bom', status: 'done' }, { stage: 'final_cutlist', status: 'done' }, { stage: 'procurement', status: 'done' },
    { stage: 'fabrication', status: 'in_progress', planned_start: '2026-11-24', planned_end: '2026-12-08' },
    { stage: 'installation', status: 'not_started', planned_start: '2026-12-09', planned_end: '2026-12-14' },
    { stage: 'handover', status: 'not_started', planned_start: '2026-12-15', planned_end: '2026-12-15' }] };
  s = S.status(late, '2026-12-10');
  assert.deepEqual([s.forecast, s.reference, s.slip, s.label, s.severity, s.overdue], ['2026-12-17', '2026-12-15', 2, 'At risk +2 days', 'warn', ['fabrication']]);
  // Against a client target well before that, it's late.
  s = S.status(Object.assign({ target: '2026-12-05' }, late), '2026-12-10');
  assert.deepEqual([s.slip, s.label, s.severity], [12, 'Late +12 days', 'bad']);
  // Behind on a stage but the target still has room.
  s = S.status(Object.assign({ target: '2026-12-31' }, late), '2026-12-10');
  assert.deepEqual([s.slip, s.label, s.severity], [-14, 'Behind on fabrication', 'warn']);

  // Nothing planned: forecast from the defaults starting today (Wed Nov 11). The nine stages add up to
  // 40 working days: Nov 11-14, 16-21, 23-28, 30 (17) and Dec 1-5, 7-12, 14-19, 21-26 (23) -> Sat Dec 26.
  s = S.status({ stages: [] }, '2026-11-11');
  assert.deepEqual([s.current, s.forecast, s.label, s.planned], ['consultation', '2026-12-26', 'Not planned', false]);
  assert.equal(S.workdaysBetween('2026-11-11', '2026-12-26'), 40);
  assert.equal(S.STAGES.reduce((n, x) => n + x.days, 0), 40);

  // Stuck rather than slow: the stage in front is on hold, or the client hasn't answered the design proposal.
  assert.equal(S.status({ stages: planned({ consultation: done, design: { status: 'waiting_client' } }) }, '2026-11-20').hold, 'waiting_client');
  assert.equal(S.status({ stages: planned({ consultation: done, design: done, cutlist: { status: 'blocked' } }) }, '2026-11-20').hold, 'blocked');
  assert.equal(S.status({ stages: planned({ consultation: done, design: done, cutlist: done, bom: { status: 'submitted' } }) }, '2026-11-20').current, 'bom');
});

test('pushing the rest after a slip keeps each stage\'s planned length', () => {
  // Planned around the holidays (procurement Dec 2-8 is 6 working days, installation Dec 28-Jan 1 is 5).
  const stages = S.plan('2026-11-16', HOLIDAYS).map((x) => Object.assign({ status: ['consultation', 'design'].includes(x.stage) ? 'done' : 'not_started' }, x));
  // Initial cutlist (2 days) restarts Thu Dec 3 -> Dec 3-4, BOM Sat Dec 5, final cutlist Mon Dec 7, procurement
  // Dec 8-14, fabrication 15 days Dec 15-Jan 1 (Christmas skipped), installation Jan 2, 4, 5, 6, 7, handover Jan 8.
  const rows = S.pushRest(stages, 'cutlist', '2026-12-03', HOLIDAYS).map((r) => `${r.stage} ${r.planned_start} ${r.planned_end}`);
  assert.deepEqual(rows, [
    'cutlist 2026-12-03 2026-12-04',
    'bom 2026-12-05 2026-12-05',
    'final_cutlist 2026-12-07 2026-12-07',
    'procurement 2026-12-08 2026-12-14',
    'fabrication 2026-12-15 2027-01-01',
    'installation 2027-01-02 2027-01-07',
    'handover 2027-01-08 2027-01-08']);
});

test('workshop load counts projects in fabrication per Monday-to-Saturday week', () => {
  const p = (name, start, end, status) => ({ name, status, stages: [{ stage: 'fabrication', status: 'not_started', planned_start: start, planned_end: end }] });
  const weeks = S.load([p('A', '2026-12-07', '2026-12-23'), p('B', '2026-12-14', '2027-01-05'), p('Old', '2026-12-07', '2026-12-30', 'completed'),
    p('Sunday only', '2026-12-13', '2026-12-13')], '2026-12-09', 5, '2026-12-09');
  assert.deepEqual(weeks.map((w) => `${w.week} ${w.count}`), ['2026-12-07 1', '2026-12-14 2', '2026-12-21 2', '2026-12-28 1', '2027-01-04 1']);
  assert.deepEqual(weeks[1].names, ['A', 'B']);
  // A stage still in progress past its planned end keeps counting until today.
  const running = { name: 'C', stages: [{ stage: 'fabrication', status: 'in_progress', actual_start: '2026-11-30', planned_end: '2026-12-05' }] };
  assert.deepEqual(S.load([running], '2026-11-30', 3, '2026-12-15').map((w) => w.count), [1, 1, 1]);
});

test('month grid and holidays from calendar events', () => {
  const g = S.monthGrid(2026, 11);
  assert.equal(g[0][0], '2026-10-26'); assert.equal(g[0][6], '2026-11-01');
  assert.equal(g[g.length - 1][0], '2026-11-30'); assert.equal(g.length, 6);
  assert.equal(S.monthGrid(2027, 2).length, 4, 'Feb 2027: 28 days starting on a Monday');
  assert.equal(S.monthGrid(2026, 2).length, 5, 'Feb 2026 starts on a Sunday, so its first row is mostly January');
  const h = S.holidaysFrom([{ kind: 'holiday', starts_at: '2026-12-24T00:00:00+08:00', ends_at: '2026-12-25T23:59:00+08:00' },
    { kind: 'meeting', starts_at: '2026-12-01T09:00:00+08:00' }]);
  assert.deepEqual([...h], ['2026-12-24', '2026-12-25']);
});
