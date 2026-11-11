/* Is a project on track to make money? Pure functions over a project's cached figures
   (price, budget, totalSpent, materialsSpent, progress, status, targetDate), shared by the
   project page and the projects list. Loaded in the browser as window.RitehomeHealth and in
   Node tests.

   Cost at handover = spent so far + what the budget allows for the work still to do:
       spent + (1 − work done) × (budget − materials already bought)
   Materials are bought up front in modular cabinetry, so they count as spent, not as a sign
   of overspending; stretching spend-so-far across the job (spent ÷ work done) would call
   every new job a loss the week its boards arrive. The assumption is stated in the page: the
   work left costs what's left in the budget for it. Figures are before VAT and income tax,
   the same basis as the tracker's own "Total profit" (contract price − cost). */
(function(root){
  'use strict';
  var OVERRUN = 1.02;         // a projected cost this far over budget is worth a look
  var SEVERITY = {loss: 5, over: 4, overrun: 3, late: 2, setup: 1, unknown: 1, ok: 0, done: 0};
  var LABEL = {loss: 'Heading for a loss', over: 'Over budget', overrun: 'Heading over budget', late: 'Past target date',
    setup: 'Set a budget', unknown: 'Set work done', ok: 'On track', done: 'Completed'};

  function num(v){ var n = Number(v); return isFinite(n) ? n : 0; }
  function progressOf(p){
    if(p.progress === '' || p.progress == null) return null;
    var n = Number(p.progress);
    return isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  }

  function health(p, today){
    var price = num(p.price), budget = num(p.budget), spent = num(p.totalSpent);
    var materials = Math.min(spent, Math.max(0, num(p.materialsSpent)));
    var done = p.status === 'completed';
    var progress = done ? 100 : progressOf(p);
    var budgetUsed = budget > 0 ? spent / budget * 100 : null;
    var gap = budgetUsed != null && progress != null ? budgetUsed - progress : null;
    var quotedProfit = price > 0 && budget > 0 ? price - budget : null;
    var budgetLeftForWork = Math.max(0, budget - materials);
    var projectedCost = done ? spent
      : progress != null && budget > 0 ? spent + (1 - progress / 100) * budgetLeftForWork
      : Math.max(spent, budget);
    var projectedProfit = price > 0 && (done || projectedCost > 0) ? price - projectedCost : null;
    var erosion = quotedProfit != null && projectedProfit != null ? quotedProfit - projectedProfit : null;
    var late = !done && !!p.targetDate && String(p.targetDate) < String(today);

    var flags = [];
    if(done) flags.push('done');
    else {
      if(projectedProfit != null && projectedProfit < 0) flags.push('loss');
      if(budget > 0 && spent > budget) flags.push('over');
      if(budget > 0 && projectedCost > budget * OVERRUN && spent <= budget) flags.push('overrun');
      if(late) flags.push('late');
      if(budget <= 0) flags.push('setup');
      else if(progress == null) flags.push('unknown');
      if(!flags.length) flags.push('ok');
    }
    flags.sort(function(a, b){ return SEVERITY[b] - SEVERITY[a]; });
    return {
      price: price, budget: budget, spent: spent, progress: progress, budgetUsed: budgetUsed, gap: gap,
      quotedProfit: quotedProfit, projectedCost: projectedCost, projectedProfit: projectedProfit, erosion: erosion,
      late: late, flags: flags, status: flags[0], label: LABEL[flags[0]], severity: SEVERITY[flags[0]],
      needsAttention: SEVERITY[flags[0]] >= SEVERITY.late
    };
  }

  // Active projects only: what the open book of work is expected to earn, and which jobs to look at first.
  function portfolio(projects, today){
    var active = (projects || []).filter(function(p){ return p && p.id !== 'sample' && p.status !== 'completed'; });
    var rows = active.map(function(p){ return {project: p, h: health(p, today)}; });
    var both = rows.filter(function(r){ return r.h.quotedProfit != null && r.h.projectedProfit != null; });
    function total(list, k){ return list.reduce(function(s, r){ return s + r.h[k]; }, 0); }
    var attention = rows.filter(function(r){ return r.h.needsAttention; }).sort(function(a, b){
      return b.h.severity - a.h.severity || (b.h.erosion || 0) - (a.h.erosion || 0);
    });
    return {
      active: rows.length,
      compared: both.length,
      quotedProfit: total(both, 'quotedProfit'),
      projectedProfit: total(both, 'projectedProfit'),
      // Only jobs falling short of their quote: a job doing better must not hide one doing worse.
      erosion: both.reduce(function(s, r){ return s + Math.max(0, r.h.erosion); }, 0),
      eroding: both.filter(function(r){ return r.h.erosion > 0; }).length,
      contractValue: rows.reduce(function(s, r){ return s + r.h.price; }, 0),
      spent: rows.reduce(function(s, r){ return s + r.h.spent; }, 0),
      budget: rows.reduce(function(s, r){ return s + r.h.budget; }, 0),
      missingProgress: rows.filter(function(r){ return r.h.progress == null; }).length,
      attention: attention
    };
  }

  var api = {health: health, portfolio: portfolio, LABEL: LABEL, OVERRUN: OVERRUN};
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RitehomeHealth = api;
})(typeof window !== 'undefined' ? window : globalThis);
