/* Executive dashboard (v4.2) on "/" for the admin. Read-only: no forms, no writes. Data from
   supabase/migrations/20261129000026_executive_dashboard.sql:
     executive_overview()            organisation, money (actual / owed / we owe / forecast), payroll, risks
     executive_calendar(from, to)    holidays, events, milestones, cutoffs and pay days, expiries, money moved
   plus schedule_board() for the Gantt. Money stays in its box: actual (the books), owed, estimate,
   forecast; nothing projected is ever shown as cash. Every risk is a rule on real records.
   Exposed as window.RitehomeExec.load(client) -> Promise<boolean> (false: tracker.html keeps the old overview). */
(function(){
  'use strict';
  var root, client, data, board, cal = {view: "month", anchor: null, items: [], hide: {}};
  var STAGES = ["consultation", "site_visit", "design", "cutlist", "bom", "final_cutlist", "procurement", "fabrication", "installation", "handover"];
  var STAGE = {consultation: "Consultation", site_visit: "Site visit", design: "Design", cutlist: "Initial cutlist", bom: "BOM",
    final_cutlist: "Final cutlist", procurement: "Procurement", fabrication: "Fabrication", installation: "Installation", handover: "Handover"};
  // Which department works a stage (as on the Schedule; the database decides who may change it).
  var DEPT = {consultation: "Sales", site_visit: "Sales", design: "Design", cutlist: "Design", final_cutlist: "Design", bom: "Purchasing",
    procurement: "Purchasing", fabrication: "Workshop", installation: "Installation", handover: "Installation"};
  var ST_WORD = {not_started: "Not started", in_progress: "In progress", waiting_client: "Waiting for client", submitted: "Submitted",
    blocked: "Blocked", done: "Done"};
  var CATS = [["holiday", "Holidays"], ["event", "Events"], ["milestone", "Milestones"], ["payroll", "Payroll"], ["compliance", "Compliance"],
    ["money_in", "Money in"], ["money_out", "Money out"]];
  var CAT = {}; CATS.forEach(function(c){ CAT[c[0]] = c[1]; });
  var SEV = [["critical", "Critical"], ["high", "High"], ["moderate", "Moderate"], ["low", "Low"]];

  function h(tag, attrs, kids){
    var e = document.createElement(tag);
    if(attrs) Object.keys(attrs).forEach(function(k){
      var v = attrs[k]; if(v == null || v === false) return;
      if(k === "text") e.textContent = v; else if(k === "class") e.className = v;
      else if(k.slice(0, 2) === "on") e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? "" : v);
    });
    (function add(c){ if(c == null || c === false) return; if(Array.isArray(c)){ c.forEach(add); return; } e.appendChild(typeof c === "object" ? c : document.createTextNode(String(c))); })(kids);
    return e;
  }
  function svg(tag, attrs, kids){
    var e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs || {}).forEach(function(k){ if(attrs[k] != null) e.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function(c){ if(c) e.appendChild(c); });
    return e;
  }
  var pesoFmt = new Intl.NumberFormat("en-PH", {style: "currency", currency: "PHP", maximumFractionDigits: 0});
  var peso2 = new Intl.NumberFormat("en-PH", {style: "currency", currency: "PHP"});
  function peso(n){ return pesoFmt.format(Math.round(Number(n) || 0)); }
  function compact(n){ n = Number(n) || 0; var a = Math.abs(n); return (n < 0 ? "−" : "") + "₱" + (a >= 1e6 ? (a / 1e6).toFixed(1) + "M" : a >= 1e3 ? Math.round(a / 1e3) + "k" : Math.round(a)); }
  function link(m){ return window.RitehomeLinks ? window.RitehomeLinks.href(m) : m + ".html"; }
  function iso(d){ return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function parse(s){ var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(s, n){ var d = parse(s); d.setDate(d.getDate() + n); return iso(d); }
  var dayFmt = new Intl.DateTimeFormat("en-PH", {weekday: "short", month: "short", day: "numeric"});
  var monFmt = new Intl.DateTimeFormat("en-PH", {month: "short"});
  var monYear = new Intl.DateTimeFormat("en-PH", {month: "long", year: "numeric"});
  function day(s){ return dayFmt.format(parse(s)); }
  function plural(n, one, many){ return n + " " + (n === 1 ? one : many); }
  function card(id, title, sub, body){
    return h("section", {class: "card ex-card", id: id}, [h("div", {class: "ex-card-head"}, [h("h2", {text: title}), sub ? h("p", {class: "muted small", text: sub}) : null]), body]);
  }
  function tag(kind, text){ return h("span", {class: "ex-tag ex-tag-" + kind, text: text}); }
  function stat(label, value, sub, kind, href){
    var inner = [h("span", {class: "label", text: label}), h("span", {class: "val", text: value}), sub ? h("span", {class: "sub-line", text: sub}) : null];
    return href ? h("a", {class: "kpi ex-stat" + (kind ? " " + kind : ""), href: href}, inner) : h("div", {class: "kpi ex-stat" + (kind ? " " + kind : "")}, inner);
  }

  // ---------- chart: grouped bars by month, one axis, hover tooltip, legend, table view ----------
  function barChart(rows, series, label){
    var W = 640, H = 220, L = 52, B = 26, T = 10, n = rows.length;
    var max = Math.max(1, Math.max.apply(null, rows.map(function(r){ return Math.max.apply(null, series.map(function(s){ return Math.max(0, Number(r[s.key]) || 0); })); })));
    var step = Math.pow(10, Math.floor(Math.log10(max))), top = Math.ceil(max / step) * step;
    var gw = (W - L - 8) / n, bw = Math.max(3, Math.min(18, (gw - 6) / series.length - 2));
    var y = function(v){ return T + (H - T - B) * (1 - v / top); };
    var g = [];
    [0, .5, 1].forEach(function(f){
      g.push(svg("line", {x1: L, x2: W - 4, y1: y(top * f), y2: y(top * f), class: "ex-grid"}));
      g.push(svg("text", {x: L - 6, y: y(top * f) + 4, "text-anchor": "end", class: "ex-axis"}, [document.createTextNode(compact(top * f))]));
    });
    var tip = h("div", {class: "ex-tip", hidden: true});
    rows.forEach(function(r, i){
      var x0 = L + i * gw + (gw - (bw + 2) * series.length) / 2;
      series.forEach(function(s, k){
        var v = Math.max(0, Number(r[s.key]) || 0), yy = y(v);
        g.push(svg("rect", {x: x0 + k * (bw + 2), y: yy, width: bw, height: Math.max(0, H - B - yy), rx: v ? 3 : 0, class: "ex-bar " + s.cls}));
      });
      g.push(svg("text", {x: L + i * gw + gw / 2, y: H - 8, "text-anchor": "middle", class: "ex-axis"}, [document.createTextNode(monFmt.format(parse(r.month + "-01")))]));
      var hit = svg("rect", {x: L + i * gw, y: T, width: gw, height: H - T - B, class: "ex-hit", tabindex: "0", "aria-label": r.month});
      function show(){ tip.hidden = false; tip.textContent = "";
        tip.appendChild(h("strong", {text: monYear.format(parse(r.month + "-01"))}));
        series.forEach(function(s){ tip.appendChild(h("div", null, [h("span", {class: "ex-key " + s.cls}), s.label + ": " + peso(r[s.key])])); });
        tip.style.left = Math.min(78, Math.max(4, (L + i * gw) / W * 100)) + "%"; }
      hit.addEventListener("mouseenter", show); hit.addEventListener("focus", show);
      hit.addEventListener("mouseleave", function(){ tip.hidden = true; }); hit.addEventListener("blur", function(){ tip.hidden = true; });
      g.push(hit);
    });
    var table = h("details", {class: "ex-table"}, [h("summary", {text: "See the numbers"}), h("div", {class: "acct-scroll"}, h("table", {class: "acct-table"}, [
      h("thead", null, h("tr", null, [h("th", {text: "Month"})].concat(series.map(function(s){ return h("th", {class: "num", text: s.label}); })))),
      h("tbody", null, rows.map(function(r){ return h("tr", null, [h("td", {text: monYear.format(parse(r.month + "-01"))})].concat(series.map(function(s){ return h("td", {class: "num", text: peso(r[s.key])}); }))); }))]))]);
    return h("div", {class: "ex-chart"}, [
      h("div", {class: "ex-legend"}, series.map(function(s){ return h("span", null, [h("span", {class: "ex-key " + s.cls}), s.label]); })),
      h("div", {class: "ex-plot"}, [svg("svg", {viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": label}, g), tip]), table]);
  }

  // Deadlines (v4.3, compliance_list): overdue ones are critical, due within 5 days high.
  var SHORT = {deadline_1601c: "BIR 1601-C", deadline_2316: "BIR 2316", deadline_1604c: "BIR 1604-C", deadline_sss: "SSS remittance",
    deadline_philhealth: "PhilHealth remittance", deadline_pagibig: "Pag-IBIG remittance", deadline_13th_month: "13th-month pay"};
  function mergeComplianceRisks(){
    (data.compliance || []).forEach(function(x){
      if(x.status !== "overdue" && x.status !== "due_soon") return;
      data.risks.push({severity: x.status === "overdue" ? "critical" : "high", area: "Compliance",
        title: (SHORT[x.code] || x.name) + " for " + x.period + (x.status === "overdue" ? " is overdue" : " is due " + day(x.due)),
        why: "Due " + day(x.due) + " under " + x.source_title + (x.rule_status !== "approved" ? " (rule waiting for the accountant's review)" : "") + ". Nothing recorded as " + x.done_kind + " yet." + (x.amount != null ? " Amount from approved payroll: " + peso(x.amount) + "." : ""),
        link: "accounting"});
    });
    var rank = {critical: 0, high: 1, moderate: 2, low: 3};
    data.risks.sort(function(a, b){ return rank[a.severity] - rank[b.severity]; });
  }
  function complianceCal(from, to){
    return (data.compliance || []).filter(function(x){ return x.due >= from && x.due <= to; }).map(function(x){
      return {date: x.due, category: "compliance", title: (SHORT[x.code] || x.name) + " " + x.period, detail: x.agency, link: "accounting",
        status: x.status === "done" ? "done" : x.status === "overdue" ? "overdue" : "upcoming", amount: x.amount, comp: x};
    });
  }

  // ---------- 1. overview ----------
  function overview(){
    var o = data.org, t = o.today, risks = data.risks, crit = risks.filter(function(r){ return r.severity === "critical" || r.severity === "high"; }).length;
    var waiting = o.pending.approvals + o.pending.payroll_to_approve + o.pending.payroll_adjustments;
    var offDay = t.sunday || t.holiday;
    return h("div", {class: "kpis ex-kpis"}, [
      stat("Attendance today", offDay ? (t.sunday ? "Sunday" : "Holiday") : t.present + " of " + o.staff, offDay ? "No work day" : (t.on_leave ? plural(t.on_leave, "on leave", "on leave") + " · " : "") + (t.absent ? t.absent + " absent" : "clocked in"), "", link("attendance")),
      stat("Open projects", String(o.projects.open), (o.projects.progress != null ? o.projects.progress + "% of stages done" : "No stages yet") + (o.projects.with_late_stages ? " · " + o.projects.with_late_stages + " running late" : ""), "", link("schedule")),
      stat("Waiting on you", String(waiting), waiting ? [o.pending.approvals ? plural(o.pending.approvals, "approval", "approvals") : "", o.pending.payroll_to_approve ? "payroll to approve" : "", o.pending.payroll_adjustments ? plural(o.pending.payroll_adjustments, "pay adjustment", "pay adjustments") : ""].filter(Boolean).join(" · ") : "Nothing waiting", waiting ? "warn" : "", link("approvals")),
      stat("Risks to look at", String(crit), crit ? "critical or high, below" : "None critical or high", crit ? "alert" : "", "#exRisks")
    ]);
  }

  // ---------- 2. financial health ----------
  function sumMonths(list, key){ return list.reduce(function(t, m){ return t + (Number(m[key]) || 0); }, 0); }
  function finance(){
    var f = data.finance, a = f.actual, owe = f.we_owe, months = f.months, cur = data.today.slice(0, 7);
    var idx = months.findIndex(function(m){ return m.month === cur; });
    function rng(from, to){ return months.slice(Math.max(0, from), Math.max(0, to)); }
    var qStart = idx - ((parse(cur + "-01").getMonth()) % 3);
    var cmp = [
      ["This month", rng(idx, idx + 1), "Last month", rng(idx - 1, idx)],
      ["This quarter", rng(qStart, idx + 1), "Last quarter", qStart - 3 >= 0 ? rng(qStart - 3, qStart) : null],
      ["This year to date", months.filter(function(m){ return m.month.slice(0, 4) === cur.slice(0, 4) && m.month <= cur; }), "Last year", null]];
    function line(list){ if(!list) return null; var i = sumMonths(list, "income"), c = sumMonths(list, "costs"); return {i: i, c: c, n: i - c}; }
    var boxes = h("div", {class: "ex-money"}, [
      h("div", {class: "ex-box ex-actual"}, [tag("actual", "Actual · the books"), h("div", {class: "ex-big", text: peso(a.cash)}), h("div", {class: "muted small", text: "Cash on hand, in bank and in e-wallets today" + (f.books_start ? ", books since " + day(f.books_start) : "")}),
        h("ul", {class: "ex-mini"}, [["1010", "On hand"], ["1020", "In bank"], ["1030", "E-wallets"]].map(function(k){ return h("li", null, [k[1], h("span", {text: peso((a.cash_by_account || {})[k[0]] || 0)})]); }))]),
      h("div", {class: "ex-box ex-owed"}, [tag("owed", "Owed to us · not cash yet"), h("div", {class: "ex-big", text: peso(f.owed_to_us.receivables)}), h("div", {class: "muted small", text: "Still to collect on " + plural(f.owed_to_us.projects, "contract", "contracts") + ": contract price less payments received, including parts not billed yet."}),
        h("a", {class: "small", href: link("accounting"), text: "Receivables in Accounting"})]),
      h("div", {class: "ex-box ex-weowe"}, [tag("owe", "We owe"), owe.tracked || owe.liabilities ? h("div", {class: "ex-big", text: peso(owe.liabilities)}) : h("div", {class: "ex-big muted", text: "Not tracked"}),
        owe.tracked || owe.liabilities ? h("ul", {class: "ex-mini"}, [["Supplier bills", owe.payables], ["Taxes payable", owe.tax], ["SSS, PhilHealth, Pag-IBIG", owe.contributions], ["Loans", owe.loans]].map(function(k){ return h("li", null, [k[0], h("span", {text: peso(k[1])})]); }))
          : h("div", {class: "muted small", text: "No bills, loans or payables are in the books yet. Expenses are recorded when paid, so nothing owed shows here until it is entered as a journal entry."})])]);
    var table = h("table", {class: "acct-table ex-cmp"}, [h("thead", null, h("tr", null, ["", "Income", "Costs", "Net", "Compared with", "Net then", "Change in net"].map(function(t, i){ return h("th", {class: i && i !== 4 ? "num" : null, text: t}); }))),
      h("tbody", null, cmp.map(function(c){ var a1 = line(c[1]), b1 = line(c[3]);
        var diff = b1 ? a1.n - b1.n : null;
        return h("tr", null, [h("td", {text: c[0]}), h("td", {class: "num", text: peso(a1.i)}), h("td", {class: "num", text: peso(a1.c)}), h("td", {class: "num" + (a1.n < 0 ? " neg" : ""), text: peso(a1.n)}),
          h("td", {text: c[2]}), h("td", {class: "num", text: b1 ? peso(b1.n) : "Not enough history"}),
          h("td", {class: "num" + (diff < 0 ? " neg" : ""), text: b1 == null ? "—" : !diff ? "No change" : (diff > 0 ? "▲ up " : "▼ down ") + peso(Math.abs(diff))})]); }))]);
    return card("exFinance", "Financial health", "Actual money, money owed to us and money we owe are kept apart and never added together. Figures come from the books in Accounting.",
      h("div", {class: "ex-stack"}, [boxes, h("div", {class: "acct-scroll"}, table),
        h("details", {class: "ex-more", open: true}, [h("summary", {text: "Income and costs by month"}),
          barChart(months, [{key: "income", label: "Income", cls: "s1"}, {key: "costs", label: "Costs", cls: "s2"}], "Income and costs by month, last 12 months")])]));
  }

  // ---------- 3. cash flow ----------
  function cashflow(){
    var f = data.finance, fc = f.forecast;
    var fcBox = fc.available ? h("div", {class: "ex-forecast"}, [tag("forecast", "Forecast · confidence " + fc.confidence),
        h("p", {class: "small", text: "Method: " + fc.method + ". Assumes: " + fc.assumptions}),
        h("ul", {class: "ex-mini"}, fc.months.map(function(m){ return h("li", null, [monYear.format(parse(m.month + "-01")) + " (projected)", h("span", {class: m.cash < 0 ? "neg" : null, text: peso(m.cash)})]); }))])
      : h("div", {class: "ex-forecast"}, [tag("forecast", "Forecast"), h("p", {class: "small", text: "No forecast yet. " + fc.reason}), h("p", {class: "muted small", text: "This is on purpose: a projection from too little history would look precise and be wrong."})]);
    return card("exCash", "Cash flow", "Cash that actually came in and went out of cash on hand, bank and e-wallets, by month.",
      h("div", {class: "ex-stack"}, [barChart(f.months, [{key: "cash_in", label: "Cash in", cls: "s1"}, {key: "cash_out", label: "Cash out", cls: "s2"}], "Cash in and out by month"), fcBox]));
  }

  // ---------- 4. payroll and compliance ----------
  function payroll(){
    var p = data.payroll, per = p.period, m = p.month || {};
    var runs = p.runs.length ? h("table", {class: "acct-table"}, [h("thead", null, h("tr", null, ["Cutoff", "Status", "Net pay", "Employer contributions", "Tax withheld"].map(function(t, i){ return h("th", {class: i > 1 ? "num" : null, text: t}); }))),
      h("tbody", null, p.runs.map(function(r){ return h("tr", null, [h("td", {text: day(r.period_start) + " – " + day(r.period_end)}), h("td", {text: r.status}),
        h("td", {class: "num", text: peso(r.net)}), h("td", {class: "num", text: peso(r.employer)}), h("td", {class: "num", text: peso(r.tax)})]); }))]) : h("p", {class: "muted small", text: "No payroll prepared yet."});
    return card("exPayroll", "Payroll and compliance", "Employee-level pay stays in Attendance → Pay, for the admin and the bookkeeper only.",
      h("div", {class: "ex-stack"}, [h("div", {class: "kpis ex-kpis"}, [
        stat("Next pay day", day(per.release), "Cutoff " + day(per.start) + " – " + day(per.end), "", link("attendance")),
        h("div", {class: "kpi ex-stat"}, [h("span", {class: "label"}, ["This cutoff so far ", tag("estimate", "Estimate")]), h("span", {class: "val", text: peso(p.estimate_to_date)}), h("span", {class: "sub-line", text: "From attendance, until a payroll is approved"})]),
        h("div", {class: "kpi ex-stat"}, [h("span", {class: "label"}, ["Rest of the cutoff ", tag("forecast", "Forecast")]), h("span", {class: "val", text: peso(p.forecast_rest)}), h("span", {class: "sub-line", text: plural(p.working_days_left, "working day", "working days") + " left. " + p.forecast_assumption})]),
        stat("Approved this month", peso(m.approved_net), "Employer contributions " + peso(m.employer_contributions) + " · tax withheld " + peso(m.withholding), "", link("attendance"))]),
        h("div", {class: "acct-scroll"}, runs),
        compliancePanel(),
        h("p", {class: "muted small", text: p.rules_pending ? p.rules_pending + " statutory rules (rates and deadlines) are still waiting for the accountant, so contributions, tax and due dates are estimates." : ""})]));
  }

  function compliancePanel(){
    var c = data.compliance;
    if(!c) return h("p", {class: "muted small", text: "Tax and contribution deadlines show here once the compliance update is in the database."});
    var open = c.filter(function(x){ return x.status !== "done"; }).sort(function(a, b){ return a.due < b.due ? -1 : 1; });
    var od = open.filter(function(x){ return x.status === "overdue"; }).length;
    return h("div", {class: "ex-comp"}, [h("div", {class: "muted small", text: od ? plural(od, "obligation is", "obligations are") + " overdue." : "Nothing overdue."}),
      h("ul", {class: "ex-mini"}, open.slice(0, 5).map(function(x){ return h("li", null, [(SHORT[x.code] || x.name) + " · " + x.period, h("span", {class: x.status === "overdue" ? "neg" : null, text: (x.status === "overdue" ? "overdue since " : "due ") + day(x.due)})]); })),
      h("a", {class: "small", href: link("accounting") + "#compliance", text: "All deadlines in Accounting → Compliance"})]);
  }

  // ---------- 5. calendar: day, week, month, year ----------
  function calRange(){
    var a = cal.anchor, d = parse(a);
    if(cal.view === "day") return [a, a];
    if(cal.view === "week"){ var s = addDays(a, -((d.getDay() + 6) % 7)); return [s, addDays(s, 6)]; }
    if(cal.view === "month"){ var f = new Date(d.getFullYear(), d.getMonth(), 1), l = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      return [addDays(iso(f), -((f.getDay() + 6) % 7)), addDays(iso(l), (7 - l.getDay()) % 7)]; }
    return [d.getFullYear() + "-01-01", d.getFullYear() + "-12-31"];
  }
  function loadCal(){
    var r = calRange();
    return Promise.all([client.rpc("executive_calendar", {p_from: r[0], p_to: r[1]}), client.rpc("compliance_list", {p_from: r[0], p_to: r[1]})]).then(function(res){
      cal.error = res[0].error; cal.items = (res[0].error ? [] : (res[0].data || [])).concat(res[1].error || !res[1].data ? [] :
        res[1].data.items.filter(function(x){ return x.due >= r[0] && x.due <= r[1]; }).map(function(x){ return {date: x.due, category: "compliance", title: (SHORT[x.code] || x.name) + " " + x.period, detail: x.agency, link: "accounting", status: x.status === "done" ? "done" : x.status === "overdue" ? "overdue" : "upcoming"}; }));
      renderCal(); });
  }
  function itemsOn(d){ return cal.items.filter(function(x){ return !cal.hide[x.category] && x.date <= d && (x.end || x.date) >= d; }); }
  function itemEl(x){
    return h("a", {class: "ex-item cat-" + x.category + (x.status === "overdue" ? " overdue" : ""), href: link(x.link || "schedule"), title: (CAT[x.category] || "") + ": " + x.title + (x.detail ? " · " + x.detail : "")}, [
      h("span", {class: "ex-dot"}), h("span", {class: "ex-item-t", text: x.title + (x.amount != null ? " " + peso(x.amount) : "")}), x.status === "overdue" ? h("span", {class: "ex-od", text: "overdue"}) : null]);
  }
  function renderCal(){
    var box = document.getElementById("exCalBody"); if(!box) return;
    var r = calRange(), today = data.today, out;
    document.getElementById("exCalTitle").textContent = cal.view === "day" ? day(r[0]) : cal.view === "week" ? day(r[0]) + " – " + day(r[1])
      : cal.view === "month" ? monYear.format(parse(cal.anchor)) : cal.anchor.slice(0, 4);
    if(cal.view === "year"){
      out = h("div", {class: "ex-year"}, Array.from({length: 12}, function(_, m){
        var y = +cal.anchor.slice(0, 4), first = y + "-" + String(m + 1).padStart(2, "0"), list = cal.items.filter(function(x){ return !cal.hide[x.category] && x.date.slice(0, 7) === first; });
        var by = {}; list.forEach(function(x){ by[x.category] = (by[x.category] || 0) + 1; });
        return h("button", {type: "button", class: "ex-ymonth", onclick: function(){ cal.view = "month"; cal.anchor = first + "-01"; syncViewBtns(); loadCal(); }}, [
          h("strong", {text: monFmt.format(parse(first + "-01"))}), h("span", {class: "muted small", text: plural(list.length, "item", "items")}),
          h("span", {class: "ex-ycats"}, Object.keys(by).map(function(c){ return h("span", {class: "ex-chip cat-" + c, text: by[c] + " " + (CAT[c] || c).toLowerCase()}); }))]);
      }));
    } else if(cal.view === "day"){
      var l = itemsOn(r[0]); out = l.length ? h("div", {class: "ex-daylist"}, l.map(itemEl)) : h("p", {class: "muted", text: "Nothing on this day."});
    } else {
      var days = []; for(var d = r[0]; d <= r[1]; d = addDays(d, 1)) days.push(d);
      out = h("div", {class: "ex-grid-cal" + (cal.view === "week" ? " week" : "")}, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(function(w){ return h("div", {class: "ex-wd", text: w}); }).concat(days.map(function(d){
        var l = itemsOn(d), max = cal.view === "week" ? 50 : 3, other = cal.view === "month" && d.slice(0, 7) !== cal.anchor.slice(0, 7);
        return h("div", {class: "ex-day" + (d === today ? " today" : "") + (other ? " other" : ""), "data-day": d}, [h("span", {class: "ex-dnum", text: String(+d.slice(8))}),
          l.slice(0, max).map(itemEl), l.length > max ? h("button", {type: "button", class: "ex-more-btn", text: "+" + (l.length - max) + " more", onclick: function(){ cal.view = "day"; cal.anchor = d; syncViewBtns(); loadCal(); }}) : null]);
      })));
    }
    box.textContent = ""; box.appendChild(cal.error ? h("p", {class: "muted", text: "The calendar couldn't load."}) : out);
  }
  function syncViewBtns(){ document.querySelectorAll("#exCalViews button").forEach(function(b){ if(b.getAttribute("data-view") === cal.view) b.setAttribute("aria-pressed", "true"); else b.setAttribute("aria-pressed", "false"); }); }
  function calendar(){
    cal.anchor = data.today;
    var move = function(n){ return function(){ var d = parse(cal.anchor);
      if(cal.view === "day") d.setDate(d.getDate() + n); else if(cal.view === "week") d.setDate(d.getDate() + 7 * n);
      else if(cal.view === "month") d = new Date(d.getFullYear(), d.getMonth() + n, 1); else d = new Date(d.getFullYear() + n, 0, 1);
      cal.anchor = iso(d); loadCal(); }; };
    var views = h("div", {class: "ex-seg", id: "exCalViews", role: "group", "aria-label": "Calendar view"}, [["day", "Day"], ["week", "Week"], ["month", "Month"], ["year", "Year"]].map(function(v){
      return h("button", {type: "button", "data-view": v[0], "aria-pressed": String(v[0] === cal.view), text: v[1], onclick: function(){ cal.view = v[0]; syncViewBtns(); loadCal(); }}); }));
    var chips = h("div", {class: "ex-chips", role: "group", "aria-label": "Show"}, CATS.map(function(c){
      var b = h("button", {type: "button", class: "ex-chip cat-" + c[0], "aria-pressed": "true", text: c[1]});
      b.addEventListener("click", function(){ cal.hide[c[0]] = !cal.hide[c[0]]; b.setAttribute("aria-pressed", String(!cal.hide[c[0]])); renderCal(); });
      return b; }));
    return card("exCalendar", "Calendar", "Pay days, cutoffs, holidays, project milestones, events, document expiries and money that moved. Tap an item to open where it's managed.",
      h("div", {class: "ex-stack"}, [h("div", {class: "ex-calbar"}, [views, h("div", {class: "ex-nav"}, [
          h("button", {type: "button", class: "btn ghost small", "aria-label": "Previous", text: "‹", onclick: move(-1)}),
          h("button", {type: "button", class: "btn ghost small", text: "Today", onclick: function(){ cal.anchor = data.today; loadCal(); }}),
          h("button", {type: "button", class: "btn ghost small", "aria-label": "Next", text: "›", onclick: move(1)}), h("strong", {id: "exCalTitle"})])]),
        chips, h("div", {id: "exCalBody"})]));
  }

  // ---------- 6. Gantt (read-only, from the Schedule) ----------
  function gantt(){
    var projects = (board && board.projects || []).filter(function(p){ return p.status !== "cancelled"; });
    var staff = {}; (board && board.staff || []).forEach(function(s){ staff[s.id] = s.full_name || s.name; });
    var f = {from: addDays(data.today, -30), to: addDays(data.today, 90), project: "", dept: "", status: "", who: "", done: false};
    var body = h("div", {class: "ex-gantt-body"});
    function sel(label, opts, key){
      var s = h("select", {"aria-label": label}, opts.map(function(o){ return h("option", {value: o[0], text: o[1]}); }));
      s.addEventListener("change", function(){ f[key] = s.value; draw(); }); return h("label", null, [label, s]);
    }
    function dateIn(label, key){ var i = h("input", {type: "date", value: f[key], "aria-label": label}); i.addEventListener("change", function(){ if(i.value) f[key] = i.value; draw(); }); return h("label", null, [label, i]); }
    var whoOpts = [["", "Anyone"]].concat(Object.keys(staff).map(function(id){ return [id, staff[id]]; }));
    var filters = h("div", {class: "ex-filters"}, [
      sel("Project", [["", "All open projects"]].concat(projects.map(function(p){ return [p.id, p.name]; })), "project"),
      sel("Department", [["", "All"]].concat(["Sales", "Design", "Purchasing", "Workshop", "Installation"].map(function(d){ return [d, d]; })), "dept"),
      sel("Responsible", whoOpts, "who"),
      sel("Status", [["", "Any"], ["late", "Late"], ["blocked", "Blocked"], ["in_progress", "In progress"], ["not_started", "Not started"], ["done", "Done"]], "status"),
      dateIn("From", "from"), dateIn("To", "to")]);
    function draw(){
      var a = parse(f.from), z = parse(f.to), span = Math.max(1, (z - a) / 864e5), pos = function(s){ return Math.min(100, Math.max(0, (parse(s) - a) / 864e5 / span * 100)); };
      var today = data.today, rows = [];
      projects.filter(function(p){ return !f.project || p.id === f.project; }).filter(function(p){ return p.status !== "completed" || f.project; }).forEach(function(p){
        var stages = (p.stages || []).slice().sort(function(x, y){ return STAGES.indexOf(x.stage) - STAGES.indexOf(y.stage); }).filter(function(s){
          var late = s.status !== "done" && s.planned_end && s.planned_end < today;
          return (!f.dept || DEPT[s.stage] === f.dept) && (!f.who || s.assignee === f.who) && (!f.status || (f.status === "late" ? late : s.status === f.status));
        });
        if(!stages.length) return;
        var done = (p.stages || []).filter(function(s){ return s.status === "done"; }).length, total = (p.stages || []).length;
        rows.push(h("div", {class: "ex-g-proj"}, [h("strong", {text: p.name}), h("span", {class: "muted small", text: done + " of " + total + " stages done" + (p.target ? " · handover target " + day(p.target) : "")})]));
        stages.forEach(function(s){
          var st = s.actual_start || s.planned_start, en = s.status === "done" ? (s.actual_end || s.planned_end) : (s.planned_end || s.actual_end);
          var late = s.status !== "done" && s.planned_end && s.planned_end < today;
          var bar = st && en && !(en < f.from || st > f.to) ? h("span", {class: "ex-g-bar st-" + s.status + (late ? " late" : ""), style: "left:" + pos(st) + "%;width:" + Math.max(0.8, pos(en) - pos(st) + 100 / span) + "%",
            title: STAGE[s.stage] + ": " + (ST_WORD[s.status] || s.status) + " · " + (st ? day(st) : "?") + " – " + (en ? day(en) : "?") + (late ? " · late" : "")}) : null;
          rows.push(h("div", {class: "ex-g-row", "data-stage": p.name + "/" + s.stage}, [
            h("div", {class: "ex-g-label"}, [h("span", {text: STAGE[s.stage]}), h("span", {class: "ex-g-st st-" + s.status + (late ? " late" : ""), text: late ? "Late" : (ST_WORD[s.status] || s.status)}),
              s.assignee && staff[s.assignee] ? h("span", {class: "muted small", text: staff[s.assignee]}) : null]),
            h("div", {class: "ex-g-track"}, [bar, today >= f.from && today <= f.to ? h("span", {class: "ex-g-today", style: "left:" + pos(today) + "%"}) : null])]));
        });
      });
      body.textContent = "";
      body.appendChild(rows.length ? h("div", {class: "ex-g"}, rows) : h("p", {class: "muted", text: board ? "No stages match these filters." : "The Schedule couldn't load."}));
    }
    draw();
    return card("exGantt", "Project timeline", "Read-only, from the Schedule: each stage from its start to its end, in order (a stage starts when the one before it is approved). Change dates on the Schedule.",
      h("div", {class: "ex-stack"}, [filters, h("div", {class: "ex-g-legend muted small"}, [["done", "Done"], ["in_progress", "In progress"], ["submitted", "Submitted"], ["blocked", "Blocked"], ["not_started", "Not started"], ["late", "Late (red edge)"]].map(function(k){
        return h("span", null, [h("span", {class: "ex-g-sw st-" + k[0] + (k[0] === "late" ? " late" : "")}), k[1]]); })), body,
        h("a", {class: "small", href: link("schedule"), text: "Open the Schedule to change dates or status"})]));
  }

  // ---------- 7. financial timeline ----------
  function timeline(){
    var box = h("div", {class: "ex-timeline"}, h("p", {class: "muted small", text: "Loading…"}));
    var from = addDays(data.today, -30), to = addDays(data.today, 60);
    client.rpc("executive_calendar", {p_from: from, p_to: to}).then(function(res){
      var list = (res.data || []).filter(function(x){ return ["money_in", "money_out", "payroll", "compliance"].indexOf(x.category) >= 0 && !(x.category === "payroll" && x.title === "Cutoff ends"); })
        .concat(complianceCal(from, to));
      box.textContent = "";
      if(!list.length){ box.appendChild(h("p", {class: "muted", text: "Nothing in the last 30 or next 60 days."})); return; }
      var by = {}; list.forEach(function(x){ (by[x.date] = by[x.date] || []).push(x); });
      box.appendChild(h("ol", {class: "ex-tl"}, Object.keys(by).sort().map(function(d){
        var past = d < data.today;
        return h("li", {class: past ? "past" : d === data.today ? "now" : "next"}, [h("span", {class: "ex-tl-date", text: day(d) + (d === data.today ? " · today" : "")}),
          h("div", null, by[d].map(function(x){
            var kind = x.category === "money_in" ? ["in", "Received"] : x.category === "money_out" ? ["out", x.title] : x.category === "payroll" ? ["pay", "Pay day"] : ["comp", "Due"];
            var state = x.category === "payroll" ? (x.status === "released" ? "paid" : past ? "overdue" : "upcoming") : x.status || (past ? "done" : "upcoming");
            return h("div", {class: "ex-tl-item"}, [tag(kind[0], kind[1]), h("span", {text: (x.category === "payroll" ? x.detail : x.title) + (x.amount != null ? " · " + peso2.format(x.amount) : "")}),
              x.category === "payroll" ? h("span", {class: "ex-state " + state, text: state === "overdue" ? "pay day passed, payroll " + x.status : state === "paid" ? "released" : "payroll " + x.status})
              : x.category === "compliance" ? h("span", {class: "ex-state " + (state === "done" ? "paid" : state), text: state === "done" ? "done" : state === "overdue" ? "overdue" : "not recorded yet"}) : null]);
          }))]);
      })));
    });
    return card("exTimeline", "Financial timeline", "The last 30 days and the next 60: money received and paid (from the books), pay days and their payroll status, and tax and contribution deadlines. Loans and supplier bills appear once they're in the books.", box);
  }

  // ---------- 8. organisational performance ----------
  function people(){
    var o = data.org, tr = o.trend;
    var max = Math.max.apply(null, tr.map(function(t){ return t.staff; }).concat([1]));
    var W = 640, H = 120, B = 22, bw = (W - 20) / Math.max(1, tr.length);
    var g = tr.map(function(t, i){ var v = t.staff ? t.present / max : 0, hh = (H - B - 6) * v;
      return svg("g", null, [svg("rect", {x: 10 + i * bw + 2, y: H - B - hh, width: bw - 4, height: hh, rx: hh ? 3 : 0, class: "ex-bar s1"}, [svg("title", {}, [document.createTextNode(day(t.date) + ": " + t.present + " of " + t.staff)])]),
        svg("text", {x: 10 + i * bw + bw / 2, y: H - 6, "text-anchor": "middle", class: "ex-axis"}, [document.createTextNode(String(+t.date.slice(8)))])]); });
    var avg = tr.length ? Math.round(100 * tr.reduce(function(s, t){ return s + (t.staff ? t.present / t.staff : 0); }, 0) / tr.length) : 0;
    var roles = Object.keys(o.by_role || {}).map(function(r){ return r + " " + o.by_role[r]; }).join(" · ");
    return card("exPeople", "Organisation", "Attendance over the last 14 working days, the team, and the work in hand.",
      h("div", {class: "ex-stack"}, [h("div", {class: "kpis ex-kpis"}, [stat("Attendance, 14 working days", avg + "%", "Average share of staff who clocked in"),
          stat("People", String(o.people), roles), stat("Projects finished, 30 days", String(o.projects.completed_30d), o.projects.late_target ? o.projects.late_target + " open past their handover target" : "None past their handover target", o.projects.late_target ? "warn" : "")]),
        tr.some(function(t){ return t.present; }) ? h("div", {class: "ex-plot"}, svg("svg", {viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Staff who clocked in, each of the last 14 working days"}, g))
          : h("p", {class: "muted small", text: "Nobody clocked in on any of the last 14 working days, so there's no trend to draw yet."}),
        h("details", {class: "ex-table"}, [h("summary", {text: "See the numbers"}), h("div", {class: "acct-scroll"}, h("table", {class: "acct-table"}, [h("tbody", null, tr.map(function(t){ return h("tr", null, [h("td", {text: day(t.date)}), h("td", {class: "num", text: t.present + " of " + t.staff})]); }))]))])]));
  }

  // ---------- 9. risks ----------
  function risks(){
    var list = data.risks;
    return card("exRisks", "Risks and alerts", "Each one is a rule on real records: it says what it found and why it matters. Ranked by severity.",
      list.length ? h("div", {class: "ex-risks"}, SEV.map(function(s){
        var l = list.filter(function(r){ return r.severity === s[0]; }); if(!l.length) return null;
        return h("div", {class: "ex-sev ex-sev-" + s[0]}, [h("h3", null, [h("span", {class: "ex-sev-badge " + s[0], text: s[1]}), " " + l.length]),
          h("ul", null, l.map(function(r){ return h("li", null, h("details", null, [h("summary", null, [h("span", {class: "muted small", text: r.area + " · "}), r.title]),
            h("p", {class: "small", text: r.why}), h("a", {class: "small", href: link(r.link), text: "Open " + r.link.charAt(0).toUpperCase() + r.link.slice(1)})])); }))]);
      })) : h("p", {class: "muted", text: "No risks found in the records right now."}));
  }

  // ---------- 10. AI (not on yet) ----------
  function ai(){
    return card("exAI", "Executive intelligence (AI)", null, h("div", {class: "ex-stack"}, [
      h("p", {class: "small", text: "Not switched on. It needs your decision on the AI provider and its key (decision 5). When it's on, it will read the same records as this page and write recommendations that keep facts, calculated figures, forecasts and its own interpretation apart, link to the records, and never change anything."}),
      h("p", {class: "muted small", text: "Until then, the risk list above is the analysis: every line in it comes from a record you can open."})]));
  }

  function headline(){
    var r = data.risks, crit = r.filter(function(x){ return x.severity === "critical"; }).length, high = r.filter(function(x){ return x.severity === "high"; }).length;
    var parts = [crit ? plural(crit, "critical risk", "critical risks") : high ? plural(high, "high risk", "high risks") : "No critical risks",
      peso(data.finance.actual.cash) + " cash in the books", "pay day " + day(data.payroll.period.release)];
    var t = document.getElementById("dashTitle"); if(t) t.textContent = parts.join(" · ");
    var s = document.querySelector("#dashboardScreen .hero .sub"); if(s) s.textContent = "Monitoring only: everything here is read from the records; act in each workspace.";
  }

  function render(){
    root.textContent = "";
    [overview(), finance(), cashflow(), payroll(), calendar(), gantt(), timeline(), people(), risks(), ai()].forEach(function(x){ root.appendChild(x); });
    headline(); root.hidden = false; loadCal();
  }

  window.RitehomeExec = {
    load: function(c){
      client = c; root = document.getElementById("execDash");
      if(!root) return Promise.resolve(false);
      return client.rpc("executive_overview").then(function(r){
        if(r.error || !r.data) return false;
        data = r.data;
        return client.rpc("compliance_list", {p_from: addDays(data.today, -400), p_to: addDays(data.today, 60)}).then(function(c){
          data.compliance = c.error || !c.data ? null : c.data.items; mergeComplianceRisks();
        }, function(){ data.compliance = null; }).then(function(){ return client.rpc("schedule_board"); }).then(function(b){ board = b.error ? null : b.data; render(); return true; }, function(){ board = null; render(); return true; });
      }, function(){ return false; });
    }
  };
})();
