/* Lead scoreboard: reads and writes leads only through the Supabase functions in
   supabase/migrations/20261112000006_leads.sql; scores come from lead-score.js. Admin only. */
(function(){
  'use strict';
  var SUPABASE_URL = "https://laxavfldivkhufeubgmb.supabase.co";
  var SUPABASE_KEY = "sb_publishable_8vOuny8cDkb-vtwyOP7vnA_VqFYc5T1";
  var L = window.RitehomeLeads;
  var STAGES = [["new", "New"], ["contacted", "Contacted"], ["site_visit", "Site visit"], ["quoted", "Quoted"], ["won", "Won"], ["lost", "Lost"]];
  var STAGE_LABEL = {}; STAGES.forEach(function(s){ STAGE_LABEL[s[0]] = s[1]; });
  var SOURCE_LABEL = {website: "Website", "site-visit": "Site visit form", hannah: "Hannah chat", facebook: "Facebook", "walk-in": "Walk-in", referral: "Referral", phone: "Phone", other: "Other"};
  var SYSTEMS = [["", "Not asked"], ["kitchen", "Kitchen"], ["storage", "Storage / wardrobe"], ["partition", "Partition"], ["workspace", "Workspace"], ["other", "Other"]];
  var TIMELINES = [["", "Not asked"], ["asap", "As soon as possible"], ["1-3m", "1 to 3 months"], ["3-6m", "3 to 6 months"], ["later", "Later than 6 months"]];
  var KINDS = [["call", "Call"], ["message", "Message"], ["visit", "Site visit"], ["quote", "Quote sent"], ["note", "Note"]];
  function label(list, v){ var f = list.filter(function(x){ return x[0] === v; })[0]; return f ? f[1] : ""; }

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: false}});
  var state = {leads: [], filter: {stage: "", source: "", search: "", closed: false}, detail: null, logKind: "call"};

  // ---------- helpers ----------
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
      if(r.error){ if(window.RitehomeRefused) window.RitehomeRefused(client, "Leads", name, r.error); throw new Error(r.error.message || "The request failed."); }
      return r.data;
    });
  }
  function nowISO(){ return new Date().toISOString(); }
  function todayPH(){ return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }
  function money(n){ return "₱" + Math.round(Number(n) || 0).toLocaleString("en-PH"); }
  function dateFmt(iso){
    if(!iso) return "—";
    var d = String(iso).length === 10 ? new Date(iso + "T00:00:00+08:00") : new Date(iso);
    return d.toLocaleDateString("en-PH", {month: "short", day: "numeric", year: "numeric", timeZone: "Asia/Manila"});
  }
  function when(iso){
    if(!iso) return "—";
    var mins = (Date.now() - Date.parse(iso)) / 60000;
    if(mins < 60) return Math.max(1, Math.round(mins)) + " min ago";
    if(mins < 1440) return Math.round(mins / 60) + " h ago";
    if(mins < 2880) return "yesterday";
    return Math.round(mins / 1440) + " days ago";
  }
  function hours(x){ return x < 1 ? Math.round(x * 60) + " min" : (Math.round(x * 10) / 10) + " h"; }
  function msg(text, bad){
    var m = $("acctMsg"); m.textContent = text; m.hidden = !text; m.classList.toggle("bad", !!bad);
    clearTimeout(msg.t); if(text && !bad) msg.t = setTimeout(function(){ m.hidden = true; }, 4000);
  }
  function fail(e){ msg(e && e.message ? e.message : String(e), true); }
  function options(sel, list, value){ sel.textContent = ""; list.forEach(function(o){ sel.appendChild(h("option", {value: o[0], text: o[1]})); }); sel.value = value || ""; return sel; }
  function wa(phone){
    var d = String(phone || "").replace(/\D/g, "");
    if(/^0\d{10}$/.test(d)) d = "63" + d.slice(1); else if(/^9\d{9}$/.test(d)) d = "63" + d;
    return d.length >= 11 ? "https://wa.me/" + d : "";
  }
  function contactButtons(l){
    var out = [];
    if(l.phone) out.push(h("a", {class: "btn ghost small", href: "tel:" + l.phone.replace(/[^\d+]/g, ""), text: "Call"}));
    if(wa(l.phone)) out.push(h("a", {class: "btn ghost small", href: wa(l.phone), target: "_blank", rel: "noopener", text: "WhatsApp"}));
    if(l.email) out.push(h("a", {class: "btn ghost small", href: "mailto:" + l.email + "?subject=" + encodeURIComponent("Ritehome Modular Systems"), text: "Email"}));
    return out;
  }
  function scoreBadge(s){
    if(s.closed) return h("span", {class: "score " + (s.label === "Won" ? "closed" : "lost"), text: s.label});
    return h("span", {class: "score " + s.label.toLowerCase(), title: s.parts.map(function(p){ return p.label + " " + p.points + (p.max ? "/" + p.max : ""); }).join(" · "), text: s.label + " " + s.total});
  }

  // ---------- board ----------
  function load(){
    return rpc("leads_list").then(function(list){ state.leads = list || []; render(); });
  }
  function render(){
    var b = L.board(state.leads, nowISO());
    var kpis = [
      ["Waiting for a reply", String(b.waiting.length), b.overdueReplies ? b.overdueReplies + " past the 2-hour promise" : b.waiting.length ? "All within 2 business hours" : "Nobody waiting", b.overdueReplies > 0],
      ["Hot leads", String(b.hot), "Score 65 or more"],
      ["Follow-ups due", String(b.followUpsDue), "Today or overdue", b.followUpsDue > 0],
      ["Open pipeline", money(b.pipelineValue), b.rows.length + (b.rows.length === 1 ? " open lead" : " open leads")],
      ["Win rate, 90 days", b.winRate == null ? "—" : Math.round(b.winRate * 100) + "%", b.closed90 ? b.closed90 + " won or lost" : "Nothing closed yet"],
      ["Typical first reply", b.medianReplyHours == null ? "—" : hours(b.medianReplyHours), "Business hours, last 30 days", b.medianReplyHours != null && b.medianReplyHours > L.REPLY_HOURS]
    ];
    put("leadKpis", h("div", {style: "display:contents"}, kpis.map(function(k){
      return h("div", {class: "kpi"}, [h("span", {class: "label", text: k[0]}), h("span", {class: "val" + (k[3] ? " neg" : ""), text: k[1]}), h("span", {class: "sub", text: k[2]})]);
    })));

    // Reply now
    $("waitCard").hidden = !b.waiting.length;
    $("waitCount").textContent = b.waiting.length ? String(b.waiting.length) : "";
    put("waitList", h("div", null, b.waiting.map(function(r){
      var l = r.lead;
      return h("div", {class: "wait-row"}, [
        h("div", {class: "who"}, [h("a", {class: "lead-row-name", href: "#lead=" + l.id, text: l.name}),
          h("span", {class: "clock" + (r.reply.overdue ? " late" : ""), text: hours(r.reply.hours) + " waiting"}),
          h("span", {class: "meta", text: [SOURCE_LABEL[l.source], label(SYSTEMS, l.system) && l.system ? label(SYSTEMS, l.system) : "", l.location, "came in " + when(l.created_at)].filter(Boolean).join(" · ")})]),
        h("div", {class: "contact-btns no-print"}, contactButtons(l).concat([h("a", {class: "btn small", href: "#lead=" + l.id + "&log=call", text: "Log reply"})]))
      ]);
    })));

    // Stage bar
    put("stageBar", h("div", {style: "display:contents"}, STAGES.map(function(s){
      var st = b.byStage[s[0]];
      return h("button", {type: "button", "aria-pressed": state.filter.stage === s[0] ? "true" : "false", onclick: function(){
        state.filter.stage = state.filter.stage === s[0] ? "" : s[0];
        if(s[0] === "won" || s[0] === "lost") state.filter.closed = true, $("fClosed").checked = true;
        render();
      }}, [s[1], h("b", {text: String(st.count)}), h("small", {text: st.value ? money(st.value) : " "})]);
    })));

    // Scoreboard
    var f = state.filter, q = f.search.trim().toLowerCase(), now = nowISO(), today = todayPH();
    var rows = state.leads.map(function(l){ return {lead: l, s: L.score(l, now)}; }).filter(function(r){
      var l = r.lead;
      if(!f.closed && r.s.closed && f.stage !== l.stage) return false;
      if(f.stage && l.stage !== f.stage) return false;
      if(f.source && l.source !== f.source) return false;
      if(q && [l.name, l.phone, l.email, l.location, l.message].join(" ").toLowerCase().indexOf(q) < 0) return false;
      return true;
    }).sort(function(a, b){
      if(a.s.closed !== b.s.closed) return a.s.closed ? 1 : -1;
      return (b.s.total || 0) - (a.s.total || 0) || String(b.lead.created_at).localeCompare(String(a.lead.created_at));
    });
    $("boardCount").textContent = String(rows.length);
    if(!rows.length){ put("boardTable", h("p", {class: "muted", text: state.leads.length ? "No leads match." : "No leads yet. Website inquiries arrive here on their own; add walk-ins, Facebook messages and referrals with + Add lead."})); return; }
    var table = h("table", {class: "acct-table"}, [
      h("thead", null, h("tr", null, ["Score", "Lead", "Wants", "Where", "Stage", "Next step"].map(function(t){ return h("th", {text: t}); }))),
      h("tbody", null, rows.map(function(r){
        var l = r.lead, overdue = l.next_action_at && l.next_action_at <= today && !r.s.closed;
        var wants = [l.system ? label(SYSTEMS, l.system) : "", l.timeline ? label(TIMELINES, l.timeline) : "", Number(l.expected_value || l.budget) ? money(l.expected_value || l.budget) : ""].filter(Boolean).join(" · ") || "—";
        return h("tr", {class: overdue ? "overdue" : null}, [
          h("td", null, scoreBadge(r.s)),
          h("td", null, [h("a", {class: "lead-row-name", href: "#lead=" + l.id, text: l.name}), h("span", {class: "cell-sub", text: (SOURCE_LABEL[l.source] || l.source) + " · " + when(l.created_at)})]),
          h("td", {text: wants}),
          h("td", {text: l.location || "—"}),
          h("td", {text: STAGE_LABEL[l.stage] || l.stage}),
          h("td", {class: "next", text: l.next_action_at ? dateFmt(l.next_action_at) + (l.next_action ? " · " + l.next_action : "") : (l.next_action || "—")})
        ]);
      }))
    ]);
    put("boardTable", h("div", {class: "acct-scroll"}, table));
  }

  // ---------- one lead ----------
  function openFromHash(){
    var m = /lead=([0-9a-f-]{36})/.exec(location.hash), k = /log=(\w+)/.exec(location.hash);
    if(!m){ $("leadCard").hidden = true; state.detail = null; return Promise.resolve(); }
    if(k) state.logKind = k[1];
    return rpc("lead_get", {p_id: m[1]}).then(function(d){
      if(!d){ msg("That lead no longer exists.", true); return; }
      state.detail = d; renderDetail();
      $("leadCard").scrollIntoView({block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"});
    }).catch(fail);
  }
  function refreshDetail(){
    return Promise.all([load(), state.detail ? rpc("lead_get", {p_id: state.detail.lead.id}).then(function(d){ state.detail = d; renderDetail(); }) : null]);
  }
  function renderDetail(){
    var l = state.detail.lead, s = L.score(l, nowISO()), card = $("leadCard");
    card.hidden = false; card.textContent = "";
    card.appendChild(h("div", {class: "lead-head"}, [
      h("div", null, [h("h2", null, [l.name, " ", scoreBadge(s)]),
        h("div", {class: "muted small", text: [SOURCE_LABEL[l.source], "came in " + dateFmt(l.created_at), l.visit_requested ? "asked for a visit: " + l.visit_requested : "", l.first_response_at ? "first reply " + hours(L.businessHours(l.created_at, l.first_response_at)) + " after" : ""].filter(Boolean).join(" · ")})]),
      h("div", {class: "contact-btns no-print"}, contactButtons(l).concat([h("a", {class: "btn ghost small", href: "#", text: "Close", onclick: function(e){ e.preventDefault(); history.replaceState(null, "", location.pathname); card.hidden = true; state.detail = null; }})]))
    ]));

    // stage
    var stageRow = h("div", {class: "stage-btns no-print"}, STAGES.map(function(st){
      return h("button", {type: "button", class: "btn ghost small", "aria-current": l.stage === st[0] ? "true" : "false", text: st[1], onclick: function(){ setStage(l, st[0]); }});
    }));
    var won = l.project_id ? h("p", {class: "small"}, ["Won: ", h("a", {href: (window.RitehomeLinks ? window.RitehomeLinks.href("projects") : "tracker.html?portal=projects") + "#p=" + l.project_id, text: "open the project in the tracker"}), "."]) : null;

    // details form
    function field(lbl, key, type, attrs){
      var inp = type === "select" ? options(h("select"), attrs, l[key]) : h(type === "textarea" ? "textarea" : "input", Object.assign({type: type === "textarea" ? null : type, value: l[key] == null ? "" : l[key], rows: type === "textarea" ? "3" : null}, attrs || {}));
      inp.setAttribute("data-key", key);
      return h("label", {class: type === "textarea" ? "wide" : null}, [lbl, inp]);
    }
    var form = h("form", {class: "acct-grid", onsubmit: function(e){
      e.preventDefault();
      var p = {id: l.id};
      form.querySelectorAll("[data-key]").forEach(function(el){ p[el.getAttribute("data-key")] = el.value; });
      busy(e, rpc("lead_save", {p: p}).then(function(){ msg((p.name || "Lead") + " saved."); return refreshDetail(); })).catch(fail);
    }}, [
      field("Name", "name", "text", {maxlength: "120"}), field("Phone", "phone", "tel", {maxlength: "40"}), field("Email", "email", "email", {maxlength: "160"}),
      field("System", "system", "select", SYSTEMS), field("When", "timeline", "select", TIMELINES),
      field("Budget (₱)", "budget", "number", {min: "0", step: "1000"}), field("Expected contract (₱)", "expected_value", "number", {min: "0", step: "1000"}),
      field("Location", "location", "text", {maxlength: "300"}), field("What they want", "message", "textarea", {maxlength: "2000"}),
      h("div", {class: "wide acct-actions"}, h("button", {class: "btn", type: "submit", text: "Save details"}))
    ]);

    // score breakdown
    var parts = s.closed ? h("p", {class: "muted small", text: "Closed leads aren't scored."}) : h("table", {class: "lead-parts"}, h("tbody", null, s.parts.map(function(p){
      return h("tr", null, [h("td", {text: p.label}), h("td", {class: "why", text: p.why}), h("td", {class: "pts", text: (p.points > 0 ? "+" : "") + p.points + (p.max ? " / " + p.max : "")})]);
    }).concat([h("tr", null, [h("td", null, h("b", {text: "Score"})), h("td"), h("td", {class: "pts"}, h("b", {text: String(s.total)}))])])));

    // log
    var kind = options(h("select", {"aria-label": "What happened"}), KINDS, state.logKind);
    var body = h("input", {maxlength: "2000", placeholder: "What was said or agreed", "aria-label": "Note"});
    var next = h("input", {maxlength: "200", placeholder: "Next step, e.g. send quote", value: l.next_action || "", "aria-label": "Next step"});
    var nextAt = h("input", {type: "date", value: l.next_action_at || "", "aria-label": "Next step date"});
    var log = h("form", {class: "acct-grid no-print", onsubmit: function(e){
      e.preventDefault();
      busy(e, rpc("lead_log", {p_id: l.id, p_kind: kind.value, p_body: body.value, p_next_action: next.value, p_next_at: nextAt.value || null})
        .then(function(){ msg("Logged."); state.logKind = "call"; return refreshDetail(); })).catch(fail);
    }}, [h("label", null, ["What happened", kind]), h("label", {class: "wide"}, ["Note", body]), h("label", null, ["Next step", next]), h("label", null, ["By", nextAt]),
      h("div", {class: "wide acct-actions"}, h("button", {class: "btn", type: "submit", text: "Log it"}))]);

    var timeline = h("ol", {class: "timeline"}, state.detail.activity.map(function(a){
      var contact = ["call", "message", "visit", "quote"].indexOf(a.kind) >= 0;
      return h("li", {class: contact ? "contact" : a.kind === "inquiry" ? "inquiry" : null}, [
        h("span", {class: "when", text: dateFmt(a.at) + " · " + (label(KINDS, a.kind) || (a.kind === "inquiry" ? "Inquiry" : "Stage")) + (a.by_name ? " · " + a.by_name : "")}), a.body || "—"]);
    }));

    card.appendChild(stageRow);
    if(won) card.appendChild(won);
    card.appendChild(h("div", {class: "lead-cols"}, [
      h("div", null, [h("h3", {class: "small", text: "Details"}), form]),
      h("div", null, [h("h3", {class: "small", text: "Why this score"}), parts, h("h3", {class: "small", text: "Log a call, message or visit"}), log, h("h3", {class: "small", text: "History"}), timeline])
    ]));
  }

  function setStage(l, stage){
    if(stage === l.stage) return;
    if(stage === "won" && !state.admin){
      // Winning opens the project with its contract price and budget: that's the admin's call.
      msg("Only the admin marks a lead won, because it opens the project with its price. Move it to Quoted and tell the admin.");
      return refreshDetail();
    }
    if(stage === "won"){
      var price = window.prompt("Won! Contract price (₱) for the new project?", l.expected_value || l.budget || "");
      if(price == null) return;
      var budget = window.prompt("Budget (₱) for it? Leave blank to set it later in the tracker.", "");
      if(budget == null) return;
      rpc("lead_convert", {p_id: l.id, p_price: Number(price) || null, p_budget: Number(budget) || null})
        .then(function(){ msg("Won. The project is open in the tracker."); return refreshDetail(); }).catch(fail);
      return;
    }
    var p = {id: l.id, stage: stage};
    if(stage === "lost"){
      var why = window.prompt("Why was it lost? (price, timing, went elsewhere, no reply…)", "");
      if(why == null) return;
      p.lost_reason = why;
    }
    rpc("lead_save", {p: p}).then(function(){ msg("Moved to " + STAGE_LABEL[stage] + "."); return refreshDetail(); }).catch(fail);
  }

  // (19) the button that sent a form spins until the answer comes back (RitehomeBusy, shell.js)
  function busy(e, promise){
    var b = e && (e.submitter || (e.target && e.target.querySelector && e.target.querySelector("[type=submit]")));
    if(!b || !window.RitehomeBusy) return promise;
    RitehomeBusy(b, true);
    return promise.then(function(v){ RitehomeBusy(b, false); return v; }, function(err){ RitehomeBusy(b, false); throw err; });
  }

  // ---------- add ----------
  function addLead(e){
    e.preventDefault();
    var p = {source: $("nSource").value, name: $("nName").value, phone: $("nPhone").value, email: $("nEmail").value, location: $("nLocation").value,
      system: $("nSystem").value, timeline: $("nTimeline").value, budget: $("nBudget").value, message: $("nMessage").value};
    if(!p.name.trim()){ msg("A lead needs a name.", true); return; }
    busy(e, rpc("lead_save", {p: p})).then(function(id){
      $("addForm").reset(); $("addCard").hidden = true; msg("Lead added.");
      location.hash = "lead=" + id;
      return load();
    }).catch(fail);
  }

  // ---------- start ----------
  function gate(title, text, link){
    $("gate").hidden = false; $("app").hidden = true;
    $("gateTitle").textContent = title; $("gateText").textContent = text || ""; $("gateLinkRow").hidden = !link;
    document.body.classList.add("gated"); document.body.classList.remove("connecting");
  }
  function start(){
    options($("nSystem"), SYSTEMS); options($("nTimeline"), TIMELINES);
    $("addLeadBtn").addEventListener("click", function(){ $("addCard").hidden = !$("addCard").hidden; if(!$("addCard").hidden) $("nName").focus(); });
    $("addCancel").addEventListener("click", function(){ $("addCard").hidden = true; });
    $("addForm").addEventListener("submit", addLead);
    $("fSearch").addEventListener("input", function(){ state.filter.search = this.value; render(); });
    $("fSource").addEventListener("change", function(){ state.filter.source = this.value; render(); });
    $("fClosed").addEventListener("change", function(){ state.filter.closed = this.checked; render(); });
    window.addEventListener("hashchange", openFromHash);
    setInterval(function(){ if(document.visibilityState === "visible") load().catch(function(){}); }, 60000);   // new website leads and the reply clock
    return load().then(function(){
      $("gate").hidden = true; $("app").hidden = false; document.body.classList.remove("gated", "connecting");
      return openFromHash();
    });
  }
  function home(){ return window.RitehomeLinks ? window.RitehomeLinks.href("all") : "tracker.html"; }
  if(window.RitehomeLinks && window.RitehomeLinks.href("leads") === "/leads" && /leads\.html$/.test(location.pathname)){
    try { history.replaceState(history.state, "", "/leads" + location.hash); } catch(e){}
  }
  $("forgetKeyBtn").addEventListener("click", function(){ client.auth.signOut().then(function(){ location.href = home(); }); });
  document.body.classList.add("gated", "connecting");
  client.auth.getSession().then(function(r){
    var session = r && r.data && r.data.session;
    if(!session){ $("gateLink").href = home(); return gate("Sign in first", "Sign in on the staff portal, then come back to Leads from the menu.", true); }
    return rpc("my_roles").then(function(roles){
      roles = roles || [];
      if(window.RitehomeAccess) window.RitehomeAccess.apply(roles);
      if(roles.indexOf("admin") < 0 && roles.indexOf("sales") < 0) return gate("Leads are for sales and the admin", roles.length ? "Your account can use the Schedule." : "This account hasn't been activated yet.");
      state.admin = roles.indexOf("admin") >= 0;
      return start();
    });
  }).catch(function(e){ gate("Couldn't open the leads", e && e.message ? e.message : String(e)); });
})();
