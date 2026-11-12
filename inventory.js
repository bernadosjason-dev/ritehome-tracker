/* Inventory: stock on hand and every time it was added or used.
   One read (inventory_board()) and two writes (inventory_item_save(), inventory_move()), all in
   supabase/migrations/20261115000012_inventory.sql. For the purchaser and the admin. */
(function(){
  'use strict';
  var SUPABASE_URL = "https://laxavfldivkhufeubgmb.supabase.co";
  var SUPABASE_KEY = "sb_publishable_8vOuny8cDkb-vtwyOP7vnA_VqFYc5T1";
  var CATS = [["board", "Boards"], ["edgeband", "Edgebanding"], ["hardware", "Hardware"], ["accessory", "Accessories"],
    ["countertop", "Countertops"], ["consumable", "Consumables"], ["other", "Other"]];
  var CAT = {}; CATS.forEach(function(c){ CAT[c[0]] = c[1]; });
  var KIND = {receive: ["Add stock", "Add", "Added"], issue: ["Use stock", "Minus", "Used"], count: ["Count stock", "Save count", "Counted"]};

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: false}});
  var state = {items: [], moves: [], jobs: [], cat: "", editing: null, flash: null};

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
      if(r.error){ if(window.RitehomeRefused) window.RitehomeRefused(client, "Inventory", name, r.error); throw new Error(r.error.message || "The request failed."); }
      return r.data;
    });
  }
  function msg(text, bad){
    var m = $("acctMsg"); m.textContent = text; m.hidden = !text; m.classList.toggle("bad", !!bad);
    clearTimeout(msg.t); if(text && !bad) msg.t = setTimeout(function(){ m.hidden = true; }, 5000);
  }
  function fail(e){ msg(e && e.message ? e.message : String(e), true); }
  function busy(b, on){ if(window.RitehomeBusy) window.RitehomeBusy(b, on); else if(b) b.disabled = !!on; }
  function num(n){ return (Math.round(Number(n) * 100) / 100).toLocaleString("en-PH", {maximumFractionDigits: 2}); }
  function label(i){ return i.name + (i.spec ? " " + i.spec : ""); }
  function when(iso){ return new Date(iso).toLocaleString("en-PH", {month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila"}); }
  function level(i){ return i.on_hand <= 0 ? "out" : i.reorder_level > 0 && i.on_hand <= i.reorder_level ? "low" : "ok"; }

  // ---------- loading ----------
  function load(){
    return rpc("inventory_board").then(function(b){
      state.items = (b && b.items) || []; state.moves = (b && b.moves) || []; state.jobs = (b && b.jobs) || [];
      render();
    });
  }
  function render(){
    var low = state.items.filter(function(i){ return level(i) !== "ok"; }), out = low.filter(function(i){ return level(i) === "out"; });
    var week = Date.now() - 7 * 864e5, recent = state.moves.filter(function(m){ return new Date(m.at).getTime() >= week; });
    var used = recent.filter(function(m){ return m.qty < 0; }).length, added = recent.filter(function(m){ return m.qty > 0; }).length;
    var k = [["Low or out of stock", String(low.length), low.length ? (out.length ? out.length + " out, " : "") + (low.length - out.length) + " low" : "Nothing needs buying", low.length > 0],
      ["Items on the list", String(state.items.length), state.items.length ? "Tap Add or Minus on a row" : "Add your first item"],
      ["This week", used + " used", added + " added"]];
    put("invKpis", h("div", {style: "display:contents"}, k.map(function(x){
      return h("div", {class: "kpi"}, [h("span", {class: "label", text: x[0]}), h("span", {class: "val" + (x[3] ? " neg" : ""), text: x[1]}), h("span", {class: "sub", text: x[2]})]);
    })));
    renderCats(); renderStock(); renderMoves();
  }
  function renderCats(){
    var counts = {}; state.items.forEach(function(i){ counts[i.category] = (counts[i.category] || 0) + 1; });
    var chips = [["", "All", state.items.length]].concat(CATS.filter(function(c){ return counts[c[0]]; }).map(function(c){ return [c[0], c[1], counts[c[0]]]; }));
    put("catBar", h("div", {style: "display:contents"}, chips.length > 2 ? chips.map(function(c){
      return h("button", {type: "button", "aria-pressed": state.cat === c[0] ? "true" : "false", "data-cat": c[0] || "all",
        onclick: function(){ state.cat = c[0]; renderCats(); renderStock(); }}, [c[1], h("b", {text: String(c[2])})]);
    }) : null));
  }
  function shown(){
    var q = $("fSearch").value.trim().toLowerCase(), onlyLow = $("fLow").checked;
    return state.items.filter(function(i){
      if(state.cat && i.category !== state.cat) return false;
      if(onlyLow && level(i) === "ok") return false;
      return !q || (i.name + " " + i.spec + " " + i.location + " " + CAT[i.category]).toLowerCase().indexOf(q) >= 0;
    });
  }
  function renderStock(){
    var rows = shown();
    $("stockCount").textContent = state.items.length ? String(rows.length) : "";
    if(!state.items.length){
      put("stockTable", h("p", {class: "muted", text: "Nothing on the list yet. Add the boards, edgebanding and hardware you keep in the workshop, with what's on the shelf today."}));
      return;
    }
    if(!rows.length){ put("stockTable", h("p", {class: "muted", text: "No items match."})); return; }
    var body = rows.map(function(i){
      var lv = level(i), glow = state.flash === i.id ? (state.flash = null, " just-saved") : "";
      return h("tr", {class: lv + glow, "data-item": label(i)}, [
        h("td", {class: "what"}, [h("strong", {text: i.name}), h("small", {text: [i.spec, CAT[i.category]].filter(Boolean).join(" · ")})]),
        h("td", {class: "qty"}, [num(i.on_hand), h("small", {text: i.unit})]),
        h("td", null, h("span", {class: "pill " + (lv === "out" ? "bad" : lv === "low" ? "warn" : "good"),
          text: lv === "out" ? "Out" : lv === "low" ? "Low · reorder at " + num(i.reorder_level) : "In stock"})),
        h("td", {class: "where muted", text: i.location}),
        h("td", {class: "acts-cell"}, h("div", {class: "acts no-print"}, [
          h("button", {class: "btn ghost small", type: "button", text: "+ Add", "aria-label": "Add stock: " + label(i), onclick: function(){ openMove(i, "receive"); }}),
          h("button", {class: "btn ghost small", type: "button", text: "− Minus", "aria-label": "Minus stock: " + label(i), disabled: i.on_hand <= 0, onclick: function(){ openMove(i, "issue"); }}),
          h("button", {class: "btn ghost small", type: "button", text: "Edit", "aria-label": "Edit " + label(i), onclick: function(){ openItem(i); }})]))
      ]);
    });
    put("stockTable", h("div", {class: "acct-scroll"}, h("table", {class: "acct-table stock"}, [
      h("thead", null, h("tr", null, ["Item", "On hand", "Status", "Kept at", ""].map(function(t){ return h("th", {text: t}); }))),
      h("tbody", null, body)])));
  }
  function renderMoves(){
    $("moveCount").textContent = state.moves.length ? String(state.moves.length) : "";
    if(!state.moves.length){ put("moveTable", h("p", {class: "muted", text: "Nothing added or used yet."})); return; }
    put("moveTable", h("div", {class: "acct-scroll"}, h("table", {class: "acct-table moves"}, [
      h("thead", null, h("tr", null, ["When", "Item", "Change", "For", "By"].map(function(t){ return h("th", {text: t}); }))),
      h("tbody", null, state.moves.map(function(m){
        return h("tr", null, [h("td", {class: "muted", text: when(m.at)}),
          h("td", null, [m.item, m.spec ? h("span", {class: "muted", text: " " + m.spec}) : null]),
          h("td", {class: "chg " + (m.qty > 0 ? "plus" : "minus"), text: (m.qty > 0 ? "+" : "−") + num(Math.abs(m.qty)) + " " + m.unit + (m.kind === "adjust" ? " (count)" : "")}),
          h("td", null, [m.job, m.job && m.note ? " · " : "", m.note ? h("span", {class: "muted", text: m.note}) : null]),
          h("td", {class: "muted", text: m.by})]);
      }))])));
  }

  // ---------- add, minus, count ----------
  function openMove(i, kind){
    $("itemCard").hidden = true;
    var qty = h("input", {type: "number", min: "0", step: "any", inputmode: "decimal", required: true, "aria-label": "Quantity", value: kind === "count" ? String(i.on_hand) : ""});
    var job = kind === "issue" ? h("input", {maxlength: "120", list: "mJobs", placeholder: "Client or job name", "aria-label": "For which job"}) : null;
    var note = h("input", {maxlength: "300", placeholder: kind === "receive" ? "Supplier or receipt no." : kind === "issue" ? "What it's for" : "Why it changed", "aria-label": "Note"});
    var after = h("span", {class: "after"});
    var save = h("button", {class: "btn", type: "submit", text: KIND[kind][1]});
    function preview(){
      var q = Number(qty.value), next = kind === "receive" ? i.on_hand + q : kind === "issue" ? i.on_hand - q : q;
      after.textContent = ""; after.className = "after" + (next < 0 ? " bad" : "");
      if(qty.value === "" || !(q >= 0)) return;
      after.appendChild(document.createTextNode(next < 0 ? "Only " + num(i.on_hand) + " " + i.unit + " on hand " : "After: "));
      if(next >= 0){ after.appendChild(h("b", {text: num(next)})); after.appendChild(document.createTextNode(" " + i.unit)); }
    }
    qty.addEventListener("input", preview);
    var form = h("form", {class: "acct-grid", novalidate: true, onsubmit: function(e){
      e.preventDefault();
      var q = Number(qty.value);
      if(qty.value === "" || !(kind === "count" ? q >= 0 : q > 0)) return fail(new Error("Enter a quantity."));
      busy(save, true);
      rpc("inventory_move", {p_item: i.id, p_kind: kind, p_qty: q, p_job: job ? job.value : "", p_note: note.value}).then(function(left){
        $("moveCard").hidden = true; state.flash = i.id;
        msg(kind === "count" ? label(i) + " counted: " + num(left) + " " + i.unit + " on hand."
          : KIND[kind][2] + " " + num(q) + " " + i.unit + " of " + label(i) + (job && job.value.trim() ? " for " + job.value.trim() : "") + ". " + num(left) + " on hand.");
        return load();
      }).catch(function(err){ busy(save, false); fail(err); });
    }}, [
      h("label", null, [kind === "count" ? "Counted on the shelf (" + i.unit + ")" : "How many (" + i.unit + ")", qty]),
      job ? h("label", null, ["For which job", job]) : null,
      h("label", {class: job ? null : "wide"}, ["Note", note]),
      h("div", {class: "wide acct-actions"}, [save, h("button", {class: "btn ghost", type: "button", text: "Cancel", onclick: function(){ $("moveCard").hidden = true; }}),
        kind !== "count" ? h("button", {class: "btn ghost", type: "button", text: "Count instead", onclick: function(){ openMove(i, "count"); }}) : null]),
      job ? h("datalist", {id: "mJobs"}, state.jobs.map(function(j){ return h("option", {value: j}); })) : null
    ]);
    put("moveCard", h("div", null, [h("h2", {text: KIND[kind][0] + ": " + label(i)}),
      h("p", {class: "move-now"}, [h("span", null, ["On hand now: ", h("b", {text: num(i.on_hand)}), " " + i.unit]), after]), form]));
    $("moveCard").hidden = false; preview();
    $("moveCard").scrollIntoView({block: "nearest"}); qty.focus(); if(kind === "count") qty.select();
  }

  // ---------- the list itself ----------
  function openItem(i){
    state.editing = i || null;
    $("moveCard").hidden = true;
    $("itemTitle").textContent = i ? "Edit " + label(i) : "Add an item";
    $("iName").value = i ? i.name : ""; $("iSpec").value = i ? i.spec : ""; $("iCategory").value = i ? i.category : "board";
    $("iUnit").value = i ? i.unit : ""; $("iLocation").value = i ? i.location : ""; $("iReorder").value = i && i.reorder_level ? i.reorder_level : "";
    $("iStart").value = ""; $("iStartWrap").hidden = !!i; $("iRemove").hidden = !i;
    $("itemCard").hidden = false; $("itemCard").scrollIntoView({block: "nearest"}); $("iName").focus();
  }
  function saveItem(e){
    e.preventDefault();
    var i = state.editing, name = $("iName").value.trim(), start = Number($("iStart").value);
    if(!name) return fail(new Error("Give the item a name."));
    var p = {name: name, spec: $("iSpec").value, category: $("iCategory").value, unit: $("iUnit").value, location: $("iLocation").value, reorder_level: $("iReorder").value || "0"};
    if(i) p.id = i.id;
    busy($("iSave"), true);
    rpc("inventory_item_save", {p: p}).then(function(id){
      return !i && start > 0 ? rpc("inventory_move", {p_item: id, p_kind: "receive", p_qty: start, p_job: "", p_note: "Opening stock"}).then(function(){ return id; }) : id;
    }).then(function(id){
      busy($("iSave"), false); $("itemCard").hidden = true; state.flash = id;
      msg(name + (i ? " saved." : " added to the list."));
      return load();
    }).catch(function(err){ busy($("iSave"), false); fail(err); });
  }
  function removeItem(){
    var i = state.editing; if(!i) return;
    if(!confirm("Remove " + label(i) + " from the list? Its history is kept.")) return;
    rpc("inventory_item_save", {p: {id: i.id, name: i.name, active: false}}).then(function(){
      $("itemCard").hidden = true; msg(label(i) + " removed from the list."); return load();
    }).catch(fail);
  }

  // ---------- start ----------
  function gate(title, text, link){
    $("gate").hidden = false; $("app").hidden = true;
    $("gateTitle").textContent = title; $("gateText").textContent = text || ""; $("gateLinkRow").hidden = !link;
    document.body.classList.add("gated"); document.body.classList.remove("connecting");
  }
  function start(){
    CATS.forEach(function(c){ $("iCategory").appendChild(h("option", {value: c[0], text: c[1]})); });
    $("addItemBtn").addEventListener("click", function(){ if($("itemCard").hidden || state.editing) openItem(null); else $("itemCard").hidden = true; });
    $("iCancel").addEventListener("click", function(){ $("itemCard").hidden = true; });
    $("iRemove").addEventListener("click", removeItem);
    $("itemForm").addEventListener("submit", saveItem);
    $("fSearch").addEventListener("input", renderStock); $("fLow").addEventListener("change", renderStock);
    return load().then(function(){ $("gate").hidden = true; $("app").hidden = false; document.body.classList.remove("gated", "connecting"); });
  }
  function home(){ return window.RitehomeLinks ? window.RitehomeLinks.href("all") : "tracker.html"; }
  if(window.RitehomeLinks && window.RitehomeLinks.href("inventory") === "/inventory" && /inventory\.html$/.test(location.pathname)){
    try { history.replaceState(history.state, "", "/inventory" + location.hash); } catch(e){}
  }
  $("forgetKeyBtn").addEventListener("click", function(){ client.auth.signOut().then(function(){ location.href = home(); }); });
  document.body.classList.add("gated", "connecting");
  client.auth.getSession().then(function(r){
    var session = r && r.data && r.data.session;
    if(!session){ $("gateLink").href = home(); return gate("Sign in first", "Sign in on the staff portal, then open Inventory from the menu.", true); }
    if(session.user && session.user.user_metadata && session.user.user_metadata.must_change_password){ $("gateLink").href = home(); return gate("Choose your password first", "Your account still has the temporary password. Open the staff portal to set your own.", true); }
    return rpc("my_roles").then(function(roles){
      roles = roles || [];
      if(window.RitehomeAccess) window.RitehomeAccess.apply(roles, client);
      if(roles.indexOf("admin") < 0 && roles.indexOf("purchaser") < 0) return gate("Inventory is for the purchaser and the admin", roles.length ? "Your account can use the Schedule." : "This account hasn't been activated yet.");
      return start();
    });
  }).catch(function(e){ gate("Couldn't open the inventory", e && e.message ? e.message : String(e)); });
})();
