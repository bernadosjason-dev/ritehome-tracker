/* Team accounts: lists people through team_list() (supabase/migrations/20261114000010_team.sql),
   changes roles and switches accounts on and off through team_update(), hands people their
   whiteboard rows through team_assign_in_charge(), and creates sign-ins / resets passwords
   through the team-admin Edge Function (the only place the service role key exists). Admin only. */
(function(){
  'use strict';
  var SUPABASE_URL = "https://laxavfldivkhufeubgmb.supabase.co";
  var SUPABASE_KEY = "sb_publishable_8vOuny8cDkb-vtwyOP7vnA_VqFYc5T1";
  var ROLES = [["designer", "Designer", "Design, initial cutlist, BOM and final cutlist on their own projects."],
    ["fabrication", "Workshop", "The fabrication stage on their own projects."],
    ["installer", "Installer", "Installation and handover on their own projects."],
    ["admin", "Admin", "Everything, including prices, billing, expenses, the books and this page."]];
  var WORDS = ["oak", "maple", "cedar", "pine", "hinge", "drawer", "panel", "shelf", "ember", "river", "harbor", "coral", "delta", "north", "cloud", "mango", "lamp", "tile", "brick", "sink"];
  function roleName(r){ var f = ROLES.filter(function(x){ return x[0] === r; })[0]; return f ? f[1] : r; }

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: false}});
  var state = {people: [], board: [], token: ""};

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
    return client.rpc(name, args || {}).then(function(r){ if(r.error) throw new Error(r.error.message || "The request failed."); return r.data; });
  }
  // The Edge Function: the signed-in admin's own token proves who is asking.
  function fn(body){
    return client.auth.getSession().then(function(r){
      var s = r && r.data && r.data.session;
      if(!s) throw new Error("Your sign-in has expired. Sign in again.");
      return fetch(SUPABASE_URL + "/functions/v1/team-admin", {method: "POST",
        headers: {"content-type": "application/json", apikey: SUPABASE_KEY, Authorization: "Bearer " + s.access_token},
        body: JSON.stringify(body)});
    }).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(j){
        if(!res.ok) throw new Error(j.error || "The account service answered " + res.status + ".");
        return j;
      });
    });
  }
  function msg(text, bad){
    var m = $("acctMsg"); m.textContent = text; m.hidden = !text; m.classList.toggle("bad", !!bad);
    clearTimeout(msg.t); if(text && !bad) msg.t = setTimeout(function(){ m.hidden = true; }, 5000);
  }
  function fail(e){ msg(e && e.message ? e.message : String(e), true); }
  function tempPassword(){
    var n = new Uint32Array(4); crypto.getRandomValues(n);
    return [WORDS[n[0] % WORDS.length], WORDS[n[1] % WORDS.length], WORDS[n[2] % WORDS.length]].join("-") + "-" + (10 + n[3] % 90);
  }
  function when(iso){
    if(!iso) return "Never";
    return new Date(iso).toLocaleString("en-PH", {month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila"});
  }
  function portalAddress(){ return location.hostname === "portal.ritehomemodular.com" ? "portal.ritehomemodular.com" : location.host; }

  // Whiteboard rows written under a person's name ("Jane" for Jane Dela Cruz), not finished.
  function boardRows(p){
    var first = String(p.full_name || "").trim().split(/\s+/)[0].toLowerCase(), full = String(p.full_name || "").trim().toLowerCase();
    if(!first) return [];
    return state.board.filter(function(b){
      var n = String(b.in_charge || "").trim().toLowerCase();
      return b.status !== "completed" && n && (n === first || n === full);
    });
  }

  // ---------- loading ----------
  function load(){
    return Promise.all([rpc("team_list"), rpc("schedule_board")]).then(function(r){
      state.people = r[0] || []; state.board = (r[1] && r[1].projects) || [];
      render();
    });
  }
  function render(){
    var active = state.people.filter(function(p){ return p.active; });
    var waiting = state.people.filter(function(p){ return p.active && p.must_change_password; });
    var off = state.people.filter(function(p){ return !p.active; });
    var k = [["Active accounts", String(active.length), active.filter(function(p){ return p.role !== "admin"; }).length + " staff, " + active.filter(function(p){ return p.role === "admin"; }).length + " admin"],
      ["Waiting for first sign-in", String(waiting.length), waiting.length ? "Still on a temporary password" : "Everyone has their own password", waiting.length > 0],
      ["Switched off", String(off.length), off.length ? "Can't sign in" : "Nobody"]];
    put("teamKpis", h("div", {style: "display:contents"}, k.map(function(x){
      return h("div", {class: "kpi"}, [h("span", {class: "label", text: x[0]}), h("span", {class: "val" + (x[3] ? " neg" : ""), text: x[1]}), h("span", {class: "sub", text: x[2]})]);
    })));
    $("peopleCount").textContent = String(state.people.length);
    put("peopleTable", h("table", {class: "acct-table people"}, [
      h("thead", null, h("tr", null, ["Person", "Role", "Status", "Last sign-in", "Projects", ""].map(function(t){ return h("th", {text: t}); }))),
      h("tbody", null, state.people.map(personRow))
    ]));
    put("roleGuide", h("div", {style: "display:contents"}, ROLES.map(function(r){ return h("div", null, [h("b", {text: r[1]}), h("p", {text: r[2]})]); })));
  }
  function personRow(p){
    var role = h("select", {"aria-label": "Role for " + p.full_name, disabled: p.me ? true : null},
      ROLES.map(function(r){ return h("option", {value: r[0], text: r[1]}); }));
    role.value = p.role;
    role.addEventListener("change", function(){
      rpc("team_update", {p_user: p.id, p: {role: role.value}}).then(function(){ msg(p.full_name + " is now " + roleName(role.value) + "."); return load(); }).catch(function(e){ role.value = p.role; fail(e); });
    });
    var status = !p.active ? h("span", {class: "pill bad", text: "Switched off"})
      : p.must_change_password ? h("span", {class: "pill warn", text: "Temporary password"})
      : h("span", {class: "pill good", text: "Active"});
    var mine = p.project_ids || [], rows = boardRows(p).filter(function(b){ return mine.indexOf(b.id) < 0; });
    var unassigned = rows.length && p.active && p.role !== "admin";
    var acts = [];
    if(unassigned) acts.push(h("button", {class: "btn small", type: "button", onclick: function(){ assign(p, rows); },
      text: "Give " + rows.length + " board row" + (rows.length === 1 ? "" : "s") + " (“" + rows[0].in_charge.trim() + "”)"}));
    if(!p.me) acts.push(h("button", {class: "btn ghost small", type: "button", onclick: function(){ resetPassword(p); }, text: "Reset password"}));
    if(!p.me) acts.push(h("button", {class: "btn ghost small" + (p.active ? " danger" : ""), type: "button", onclick: function(){ toggle(p); }, text: p.active ? "Switch off" : "Switch on"}));
    return h("tr", {class: p.active ? "" : "off", "data-person": p.email || p.id}, [
      h("td", {class: "who"}, [h("strong", {text: (p.full_name || "No name") + (p.me ? " (you)" : "")}), h("small", {text: p.email || "—"})]),
      h("td", null, role), h("td", null, status),
      h("td", {class: "muted", text: when(p.last_sign_in_at)}),
      h("td", {class: "num", text: String(p.projects || 0)}),
      h("td", {class: "acts-cell"}, h("div", {class: "acts"}, acts))
    ]);
  }

  // ---------- actions ----------
  function showHandover(name, email, password, rows){
    var card = $("handover"); card.hidden = false; card.textContent = "";
    var text = "Ritehome staff portal\n" + portalAddress() + "\nEmail: " + email + "\nTemporary password: " + password + "\nYou'll choose your own password when you sign in.";
    card.appendChild(h("h2", {text: "Give " + name + " these sign-in details"}));
    card.appendChild(h("p", {class: "muted small", text: "Tell them in person or send them privately. This password is shown only now, and works only until they choose their own at the first sign-in."}));
    card.appendChild(h("dl", {class: "handover-box"}, [h("dt", {text: "Address"}), h("dd", {text: portalAddress()}), h("dt", {text: "Email"}), h("dd", {text: email}),
      h("dt", {text: "Password"}), h("dd", {"data-temp-password": "", text: password})]));
    var copy = h("button", {class: "btn small", type: "button", text: "Copy all"});
    copy.addEventListener("click", function(){
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function(){ copy.textContent = "Copied"; }, function(){ copy.textContent = "Select and copy the details above"; });
    });
    card.appendChild(h("div", {class: "acct-actions"}, [copy,
      rows && rows.length ? h("span", {class: "muted small", text: rows.length + " whiteboard row" + (rows.length === 1 ? "" : "s") + " under “" + rows[0].in_charge.trim() + "” can be handed to them from the list below."}) : null,
      h("button", {class: "btn ghost small", type: "button", onclick: function(){ card.hidden = true; card.textContent = ""; }, text: "Done"})]));
    card.scrollIntoView({block: "start", behavior: "smooth"});
  }
  function addPerson(e){
    e.preventDefault();
    var body = {action: "create", full_name: $("pName").value.trim(), email: $("pEmail").value.trim(), role: $("pRole").value, password: $("pPassword").value};
    if(!body.full_name) return fail(new Error("Write the person's name."));
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email)) return fail(new Error("That email address doesn't look right."));
    if(body.password.length < 10) return fail(new Error("The temporary password needs at least 10 characters."));
    $("pSave").disabled = true;
    fn(body).then(function(){
      $("pSave").disabled = false; $("addCard").hidden = true; $("addForm").reset();
      msg("Account created for " + body.full_name + ".");
      return load().then(function(){
        var p = state.people.filter(function(x){ return (x.email || "").toLowerCase() === body.email.toLowerCase(); })[0];
        showHandover(body.full_name, body.email.toLowerCase(), body.password, p ? boardRows(p).filter(function(b){ return (p.project_ids || []).indexOf(b.id) < 0; }) : []);
      });
    }).catch(function(err){ $("pSave").disabled = false; fail(err); });
  }
  function resetPassword(p){
    var pw = tempPassword();
    if(!confirm("Give " + p.full_name + " a new temporary password? Their current password stops working right away.")) return;
    fn({action: "reset_password", user_id: p.id, password: pw}).then(function(){
      msg("New temporary password set for " + p.full_name + ".");
      showHandover(p.full_name, p.email, pw, null);
      return load();
    }).catch(fail);
  }
  function toggle(p){
    if(p.active && !confirm("Switch off " + p.full_name + "'s account? They can't sign in until you switch it back on. Nothing they did is deleted.")) return;
    rpc("team_update", {p_user: p.id, p: {active: !p.active}}).then(function(){ msg(p.full_name + (p.active ? " is switched off." : " can sign in again.")); return load(); }).catch(fail);
  }
  function assign(p, rows){
    var name = rows[0].in_charge.trim();
    rpc("team_assign_in_charge", {p_user: p.id, p_name: name}).then(function(n){
      msg(p.full_name + " now has " + n + " project" + (n === 1 ? "" : "s") + " from the whiteboard, and the " + roleName(p.role).toLowerCase() + " stages nobody else had.");
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
    var sel = $("pRole"); ROLES.forEach(function(r){ sel.appendChild(h("option", {value: r[0], text: r[1]})); });
    var hint = function(){ $("pRoleHint").textContent = ROLES.filter(function(r){ return r[0] === sel.value; })[0][2]; };
    sel.addEventListener("change", hint); hint();
    $("addPersonBtn").addEventListener("click", function(){
      $("addCard").hidden = !$("addCard").hidden;
      if(!$("addCard").hidden){ $("pPassword").value = tempPassword(); $("pName").focus(); }
    });
    $("pNewPw").addEventListener("click", function(){ $("pPassword").value = tempPassword(); });
    $("addCancel").addEventListener("click", function(){ $("addCard").hidden = true; });
    $("addForm").addEventListener("submit", addPerson);
    return load().then(function(){ $("gate").hidden = true; $("app").hidden = false; document.body.classList.remove("gated", "connecting"); });
  }
  function home(){ return window.RitehomeLinks ? window.RitehomeLinks.href("all") : "tracker.html"; }
  if(window.RitehomeLinks && window.RitehomeLinks.href("team") === "/team" && /team\.html$/.test(location.pathname)){
    try { history.replaceState(history.state, "", "/team" + location.hash); } catch(e){}
  }
  $("forgetKeyBtn").addEventListener("click", function(){ client.auth.signOut().then(function(){ location.href = home(); }); });
  document.body.classList.add("gated", "connecting");
  client.auth.getSession().then(function(r){
    var session = r && r.data && r.data.session;
    if(!session){ $("gateLink").href = home(); return gate("Sign in first", "Sign in on the staff portal, then open Team from the menu.", true); }
    if(session.user && session.user.user_metadata && session.user.user_metadata.must_change_password){ $("gateLink").href = home(); return gate("Choose your password first", "Your account still has the temporary password. Open the portal's front page to choose your own.", true); }
    return rpc("my_role").then(function(role){
      if(role !== "admin") return gate("Team accounts are for admins", role ? "Your account can use the Schedule." : "This account hasn't been activated yet.");
      return start();
    });
  }).catch(function(e){ gate("Couldn't open the team page", e && e.message ? e.message : String(e)); });
})();
