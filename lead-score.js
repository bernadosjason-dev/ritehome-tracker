/* Lead scores and the scoreboard's numbers. Pure functions, shared by leads.html and Node tests;
   window.RitehomeLeads in the browser.

   A score is 0-100 and every point is explained (breakdown), so the rules can be argued with:
     When they want it   30   ASAP 30 · 1-3 months 20 · 3-6 months 8 · later 0 · not asked 10
     Job size            25   ≥ ₱300k 25 · ≥ ₱150k 20 · ≥ ₱80k 12 · smaller 5 · not asked 8
     Where               15   CDO & Misamis Oriental 15 · rest of Northern Mindanao 8 · not asked 5
     Fit                 15   system known 8 · measurements or a real description 7
     Engagement          15   site visit asked for or done, or quoted 15 · in conversation 6 · phone and email +3
     Going cold        -15/-25 no contact for 14 / 30 days
   Hot ≥ 65 · Warm 40-64 · Cold < 40. Won and lost leads are closed and not scored.

   The website promises a reply within 2 business hours; business hours here are Monday to
   Saturday, 8 AM to 5 PM, Philippine time (UTC+8, no daylight saving). */
(function(root){
  'use strict';
  var HOT = 65, WARM = 40, REPLY_HOURS = 2, OPEN = 8, CLOSE = 17, PH = 8 * 3600000;
  var LOCAL = /\b(cagayan de oro|cdo|misamis oriental|opol|el salvador|tagoloan|villanueva|jasaan|laguindingan|alubijid|gitagum|balingasag|claveria|manticao|initao|naawan|lugait|carmen|lapasan|macasandig|bulua|kauswagan|gusa|cugman|agusan|puerto|iponan|canitoan|balulang|camaman-an|nazareth|patag|bugo|macabalan|consolacion|nazareth)\b/i;
  var REGION = /\b(bukidnon|malaybalay|valencia|manolo fortich|iligan|lanao|camiguin|misamis occidental|ozamiz|oroquieta|tangub|gingoog|el salvador)\b/i;
  var MEASURE = /\d+(\.\d+)?\s*(m\b|meter|metre|ft\b|feet|cm\b|x\s*\d|by\s*\d|sqm|sq\.?\s*m)/i;

  function num(v){ var n = Number(v); return isFinite(n) && n > 0 ? n : 0; }
  function days(a, b){ return (Date.parse(b) - Date.parse(a)) / 86400000; }

  function score(l, nowISO){
    if(l.stage === 'won' || l.stage === 'lost') return {closed: true, total: null, label: l.stage === 'won' ? 'Won' : 'Lost', parts: []};
    var parts = [];
    function part(label, points, max, why){ parts.push({label: label, points: points, max: max, why: why}); }

    var tl = {asap: [30, 'Wants it as soon as possible'], '1-3m': [20, 'Within 1 to 3 months'], '3-6m': [8, 'In 3 to 6 months'], later: [0, 'More than 6 months away']}[l.timeline];
    part('When they want it', tl ? tl[0] : 10, 30, tl ? tl[1] : 'Not asked yet');

    var v = num(l.expected_value) || num(l.budget);
    part('Job size', !v ? 8 : v >= 300000 ? 25 : v >= 150000 ? 20 : v >= 80000 ? 12 : 5, 25,
      v ? '₱' + Math.round(v).toLocaleString('en-PH') + (num(l.expected_value) ? ' expected' : ' budget') : 'Not asked yet');

    var loc = String(l.location || '');
    part('Where', !loc ? 5 : LOCAL.test(loc) ? 15 : REGION.test(loc) ? 8 : 0, 15,
      !loc ? 'Not asked yet' : LOCAL.test(loc) ? 'In the service area' : REGION.test(loc) ? 'Northern Mindanao, outside CDO' : 'Outside the usual area');

    var known = l.system && l.system !== 'other';
    var detail = MEASURE.test(String(l.message || '')) || String(l.message || '').trim().length >= 40;
    part('Fit', (known ? 8 : 0) + (detail ? 7 : 0), 15,
      [known ? 'knows the system' : 'system unclear', detail ? 'gave measurements or details' : 'no details yet'].join(', '));

    var eng = 0, why = [];
    if(l.visit_requested || l.stage === 'site_visit' || l.stage === 'quoted'){ eng = 15; why.push(l.stage === 'quoted' ? 'quoted' : 'site visit'); }
    else if(l.stage === 'contacted'){ eng = 6; why.push('in conversation'); }
    if(l.phone && l.email && eng < 15){ eng = Math.min(15, eng + 3); why.push('phone and email'); }
    part('Engagement', eng, 15, why.length ? why.join(', ') : 'No reply yet');

    var since = days(l.last_contact_at || l.created_at, nowISO);
    if(since > 30) part('Going cold', -25, 0, Math.floor(since) + ' days since last contact');
    else if(since > 14) part('Going cold', -15, 0, Math.floor(since) + ' days since last contact');

    var total = Math.max(0, Math.min(100, parts.reduce(function(s, p){ return s + p.points; }, 0)));
    return {closed: false, total: total, label: total >= HOT ? 'Hot' : total >= WARM ? 'Warm' : 'Cold', parts: parts};
  }

  // Business hours (Mon-Sat 8:00-17:00, Philippine time) between two instants.
  function businessHours(fromISO, toISO){
    var a = Date.parse(fromISO), b = Date.parse(toISO);
    if(!(b > a)) return 0;
    var total = 0, t = a;
    while(t < b){
      var local = new Date(t + PH), dow = local.getUTCDay();
      var dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - PH;
      var open = dayStart + OPEN * 3600000, close = dayStart + CLOSE * 3600000;
      if(dow !== 0) total += Math.max(0, Math.min(b, close) - Math.max(t, open));
      t = dayStart + 86400000;
    }
    return total / 3600000;
  }

  // Waiting for a first reply: hours on the 2-hour clock, overdue past it.
  function replyClock(l, nowISO){
    if(l.first_response_at || l.stage === 'won' || l.stage === 'lost') return null;
    var h = businessHours(l.created_at, nowISO);
    return {hours: h, overdue: h > REPLY_HOURS};
  }

  function median(xs){
    if(!xs.length) return null;
    var s = xs.slice().sort(function(a, b){ return a - b; }), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function board(leads, nowISO){
    var today = new Date(Date.parse(nowISO) + PH).toISOString().slice(0, 10);
    var open = leads.filter(function(l){ return l.stage !== 'won' && l.stage !== 'lost'; });
    var rows = open.map(function(l){ return {lead: l, s: score(l, nowISO), reply: replyClock(l, nowISO)}; });
    var waiting = rows.filter(function(r){ return r.reply; }).sort(function(a, b){ return b.reply.hours - a.reply.hours; });
    var recent = leads.filter(function(l){ return l.first_response_at && days(l.created_at, nowISO) <= 30; });
    var closed90 = leads.filter(function(l){ return (l.stage === 'won' || l.stage === 'lost') && days(l.updated_at || l.created_at, nowISO) <= 90; });
    var won90 = closed90.filter(function(l){ return l.stage === 'won'; }).length;
    var byStage = {};
    ['new', 'contacted', 'site_visit', 'quoted', 'won', 'lost'].forEach(function(s){ byStage[s] = {count: 0, value: 0}; });
    leads.forEach(function(l){ var b = byStage[l.stage]; if(b){ b.count++; b.value += num(l.expected_value) || num(l.budget); } });
    return {
      rows: rows.sort(function(a, b){ return b.s.total - a.s.total || String(b.lead.created_at).localeCompare(String(a.lead.created_at)); }),
      waiting: waiting,
      overdueReplies: waiting.filter(function(r){ return r.reply.overdue; }).length,
      hot: rows.filter(function(r){ return r.s.label === 'Hot'; }).length,
      followUpsDue: open.filter(function(l){ return l.next_action_at && l.next_action_at <= today; }).length,
      newThisWeek: leads.filter(function(l){ return days(l.created_at, nowISO) <= 7; }).length,
      pipelineValue: open.reduce(function(s, l){ return s + (num(l.expected_value) || num(l.budget)); }, 0),
      winRate: closed90.length ? won90 / closed90.length : null,
      closed90: closed90.length,
      medianReplyHours: median(recent.map(function(l){ return businessHours(l.created_at, l.first_response_at); })),
      byStage: byStage
    };
  }

  var api = {score: score, board: board, businessHours: businessHours, replyClock: replyClock, HOT: HOT, WARM: WARM, REPLY_HOURS: REPLY_HOURS};
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RitehomeLeads = api;
})(typeof window !== 'undefined' ? window : globalThis);
