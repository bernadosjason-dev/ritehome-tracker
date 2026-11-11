/* Scheduling arithmetic for schedule.html: working days, the default stage plan, the handover
   forecast and the workshop load. Pure functions on 'YYYY-MM-DD' strings (Manila calendar days),
   no page or database code, so tests/schedule-plan.test.cjs can check them by hand.

   Working days are Monday to Saturday, minus the company holidays on the calendar. The stages are
   the office whiteboard's (initial cutlist, BOM, final cutlist, fabrication) inside the full
   pipeline. The default durations are a starting point to tune against real jobs: initial cutlist
   to handover adds up to 31 working days, about 36 calendar days, inside the website's 30-45 day
   promise. */
(function(root){
  'use strict';
  var STAGES = [
    {key: 'consultation', label: 'Consultation', days: 2, owner: 'Admin'},
    {key: 'design', label: 'Design', days: 7, owner: 'Designer'},
    {key: 'cutlist', label: 'Initial cutlist', days: 2, owner: 'Designer'},
    {key: 'bom', label: 'Bill of materials', days: 1, owner: 'Designer'},
    {key: 'final_cutlist', label: 'Final cutlist', days: 1, owner: 'Designer'},
    {key: 'procurement', label: 'Procurement', days: 6, owner: 'Admin'},
    {key: 'fabrication', label: 'Fabrication', days: 15, owner: 'Workshop'},
    {key: 'installation', label: 'Installation', days: 5, owner: 'Installers'},
    {key: 'handover', label: 'Handover', days: 1, owner: 'Installers'}
  ];
  var INDEX = {}; STAGES.forEach(function(s, i){ INDEX[s.key] = i; });

  function toDate(iso){ return new Date(String(iso).slice(0, 10) + 'T00:00:00Z'); }
  function iso(d){ return d.toISOString().slice(0, 10); }
  function addDays(isoDate, n){ var d = toDate(isoDate); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
  function diffDays(a, b){ return Math.round((toDate(b) - toDate(a)) / 86400000); }   // b - a
  function weekday(isoDate){ return toDate(isoDate).getUTCDay(); }                      // 0 = Sunday
  function maxDate(a, b){ return !a ? b : !b ? a : a > b ? a : b; }
  function asSet(h){ return h instanceof Set ? h : new Set(h || []); }

  function isWorkday(d, holidays){ return weekday(d) !== 0 && !asSet(holidays).has(d); }
  function nextWorkday(d, holidays){
    var h = asSet(holidays), x = d;
    for(var i = 0; i < 400 && !isWorkday(x, h); i++) x = addDays(x, 1);
    return x;
  }
  // The last day of a span of n working days that starts on the first working day on or after start.
  function addWorkdays(start, n, holidays){
    var h = asSet(holidays), x = nextWorkday(start, h);
    for(var left = Math.max(1, Math.round(n || 1)) - 1; left > 0; left--) x = nextWorkday(addDays(x, 1), h);
    return x;
  }
  // Working days in [a, b], both ends included.
  function workdaysBetween(a, b, holidays){
    if(!a || !b || b < a) return 0;
    var h = asSet(holidays), n = 0;
    for(var x = a; x <= b; x = addDays(x, 1)) if(isWorkday(x, h)) n++;
    return n;
  }

  // Back-to-back planned dates from `start`, for every stage from opts.from (default: the first).
  function plan(start, holidays, opts){
    opts = opts || {};
    var h = asSet(holidays), days = opts.days || {}, cursor = start, rows = [];
    STAGES.slice(INDEX[opts.from || 'consultation'] || 0).forEach(function(s){
      var len = days[s.key] != null ? days[s.key] : s.days;
      var first = nextWorkday(cursor, h), last = addWorkdays(first, len, h);
      rows.push({stage: s.key, planned_start: first, planned_end: last});
      cursor = addDays(last, 1);
    });
    return rows;
  }

  function byKey(stages){ var m = {}; (stages || []).forEach(function(s){ m[s.stage] = s; }); return m; }
  function plannedLength(s, h){
    var n = s && s.planned_start && s.planned_end ? workdaysBetween(s.planned_start, s.planned_end, h) : 0;
    return n || STAGES[INDEX[s.stage]].days;
  }

  // Re-plan every unfinished stage from `fromStage` onward to start on `start`, each keeping the
  // number of working days it was planned to take (or its default). For "push the rest" after a slip.
  function pushRest(stages, fromStage, start, holidays){
    var h = asSet(holidays), m = byKey(stages), cursor = start, rows = [];
    STAGES.slice(INDEX[fromStage]).forEach(function(d){
      var s = m[d.key] || {stage: d.key};
      if(s.status === 'done') return;
      var first = nextWorkday(cursor, h), last = addWorkdays(first, plannedLength(s, h), h);
      rows.push({stage: d.key, planned_start: first, planned_end: last});
      cursor = addDays(last, 1);
    });
    return rows;
  }

  /* Where a project stands on `today`:
     current   the first stage not done (null when all are done)
     overdue   unfinished stages whose planned end has passed
     forecast  the handover day if every unfinished stage takes its planned length from now on
     reference the client's target date, else the planned handover
     slip      forecast - reference, in calendar days (positive = late) */
  function status(project, today, holidays){
    var h = asSet(holidays), m = byKey(project.stages), out = {current: null, overdue: [], forecast: null, reference: null, slip: null,
      planned: (project.stages || []).some(function(s){ return s.planned_start || s.planned_end; })};
    var open = STAGES.filter(function(d){ return !m[d.key] || m[d.key].status !== 'done'; });
    out.overdue = open.filter(function(d){ var s = m[d.key]; return s && s.planned_end && s.planned_end < today; }).map(function(d){ return d.key; });
    var handover = m.handover || {};
    out.reference = project.target || handover.planned_end || null;
    if(project.status === 'completed'){ out.label = 'Completed'; out.severity = 'muted'; out.done = true; return out; }
    if(!open.length){
      out.done = true; out.forecast = handover.actual_end || null; out.label = 'Handed over'; out.severity = 'good';
      return out;
    }
    out.current = open[0].key;
    // The current stage is stuck rather than slow: on hold, waiting on the client, or waiting for approval.
    var cs = m[out.current];
    out.hold = cs && ['blocked', 'waiting_client', 'submitted'].indexOf(cs.status) >= 0 ? cs.status : null;
    var cursor = null;
    open.forEach(function(d, i){
      var s = m[d.key] || {stage: d.key}, end;
      if(i === 0){
        if(s.planned_end && s.planned_end >= today) end = s.planned_end;
        else if(s.planned_end) end = nextWorkday(today, h);                       // overdue: finishes today at best
        else if(s.status === 'in_progress' && s.actual_start) end = maxDate(addWorkdays(s.actual_start, d.days, h), nextWorkday(today, h));
        else end = addWorkdays(today, d.days, h);
      } else {
        var first = nextWorkday(maxDate(addDays(cursor, 1), s.planned_start || null), h);
        end = addWorkdays(first, plannedLength(s, h), h);
      }
      cursor = end;
    });
    out.forecast = cursor;
    if(!out.reference){ out.label = out.planned ? 'Planned' : 'Not planned'; out.severity = 'muted'; return out; }
    out.slip = diffDays(out.reference, out.forecast);
    if(out.slip <= 0 && !out.overdue.length){ out.label = 'On track'; out.severity = 'good'; }
    else if(out.slip <= 0){ out.label = 'Behind on ' + STAGES[INDEX[out.overdue[0]]].label.toLowerCase(); out.severity = 'warn'; }
    else if(out.slip <= 7){ out.label = 'At risk +' + out.slip + (out.slip === 1 ? ' day' : ' days'); out.severity = 'warn'; }
    else { out.label = 'Late +' + out.slip + ' days'; out.severity = 'bad'; }
    return out;
  }

  // The days a stage occupies: what really happened where known, the plan otherwise.
  function window_(s, today){
    if(!s) return null;
    var start = s.actual_start || s.planned_start, end;
    if(s.status === 'done') end = s.actual_end || s.planned_end || s.actual_start;
    else end = s.status === 'in_progress' ? maxDate(s.planned_end, today) : s.planned_end;
    return start && end && end >= start ? {start: start, end: end} : null;
  }
  function mondayOf(d){ var w = weekday(d); return addDays(d, w === 0 ? -6 : 1 - w); }
  // How many projects have `stage` (default fabrication) running in each Monday-to-Saturday week.
  function load(projects, from, weeks, today, stage){
    stage = stage || 'fabrication';
    var out = [], first = mondayOf(from);
    for(var i = 0; i < weeks; i++){
      var mon = addDays(first, 7 * i), sat = addDays(mon, 5), names = [];
      (projects || []).forEach(function(p){
        if(p.status === 'completed') return;
        var w = window_(byKey(p.stages)[stage], today);
        if(w && w.start <= sat && w.end >= mon) names.push(p.name);
      });
      out.push({week: mon, count: names.length, names: names});
    }
    return out;
  }

  // Monday-first weeks covering a month, as arrays of seven dates.
  function monthGrid(year, month){   // month 1-12
    var first = year + '-' + String(month).padStart(2, '0') + '-01';
    var last = addDays(month === 12 ? (year + 1) + '-01-01' : year + '-' + String(month + 1).padStart(2, '0') + '-01', -1);
    var weeks = [], d = mondayOf(first);
    while(d <= last){ var w = []; for(var i = 0; i < 7; i++) w.push(addDays(d, i)); weeks.push(w); d = addDays(d, 7); }
    return weeks;
  }

  // Every day a holiday event covers, as dates in Manila.
  function holidaysFrom(events){
    var set = new Set();
    (events || []).forEach(function(e){
      if(e.kind !== 'holiday') return;
      var a = manilaDate(e.starts_at), b = manilaDate(e.ends_at || e.starts_at);
      for(var x = a; x <= b; x = addDays(x, 1)) set.add(x);
    });
    return set;
  }
  function manilaDate(ts){ return new Date(Date.parse(ts) + 8 * 3600000).toISOString().slice(0, 10); }

  var api = {STAGES: STAGES, INDEX: INDEX, addDays: addDays, diffDays: diffDays, weekday: weekday, isWorkday: isWorkday,
    nextWorkday: nextWorkday, addWorkdays: addWorkdays, workdaysBetween: workdaysBetween, plan: plan, pushRest: pushRest,
    status: status, stageWindow: window_, mondayOf: mondayOf, load: load, monthGrid: monthGrid, holidaysFrom: holidaysFrom,
    manilaDate: manilaDate};
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RitehomeSchedule = api;
})(this);
