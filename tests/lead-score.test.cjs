// lead-score.js: scores, the 2-business-hour reply clock and the board numbers, worked out by hand.
//   node --test tests/lead-score.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { score, board, businessHours, replyClock } = require('../lead-score.js');
// Wed 12 Nov 2026, 10:00 in Manila = 02:00 UTC.
const NOW = '2026-11-12T02:00:00Z';

test('a hot lead: soon, sizeable, local, specific, booked a visit', () => {
  const s = score({ stage: 'new', timeline: 'asap', budget: 180000, location: 'Carmen, Cagayan de Oro', system: 'kitchen',
    message: 'L-shape 4m by 3m', visit_requested: '2026-11-20 9:00 AM', phone: '0917', email: 'a@b.c', created_at: '2026-11-12T01:00:00Z' }, NOW);
  // 30 + 20 + 15 + (8 + 7) + 15 = 95
  assert.equal(s.total, 95);
  assert.equal(s.label, 'Hot');
  assert.deepEqual(s.parts.map((p) => p.points), [30, 20, 15, 15, 15]);
  assert.equal(s.parts[4].why, 'site visit');
});

test('a bare Hannah chat lead is cold until someone asks the questions', () => {
  const s = score({ stage: 'new', phone: '0918', created_at: '2026-11-11T02:00:00Z' }, NOW);
  // timeline 10 + size 8 + where 5 + fit 0 + engagement 0 = 23
  assert.equal(s.total, 23);
  assert.equal(s.label, 'Cold');
  assert.equal(s.parts[0].why, 'Not asked yet');
});

test('warm, outside CDO, and going cold with time', () => {
  const lead = { stage: 'contacted', timeline: '1-3m', expected_value: 90000, location: 'Valencia, Bukidnon', system: 'storage',
    message: 'two wardrobes', phone: '0917', created_at: '2026-10-01T00:00:00Z', last_contact_at: '2026-11-05T00:00:00Z' };
  // 20 + 12 + 8 + 8 (no details) + 6 = 54
  assert.equal(score(lead, NOW).total, 54);
  assert.equal(score(lead, NOW).label, 'Warm');
  const stale = score({ ...lead, last_contact_at: '2026-10-25T00:00:00Z' }, NOW);   // 18 days
  assert.equal(stale.total, 39);
  assert.equal(stale.parts.at(-1).label, 'Going cold');
  assert.equal(score({ ...lead, last_contact_at: '2026-10-01T00:00:00Z' }, NOW).total, 29, '42 days: -25');
  assert.equal(score({ ...lead, location: 'Davao City' }, NOW).parts[2].why, 'Outside the usual area');
});

test('won and lost leads are closed, not scored', () => {
  assert.deepEqual(score({ stage: 'won' }, NOW), { closed: true, total: null, label: 'Won', parts: [] });
  assert.equal(score({ stage: 'lost' }, NOW).label, 'Lost');
});

test('the 2-business-hour clock: Monday to Saturday, 8 to 5, Manila time', () => {
  // Wed 08:30 → Wed 10:00 Manila = 1.5 h
  assert.equal(businessHours('2026-11-12T00:30:00Z', NOW), 1.5);
  // Sat 16:00 → Mon 09:00 Manila: 1 h Saturday + 0 Sunday + 1 h Monday = 2
  assert.equal(businessHours('2026-11-14T08:00:00Z', '2026-11-16T01:00:00Z'), 2);
  // Overnight: Tue 16:30 → Wed 08:30 = 0.5 + 0.5 = 1
  assert.equal(businessHours('2026-11-11T08:30:00Z', '2026-11-12T00:30:00Z'), 1);
  // A Sunday inquiry answered Monday 8:00 is on time
  assert.equal(businessHours('2026-11-15T03:00:00Z', '2026-11-16T00:00:00Z'), 0);
  assert.equal(replyClock({ stage: 'new', created_at: '2026-11-11T07:00:00Z' }, NOW).overdue, true, 'Tue 15:00 → Wed 10:00 is 4 h');
  assert.equal(replyClock({ stage: 'new', created_at: '2026-11-11T07:00:00Z', first_response_at: '2026-11-11T07:30:00Z' }, NOW), null);
});

test('the board: waiting queue oldest first, follow-ups, pipeline, win rate, reply speed', () => {
  const leads = [
    { id: 'a', stage: 'new', created_at: '2026-11-11T07:00:00Z', budget: 200000 },                          // 4 h waiting
    { id: 'b', stage: 'new', created_at: '2026-11-12T01:30:00Z' },                                            // 0.5 h waiting
    { id: 'c', stage: 'contacted', created_at: '2026-11-10T01:00:00Z', first_response_at: '2026-11-10T02:00:00Z', next_action_at: '2026-11-12', expected_value: 150000 },
    { id: 'd', stage: 'quoted', created_at: '2026-11-03T01:00:00Z', first_response_at: '2026-11-03T04:00:00Z', expected_value: 300000, next_action_at: '2026-11-20' },
    { id: 'e', stage: 'won', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-20T00:00:00Z', expected_value: 210000 },
    { id: 'f', stage: 'lost', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-10-25T00:00:00Z' },
    { id: 'g', stage: 'lost', created_at: '2026-06-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' }      // outside 90 days
  ];
  const b = board(leads, NOW);
  assert.deepEqual(b.waiting.map((r) => r.lead.id), ['a', 'b']);
  assert.equal(b.overdueReplies, 1);
  assert.equal(b.followUpsDue, 1, 'c is due today, d next week');
  assert.equal(b.pipelineValue, 200000 + 150000 + 300000);
  assert.equal(b.winRate, 0.5, 'e won, f lost; g is older than 90 days');
  assert.equal(b.medianReplyHours, 2, 'c 1 h, d 3 h');
  assert.equal(b.newThisWeek, 3, 'a, b and c (Nov 10); d is 9 days old');
  assert.equal(b.byStage.won.value, 210000);
  assert.equal(b.rows.length, 4);
});
