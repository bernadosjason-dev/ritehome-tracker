// project-health.js: is a project on track to make money? Every expected figure is worked out by hand.
// Cost at handover = spent + (1 − work done) × (budget − materials already bought).
//   node --test tests/project-health.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const {health, portfolio} = require('../project-health.js');
const TODAY = '2026-11-12';

test('on pace: profit holds, and early materials are not mistaken for overspending', () => {
  // ₱310,000 contract, ₱250,000 budget, 35% done, ₱82,700 spent of which ₱52,200 materials.
  // 82,700 + 0.65 × (250,000 − 52,200) = 82,700 + 128,570 = 211,270.
  const h = health({price: 310000, budget: 250000, totalSpent: 82700, materialsSpent: 52200, progress: 35, targetDate: '2026-12-20'}, TODAY);
  assert.equal(h.status, 'ok');
  assert.equal(Math.round(h.budgetUsed * 100) / 100, 33.08);
  assert.equal(h.quotedProfit, 60000);
  assert.equal(Math.round(h.projectedCost), 211270);
  assert.equal(Math.round(h.projectedProfit), 98730);
  assert(h.erosion < 0, 'ahead of the quote');
  assert.equal(h.needsAttention, false);
});

test('front-loaded materials: 48% of budget at 25% done is normal, not a loss', () => {
  // Office partitions: all ₱67,000 is frames and glass. 67,000 + 0.75 × (140,000 − 67,000) = 121,750.
  const h = health({price: 180000, budget: 140000, totalSpent: 67000, materialsSpent: 67000, progress: 25}, TODAY);
  assert.equal(h.projectedCost, 121750);
  assert.equal(h.projectedProfit, 58250);
  assert.equal(h.status, 'ok');
});

test('labor and site costs running hot are caught before the budget runs out', () => {
  // 220,000 contract, 200,000 budget, 40% done, 150,000 spent (50,000 materials).
  // 150,000 + 0.6 × 150,000 = 240,000 → −20,000 at handover; quoted 20,000.
  const h = health({price: 220000, budget: 200000, totalSpent: 150000, materialsSpent: 50000, progress: 40}, TODAY);
  assert.equal(h.projectedCost, 240000);
  assert.equal(h.projectedProfit, -20000);
  assert.equal(h.erosion, 40000);
  assert.deepEqual(h.flags, ['loss', 'overrun']);
  assert.equal(h.label, 'Heading for a loss');
  assert.equal(h.needsAttention, true);
  // Same job with a fatter contract: still over budget at handover, but no loss.
  const fat = health({price: 280000, budget: 200000, totalSpent: 150000, materialsSpent: 50000, progress: 40}, TODAY);
  assert.deepEqual(fat.flags, ['overrun']);
  assert.equal(fat.label, 'Heading over budget');
});

test('Banisilan: over budget and, finished, a loss', () => {
  // 104,172 + 0.1 × (80,000 − 65,345) = 105,637.50
  const running = health({price: 100000, budget: 80000, totalSpent: 104172, materialsSpent: 65345, progress: 90}, TODAY);
  assert.deepEqual(running.flags, ['loss', 'over']);
  assert.equal(running.projectedCost, 105637.5);
  const done = health({price: 100000, budget: 80000, totalSpent: 104172, materialsSpent: 65345, status: 'completed'}, TODAY);
  assert.equal(done.status, 'done');
  assert.equal(done.progress, 100);
  assert.equal(done.projectedProfit, -4172, 'a finished job is what it cost');
  assert.equal(done.erosion, 24172);
  assert.equal(done.needsAttention, false, 'finished jobs are history, not attention');
});

test('no work-done figure yet: the budget stands in, and the page asks for it', () => {
  const h = health({price: 180000, budget: 140000, totalSpent: 67000}, TODAY);
  assert.equal(h.projectedCost, 140000);
  assert.equal(h.projectedProfit, 40000);
  assert.equal(h.status, 'unknown');
  assert.equal(h.label, 'Set work done');
  assert.equal(h.needsAttention, false);
});

test('late, missing budget, odd input', () => {
  assert.equal(health({price: 50000, budget: 40000, totalSpent: 10000, progress: 30, targetDate: '2026-11-01'}, TODAY).status, 'late');
  assert.equal(health({price: 50000, totalSpent: 10000, progress: 30}, TODAY).status, 'setup');
  const odd = health({price: 'abc', budget: '40000', totalSpent: null, materialsSpent: 'x', progress: '150'}, TODAY);
  assert.equal(odd.progress, 100);
  assert.equal(odd.price, 0);
  assert.equal(odd.projectedProfit, null, 'no contract price, no profit figure');
  assert.equal(health({budget: 1000, totalSpent: 0, progress: ''}, TODAY).progress, null);
  assert.equal(health({price: 100, budget: 100, totalSpent: 10, materialsSpent: 999, progress: 50}, TODAY).projectedCost, 55, 'materials never exceed what was spent');
});

test('portfolio: open jobs only, attention ranked worst first', () => {
  const projects = [
    {id: 'a', name: 'On pace', price: 310000, budget: 250000, totalSpent: 82700, materialsSpent: 52200, progress: 35},
    {id: 'b', name: 'Leaking', price: 220000, budget: 200000, totalSpent: 150000, materialsSpent: 50000, progress: 40},
    {id: 'c', name: 'Late', price: 50000, budget: 40000, totalSpent: 10000, progress: 30, targetDate: '2026-11-01'},
    {id: 'd', name: 'Done', price: 100000, budget: 80000, totalSpent: 104172, status: 'completed'},
    {id: 'sample', name: 'Sample', price: 1, budget: 1}
  ];
  const f = portfolio(projects, TODAY);
  assert.equal(f.active, 3);
  assert.equal(f.quotedProfit, 60000 + 20000 + 10000);
  // a 98,730 · b −20,000 · c: 10,000 + 0.7 × 40,000 = 38,000 → 12,000
  assert.equal(Math.round(f.projectedProfit), 90730);
  assert.deepEqual(f.attention.map(r => r.project.id), ['b', 'c']);
  // erosion per job: a −38,730 (beating its quote) · b 40,000 · c −2,000. Only b counts.
  assert.equal(f.erosion, 40000);
  assert.equal(f.eroding, 1);
  assert.equal(f.missingProgress, 0);
});
