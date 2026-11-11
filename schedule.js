/* Schedule: pipeline board, timeline (Gantt) and calendar. Reads and writes only through the
   Supabase functions in supabase/migrations/20261113000008_schedule.sql; dates, forecasts and the
   workshop load come from schedule-plan.js. Admins see and plan every project; staff see the
   projects they're assigned to and move their own stages. Row-level security enforces both. */
(function(){
  'use strict';
  var SUPABASE_URL = "https://laxavfldivkhufeubgmb.supabase.co";
  var SUPABASE_KEY = "sb_publishable_8vOuny8cDkb-vtwyOP7vnA_VqFYc5T1";
  var S = window.RitehomeSchedule;
  // Statuses in the office whiteboard's own words, per stage where the board uses its own.
  var STATUS = [["not_started", "Not started"], ["in_progress", "In progress"], ["waiting_client", "Waiting on client"],
    ["submitted", "Submitted"], ["blocked", "On hold"], ["done", "Completed"]];
  var STAGE_WORDS = {
    design: {in_progress: "Designing", waiting_client: "No feedback yet", submitted: "For approval", done: "Approved"},
    cutlist: {submitted: "For review"},
    bom: {submitted: "Submitted", done: "Approved"},
    final_cutlist: {submitted: "For review", done: "Printed, approved"},
    procurement: {in_progress: "Buying", done: "Materials complete"},
    fabrication: {in_progress: "On going"},
    installation: {in_progress: "On going", done: "Installed"},
    handover: {done: "Handed over"}
  };
  function statusWord(stage, st){ return (STAGE_WORDS[stage] || {})[st] || label(STATUS, st || "not_started"); }
  function statusList(stage){ return STATUS.map(function(x){ return [x[0], statusWord(stage, x[0])]; }); }
  // The marker colours on the board: green finished, red moving, blue waiting for approval, black stuck.
  var INK = {done: "ink-done", in_progress: "ink-moving", submitted: "ink-review", waiting_client: "ink-stuck", blocked: "ink-stuck", not_started: "ink-none"};
  var KINDS = [["site_visit", "Site visit"], ["delivery", "Delivery"], ["installation", "Installation"], ["meeting", "Meeting"], ["holiday", "Holiday (no work)"], ["other", "Other"]];
  var KIND_COLOR = {site_visit: "var(--st-design)", delivery: "var(--st-procurement)", installation: "var(--st-installation)", meeting: "var(--st-cutlist)", holiday: "var(--warn)", other: "var(--st-consultation)"};
  var SYSTEM = {kitchen: "Kitchen", storage: "Storage", partition: "Partition", workspace: "Workspace"};
  var ROLE = {admin: "Admin", designer: "Designer", fabrication: "Workshop", installer: "Installer"};
  function label(list, v){ var f = list.filter(function(x){ return x[0] === v; })[0]; return f ? f[1] : v; }
  function stageLabel(k){ return S.STAGES[S.INDEX[k]].label; }

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: false}});
  var state = {board: null, cal: {events: [], leads: []}, holidays: new Set(), tab: "board", open: null, plan: null,
    month: null, day: null, showDone: false, span: 13, cap: 2, editEvent: null};

  // ---------- helpers ----------
  function $(id){ return document.getElementById(id); }
  function h(tag, attrs, kids){
    var e = document.createElement(tag);
    if(attrs) Object.keys(attrs).forEach(function(k){
      var v = attrs[k];
      if(v == null || v === false) return;
      if(k === "text") e.textContent = v;
      else if(k === "class") e.className = v;
      else if(k === "style") e.style.cssText = v;
      else if(k.slice(0, 2) === "on") e.addEventListener(k.slice(2), v);
      else if(k === "value") e.value = v;
      else e.setAttribute(k, v === true ? "" : v);
    });
    (function add(c){
      if(c == null || c === false) return;
      if(Array.isArray(c)){ c.forEach(add); return; }
      e.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
    })(kids);
    return e;
  }
  function put(id, node){ var el = $(id); el.textContent = ""; if(node) el.appendChild(node); }
  function rpc(name, args){
    return client.rpc(name, args || {}).then(function(r){ if(r.error) throw new Error(r.error.message || "The request failed."); return r.data; });
  }
  function msg(text, bad){
    var m = $("acctMsg"); m.textContent = text; m.hidden = !text; m.classList.toggle("bad", !!bad);
    clearTimeout(msg.t); if(text && !bad) msg.t = setTimeout(function(){ m.hidden = true; }, 4000);
  }
  function fail(e){ msg(e && e.message ? e.message : String(e), true); }
  function options(sel, list, value){ sel.textContent = ""; list.forEach(function(o){ sel.appendChild(h("option", {value: o[0], text: o[1]})); }); sel.value = value == null ? "" : value; return sel; }
  function store(k, v){ try { if(v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch(e){ return null; } }
  function keep(k, v){ try { if(v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch(e){ return null; } }
  function today(){ return state.board ? state.board.today : S.manilaDate(new Date().toISOString()); }
  function fmt(d, year){
    if(!d) return "—";
    var x = new Date(String(d).slice(0, 10) + "T00:00:00Z");
    return x.toLocaleDateString("en-PH", {weekday: "short", day: "numeric", month: "short", year: year ? "numeric" : undefined, timeZone: "UTC"});
  }
  function short(d){ return d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-PH", {day: "numeric", month: "short", timeZone: "UTC"}) : "—"; }
  function time(ts){ return new Date(ts).toLocaleTimeString("en-PH", {hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila"}); }
  function isAdmin(){ return state.board && state.board.role === "admin"; }
  function staffName(id){ var s = (state.board.staff || []).filter(function(x){ return x.id === id; })[0]; return s ? s.full_name || ROLE[s.role] : ""; }
  function project(id){ return (state.board.projects || []).filter(function(p){ return p.id === id; })[0]; }
  function stageOf(p, k){ return (p.stages || []).filter(function(s){ return s.stage === k; })[0]; }
  function health(p){ return S.status(p, today(), state.holidays); }
  function pill(st){
    var hold = st.hold && st.current ? statusWord(st.current, st.hold) : "";
    return h("span", {style: "display:inline-flex;gap:4px;flex-wrap:wrap"}, [h("span", {class: "pill " + (st.severity || ""), text: st.label}),
      hold ? h("span", {class: "pill " + (st.hold === "submitted" ? "" : "warn"), text: hold}) : null]);
  }
  function stDot(k){ return h("span", {class: "dot", style: "background:var(--st-" + k + ")"}); }
  function visibleProjects(){ return (state.board.projects || []).filter(function(p){ return state.showDone || p.status !== "completed"; }); }

  // ---------- loading ----------
  function range(){
    // Everything any view needs at once: the calendar month, the timeline, and a year ahead for holidays.
    var t = today(), m = monthParts(), grid = S.monthGrid(m[0], m[1]);
    var from = [grid[0][0], S.addDays(S.mondayOf(t), -7)].sort()[0];
    var to = [grid[grid.length - 1][6], S.addDays(t, 370)].sort().pop();
    return [from, to];
  }
  function monthParts(){ var m = state.month || today().slice(0, 7); return [Number(m.slice(0, 4)), Number(m.slice(5, 7))]; }
  function load(){
    return rpc("schedule_board").then(function(b){
      state.board = b;
      var r = range();
      return rpc("schedule_events", {p_from: r[0], p_to: r[1]});
    }).then(function(c){
      state.cal = c || {events: [], leads: []};
      state.holidays = S.holidaysFrom(state.cal.events);
      render();
    });
  }

  // ---------- page ----------
  function render(){
    $("addEventBtn").hidden = !isAdmin();
    $("capLabel").hidden = !isAdmin();
    $("schedSub").textContent = isAdmin()
      ? "Every project from consultation to handover: who has it, what's due, and whether the handover date still holds."
      : "Your projects and the stages you're responsible for. Tap a status as the work moves; the dates fill themselves in.";
    renderKpis();
    renderTabs();
    renderProject();
    renderEventForm();
    if(state.tab === "board") renderBoard();
    if(state.tab === "pipeline") renderPipeline();
    if(state.tab === "timeline") renderTimeline();
    if(state.tab === "calendar") renderCalendar();
  }

  function renderKpis(){
    var t = today(), week = S.addDays(t, 6), active = (state.board.projects || []).filter(function(p){ return p.status !== "completed"; });
    var hs = active.map(function(p){ return {p: p, s: health(p)}; });
    var dueWeek = 0, overdue = 0;
    active.forEach(function(p){ (p.stages || []).forEach(function(s){
      if(s.status === "done" || !s.planned_end) return;
      if(!isAdmin() && !s.can_edit) return;
      if(s.planned_end < t) overdue++; else if(s.planned_end <= week) dueWeek++;
    }); });
    var k;
    if(isAdmin()){
      var risky = hs.filter(function(x){ return x.s.severity === "warn" || x.s.severity === "bad"; }).length;
      var handovers = hs.filter(function(x){ return x.s.forecast && x.s.forecast >= t && x.s.forecast <= S.addDays(t, 30); }).length;
      var ld = S.load(active, t, 8, t), peak = ld.reduce(function(m, w){ return w.count > m.count ? w : m; }, {count: 0});
      k = [
        ["Active projects", String(active.length), active.filter(function(p){ return !health(p).planned; }).length + " not planned yet"],
        ["Late or at risk", String(risky), risky ? "Open them from the pipeline" : "Every planned handover holds", risky > 0],
        ["Stages due this week", String(dueWeek), overdue ? overdue + " overdue" : "None overdue", overdue > 0],
        ["Handovers in 30 days", String(handovers), "By forecast"],
        ["Workshop peak, 8 weeks", peak.count ? peak.count + " of " + state.cap : "0", peak.count ? "Week of " + short(peak.week) : "Nothing in fabrication", peak.count > state.cap]
      ];
    } else {
      var mine = 0;
      active.forEach(function(p){ (p.stages || []).forEach(function(s){ if(s.can_edit && s.status !== "done") mine++; }); });
      k = [["Your projects", String(active.length), "Assigned to you"], ["Your open stages", String(mine), "Not done yet"],
        ["Due this week", String(dueWeek), "Your stages"], ["Overdue", String(overdue), overdue ? "Past the planned finish" : "Nothing overdue", overdue > 0]];
    }
    put("schedKpis", h("div", {style: "display:contents"}, k.map(function(x){
      return h("div", {class: "kpi"}, [h("span", {class: "label", text: x[0]}), h("span", {class: "val" + (x[3] ? " neg" : ""), text: x[1]}), h("span", {class: "sub", text: x[2]})]);
    })));
  }

  function renderTabs(){
    document.querySelectorAll("[data-stab]").forEach(function(b){
      if(b.getAttribute("data-stab") === state.tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    document.querySelectorAll("[data-view]").forEach(function(s){ s.hidden = s.getAttribute("data-view") !== state.tab; });
  }
  function setTab(t){ state.tab = t; store("ritehome_stab", t); render(); }

  // ---------- whiteboard ----------
  // The office whiteboard, row for row: client, project type, person in charge, then a status per stage
  // in the board's own words and marker colours. Tap a cell to change it (your own stages only).
  var BOARD_STAGES = ["design", "cutlist", "bom", "final_cutlist", "fabrication", "installation"];
  function people(){
    var seen = {}, out = [];
    (state.board.projects || []).forEach(function(p){ var n = (p.in_charge || "").trim(); if(n && !seen[n.toLowerCase()]){ seen[n.toLowerCase()] = 1; out.push(n); } });
    return out.sort();
  }
  function types(){
    var seen = {}, out = [];
    (state.board.projects || []).forEach(function(p){ var n = (p.type || "").trim(); if(n && !seen[n.toLowerCase()]){ seen[n.toLowerCase()] = 1; out.push(n); } });
    return out.sort();
  }
  function datalist(id, list){ return h("datalist", {id: id}, list.map(function(x){ return h("option", {value: x}); })); }
  function boardCell(p, key){
    var s = stageOf(p, key);
    if(!s) return h("td");
    var cls = "wb-cell " + INK[s.status || "not_started"];
    var note = s.notes ? h("small", {class: "wb-note", text: s.notes}) : null;
    if(!s.can_edit) return h("td", null, [h("span", {class: cls, text: s.status === "not_started" ? "" : statusWord(key, s.status)}), note]);
    var sel = options(h("select", {class: cls, "aria-label": (p.client || p.name) + " " + stageLabel(key)}),
      statusList(key).map(function(o){ return o[0] === "not_started" ? ["not_started", "—"] : o; }), s.status);
    sel.addEventListener("change", function(){
      sel.className = "wb-cell " + INK[sel.value];   // the marker colour changes at once
      sel.disabled = true;
      rpc("stage_save", {p_project: p.id, p_stage: key, p: {status: sel.value}})
        .then(function(){ msg((p.client || p.name) + ": " + stageLabel(key).toLowerCase() + " " + statusWord(key, sel.value).toLowerCase() + "."); return load(); })
        .catch(function(e){ sel.disabled = false; fail(e); });
    });
    return h("td", null, [sel, note]);
  }
  function renderBoard(){
    var list = visibleProjects().slice().sort(function(a, b){
      return String(a.created || "").localeCompare(String(b.created || "")) || String(a.name).localeCompare(String(b.name));
    });
    $("boardCount").textContent = String(list.length);
    var head = h("tr", null, [h("th", {class: "wb-n", text: "#"}), h("th", {class: "wb-client", text: "Client's name"}), h("th", {text: "Project type"}), h("th", {text: "In charge"})]
      .concat(BOARD_STAGES.map(function(k){ return h("th", null, [stDot(k), " ", stageLabel(k)]); })));
    var rows = list.map(function(p, i){
      return h("tr", {"data-project": p.id}, [
        h("td", {class: "wb-n", text: String(i + 1)}),
        h("td", {class: "wb-client"}, h("button", {type: "button", class: "wb-name", onclick: function(){ openProject(p.id); }, text: p.client || p.name || "Untitled"})),
        h("td", {class: "wb-type", text: p.type || SYSTEM[p.system] || ""}),
        h("td", {class: "wb-person", text: p.in_charge || ""})
      ].concat(BOARD_STAGES.map(function(k){ return boardCell(p, k); })));
    });
    var foot = null;
    if(isAdmin()){
      var c = h("input", {type: "text", maxlength: "120", placeholder: "Client's name", "aria-label": "New row client's name"});
      var t = h("input", {type: "text", maxlength: "80", placeholder: "Project type", list: "wbTypes", "aria-label": "New row project type"});
      var who = h("input", {type: "text", maxlength: "80", placeholder: "In charge", list: "wbPeople", "aria-label": "New row in charge"});
      var add = h("button", {class: "btn small", type: "button", text: "Add row"});
      add.addEventListener("click", function(){
        if(!c.value.trim()) return fail(new Error("Write the client's name."));
        add.disabled = true;
        rpc("board_project_save", {p: {clientName: c.value.trim(), projectType: t.value.trim(), inCharge: who.value.trim()}})
          .then(function(){ msg("Row added for " + c.value.trim() + "."); return load(); })
          .catch(function(e){ add.disabled = false; fail(e); });
      });
      foot = h("tfoot", null, h("tr", {class: "wb-add no-print"}, [h("td", {class: "wb-n", text: String(list.length + 1)}), h("td", {class: "wb-client"}, c), h("td", null, t), h("td", null, who),
        h("td", {colspan: String(BOARD_STAGES.length)}, [add, h("span", {class: "muted small", style: "margin-left:10px", text: "Every stage starts empty; tap a cell to set it."})])]));
    }
    put("boardTable", h("div", {class: "wb-scroll"}, [
      h("table", {class: "wb"}, [h("thead", null, head), h("tbody", null, rows.length ? rows : h("tr", null, h("td", {colspan: String(4 + BOARD_STAGES.length), class: "muted", text: isAdmin() ? "No rows yet. Add the first one below." : "No projects are assigned to you yet."}))), foot]),
      datalist("wbPeople", people()), datalist("wbTypes", types())
    ]));
  }

  // ---------- pipeline ----------
  function renderPipeline(){
    var list = visibleProjects();
    $("pipeCount").textContent = String(list.length);
    if(!list.length){
      put("pipeBoard", h("p", {class: "muted", text: isAdmin()
        ? "No projects yet. A lead marked Won on the lead scoreboard, or a project added in Projects, shows up here with all eight stages."
        : "No projects are assigned to you yet. The admin assigns you to a stage; the project then appears here."}));
      return;
    }
    var cols = S.STAGES.map(function(d){ return {d: d, items: []}; }), finished = [];
    list.forEach(function(p){
      var st = health(p);
      if(!st.current){ finished.push({p: p, s: st}); return; }
      cols[S.INDEX[st.current]].items.push({p: p, s: st});
    });
    var board = h("div", {class: "pipe"}, cols.map(function(c){
      return h("div", {class: "pipe-col"}, [
        h("h3", null, [stDot(c.d.key), c.d.label, h("span", {class: "count", text: String(c.items.length)})]),
        h("div", {class: "owner", text: c.d.owner}),
        c.items.length ? c.items.map(function(x){ return projectCard(x.p, x.s); }) : h("span", {class: "pipe-empty", text: "—"})
      ]);
    }).concat(state.showDone ? [h("div", {class: "pipe-col"}, [h("h3", null, ["Finished", h("span", {class: "count", text: String(finished.length)})]),
      finished.map(function(x){ return projectCard(x.p, x.s); })])] : []));
    put("pipeBoard", board);
  }
  function projectCard(p, st){
    var cur = st.current && stageOf(p, st.current), due = cur && cur.planned_end, who = cur && cur.assignee && staffName(cur.assignee);
    return h("button", {type: "button", class: "pcard sev-" + (st.severity || "muted"), "data-project": p.id, onclick: function(){ openProject(p.id); }}, [
      h("strong", {text: p.name || "Untitled project"}),
      h("span", {class: "meta", text: [p.client, SYSTEM[p.system]].filter(Boolean).join(" · ")}),
      due ? h("span", {class: "meta" + (due < today() && cur.status !== "done" ? " late" : ""), text: (cur.status === "blocked" ? "Blocked · " : "") + "Due " + fmt(due)}) : null,
      who ? h("span", {class: "meta", text: who}) : null,
      pill(st)
    ]);
  }

  // ---------- one project ----------
  function openProject(id){
    if(location.hash !== "#project=" + id) location.hash = "project=" + id;
    else { state.open = id; render(); }
  }
  function openFromHash(){
    var m = /project=([^&]+)/.exec(location.hash);
    state.open = m ? decodeURIComponent(m[1]) : null; state.plan = null;
    render();
    if(state.open && project(state.open)) $("projCard").scrollIntoView({block: "start", behavior: "smooth"});
  }
  function renderProject(){
    var p = state.open && project(state.open), card = $("projCard");
    card.hidden = !p;
    if(!p){ card.textContent = ""; return; }
    var st = health(p), t = today();
    var forecast = st.done ? (st.forecast ? "Handed over " + fmt(st.forecast, true) + "." : "Finished.")
      : "Forecast handover " + fmt(st.forecast, true) + (st.reference ? " · " + (p.target ? "client target " : "planned ") + fmt(st.reference, true) : "") + "."
        + (st.overdue.length ? " Overdue: " + st.overdue.map(stageLabel).join(", ") + "." : "");
    var kids = [
      h("div", {class: "proj-head"}, [
        h("div", null, [h("h2", null, [p.name || "Untitled project", " ", pill(st)]),
          h("div", {class: "facts"}, [[p.client, p.type || SYSTEM[p.system], p.in_charge ? "In charge: " + p.in_charge : "", p.address].filter(Boolean).join(" · "),
            p.phone ? [" · ", h("a", {href: "tel:" + p.phone.replace(/[^\d+]/g, ""), text: p.phone})] : null])]),
        h("div", {class: "acct-actions no-print"}, [
          isAdmin() && !st.done ? h("button", {class: "btn ghost small", type: "button", onclick: function(){ startPlan(p); }, text: st.planned ? "Re-plan dates" : "Plan dates"}) : null,
          isAdmin() && st.planned && (st.overdue.length || (st.slip || 0) > 0) ? h("button", {class: "btn small", type: "button", onclick: function(){ pushRest(p, st); }, text: "Push the rest from today"}) : null,
          h("button", {class: "btn ghost small", type: "button", onclick: function(){ history.replaceState(null, "", location.pathname + location.search); state.open = null; render(); }, text: "Close"})
        ])
      ]),
      h("p", {class: "proj-forecast", text: forecast}),
      state.plan && state.plan.id === p.id ? planner(p) : null,
      isAdmin() ? labelsForm(p) : null,
      stageList(p, st, t)
    ];
    card.textContent = ""; kids.forEach(function(k){ if(k) card.appendChild(k); });
  }

  function labelsForm(p){
    var c = h("input", {type: "text", maxlength: "120", value: p.client || "", "aria-label": "Client's name"});
    var t = h("input", {type: "text", maxlength: "80", value: p.type || "", list: "pcTypes", "aria-label": "Project type"});
    var who = h("input", {type: "text", maxlength: "80", value: p.in_charge || "", list: "pcPeople", "aria-label": "In charge"});
    var target = h("input", {type: "date", value: p.target || "", "aria-label": "Client's target date"});
    var save = h("button", {class: "btn ghost small", type: "button", disabled: true, text: "Save"});
    [c, t, who, target].forEach(function(i){ i.addEventListener("input", function(){ save.disabled = false; }); });
    save.addEventListener("click", function(){
      save.disabled = true;
      rpc("board_project_save", {p: {id: p.id, clientName: c.value.trim(), projectType: t.value.trim(), inCharge: who.value.trim(), targetDate: target.value}})
        .then(function(){ msg("Saved."); return load(); }).catch(function(e){ save.disabled = false; fail(e); });
    });
    return h("div", {class: "acct-grid labels no-print"}, [h("label", null, ["Client's name", c]), h("label", null, ["Project type", t]),
      h("label", null, ["In charge", who]), h("label", null, ["Client's target", target]), h("div", {class: "acct-actions", style: "align-self:end;margin:0"}, save),
      datalist("pcPeople", people()), datalist("pcTypes", types())]);
  }
  function stageList(p, st, t){
    var head = h("div", {class: "stage-row head"}, ["Stage", "Status", "Planned start", "Planned finish", "Started", "Finished", "Assigned", ""].map(function(x){ return h("span", {text: x}); }));
    return h("div", {class: "stage-list"}, [head].concat(S.STAGES.map(function(d){ return stageRow(p, stageOf(p, d.key) || {stage: d.key}, d, t); })));
  }
  function stageRow(p, s, d, t){
    var admin = isAdmin(), edit = !!s.can_edit;
    var overdue = s.status !== "done" && s.planned_end && s.planned_end < t;
    function field(lbl, node){ return h("label", null, [h("span", {class: "lbl", text: lbl}), node]); }
    function date(key, can){ return can ? h("input", {type: "date", value: s[key] || "", "data-k": key, "aria-label": d.label + " " + key.replace("_", " ")}) : h("span", {class: "ro", text: s[key] ? fmt(s[key]) : "—"}); }
    var status = edit ? options(h("select", {"data-k": "status", "aria-label": d.label + " status"}), statusList(d.key), s.status) : h("span", {class: "ro", text: statusWord(d.key, s.status)});
    var who;
    if(admin){
      who = options(h("select", {"data-k": "assignee", "aria-label": d.label + " assigned to"}),
        [["", "Nobody"]].concat((state.board.staff || []).map(function(x){ return [x.id, (x.full_name || "Unnamed") + " · " + ROLE[x.role]]; })), s.assignee || "");
    } else who = h("span", {class: "ro", text: s.assignee ? staffName(s.assignee) || "Someone" : "—"});
    var notes = edit ? h("input", {type: "text", maxlength: "4000", value: s.notes || "", "data-k": "notes", placeholder: "Notes", "aria-label": d.label + " notes"}) : (s.notes ? h("span", {class: "ro muted", text: s.notes}) : null);
    var save = edit ? h("button", {class: "btn small save", type: "button", disabled: true, text: "Save"}) : h("span");
    var row = h("div", {class: "stage-row" + (edit ? "" : " locked") + (overdue ? " overdue" : ""), "data-stage": d.key}, [
      h("div", {class: "name"}, [h("b", null, [stDot(d.key), d.label]), h("small", {text: d.owner + (overdue ? " · overdue" : "")})]),
      field("Status", status), field("Planned start", date("planned_start", admin)), field("Planned finish", date("planned_end", admin)),
      field("Started", date("actual_start", edit)), field("Finished", date("actual_end", edit)), field("Assigned", who), save,
      notes ? h("div", {class: "notes"}, notes) : null
    ]);
    if(edit){
      var changed = function(){ save.disabled = false; };
      row.querySelectorAll("[data-k]").forEach(function(i){ i.addEventListener(i.tagName === "SELECT" ? "change" : "input", changed); });
      save.addEventListener("click", function(){
        var body = {};
        row.querySelectorAll("[data-k]").forEach(function(i){ body[i.getAttribute("data-k")] = i.value; });
        save.disabled = true;
        rpc("stage_save", {p_project: p.id, p_stage: d.key, p: body}).then(function(){ msg(d.label + " saved."); return load(); }).catch(function(e){ save.disabled = false; fail(e); });
      });
    }
    return row;
  }

  // Admin: plan every stage back to back from a start date, previewed before anything is saved.
  function startPlan(p){
    var st = health(p);
    state.plan = {id: p.id, from: st.current || "consultation", start: S.nextWorkday(today(), state.holidays)};
    render();
  }
  function planner(p){
    var pl = state.plan, rows = S.plan(pl.start, state.holidays, {from: pl.from});
    var from = options(h("select", {"aria-label": "Plan from stage"}), S.STAGES.map(function(d){ return [d.key, d.label]; }), pl.from);
    var start = h("input", {type: "date", value: pl.start, "aria-label": "Plan start date"});
    from.addEventListener("change", function(){ pl.from = from.value; render(); });
    start.addEventListener("change", function(){ if(start.value){ pl.start = start.value; render(); } });
    var last = rows[rows.length - 1];
    return h("div", {class: "planner"}, [
      h("h3", {text: "Plan dates"}),
      h("p", {class: "muted small", text: "Each stage starts the working day after the one before (Monday to Saturday, skipping holidays on the calendar), using the standard durations. Adjust any single date afterwards in the rows below."}),
      h("div", {class: "acct-grid"}, [h("label", null, ["Start with", from]), h("label", null, ["On", start])]),
      h("table", null, h("tbody", null, rows.map(function(r){
        var n = S.workdaysBetween(r.planned_start, r.planned_end, state.holidays);
        return h("tr", null, [h("td", null, [stDot(r.stage), " ", stageLabel(r.stage)]), h("td", {text: fmt(r.planned_start)}), h("td", {text: fmt(r.planned_end)}), h("td", {class: "muted", text: n + (n === 1 ? " day" : " days")})]);
      }))),
      h("p", {class: "small", style: "margin-top:10px", text: "Handover " + fmt(last.planned_end, true) + (p.target ? (last.planned_end > p.target ? ", " + S.diffDays(p.target, last.planned_end) + " days after the client's target." : ", within the client's target.") : ".")}),
      h("div", {class: "acct-actions"}, [
        h("button", {class: "btn", type: "button", onclick: function(){
          rpc("stage_plan", {p_project: p.id, p_rows: rows}).then(function(){ state.plan = null; msg("Planned " + rows.length + " stages."); return load(); }).catch(fail);
        }, text: "Save this plan"}),
        h("button", {class: "btn ghost", type: "button", onclick: function(){ state.plan = null; render(); }, text: "Cancel"})
      ])
    ]);
  }
  function pushRest(p, st){
    var start = S.nextWorkday(S.addDays(today(), 1), state.holidays), cur = stageOf(p, st.current);
    // The stage that's running now keeps its start and finishes no earlier than today.
    var rows = [];
    if(cur && cur.status !== "not_started"){
      rows.push({stage: cur.stage, planned_start: cur.planned_start || cur.actual_start || today(), planned_end: S.nextWorkday(today(), state.holidays)});
      var next = S.STAGES[S.INDEX[cur.stage] + 1];
      if(next) rows = rows.concat(S.pushRest(p.stages, next.key, start, state.holidays));
    } else rows = S.pushRest(p.stages, st.current, S.nextWorkday(today(), state.holidays), state.holidays);
    var last = rows[rows.length - 1];
    if(!confirm("Move " + rows.length + " unfinished stages so the work continues from today? Handover becomes " + fmt(last.planned_end, true) + ".")) return;
    rpc("stage_plan", {p_project: p.id, p_rows: rows}).then(function(){ msg("Re-planned from today."); return load(); }).catch(fail);
  }

  // ---------- timeline ----------
  function renderTimeline(){
    var t = today(), first = S.addDays(S.mondayOf(t), -7), weeks = state.span, last = S.addDays(first, weeks * 7 - 1), days = weeks * 7;
    var pos = function(d){ return Math.max(0, Math.min(100, S.diffDays(first, d) / days * 100)); };
    var weekCols = "repeat(" + weeks + ",minmax(0,1fr))";
    function weeksBg(withText){ return h("div", {class: "g-weeks", style: "grid-template-columns:" + weekCols}, Array.from({length: weeks}, function(_, i){ return h("span", {text: withText ? short(S.addDays(first, i * 7)) : ""}); })); }
    var hol = Array.from(state.holidays).filter(function(d){ return d >= first && d <= last; });
    function holidayBands(){ return hol.map(function(d){ return h("div", {class: "g-holiday", style: "left:" + pos(d) + "%;width:" + (100 / days) + "%", title: "Holiday"}); }); }
    var list = visibleProjects();
    var rows = list.map(function(p){
      var st = health(p), bars = [];
      S.STAGES.forEach(function(d){
        var s = stageOf(p, d.key), w = S.stageWindow(s, t);
        if(!w || w.end < first || w.start > last) return;
        var l = pos(w.start), r = pos(S.addDays(w.end, 1));
        bars.push(h("div", {class: "g-bar " + (s.status || ""), style: "left:" + l + "%;width:" + Math.max(0.3, r - l) + "%;background-color:var(--st-" + d.key + ")",
          title: d.label + " · " + short(w.start) + "–" + short(w.end) + " · " + statusWord(d.key, s.status)}));
      });
      var track = [weeksBg(false)].concat(holidayBands(), bars);
      if(!bars.length) track.push(h("span", {class: "g-none", text: st.planned ? "Outside this range" : "Not planned yet"}));
      if(p.target && p.target >= first && p.target <= last) track.push(h("div", {class: "g-target", style: "left:" + (pos(p.target) + 100 / days / 2) + "%", title: "Client target " + fmt(p.target, true)}));
      track.push(h("div", {class: "g-today", style: "left:" + (pos(t) + 100 / days / 2) + "%", title: "Today"}));
      return h("div", {class: "g-row"}, [
        h("div", {class: "g-label"}, [h("button", {type: "button", onclick: function(){ openProject(p.id); }, text: p.name || "Untitled project"}), h("span", null, pill(st))]),
        h("div", {class: "g-track"}, track)]);
    });
    var load_ = S.load(list, first, weeks, t);
    var loadRow = h("div", {class: "g-row g-load"}, [
      h("div", {class: "g-label"}, [h("strong", {text: "Workshop load"}), h("span", {class: "muted", style: "font-size:11.5px", text: "Jobs in fabrication · capacity " + state.cap})]),
      h("div", {class: "g-track", style: "grid-template-columns:" + weekCols}, load_.map(function(w){
        var cls = !w.count ? "" : w.count > state.cap ? "bad" : w.count === state.cap ? "warn" : "good";
        return h("div", {class: "cell " + cls, title: w.names.join(", ") || "Nothing in fabrication", text: String(w.count)});
      }))]);
    var head = h("div", {class: "g-row head"}, [h("div", {class: "g-label", text: "Week of"}), h("div", {class: "g-track", style: "min-height:30px"}, weeksBg(true))]);
    put("gantt", h("div", {class: "gantt"}, h("div", {class: "gantt-inner"}, [head].concat(rows.length ? rows : [h("p", {class: "muted", style: "padding:14px 0", text: "No projects to show."})], [loadRow]))));
    put("ganttLegend", h("div", {style: "display:contents"}, S.STAGES.map(function(d){ return h("span", null, [stDot(d.key), d.label]); }).concat([
      h("span", null, [h("span", {class: "dot", style: "background:var(--bad);width:2px;height:12px"}), "Today"]),
      h("span", null, [h("span", {class: "dot", style: "background:var(--ink);transform:rotate(45deg)"}), "Client target"]),
      h("span", {text: "Faint: planned · striped: in progress · solid: done"})])));
  }

  // ---------- calendar ----------
  function itemsByDay(){
    var map = {}, t = today();
    function add(d, it){ (map[d] = map[d] || []).push(it); }
    (state.cal.events || []).forEach(function(e){
      var a = S.manilaDate(e.starts_at), b = S.manilaDate(e.ends_at || e.starts_at);
      for(var d = a; d <= b; d = S.addDays(d, 1)) add(d, {type: "event", e: e, color: KIND_COLOR[e.kind], text: e.title, sort: e.kind === "holiday" ? "0" : "1" + e.starts_at});
    });
    (state.board.projects || []).forEach(function(p){
      if(p.status === "completed") return;
      (p.stages || []).forEach(function(s){
        if(s.status === "done" || !s.planned_end) return;
        add(s.planned_end, {type: "due", p: p, s: s, color: "var(--st-" + s.stage + ")", late: s.planned_end < t, text: stageLabel(s.stage) + " due · " + p.name, sort: "2"});
      });
      if(p.target) add(p.target, {type: "target", p: p, color: "var(--ink)", text: "Target handover · " + p.name, sort: "3"});
    });
    (state.cal.leads || []).forEach(function(l){
      add(l.date, {type: "lead", l: l, color: "var(--accent)", text: (l.kind === "visit_request" ? "Visit request · " : "Follow up · ") + l.name, sort: "4"});
    });
    Object.keys(map).forEach(function(d){ map[d].sort(function(a, b){ return a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0; }); });
    return map;
  }
  function renderCalendar(){
    var m = monthParts(), grid = S.monthGrid(m[0], m[1]), t = today(), key = m[0] + "-" + String(m[1]).padStart(2, "0"), map = itemsByDay();
    $("calTitle").textContent = new Date(key + "-01T00:00:00Z").toLocaleDateString("en-PH", {month: "long", year: "numeric", timeZone: "UTC"});
    var cells = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(function(d){ return h("div", {class: "dow", text: d}); });
    grid.forEach(function(w){ w.forEach(function(d){
      var items = map[d] || [], cls = ["cal-cell"];
      if(d.slice(0, 7) !== key) cls.push("out");
      if(S.weekday(d) === 0) cls.push("sun");
      if(state.holidays.has(d)) cls.push("holiday");
      if(d === t) cls.push("today");
      cells.push(h("button", {type: "button", class: cls.join(" "), "data-day": d, "aria-pressed": state.day === d ? "true" : "false",
        "aria-label": fmt(d, true) + (items.length ? ", " + items.length + " item" + (items.length > 1 ? "s" : "") : ""),
        onclick: function(){ state.day = state.day === d ? null : d; renderCalendar(); }}, [
        h("span", {class: "num", text: String(Number(d.slice(8)))}),
        items.slice(0, 3).map(function(it){ return h("span", {class: "cal-item" + (it.type === "lead" ? " lead" : ""), title: it.text}, [h("span", {class: "dot", style: "background:" + it.color}), h("span", {class: "t" + (it.late ? " late" : ""), text: it.text})]); }),
        items.length > 3 ? h("span", {class: "cal-more", text: "+" + (items.length - 3) + " more"}) : null,
        items.length ? h("span", {class: "cal-dots"}, items.slice(0, 6).map(function(it){ return h("span", {class: "dot", style: "background:" + it.color}); })) : null
      ]));
    }); });
    put("calGrid", h("div", {class: "cal"}, cells));
    renderDay(map);
  }
  function renderDay(map){
    var d = state.day;
    if(!d){ put("calDay", null); return; }
    var items = (map || itemsByDay())[d] || [];
    put("calDay", h("div", {class: "day-list"}, [
      h("h3", null, [fmt(d, true), state.holidays.has(d) ? h("span", {class: "pill warn", text: "Holiday"}) : null,
        isAdmin() ? h("button", {class: "btn ghost small no-print", type: "button", onclick: function(){ editEvent({date: d}); }, text: "+ Add event"}) : null]),
      items.length ? items.map(dayItem) : h("p", {class: "muted small", text: "Nothing on this day."})
    ]));
  }
  function dayItem(it){
    var dot = h("span", {class: "dot", style: "background:" + it.color});
    if(it.type === "event"){
      var e = it.e, p = e.project_id && project(e.project_id);
      var allDay = time(e.starts_at) === "12:00 AM" && /11:59/.test(time(e.ends_at));
      return h("div", {class: "day-item"}, [dot, h("div", null, [h("strong", {text: e.title}),
        h("span", {class: "sub", text: [label(KINDS, e.kind), allDay ? "All day" : time(e.starts_at) + (e.ends_at !== e.starts_at ? "–" + time(e.ends_at) : ""), p ? p.name : e.project_id ? "" : "Company-wide", e.notes].filter(Boolean).join(" · ")})]),
        isAdmin() ? h("button", {class: "btn ghost small no-print", type: "button", onclick: function(){ editEvent(e); }, text: "Edit"}) : h("span")]);
    }
    if(it.type === "due") return h("div", {class: "day-item"}, [dot, h("div", null, [h("button", {class: "link", type: "button", onclick: function(){ openProject(it.p.id); }, text: stageLabel(it.s.stage) + " due · " + it.p.name}),
      h("span", {class: "sub" + (it.late ? " late" : ""), text: [statusWord(it.s.stage, it.s.status), it.s.assignee ? staffName(it.s.assignee) : "Nobody assigned", it.late ? "overdue" : ""].filter(Boolean).join(" · ")})]), h("span")]);
    if(it.type === "target") return h("div", {class: "day-item"}, [dot, h("div", null, [h("button", {class: "link", type: "button", onclick: function(){ openProject(it.p.id); }, text: "Client's target handover · " + it.p.name}),
      h("span", {class: "sub", text: "Forecast " + fmt(health(it.p).forecast, true)})]), h("span")]);
    var leadsHref = window.RitehomeLinks ? window.RitehomeLinks.href("leads") : "leads.html";
    return h("div", {class: "day-item"}, [dot, h("div", null, [h("a", {href: leadsHref + "#lead=" + it.l.lead_id, text: (it.l.kind === "visit_request" ? "Requested site visit · " : "Follow up · ") + it.l.name}),
      h("span", {class: "sub", text: it.l.text || "From the lead scoreboard"})]), h("span")]);
  }

  // ---------- events (admin) ----------
  function editEvent(e){ state.editEvent = e; renderEventForm(); $("eventCard").scrollIntoView({block: "start", behavior: "smooth"}); }
  function renderEventForm(){
    var card = $("eventCard"), e = state.editEvent;
    card.hidden = !e || !isAdmin();
    if(card.hidden){ card.textContent = ""; return; }
    var isNew = !e.id, date = e.date || (e.starts_at ? S.manilaDate(e.starts_at) : today());
    var startT = e.starts_at ? hhmm(e.starts_at) : "09:00", endT = e.ends_at ? hhmm(e.ends_at) : "10:00";
    var allDay = e.starts_at ? startT === "00:00" && endT === "23:59" : false;
    var endDate = e.ends_at ? S.manilaDate(e.ends_at) : date;
    var kind = options(h("select", {id: "evKind"}), KINDS, e.kind || "site_visit");
    var proj = options(h("select", {id: "evProject"}), [["", "Company-wide (no project)"]].concat((state.board.projects || []).filter(function(p){ return p.status !== "completed" || p.id === e.project_id; }).map(function(p){ return [p.id, p.name]; })), e.project_id || "");
    var title = h("input", {id: "evTitle", maxlength: "160", required: true, value: e.title || "", placeholder: "e.g. Measure kitchen, deliver carcasses"});
    var d1 = h("input", {id: "evDate", type: "date", value: date, required: true}), d2 = h("input", {id: "evEndDate", type: "date", value: endDate});
    var t1 = h("input", {id: "evStart", type: "time", value: startT}), t2 = h("input", {id: "evEnd", type: "time", value: endT});
    var ad = h("input", {id: "evAllDay", type: "checkbox"}); ad.checked = allDay || e.kind === "holiday";
    var notes = h("input", {id: "evNotes", maxlength: "2000", value: e.notes || ""});
    function sync(){ t1.disabled = t2.disabled = ad.checked; }
    ad.addEventListener("change", sync); sync();
    kind.addEventListener("change", function(){ if(kind.value === "holiday"){ ad.checked = true; proj.value = ""; sync(); } });
    var form = h("form", {class: "acct-grid", novalidate: true}, [
      h("label", null, ["What", kind]), h("label", null, ["Project", proj]), h("label", {class: "wide"}, ["Title", title]),
      h("label", null, ["Date", d1]), h("label", null, ["Until", d2]),
      h("label", {class: "inline"}, [ad, "All day"]), h("label", null, ["From", t1]), h("label", null, ["To", t2]),
      h("label", {class: "wide"}, ["Notes", notes]),
      h("div", {class: "wide acct-actions"}, [
        h("button", {class: "btn", type: "submit", text: isNew ? "Add event" : "Save event"}),
        h("button", {class: "btn ghost", type: "button", onclick: function(){ state.editEvent = null; renderEventForm(); }, text: "Cancel"}),
        isNew ? null : h("button", {class: "btn ghost danger", type: "button", onclick: function(){
          if(!confirm("Delete “" + e.title + "”?")) return;
          rpc("event_delete", {p_id: e.id}).then(function(){ state.editEvent = null; msg("Event deleted."); return load(); }).catch(fail);
        }, text: "Delete"})
      ])
    ]);
    form.addEventListener("submit", function(ev){
      ev.preventDefault();
      if(!title.value.trim()) return fail(new Error("Give the event a title."));
      if(!d1.value) return fail(new Error("Pick a date."));
      var last = d2.value && d2.value >= d1.value ? d2.value : d1.value;
      var body = {id: e.id || "", kind: kind.value, project_id: proj.value, title: title.value.trim(), notes: notes.value.trim(),
        starts_at: d1.value + "T" + (ad.checked ? "00:00" : t1.value || "09:00") + ":00+08:00",
        ends_at: last + "T" + (ad.checked ? "23:59" : t2.value || t1.value || "09:00") + ":00+08:00"};
      if(body.ends_at < body.starts_at) return fail(new Error("The event ends before it starts."));
      rpc("event_save", {p: body}).then(function(){ state.editEvent = null; state.day = d1.value; state.month = d1.value.slice(0, 7); msg(isNew ? "Event added." : "Event saved."); return load(); }).catch(fail);
    });
    card.textContent = "";
    card.appendChild(h("h2", {text: isNew ? "Add an event" : "Edit event"}));
    card.appendChild(h("p", {class: "muted small", text: "Holidays block the planner too: no stage is scheduled on a holiday."}));
    card.appendChild(form);
    title.focus();
  }
  function hhmm(ts){ return new Date(Date.parse(ts) + 8 * 3600000).toISOString().slice(11, 16); }

  // ---------- start ----------
  function gate(title, text, link){
    $("gate").hidden = false; $("app").hidden = true;
    $("gateTitle").textContent = title; $("gateText").textContent = text || ""; $("gateLinkRow").hidden = !link;
    document.body.classList.add("gated"); document.body.classList.remove("connecting");
  }
  function start(){
    var t = store("ritehome_stab"); if(t === "board" || t === "pipeline" || t === "timeline" || t === "calendar") state.tab = t;
    var c = Number(keep("ritehome_capacity")); if(c >= 1) state.cap = c;
    $("fCap").value = state.cap; $("fSpan").value = String(state.span);
    document.querySelectorAll("[data-stab]").forEach(function(b){ b.addEventListener("click", function(){ setTab(b.getAttribute("data-stab")); }); });
    $("fDone").addEventListener("change", function(){ state.showDone = this.checked; render(); });
    $("fSpan").addEventListener("change", function(){ state.span = Number(this.value) || 13; render(); });
    $("fCap").addEventListener("change", function(){ var v = Math.round(Number(this.value)); if(v >= 1){ state.cap = v; keep("ritehome_capacity", String(v)); render(); } });
    $("addEventBtn").addEventListener("click", function(){ editEvent({date: state.day || today()}); });
    function shift(n){
      var m = monthParts(), y = m[0], mo = m[1] + n; if(mo < 1){ mo = 12; y--; } if(mo > 12){ mo = 1; y++; }
      state.month = y + "-" + String(mo).padStart(2, "0"); state.day = null;
      var r = range();   // fetch the new month's events if they're outside what's loaded
      rpc("schedule_events", {p_from: r[0], p_to: r[1]}).then(function(c){ state.cal = c; state.holidays = S.holidaysFrom(c.events); render(); }).catch(fail);
      render();
    }
    $("calPrev").addEventListener("click", function(){ shift(-1); });
    $("calNext").addEventListener("click", function(){ shift(1); });
    $("calToday").addEventListener("click", function(){ state.month = null; state.day = today(); render(); });
    window.addEventListener("hashchange", openFromHash);
    setInterval(function(){ if(document.visibilityState === "visible" && !state.editEvent && !state.plan && !document.querySelector(".stage-row .save:not([disabled])")) load().catch(function(){}); }, 120000);
    return load().then(function(){
      $("gate").hidden = true; $("app").hidden = false; document.body.classList.remove("gated", "connecting");
      openFromHash();
    });
  }
  function home(){ return window.RitehomeLinks ? window.RitehomeLinks.href("all") : "tracker.html"; }
  if(window.RitehomeLinks && window.RitehomeLinks.href("schedule") === "/schedule" && /schedule\.html$/.test(location.pathname)){
    try { history.replaceState(history.state, "", "/schedule" + location.hash); } catch(e){}
  }
  $("forgetKeyBtn").addEventListener("click", function(){ client.auth.signOut().then(function(){ location.href = home(); }); });
  document.body.classList.add("gated", "connecting");
  client.auth.getSession().then(function(r){
    var session = r && r.data && r.data.session;
    if(!session){ $("gateLink").href = home(); return gate("Sign in first", "Sign in on the staff portal, then open Schedule from the menu.", true); }
    return rpc("my_role").then(function(role){
      if(!role) return gate("Your account isn't active yet", "Ask the admin to activate your account and set your role.");
      // Staff can't open the other workspaces (the database refuses them), so don't offer them.
      if(role !== "admin") document.querySelectorAll("a.side-link:not([aria-current])").forEach(function(a){ a.hidden = true; });
      return start();
    });
  }).catch(function(e){ gate("Couldn't open the schedule", e && e.message ? e.message : String(e)); });
})();
