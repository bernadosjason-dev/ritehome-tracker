/* Activity log (activity.html at /activity, admin only). Reads public.audit_search()
   (supabase/migrations/20261118000016_audit_log.sql): every insert, change and delete on the
   business tables, written by a database trigger, plus refusals the pages report. The page only
   filters and formats; the database decides what is logged and who may read it. */
(function(){
  'use strict';
  var SUPABASE_URL = "https://laxavfldivkhufeubgmb.supabase.co";
  var SUPABASE_KEY = "sb_publishable_8vOuny8cDkb-vtwyOP7vnA_VqFYc5T1";
  var MODULES = ["Projects", "Schedule", "Leads", "Procurement", "Inventory", "Attendance", "Accounting", "Company fuel", "Team"];
  var ROLE = {admin: "Admin", designer: "Designer", sales: "Sales", bookkeeper: "Bookkeeper", purchaser: "Purchaser", fabrication: "Workshop", installer: "Installer"};
  var VERB = {insert: "added", update: "changed", "delete": "deleted", refused: "was refused"};
  var THING = {tracker_docs: "", project_stages: "stage", project_events: "event", project_files: "file", project_assignments: "assignment",
    leads: "lead", lead_activity: "lead contact:", acct_accounts: "account", acct_settings: "book settings", acct_entries: "journal entry",
    acct_lines: "journal line", acct_project_vat: "project VAT", acct_purchase_vat: "purchase VAT", inventory_items: "stock item",
    inventory_moves: "stock movement", attendance_punches: "punch", profiles: "account"};
  var DOC = {projects: "project", expenses: "expense", companyFuel: "fuel log", companyVehicles: "vehicle", procurementJobs: "procurement job", procurement: "procurement record"};
  var PAGE = 100;

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: false}});
  var state = {rows: [], filter: {}, record: null, more: false, people: []};

  function $(id){ return document.getElementById(id); }
  function h(tag, attrs, kids){
    var e = document.createElement(tag);
    if(attrs) Object.keys(attrs).forEach(function(k){
      var v = attrs[k];
      if(v == null || v === false) return;
      if(k === "text") e.textContent = v;
      else if(k === "class") e.className = v;
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
    return client.rpc(name, args || {}).then(function(r){
      if(r.error){ if(window.RitehomeRefused) window.RitehomeRefused(client, "Activity", name, r.error); throw new Error(r.error.message || "The request failed."); }
      return r.data;
    });
  }
  function msg(text, bad){
    var m = $("acctMsg"); m.textContent = text; m.hidden = !text; m.classList.toggle("bad", !!bad);
    clearTimeout(msg.t); if(text && !bad) msg.t = setTimeout(function(){ m.hidden = true; }, 5000);
  }
  function fail(e){ msg(e && e.message ? e.message : String(e), true); }

  // ---------- formatting ----------
  var dayFmt = new Intl.DateTimeFormat("en-PH", {timeZone: "Asia/Manila", weekday: "short", month: "short", day: "numeric", year: "numeric"});
  var timeFmt = new Intl.DateTimeFormat("en-PH", {timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit"});
  var keyFmt = new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit"});
  function manilaDay(iso){ return keyFmt.format(new Date(iso)); }
  function todayKey(){ return keyFmt.format(new Date()); }
  function fieldName(k){
    var s = String(k).replace(/^data\./, "").replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  var stampFmt = new Intl.DateTimeFormat("en-PH", {timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"});
  function show(v){
    if(v == null || v === "") return "—";
    if(typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !isNaN(Date.parse(v))) return stampFmt.format(new Date(v));
    if(typeof v === "string" && /^[a-z]+(_[a-z]+)+$/.test(v)) return v.replace(/_/g, " ");
    if(typeof v === "object") return JSON.stringify(v);
    return String(v);
  }
  function clip(s, n){ s = String(s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function roleText(roles){ return (roles || []).map(function(r){ return ROLE[r] || r; }).join(", "); }
  function thing(r){
    if(r.table_name === "tracker_docs"){ var c = String(r.record_id).split("/")[0]; return DOC[c] || "record"; }
    return THING[r.table_name] || r.table_name || "action";
  }
  function who(r){ return r.actor_name || (r.actor ? "Unnamed account" : "System or website"); }
  // One line that says what happened: "changed lead Carlo Diaz: stage new → quoted"
  function sentence(r){
    if(r.action === "refused") return "was refused: " + (r.label || "an action") + (r.new && r.new.detail ? " (" + r.new.detail + ")" : "");
    var s = VERB[r.action] + " " + thing(r) + (r.label ? " " + show(r.label) : "");
    if(r.action === "update" && r.changed && r.changed.length){
      var parts = r.changed.slice(0, 3).map(function(k){
        return fieldName(k) + " " + clip(show(r.old && r.old[k]), 28) + " → " + clip(show(r.new && r.new[k]), 28);
      });
      s += ": " + parts.join("; ") + (r.changed.length > 3 ? "; and " + (r.changed.length - 3) + " more" : "");
    }
    return s;
  }

  // ---------- rendering ----------
  function kpis(){
    var t = todayKey(), today = state.rows.filter(function(r){ return manilaDay(r.at) === t; });
    var refused = today.filter(function(r){ return r.action === "refused"; }).length;
    var people = {}; today.forEach(function(r){ if(r.actor) people[r.actor] = 1; });
    var deletes = today.filter(function(r){ return r.action === "delete"; }).length;
    // The first figure is the one to act on: refused attempts, drawn larger.
    var k = [["Refused today", String(refused), refused ? "Someone tried something they can't do" : "Nobody hit a wall", refused > 0, "lead"],
      ["Changes today", String(today.length - refused), deletes ? deletes + " deleted" : "Nothing deleted"],
      ["People active today", String(Object.keys(people).length), Object.keys(people).length ? "Made at least one change" : "No changes yet"]];
    put("actKpis", h("div", {style: "display:contents"}, k.map(function(x){
      return h("div", {class: "kpi" + (x[4] ? " " + x[4] : "")}, [h("span", {class: "label", text: x[0]}), h("span", {class: "val" + (x[3] ? " neg" : ""), text: x[1]}), h("span", {class: "sub", text: x[2]})]);
    })));
    var filtered = Object.keys(state.filter).some(function(k){ return state.filter[k]; }) || state.record;
    $("actTitle").textContent = filtered ? "Activity · filtered" : today.length ? today.length + (today.length === 1 ? " change today" : " changes today") + (refused ? " · " + refused + " refused" : "") : "Activity · quiet today";
  }
  function diffTable(r){
    var keys = r.action === "update" ? (r.changed || []) : Object.keys(r.action === "delete" ? (r.old || {}) : (r.new || {}));
    if(r.action === "refused") keys = [];
    var rows = keys.map(function(k){
      return h("tr", null, [h("th", {scope: "row", text: fieldName(k)}),
        r.action === "insert" ? null : h("td", {class: "was", text: show(r.old && r.old[k])}),
        r.action === "delete" ? null : h("td", {class: "now", text: show(r.new && r.new[k])})]);
    });
    var head = h("tr", null, [h("th", {text: "Field"}), r.action === "insert" ? null : h("th", {text: "Before"}), r.action === "delete" ? null : h("th", {text: "After"})]);
    var meta = [h("span", {text: "Record " + (r.table_name || "—") + (r.record_id ? " · " + r.record_id : "")}),
      r.ip ? h("span", {text: "IP " + r.ip}) : null,
      r.user_agent ? h("span", {title: r.user_agent, text: clip(r.user_agent, 60)}) : null,
      r.source === "page" ? h("span", {text: "Reported by the page"}) : null];
    var hist = r.record_id ? h("button", {class: "btn ghost small", type: "button", onclick: function(){ openRecord(r); }, text: "History of this record"}) : null;
    return h("div", {class: "act-detail"}, [
      rows.length ? h("table", {class: "acct-table act-diff"}, [h("thead", null, head), h("tbody", null, rows)]) : null,
      h("p", {class: "act-meta muted small"}, meta), hist]);
  }
  function item(r){
    var open = false, row, detail;
    row = h("button", {class: "act-row " + r.action, type: "button", "aria-expanded": "false", "data-id": String(r.id), onclick: function(){
      open = !open; row.setAttribute("aria-expanded", String(open));
      if(open){ detail = diffTable(r); row.parentNode.insertBefore(detail, row.nextSibling); }
      else if(detail){ detail.remove(); detail = null; }
    }}, [
      h("span", {class: "act-time", text: timeFmt.format(new Date(r.at))}),
      h("span", {class: "act-body"}, [
        h("span", {class: "act-who"}, [h("strong", {text: who(r)}), r.actor_roles && r.actor_roles.length ? h("small", {text: " · " + roleText(r.actor_roles)}) : null]),
        h("span", {class: "act-what", text: sentence(r)}),
        h("span", {class: "act-where muted small", text: r.module + (r.project_name ? " · " + r.project_name : "")})])
    ]);
    return h("li", null, row);
  }
  function render(){
    kpis();
    if(!state.rows.length){ put("actList", h("p", {class: "muted", text: "Nothing matches. The log starts from the day it was switched on."})); $("moreBtn").hidden = true; return; }
    var groups = [], last = null;
    state.rows.forEach(function(r){
      var d = manilaDay(r.at);
      if(!last || last.day !== d){ last = {day: d, label: dayFmt.format(new Date(r.at)), rows: []}; groups.push(last); }
      last.rows.push(r);
    });
    put("actList", h("div", null, groups.map(function(g){
      return h("section", {class: "act-day"}, [h("h2", {class: "act-day-head", text: g.label + " · " + g.rows.length}), h("ul", {class: "act-items"}, g.rows.map(item))]);
    })));
    $("moreBtn").hidden = !state.more;
  }

  // ---------- loading ----------
  function query(before){
    var p = {limit: PAGE};
    Object.keys(state.filter).forEach(function(k){ if(state.filter[k]) p[k] = state.filter[k]; });
    if(state.record){ p.table = state.record.table; p.record = state.record.record; }
    if(before) p.before = before;
    return rpc("audit_search", {p: p});
  }
  function load(){
    return query().then(function(rows){ state.rows = rows || []; state.more = state.rows.length === PAGE; render(); });
  }
  function more(){
    var btn = $("moreBtn"); window.RitehomeBusy && window.RitehomeBusy(btn, true);
    query(state.rows[state.rows.length - 1].id).then(function(rows){
      window.RitehomeBusy && window.RitehomeBusy(btn, false);
      state.rows = state.rows.concat(rows || []); state.more = (rows || []).length === PAGE; render();
    }).catch(function(e){ window.RitehomeBusy && window.RitehomeBusy(btn, false); fail(e); });
  }
  function readFilters(){
    state.filter = {actor: $("fActor").value, module: $("fModule").value, action: $("fAction").value, project: $("fProject").value,
      from: $("fFrom").value, to: $("fTo").value, q: $("fQ").value.trim()};
  }
  function openRecord(r){
    state.record = {table: r.table_name, record: r.record_id, label: r.label || r.record_id};
    $("recordNote").hidden = false; $("recordNote").textContent = "";
    $("recordNote").appendChild(document.createTextNode("Showing the history of " + thing(r) + " " + state.record.label + ". "));
    $("recordNote").appendChild(h("button", {class: "btn ghost small", type: "button", onclick: function(){ state.record = null; $("recordNote").hidden = true; load().catch(fail); }, text: "Back to everything"}));
    window.scrollTo(0, 0);
    load().catch(fail);
  }
  function options(sel, list){ list.forEach(function(o){ sel.appendChild(h("option", {value: o[0], text: o[1]})); }); }

  function start(){
    options($("fModule"), MODULES.map(function(m){ return [m, m]; }));
    var t; $("fQ").addEventListener("input", function(){ clearTimeout(t); t = setTimeout(function(){ readFilters(); load().catch(fail); }, 300); });
    ["fActor", "fModule", "fAction", "fProject", "fFrom", "fTo"].forEach(function(id){ $(id).addEventListener("change", function(){ readFilters(); load().catch(fail); }); });
    $("fClear").addEventListener("click", function(){ $("actFilters").reset(); state.record = null; $("recordNote").hidden = true; readFilters(); load().catch(fail); });
    $("actFilters").addEventListener("submit", function(e){ e.preventDefault(); });
    $("moreBtn").addEventListener("click", more);
    // People and projects for the filters; neither is needed to show the log.
    var people = rpc("team_list").then(function(list){
      options($("fActor"), (list || []).map(function(p){ return [p.id, (p.full_name || p.email || "Unnamed") + (p.active ? "" : " (off)")]; }));
    }).catch(function(){});
    var projects = rpc("schedule_board").then(function(b){
      options($("fProject"), ((b && b.projects) || []).map(function(p){ return [p.id, p.name || p.id]; }));
    }).catch(function(){});
    return Promise.all([load(), people, projects]).then(function(){ $("gate").hidden = true; $("app").hidden = false; document.body.classList.remove("gated", "connecting"); });
  }
  function gate(title, text, signIn){
    $("gateTitle").textContent = title; $("gateText").textContent = text || "";
    $("gateLinkRow").hidden = !signIn; $("gate").hidden = false; $("app").hidden = true;
    document.body.classList.remove("connecting");
  }
  function home(){ return window.RitehomeLinks ? window.RitehomeLinks.href("all") : "tracker.html"; }
  if(window.RitehomeLinks && window.RitehomeLinks.href("activity") === "/activity" && /activity\.html$/.test(location.pathname)){
    try { history.replaceState(history.state, "", "/activity" + location.hash); } catch(e){}
  }
  $("forgetKeyBtn").addEventListener("click", function(){ client.auth.signOut().then(function(){ location.href = home(); }); });
  document.body.classList.add("gated", "connecting");
  client.auth.getSession().then(function(r){
    var session = r && r.data && r.data.session;
    if(!session){ $("gateLink").href = home(); return gate("Sign in first", "Sign in on the staff portal, then open Activity from the menu.", true); }
    if(session.user && session.user.user_metadata && session.user.user_metadata.must_change_password){ $("gateLink").href = home(); return gate("Choose your password first", "Your account still has the temporary password. Open the portal's front page to choose your own.", true); }
    return rpc("my_roles").then(function(roles){
      roles = roles || [];
      if(window.RitehomeAccess) window.RitehomeAccess.apply(roles);
      if(roles.indexOf("admin") < 0) return gate("The activity log is for admins", roles.length ? "Your account can use the Schedule." : "This account hasn't been activated yet.");
      return start();
    });
  }).catch(function(e){ gate("Couldn't open the activity log", e && e.message ? e.message : String(e)); });
})();
