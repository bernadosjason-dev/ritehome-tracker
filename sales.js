/* Sales summary (sales.html at /sales; admin, sales and the bookkeeper). v4.8: the office's SALES SUMMARY workbooks.
   The data and every rule live in supabase/migrations/20261204000031_sales_summary.sql:
     sales_summary(year)          the year: contracts, months, salespeople, quotas, what to check
     sales_contract_save(p)       add (sales: their own) or change (admin: anything; bookkeeper and the salesperson: status, notes)
     sales_contract_cancel(id, r) admin; contracts are never deleted
     sales_contract_import(rows)  admin; the workbook is read in this browser by sales-import.js
     sales_quota_save(p)          admin; quotas start on a date */
(function(){
  'use strict';
  var SUPABASE_URL = "https://laxavfldivkhufeubgmb.supabase.co";
  var SUPABASE_KEY = "sb_publishable_8vOuny8cDkb-vtwyOP7vnA_VqFYc5T1";
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var STATUS = {ongoing: "Ongoing", awaiting_payment: "Waiting for payment", paid: "Paid", on_hold: "On hold", cancelled: "Cancelled"};

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: false}});
  var state = {year: null, data: null, roles: [], admin: false, books: false, me: null, parsed: null};

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
      if(r.error){ if(window.RitehomeRefused) window.RitehomeRefused(client, "Sales", name, r.error); throw new Error(r.error.message || "The request failed."); }
      return r.data;
    });
  }
  function msg(text, bad){
    var m = $("acctMsg"); m.textContent = text; m.hidden = !text; m.classList.toggle("bad", !!bad);
    clearTimeout(msg.t); if(text && !bad) msg.t = setTimeout(function(){ m.hidden = true; }, 6000);
  }
  function fail(e){ msg(e && e.message ? e.message : String(e), true); }
  function busy(b, on){ if(window.RitehomeBusy) window.RitehomeBusy(b, on); else b.disabled = on; }
  var pesoFmt = new Intl.NumberFormat("en-PH", {style: "currency", currency: "PHP", minimumFractionDigits: 2});
  function peso(n){ return pesoFmt.format(Number(n) || 0); }
  function day(d){ return d ? new Date(d + "T00:00:00+08:00").toLocaleDateString("en-PH", {month: "short", day: "numeric", timeZone: "Asia/Manila"}) : "—"; }
  function today(){ return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); }
  function plural(n, one, many){ return n + " " + (n === 1 ? one : many); }
  function canEdit(c){ return state.admin || state.books || c.salesperson_id === state.me; }

  function load(){
    return rpc("sales_summary", {p_year: state.year}).then(function(d){ state.data = d; state.me = d.me; render(); });
  }
  function render(){
    var d = state.data, contracts = d.contracts, live = contracts.filter(function(c){ return c.status !== "cancelled"; });
    var checks = d.check.missing_sc.length + d.check.no_amount.length + d.check.no_salesperson.length + d.undated.length;
    var curYear = Number(today().slice(0, 4)), curMonth = Number(today().slice(5, 7)), lastMonth = d.year < curYear ? 12 : d.year > curYear ? 0 : curMonth;
    $("slSub").textContent = d.year + ": " + peso(d.total) + " in " + plural(live.length, "contract", "contracts") + (checks ? " · " + plural(checks, "thing", "things") + " to check" : "");
    var kpis = [["Sales this year", peso(d.total), plural(live.length, "contract", "contracts") + (d.cancelled ? " · " + d.cancelled + " cancelled" : ""), true]];
    if(d.year === curYear) kpis.push(["This month", peso(d.months[curMonth - 1].total), plural(d.months[curMonth - 1].count, "contract", "contracts")]);
    var best = d.months.slice(0, Math.max(lastMonth, 1)).reduce(function(a, m){ return m.total > a.total ? m : a; }, {total: -1, month: 0});
    if(best.total > 0) kpis.push(["Best month", peso(best.total), MONTHS[best.month - 1]]);
    var tq = d.quota.team_quarter, q = Math.max(1, Math.ceil(Math.max(lastMonth, 1) / 3));
    if(tq[q - 1]){ var qt = d.months.slice((q - 1) * 3, q * 3).reduce(function(a, m){ return a + m.total; }, 0); kpis.push(["Team, quarter " + q, peso(qt), "Quota " + peso(tq[q - 1]) + " · " + Math.round(qt / tq[q - 1] * 100) + "%"]); }
    put("slKpis", h("div", {style: "display:contents"}, kpis.map(function(k){ return h("div", {class: "kpi" + (k[3] ? " lead" : "")}, [h("span", {class: "label", text: k[0]}), h("span", {class: "val", text: k[1]}), h("span", {class: "sub", text: k[2]})]); })));
    renderCheck(); renderPeople(lastMonth); renderMonths(); renderQuotas();
  }
  function renderCheck(){
    var c = state.data.check, u = state.data.undated, items = [];
    if(c.missing_sc.length) items.push("SC numbers skipped in the register: " + c.missing_sc.join(", ") + ". Each one is a contract that was never written down, or a number given out and not used.");
    if(c.no_amount.length) items.push("No amount: SC " + c.no_amount.join(", ") + ".");
    if(c.no_salesperson.length) items.push("No salesperson: SC " + c.no_salesperson.join(", ") + " (they count for nobody's quota).");
    if(u.length) items.push("No date (not in any month): SC " + u.map(function(x){ return x.sc_no; }).join(", ") + ".");
    $("checkCard").hidden = !items.length;
    put("checkBox", items.length ? h("ul", {class: "sl-check"}, items.map(function(t){ return h("li", {text: t}); })) : null);
  }
  function renderPeople(lastMonth){
    var d = state.data, pq = d.quota.person_month, any = pq.some(function(x){ return x != null; });
    $("peopleSub").textContent = any ? "Green: the month reached the individual quota (" + peso(pq[Math.max(lastMonth, 1) - 1] || pq.filter(function(x){ return x; }).pop()) + " a month). Cancelled contracts don't count." : "No individual quota set for " + d.year + " (Quotas, below).";
    if(!d.people.length) return put("peopleBox", h("p", {class: "muted", text: "No contracts in " + d.year + " yet."}));
    put("peopleBox", h("div", {class: "acct-scroll"}, h("table", {class: "acct-table sl-table sl-people"}, [
      h("thead", null, h("tr", null, [h("th", {text: "Salesperson"})].concat(MONTHS.map(function(m){ return h("th", {class: "num", text: m.slice(0, 3)}); }), [h("th", {class: "num", text: "Total"}), any ? h("th", {class: "num", text: "Months at quota"}) : null]))),
      h("tbody", null, d.people.map(function(p){
        var hits = p.months.filter(function(v, i){ return i < lastMonth && pq[i] && v >= pq[i]; }).length;
        return h("tr", {"data-person": p.salesperson}, [h("td", null, h("strong", {text: p.salesperson}))].concat(p.months.map(function(v, i){
          return h("td", {class: "num" + (pq[i] && v >= pq[i] ? " hit" : !v ? " zero" : ""), text: v ? peso(v).replace("₱", "") : "—"}); }),
          [h("td", {class: "num"}, h("strong", {text: peso(p.total)})), any ? h("td", {class: "num", text: hits + " of " + lastMonth}) : null]));
      }))])));
  }
  function renderMonths(){
    var d = state.data, by = {};
    d.contracts.forEach(function(c){ var m = Number(c.contract_date.slice(5, 7)); (by[m] = by[m] || []).push(c); });
    var months = Object.keys(by).map(Number).sort(function(a, b){ return a - b; });
    if(d.undated.length) by[0] = d.undated;
    if(!months.length && !d.undated.length) return put("monthsBox", h("p", {class: "muted", text: "No contracts in " + d.year + " yet." + (state.admin ? " Add one, or import the year's Excel summary below." : "")}));
    put("monthsBox", h("div", null, months.concat(d.undated.length ? [0] : []).map(function(m){
      var rows = by[m], total = rows.reduce(function(a, c){ return a + (c.status === "cancelled" ? 0 : Number(c.amount) || 0); }, 0);
      return h("div", {class: "sl-month", "data-month": String(m)}, [h("h3", null, [h("span", {text: m ? MONTHS[m - 1] : "No date"}), h("span", {text: peso(total) + " · " + plural(rows.filter(function(c){ return c.status !== "cancelled"; }).length, "contract", "contracts")})]),
        h("div", {class: "acct-scroll"}, h("table", {class: "acct-table sl-table"}, [
          h("thead", null, h("tr", null, ["Date", "SC no.", "Customer", "Project", "Amount", "Salesperson", "Status", ""].map(function(t, i){ return h("th", {class: i === 4 ? "num" : null, text: t}); }))),
          h("tbody", null, rows.map(function(c){
            return h("tr", {"data-sc": String(c.sc_no), class: c.status}, [h("td", {text: day(c.contract_date)}), h("td", {text: String(c.sc_no)}), h("td", {text: c.client}),
              h("td", {class: "sl-desc", text: c.description}), h("td", {class: "num", text: c.amount == null ? "—" : peso(c.amount)}),
              h("td", {text: c.salesperson || "—"}),
              h("td", null, [h("span", {class: "sl-pill " + c.status, text: STATUS[c.status] || c.status}), c.status_note ? h("div", {class: "muted", text: c.status_note}) : null]),
              h("td", null, canEdit(c) && (c.status !== "cancelled" || state.admin) ? h("button", {class: "btn ghost small", type: "button", text: "Edit", "aria-label": "Edit SC " + c.sc_no, onclick: function(){ form(c); }}) : null)]);
          }))]))]);
    })));
  }
  function names(){
    var seen = {}; (state.data.people || []).forEach(function(p){ if(p.salesperson !== "(not given)") seen[p.salesperson] = 1; });
    return Object.keys(seen).sort();
  }
  // Add or change a contract. Fields a person may not change are shown but locked (the database refuses them anyway).
  function form(c){
    var isNew = !c, full = state.admin || (isNew && state.books), lockSeller = !state.admin && !state.books;
    c = c || {sc_no: state.data.next_sc_no, contract_date: today(), client: "", description: "", amount: null, salesperson: "", status: "ongoing", status_note: ""};
    var f = {
      sc_no: h("input", {inputmode: "numeric", "aria-label": "SC number", value: String(c.sc_no || ""), disabled: !full}),
      contract_date: h("input", {type: "date", "aria-label": "Contract date", value: c.contract_date || "", disabled: !full && !isNew}),
      client: h("input", {"aria-label": "Customer", maxlength: "200", value: c.client, disabled: !full && !isNew}),
      description: h("input", {"aria-label": "Project", maxlength: "600", value: c.description}),
      amount: h("input", {inputmode: "decimal", "aria-label": "Amount", value: c.amount == null ? "" : String(c.amount), disabled: !full && !isNew}),
      salesperson: h("input", {"aria-label": "Salesperson", maxlength: "80", value: lockSeller && isNew ? "You" : c.salesperson, list: "slNames", disabled: lockSeller || (!full && !isNew)}),
      status: h("select", {"aria-label": "Status"}, Object.keys(STATUS).filter(function(k){ return k !== "cancelled" || c.status === "cancelled"; }).map(function(k){ return h("option", {value: k, text: STATUS[k]}); })),
      status_note: h("input", {"aria-label": "Status note", maxlength: "300", value: c.status_note, placeholder: "e.g. Ongoing/installation, waiting for 19 units' payment"})
    };
    f.status.value = c.status;
    var err = h("p", {class: "form-error", role: "alert"}), save = h("button", {class: "btn", type: "button", text: isNew ? "Add contract" : "Save"});
    save.addEventListener("click", function(){
      err.textContent = ""; busy(save, true);
      var p = {description: f.description.value, status: f.status.value, status_note: f.status_note.value};
      if(!isNew) p.id = c.id;
      if(isNew || full){ p.contract_date = f.contract_date.value; p.client = f.client.value; p.amount = f.amount.value.replace(/[,\s₱]/g, ""); }
      if(full){ p.sc_no = f.sc_no.value.trim(); p.salesperson = f.salesperson.value.trim(); }
      else if(isNew) p.sc_no = f.sc_no.value.trim();
      rpc("sales_contract_save", {p: p}).then(function(r){ $("formCard").hidden = true; msg("SC " + r.sc_no + (isNew ? " added." : " saved.")); return load(); })
        .catch(function(e){ busy(save, false); err.textContent = (e && e.message ? e.message : String(e)) + " Nothing you entered was lost."; });
    });
    var cancel = !isNew && state.admin && c.status !== "cancelled" ? h("button", {class: "btn ghost danger", type: "button", text: "Cancel contract…", onclick: function(e){
      var why = window.prompt("Cancel SC " + c.sc_no + "? It stays in the register, struck through. Why?", ""); if(why == null) return;
      var b = e.currentTarget; busy(b, true);
      rpc("sales_contract_cancel", {p_id: c.id, p_reason: why}).then(function(){ $("formCard").hidden = true; msg("SC " + c.sc_no + " cancelled."); return load(); }).catch(function(x){ busy(b, false); err.textContent = x.message; });
    }}) : null;
    put("formCard", h("div", {style: "display:contents"}, [
      h("h2", {text: isNew ? "New sales contract" : "SC " + c.sc_no + " · " + c.client}),
      !isNew && !state.admin ? h("p", {class: "muted small", text: "Only the admin changes the SC number, date, customer, amount or salesperson."}) : null,
      h("datalist", {id: "slNames"}, names().map(function(n){ return h("option", {value: n}); })),
      h("div", {class: "rec-form"}, [h("div", {class: "rec-row"}, [h("label", null, ["SC number", f.sc_no]), h("label", null, ["Date", f.contract_date]), h("label", null, ["Amount (₱)", f.amount])]),
        h("div", {class: "rec-row"}, [h("label", null, ["Customer", f.client]), h("label", null, ["Salesperson", f.salesperson])]),
        h("label", null, ["Project", f.description]),
        h("div", {class: "rec-row"}, [h("label", null, ["Status", f.status]), h("label", null, ["Status note", f.status_note])])]), err,
      h("div", {class: "acct-actions"}, [save, h("button", {class: "btn ghost", type: "button", text: "Close", onclick: function(){ $("formCard").hidden = true; }}), cancel])]));
    $("formCard").hidden = false; (isNew ? (full ? f.sc_no : f.client) : f.status).focus();
    $("formCard").scrollIntoView({block: "nearest"});
  }

  // ---------- import (admin) ----------
  function pick(e){
    var file = e.target.files && e.target.files[0]; e.target.value = "";
    if(!file) return;
    if(!/\.xlsx$/i.test(file.name)) return msg("Choose the .xlsx workbook (save it from Excel as .xlsx).", true);
    if(file.size > window.SalesImport.maxFileSize) return msg("That workbook is over 15 MB: it isn't a sales summary.", true);
    file.arrayBuffer().then(function(buf){
      var r = window.SalesImport.extract(window.SalesImport.readWorkbook(buf));
      state.parsed = r; preview();
    }).catch(fail);
  }
  function preview(){
    var r = state.parsed, curYear = Number(today().slice(0, 4));
    var dflt = h("select", {"aria-label": "Status for contracts without a note"}, [["paid", "Paid"], ["ongoing", "Ongoing"], ["awaiting_payment", "Waiting for payment"]].map(function(o){ return h("option", {value: o[0], text: o[1]}); }));
    dflt.value = r.year < curYear ? "paid" : "ongoing";
    var go = h("button", {class: "btn", type: "button", text: "Import " + plural(r.contracts.length, "contract", "contracts") + " for " + r.year});
    go.addEventListener("click", function(){
      busy(go, true);
      var rows = r.contracts.map(function(c){ return {sc_no: c.sc_no, contract_date: c.contract_date, client: c.client, description: c.description,
        amount: c.amount == null ? "" : String(c.amount), salesperson: c.salesperson, status: c.status || dflt.value, status_note: c.status_note}; });
      rpc("sales_contract_import", {p_rows: rows}).then(function(res){
        state.parsed = null; put("importBox", null);
        msg(r.year + ": " + plural(res.added, "contract", "contracts") + " imported" + (res.skipped.length ? "; already in the register, skipped: SC " + res.skipped.join(", ") : "") + ".", res.skipped.length > 0);
        state.year = r.year; $("slYear").value = String(r.year); return load();
      }).catch(function(e){ busy(go, false); fail(e); });
    });
    var noNote = r.contracts.filter(function(c){ return !c.status; }).length;
    put("importBox", h("div", {style: "display:contents"}, [
      h("p", {text: r.year + " · sheet \"" + r.sheet + "\": " + plural(r.contracts.length, "contract", "contracts") + ", " + peso(r.total) + (r.reserved.length ? " · " + r.reserved.length + " SC numbers reserved with no customer (not imported)" : "") + "."}),
      r.missing.length ? h("p", {class: "gov-warn", text: "SC numbers missing from the list: " + r.missing.join(", ") + "."}) : null,
      r.flagged ? h("p", {class: "gov-warn", text: plural(r.flagged, "row needs", "rows need") + " a look (marked below). Import, then fix them with Edit; nothing marked is guessed without saying so."}) : null,
      noNote ? h("div", {class: "rec-form"}, h("label", null, [plural(noNote, "contract has", "contracts have") + " no status note. Treat them as", dflt])) : null,
      h("div", {class: "acct-actions"}, [go, h("button", {class: "btn ghost", type: "button", text: "Discard", onclick: function(){ state.parsed = null; put("importBox", null); }})]),
      h("div", {class: "acct-scroll"}, h("table", {class: "acct-table sl-table"}, [
        h("thead", null, h("tr", null, ["SC no.", "Date", "Customer", "Amount", "Salesperson", "Status"].map(function(t, i){ return h("th", {class: i === 3 ? "num" : null, text: t}); }))),
        h("tbody", null, r.contracts.map(function(c){
          return h("tr", {"data-import": String(c.sc_no)}, [h("td", {text: String(c.sc_no)}), h("td", {text: c.contract_date ? day(c.contract_date) : "—"}),
            h("td", null, [c.client, c.flags.length ? h("ul", {class: "sl-flags"}, c.flags.map(function(x){ return h("li", {text: x}); })) : null]),
            h("td", {class: "num", text: c.amount == null ? "—" : peso(c.amount)}), h("td", {text: c.salesperson || "—"}), h("td", {text: c.status ? STATUS[c.status] : "(no note)"})]);
        }))]))]));
  }

  // ---------- quotas ----------
  function renderQuotas(){
    var hist = state.data.quota.history, SC = {person_month: "Each salesperson, a month", team_quarter: "The team, a quarter"};
    var list = hist.length ? h("ul", {class: "sl-check"}, hist.map(function(q){ return h("li", {text: "From " + q.effective_from + ": " + SC[q.scope] + " " + peso(q.amount) + (q.note ? " · " + q.note : "")}); }))
      : h("p", {class: "muted", text: "No quotas set yet."});
    if(!state.admin) return put("quotaBox", list);
    var from = h("input", {type: "date", "aria-label": "Quota starts on", value: state.data.year + "-01-01"}), scope = h("select", {"aria-label": "Quota for"}, Object.keys(SC).map(function(k){ return h("option", {value: k, text: SC[k]}); }));
    var amt = h("input", {inputmode: "decimal", "aria-label": "Quota amount", placeholder: "e.g. 500000"}), save = h("button", {class: "btn ghost", type: "button", text: "Save quota"});
    save.addEventListener("click", function(){
      busy(save, true);
      rpc("sales_quota_save", {p: {effective_from: from.value, scope: scope.value, amount: amt.value.replace(/[,\s₱]/g, "")}}).then(function(){ msg("Quota saved."); return load(); })
        .catch(function(e){ busy(save, false); fail(e); });
    });
    put("quotaBox", h("div", {style: "display:contents"}, [list, h("div", {class: "rec-form sl-form"}, h("div", {class: "rec-row"}, [h("label", null, ["Starts on", from]), h("label", null, ["For", scope]), h("label", null, ["Amount (₱)", amt])])),
      h("div", {class: "acct-actions"}, save)]));
  }

  function start(){
    var y = Number(today().slice(0, 4)), sel = $("slYear");
    for(var i = y + 1; i >= 2020; i--) sel.appendChild(h("option", {value: String(i), text: String(i)}));
    state.year = y; sel.value = String(y);
    sel.addEventListener("change", function(){ state.year = Number(sel.value); load().catch(fail); });
    $("slAdd").addEventListener("click", function(){ form(null); });
    $("importCard").hidden = !state.admin;
    $("slFile").addEventListener("change", pick);
    return load().then(function(){ $("gate").hidden = true; $("app").hidden = false; document.body.classList.remove("gated", "connecting"); });
  }
  function gate(title, text, signIn){
    $("gateTitle").textContent = title; $("gateText").textContent = text || "";
    $("gateLinkRow").hidden = !signIn; $("gate").hidden = false; $("app").hidden = true;
    document.body.classList.remove("connecting");
  }
  function home(){ return window.RitehomeLinks ? window.RitehomeLinks.href("all") : "tracker.html"; }
  if(window.RitehomeLinks && window.RitehomeLinks.href("sales") === "/sales" && /sales\.html$/.test(location.pathname)){
    try { history.replaceState(history.state, "", "/sales" + location.hash); } catch(e){}
  }
  $("forgetKeyBtn").addEventListener("click", function(){ client.auth.signOut().then(function(){ location.href = home(); }); });
  document.body.classList.add("gated", "connecting");
  client.auth.getSession().then(function(r){
    var session = r && r.data && r.data.session;
    if(!session){ $("gateLink").href = home(); return gate("Sign in first", "Sign in on the staff portal, then open Sales summary from the menu.", true); }
    if(session.user && session.user.user_metadata && session.user.user_metadata.must_change_password){ $("gateLink").href = home(); return gate("Choose your password first", "Your account still has the temporary password. Open the portal's front page to choose your own.", true); }
    return rpc("my_roles").then(function(roles){
      roles = roles || [];
      if(window.RitehomeAccess) window.RitehomeAccess.apply(roles, client);
      if(!roles.length) return gate("This account hasn't been activated yet", "Ask the admin to switch it on in Team.");
      state.roles = roles; state.admin = roles.indexOf("admin") >= 0; state.books = roles.indexOf("bookkeeper") >= 0;
      if(!state.admin && !state.books && roles.indexOf("sales") < 0) return gate("Sales summary is for sales, the bookkeeper and the admin", "Ask the admin if you need it.");
      return start();
    });
  }).catch(function(e){ gate("Couldn't open Sales summary", e && e.message ? e.message : String(e)); });
})();
