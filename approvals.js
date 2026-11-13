/* Approvals (approvals.html at /approvals, every active account). Phase 4 of the CRM master prompt.
   The data and every rule live in supabase/migrations/20261122000019_approvals.sql:
     approvals_list(p)        the queue and the history (admin: all; staff: their own and their stages')
     stage_review(id, d, r)   the admin approves, or asks for a revision with remarks
     approval_rules_list/save which stages need approval (admin changes them)
   Staff submit from the Schedule (stage_submit); this page shows them what was decided and why. */
(function(){
  'use strict';
  var SUPABASE_URL = "https://laxavfldivkhufeubgmb.supabase.co";
  var SUPABASE_KEY = "sb_publishable_8vOuny8cDkb-vtwyOP7vnA_VqFYc5T1";
  var STAGE = {consultation: "Consultation", site_visit: "Site visit", design: "Design", cutlist: "Initial cutlist", bom: "BOM",
    final_cutlist: "Final cutlist", procurement: "Procurement", fabrication: "Fabrication", installation: "Installation", handover: "Handover"};
  var ORDER = Object.keys(STAGE);

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: false}});
  var state = {admin: false, pending: [], decided: [], project: ""};

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
      else if(k === "checked") e.checked = !!v;
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
      if(r.error){ if(window.RitehomeRefused) window.RitehomeRefused(client, "Approvals", name, r.error); throw new Error(r.error.message || "The request failed."); }
      return r.data;
    });
  }
  function msg(text, bad){
    var m = $("acctMsg"); m.textContent = text; m.hidden = !text; m.classList.toggle("bad", !!bad);
    clearTimeout(msg.t); if(text && !bad) msg.t = setTimeout(function(){ m.hidden = true; }, 5000);
  }
  function fail(e){ msg(e && e.message ? e.message : String(e), true); }
  function busy(b, on){ if(window.RitehomeBusy) window.RitehomeBusy(b, on); else b.disabled = on; }

  var stampFmt = new Intl.DateTimeFormat("en-PH", {timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"});
  function when(iso){ return iso ? stampFmt.format(new Date(iso)) : ""; }
  function plural(n, one, many){ return n + " " + (n === 1 ? one : many); }
  function title(x){ return x.project + " · " + (STAGE[x.stage] || x.stage) + " v" + x.version; }
  var PILL = {pending: ["warn", "Waiting"], approved: ["good", "Approved"], revise: ["bad", "Revise"]};
  function pill(d){ var p = PILL[d] || ["neutral", d]; return h("span", {class: "status-pill " + p[0], text: p[1]}); }
  function linkOf(x){
    return x.link ? h("a", {class: "ap-link", href: x.link, target: "_blank", rel: "noopener noreferrer", text: "Open what was submitted"}) : null;
  }
  // Earlier versions of the same stage, from what this page already has.
  function earlier(x){
    var all = state.pending.concat(state.decided).filter(function(y){ return y.project_id === x.project_id && y.stage === x.stage && y.version < x.version; })
      .sort(function(a, b){ return b.version - a.version; });
    if(!all.length) return null;
    return h("details", {class: "ap-earlier"}, [h("summary", {text: plural(all.length, "earlier version", "earlier versions")}),
      h("ul", null, all.map(function(y){
        return h("li", null, [h("b", {text: "v" + y.version + " "}), pill(y.decision), " ", y.note,
          y.remarks ? h("div", {class: "ap-remarks", text: (y.decider || "Admin") + ": " + y.remarks}) : null]);
      }))]);
  }

  // ---------- the queue ----------
  function queueItem(x){
    var who = h("div", {class: "ap-meta"}, [x.submitter || "Someone", " · submitted " + when(x.submitted_at)]);
    var body = [h("div", {class: "ap-head"}, [h("strong", {text: title(x)}), pill(x.decision)]), who,
      h("p", {class: "ap-note", text: x.note}), linkOf(x), earlier(x)];
    if(state.admin){
      var remarks = h("textarea", {rows: "2", maxlength: "2000", placeholder: "What needs changing (required to send it back)", "aria-label": "Remarks for " + title(x)});
      var approve = h("button", {class: "btn small", type: "button", text: "Approve"});
      var revise = h("button", {class: "btn ghost small", type: "button", text: "Send back for revision"});
      approve.addEventListener("click", function(){ decide(x, "approved", remarks.value, approve); });
      revise.addEventListener("click", function(){
        if(!remarks.value.trim()){ remarks.focus(); msg("Say what needs changing before sending it back.", true); return; }
        decide(x, "revise", remarks.value, revise);
      });
      body.push(h("div", {class: "ap-decide"}, [remarks, h("div", {class: "ap-actions"}, [approve, revise])]));
    } else body.push(h("p", {class: "muted small", text: "Waiting for the admin's review. You'll see the decision here."}));
    return h("article", {class: "ap-item pending", "data-id": x.id}, body);
  }
  function decide(x, decision, remarks, btn){
    busy(btn, true);
    rpc("stage_review", {p_id: x.id, p_decision: decision, p_remarks: remarks || ""}).then(function(){
      msg(title(x) + (decision === "approved" ? " approved. The next stage can start." : " sent back for revision."));
      return load();
    }).catch(function(e){ busy(btn, false); fail(e); });
  }

  // ---------- the history ----------
  function historyItem(x){
    return h("article", {class: "ap-item " + x.decision, "data-id": x.id}, [
      h("div", {class: "ap-head"}, [h("strong", {text: title(x)}), pill(x.decision)]),
      h("div", {class: "ap-meta"}, [(x.submitter || "Someone") + " · " + when(x.submitted_at) + " → " + (x.decider || "Admin") + " · " + when(x.decided_at)]),
      h("p", {class: "ap-note", text: x.note}),
      x.remarks ? h("div", {class: "ap-remarks", text: x.remarks}) : null,
      linkOf(x)
    ]);
  }

  function render(){
    var pending = state.pending, decided = state.decided.filter(function(x){ return !state.project || x.project_id === state.project; });
    var revise = state.decided.filter(function(x){ return x.mine && x.decision === "revise"; });
    if(state.admin){
      $("apTitle").textContent = pending.length ? plural(pending.length, "stage", "stages") + " waiting for you" : "Nothing waiting for you";
      $("queueSub").textContent = pending.length ? "Oldest first. Approving finishes the stage; sending it back reopens it with your remarks." : "";
    } else {
      $("apTitle").textContent = pending.length ? plural(pending.length, "submission", "submissions") + " with the admin" : "Your submissions";
      $("queueTitle").textContent = "With the admin";
      $("historyTitle").textContent = "Decided";
      $("queueSub").textContent = revise.length ? "The newest decision on each of your stages is below; a stage sent back is open again on the Schedule." : "";
    }
    put("queue", pending.length ? h("div", null, pending.slice().sort(function(a, b){ return a.submitted_at < b.submitted_at ? -1 : 1; }).map(queueItem))
      : h("p", {class: "muted", text: state.admin ? "When someone submits a stage for review it shows here." : "Submit a stage for review from the Schedule: choose its status “Submitted”."}));
    put("history", decided.length ? h("div", null, decided.map(historyItem)) : h("p", {class: "muted", text: "Nothing decided yet."}));
  }

  function renderRules(rules){
    var by = {}; (rules || []).forEach(function(r){ by[r.stage] = r.required; });
    put("rules", h("div", null, ORDER.map(function(s){
      var box = h("input", {type: "checkbox", checked: !!by[s], "data-stage": s});
      box.addEventListener("change", function(){
        box.disabled = true;
        rpc("approval_rules_save", {p_stage: s, p_required: box.checked}).then(function(){
          box.disabled = false; msg(STAGE[s] + (box.checked ? " now needs approval." : " no longer needs approval."));
        }).catch(function(e){ box.disabled = false; box.checked = !box.checked; fail(e); });
      });
      return h("label", {class: "ap-rule"}, [box, STAGE[s]]);
    })));
    $("rulesCard").hidden = false;
  }

  function load(){
    return rpc("approvals_list", {p: {limit: 300}}).then(function(rows){
      rows = rows || [];
      state.pending = rows.filter(function(x){ return x.decision === "pending"; });
      state.decided = rows.filter(function(x){ return x.decision !== "pending"; });
      var sel = $("fProject"), keep = sel.value, seen = {};
      sel.length = 1;
      rows.forEach(function(x){ if(!seen[x.project_id]){ seen[x.project_id] = 1; sel.appendChild(h("option", {value: x.project_id, text: x.project})); } });
      sel.value = seen[keep] ? keep : "";
      state.project = sel.value;
      render();
    });
  }

  function start(){
    $("fProject").addEventListener("change", function(){ state.project = $("fProject").value; render(); });
    var rules = state.admin ? rpc("approval_rules_list").then(renderRules) : Promise.resolve();
    return Promise.all([load(), rules]).then(function(){ $("gate").hidden = true; $("app").hidden = false; document.body.classList.remove("gated", "connecting"); });
  }
  function gate(title, text, signIn){
    $("gateTitle").textContent = title; $("gateText").textContent = text || "";
    $("gateLinkRow").hidden = !signIn; $("gate").hidden = false; $("app").hidden = true;
    document.body.classList.remove("connecting");
  }
  function home(){ return window.RitehomeLinks ? window.RitehomeLinks.href("all") : "tracker.html"; }
  if(window.RitehomeLinks && window.RitehomeLinks.href("approvals") === "/approvals" && /approvals\.html$/.test(location.pathname)){
    try { history.replaceState(history.state, "", "/approvals" + location.hash); } catch(e){}
  }
  $("forgetKeyBtn").addEventListener("click", function(){ client.auth.signOut().then(function(){ location.href = home(); }); });
  document.body.classList.add("gated", "connecting");
  client.auth.getSession().then(function(r){
    var session = r && r.data && r.data.session;
    if(!session){ $("gateLink").href = home(); return gate("Sign in first", "Sign in on the staff portal, then open Approvals from the menu.", true); }
    if(session.user && session.user.user_metadata && session.user.user_metadata.must_change_password){ $("gateLink").href = home(); return gate("Choose your password first", "Your account still has the temporary password. Open the portal's front page to choose your own.", true); }
    return rpc("my_roles").then(function(roles){
      roles = roles || [];
      if(window.RitehomeAccess) window.RitehomeAccess.apply(roles, client);
      if(!roles.length) return gate("This account hasn't been activated yet", "Ask the admin to switch it on in Team.");
      state.admin = roles.indexOf("admin") >= 0;
      return start();
    });
  }).catch(function(e){ gate("Couldn't open Approvals", e && e.message ? e.message : String(e)); });
})();
