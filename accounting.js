/* Accounting page: reads and writes the in-house books only through the Supabase functions in
   supabase/migrations/20261111000005_accounting.sql. Every figure is computed in the database;
   this file formats, totals for display, and exports. Admin only: the database enforces it too. */
(function(){
  'use strict';
  var SUPABASE_URL = "https://laxavfldivkhufeubgmb.supabase.co";
  var SUPABASE_KEY = "sb_publishable_8vOuny8cDkb-vtwyOP7vnA_VqFYc5T1";
  var COMPANY = "Ritehome Modular Systems";
  var TYPE_LABEL = {asset: "Assets", liability: "Liabilities", equity: "Equity", revenue: "Revenue", cost_of_sales: "Cost of sales", expense: "Operating expenses"};
  var TYPE_ONE = {asset: "Asset", liability: "Liability", equity: "Equity", revenue: "Revenue", cost_of_sales: "Cost of sales", expense: "Expense"};
  var ISSUE_LABEL = {undated_payment: "Payment without a date", undated_purchase: "Purchase without a date", bad_amount: "Amount isn't a number",
    unmapped_category: "Category without an account", vat_unconfirmed: "VAT treatment not confirmed", before_books_start: "Before the books start"};
  var SOURCE_LABEL = {journal: "Journal", expense: "Expense", fuel: "Fuel", payment: "Payment"};
  var CATEGORY_KEYS = ["materials", "labor", "transportation", "food", "other"];

  function home(){ return window.RitehomeLinks ? window.RitehomeLinks.href("all") : "tracker.html"; }
  if(window.RitehomeLinks && window.RitehomeLinks.href("accounting") === "/accounting" && /accounting\.html$/.test(location.pathname)){
    try { history.replaceState(history.state, "", "/accounting" + location.hash); } catch(e){}
  }
  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: false}
  });
  var state = {config: null, accounts: [], byCode: {}, projectName: {}, tab: "", lines: [], tags: null, csv: {}};

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
      if(r.error) throw new Error(r.error.message || "The request failed.");
      return r.data;
    });
  }
  function todayISO(){ var d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function yearOf(iso){ return Number(String(iso).slice(0, 4)); }
  function num(n){ return Math.round((Number(n) || 0) * 100) / 100; }
  function money(n){ return num(n).toLocaleString("en-PH", {minimumFractionDigits: 2, maximumFractionDigits: 2}); }
  function peso(n){ return (num(n) < 0 ? "-₱" : "₱") + money(Math.abs(num(n))); }
  function acc(n){ n = num(n); return n < 0 ? "(" + money(-n) + ")" : money(n); }
  function dateFmt(iso){
    if(!iso) return "—";
    var p = String(iso).slice(0, 10).split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).toLocaleDateString("en-PH", {year: "numeric", month: "short", day: "numeric"});
  }
  function sum(list, f){ return list.reduce(function(s, x){ return s + (Number(f(x)) || 0); }, 0); }
  function pct(a, b){ return b ? (Math.round(a / b * 1000) / 10).toFixed(1) + "%" : "—"; }
  function acctName(code){ var a = state.byCode[code]; return a ? a.name : code; }
  function msg(text, bad){
    var m = $("acctMsg");
    m.textContent = text; m.hidden = !text; m.classList.toggle("bad", !!bad);
    clearTimeout(msg.t);
    if(text && !bad) msg.t = setTimeout(function(){ m.hidden = true; }, 5000);
  }
  function fail(e){ msg(e && e.message ? e.message : String(e), true); }
  function table(head, rows, opts){
    opts = opts || {};
    var t = h("table", {class: "acct-table"});
    if(head) t.appendChild(h("thead", null, h("tr", null, head.map(function(c){
      return h("th", {class: /^(Debit|Credit|Amount|Balance|Contract|Paid|Owed|Total|Output|Input|VAT|Tax|Sales|Non-VAT|VATable)/.test(c) ? "num" : null, text: c});
    }))));
    var tb = h("tbody"); rows.forEach(function(r){ tb.appendChild(r); }); t.appendChild(tb);
    return h("div", {class: "acct-scroll"}, t);
  }
  function tr(cells, cls){
    return h("tr", {class: cls || null}, cells.map(function(c){
      if(c && c.nodeType) return c;
      if(c && typeof c === "object") return h("td", {class: c.cls || null, colspan: c.span || null}, c.node || c.text);
      return h("td", {text: c == null ? "" : c});
    }));
  }
  function n(v, cls){ return {cls: "num" + (cls ? " " + cls : ""), text: v}; }

  // ---------- CSV ----------
  function csvText(rows){
    return "﻿" + rows.map(function(r){
      return r.map(function(c){
        var s = c == null ? "" : String(c);
        if(/^[=+\-@]/.test(s) && isNaN(Number(s))) s = "'" + s;   // never let a spreadsheet run a formula
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(",");
    }).join("\r\n") + "\r\n";
  }
  function download(name, rows){
    var url = URL.createObjectURL(new Blob([csvText(rows)], {type: "text/csv;charset=utf-8"}));
    var a = h("a", {href: url, download: name}); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  }
  function c2(v){ return num(v).toFixed(2); }

  // ---------- account pickers ----------
  function fillAccounts(select, opts){
    opts = opts || {};
    var cur = select.value;
    select.textContent = "";
    if(opts.blank) select.appendChild(h("option", {value: "", text: opts.blank}));
    ["asset", "liability", "equity", "revenue", "cost_of_sales", "expense"].forEach(function(t){
      var g = h("optgroup", {label: TYPE_LABEL[t]});
      state.accounts.forEach(function(a){
        if(a.type === t && (a.active || opts.inactive || a.code === cur)) g.appendChild(h("option", {value: a.code, text: a.code + " " + a.name + (a.active ? "" : " (inactive)")}));
      });
      if(g.children.length) select.appendChild(g);
    });
    if(cur) select.value = cur;
  }
  function loadConfig(){
    return rpc("acct_config").then(function(c){
      state.config = c;
      state.accounts = c.accounts || [];
      state.byCode = {}; state.accounts.forEach(function(a){ state.byCode[a.code] = a; });
      state.projectName = {}; (c.projects || []).forEach(function(p){ state.projectName[p.id] = p.name; });
      document.querySelectorAll("select[data-account]").forEach(function(s){ fillAccounts(s); });
      fillAccounts($("ledAccount"), {inactive: true});
      var proj = $("entryProject"), pv = proj.value; proj.textContent = "";
      proj.appendChild(h("option", {value: "", text: "None"}));
      (c.projects || []).forEach(function(p){ proj.appendChild(h("option", {value: p.id, text: p.name})); });
      proj.value = pv;
      fillSettings();
    });
  }

  // ---------- status ----------
  function loadStatus(){
    var asOf = $("statusAsOf").value || todayISO(), y = yearOf(asOf), q = Math.floor((Number(asOf.slice(5, 7)) - 1) / 3) + 1;
    return Promise.all([
      rpc("acct_trial_balance", {p_as_of: asOf}), rpc("acct_income_statement", {p_from: y + "-01-01", p_to: asOf}),
      rpc("acct_vat_quarters", {p_year: y}), rpc("acct_receivables"), rpc("acct_data_issues")
    ]).then(function(r){
      var tb = r[0], is = r[1], vat = r[2], ar = r[3], issues = r[4];
      var cash = sum(tb.filter(function(x){ return /^10/.test(x.code); }), function(x){ return x.debit - x.credit; });
      var owed = sum(ar.filter(function(x){ return x.balance > 0; }), function(x){ return x.balance; });
      var rev = sum(is.filter(function(x){ return x.type === "revenue"; }), function(x){ return x.amount; });
      var cost = sum(is.filter(function(x){ return x.type !== "revenue"; }), function(x){ return x.amount; });
      var cogs = sum(is.filter(function(x){ return x.type === "cost_of_sales"; }), function(x){ return x.amount; });
      var qv = vat.find(function(x){ return x.quarter === q; }) || {};
      var cwt = sum(vat.filter(function(x){ return x.quarter <= q; }), function(x){ return x.tax_withheld_by_clients; });
      var kpis = [
        ["Cash and bank", peso(cash), "Accounts 10xx as of " + dateFmt(asOf), cash < 0],
        ["Owed by clients", peso(owed), (function(k){ return k === 1 ? "1 project with a balance" : k + " projects with a balance"; })(ar.filter(function(x){ return x.balance > 0; }).length)],
        ["Sales, " + y + " to date", peso(rev), "Gross margin " + pct(rev - cogs, rev)],
        ["Net income, " + y + " to date", peso(rev - cost), "Net margin " + pct(rev - cost, rev), rev - cost < 0],
        ["VAT still due, Q" + q, peso(qv.vat_still_due), "Output " + peso(qv.output_vat) + " − input " + peso(qv.input_vat), false],
        ["Tax withheld by clients", peso(cwt), y + " to date; credit against income tax"]
      ];
      put("statusKpis", h("div", {style: "display:contents"}, kpis.map(function(k){
        return h("div", {class: "kpi"}, [h("span", {class: "label", text: k[0]}), h("span", {class: "val" + (k[3] ? " neg" : ""), text: k[1]}), h("span", {class: "sub", text: k[2]})]);
      })));
      $("issueCount").textContent = issues.length ? String(issues.length) : "";
      var ul = $("issueList"); ul.textContent = "";
      if(!issues.length) ul.appendChild(h("li", {class: "ok", text: "Nothing to fix. Every tracker record is in the books."}));
      issues.slice(0, 80).forEach(function(i){
        ul.appendChild(h("li", null, [h("b", {text: ISSUE_LABEL[i.kind] || i.kind}), i.detail,
          i.kind === "vat_unconfirmed" ? [" ", h("a", {href: "#tags", text: "Set it"})] : null]));
      });
      if(issues.length > 80) ul.appendChild(h("li", {text: (issues.length - 80) + " more."}));
      var arRows = ar.map(function(x){
        return tr([x.project_name, h("td", null, h("span", {class: "pill " + (x.status === "completed" ? "warn" : "neutral"), text: x.status})),
          n(money(x.contract_price)), n(money(x.settled)), n(acc(x.balance), x.balance > 0 ? "" : "muted")]);
      });
      arRows.push(tr([{text: "Total", span: 2}, n(money(sum(ar, function(x){ return x.contract_price; }))), n(money(sum(ar, function(x){ return x.settled; }))), n(acc(owed))], "total"));
      put("arTable", ar.length ? table(["Project", "Status", "Contract", "Paid + withheld", "Owed"], arRows) : h("p", {class: "muted", text: "No unpaid balances."}));
    });
  }

  // ---------- trial balance ----------
  function loadTB(){
    var asOf = $("tbAsOf").value || todayISO();
    $("tbTitleDate").textContent = "as of " + dateFmt(asOf);
    return rpc("acct_trial_balance", {p_as_of: asOf}).then(function(rows){
      var dr = num(sum(rows, function(r){ return r.debit; })), cr = num(sum(rows, function(r){ return r.credit; }));
      var body = rows.map(function(r){ return tr([{cls: "code", text: r.code}, r.name, n(r.debit ? money(r.debit) : ""), n(r.credit ? money(r.credit) : "")]); });
      body.push(tr(["", "Total", n(money(dr)), n(money(cr))], "grand"));
      put("tbTable", rows.length ? table(["Code", "Account", "Debit", "Credit"], body) : h("p", {class: "muted", text: "Nothing in the books yet for this date."}));
      put("tbCheck", h("span", {class: "pill " + (dr === cr ? "good" : "bad"), text: dr === cr ? "Balanced" : "Out by " + peso(dr - cr)}));
      state.csv.tb = {name: "ritehome-trial-balance-" + asOf + ".csv", rows: [[COMPANY], ["Trial balance as of " + asOf], [], ["Code", "Account", "Type", "Debit", "Credit"]]
        .concat(rows.map(function(r){ return [r.code, r.name, TYPE_ONE[r.type], c2(r.debit), c2(r.credit)]; }))
        .concat([["", "Total", "", c2(dr), c2(cr)]])};
    });
  }

  // ---------- income statement ----------
  function isSections(rows){
    var by = function(t){ return rows.filter(function(r){ return r.type === t; }); };
    var rev = by("revenue"), cos = by("cost_of_sales"), exp = by("expense");
    var tRev = num(sum(rev, function(r){ return r.amount; })), tCos = num(sum(cos, function(r){ return r.amount; })), tExp = num(sum(exp, function(r){ return r.amount; }));
    return {rev: rev, cos: cos, exp: exp, tRev: tRev, tCos: tCos, tExp: tExp, gross: num(tRev - tCos), net: num(tRev - tCos - tExp)};
  }
  function loadIS(){
    var from = $("isFrom").value, to = $("isTo").value;
    $("isTitleDate").textContent = dateFmt(from) + " – " + dateFmt(to);
    return rpc("acct_income_statement", {p_from: from, p_to: to}).then(function(rows){
      var s = isSections(rows), body = [], csv = [[COMPANY], ["Income statement, " + from + " to " + to], [], ["Code", "Account", "Amount"]];
      function block(title, list, totalLabel, total){
        body.push(tr([{text: title, span: 3}], "head")); csv.push(["", title, ""]);
        list.forEach(function(r){ body.push(tr([{cls: "code", text: r.code}, r.name, n(acc(r.amount))])); csv.push([r.code, r.name, c2(r.amount)]); });
        if(!list.length) body.push(tr([{text: "None", span: 3, cls: "muted"}]));
        body.push(tr(["", totalLabel, n(acc(total))], "total")); csv.push(["", totalLabel, c2(total)]);
      }
      block("Revenue", s.rev, "Total revenue", s.tRev);
      block("Cost of sales", s.cos, "Total cost of sales", s.tCos);
      body.push(tr(["", "Gross profit", n(acc(s.gross))], "total")); body.push(tr(["", "Gross margin", n(pct(s.gross, s.tRev))], "sub"));
      csv.push(["", "Gross profit", c2(s.gross)]);
      block("Operating expenses", s.exp, "Total operating expenses", s.tExp);
      body.push(tr(["", "Net income", n(acc(s.net))], "grand")); body.push(tr(["", "Net margin", n(pct(s.net, s.tRev))], "sub"));
      csv.push(["", "Net income", c2(s.net)]);
      put("isTable", table(null, body));
      state.csv.is = {name: "ritehome-income-statement-" + from + "-to-" + to + ".csv", rows: csv};
    });
  }

  // ---------- balance sheet ----------
  function loadBS(){
    var asOf = $("bsAsOf").value || todayISO();
    $("bsTitleDate").textContent = "as of " + dateFmt(asOf);
    return rpc("acct_balance_sheet", {p_as_of: asOf}).then(function(rows){
      var body = [], csv = [[COMPANY], ["Balance sheet as of " + asOf], [], ["Code", "Account", "Amount"]], totals = {};
      ["asset", "liability", "equity"].forEach(function(t){
        var list = rows.filter(function(r){ return r.type === t && (num(r.amount) !== 0 || r.code === ""); });
        totals[t] = num(sum(list, function(r){ return r.amount; }));
        body.push(tr([{text: TYPE_LABEL[t], span: 3}], "head")); csv.push(["", TYPE_LABEL[t], ""]);
        list.forEach(function(r){ body.push(tr([{cls: "code", text: r.code}, r.name, n(acc(r.amount))])); csv.push([r.code, r.name, c2(r.amount)]); });
        if(!list.length) body.push(tr([{text: "None", span: 3, cls: "muted"}]));
        body.push(tr(["", "Total " + TYPE_LABEL[t].toLowerCase(), n(acc(totals[t]))], t === "asset" ? "grand" : "total"));
        csv.push(["", "Total " + TYPE_LABEL[t].toLowerCase(), c2(totals[t])]);
      });
      var le = num(totals.liability + totals.equity);
      body.push(tr(["", "Total liabilities and equity", n(acc(le))], "grand")); csv.push(["", "Total liabilities and equity", c2(le)]);
      put("bsTable", table(null, body));
      put("bsCheck", h("span", {class: "pill " + (le === totals.asset ? "good" : "bad"), text: le === totals.asset ? "Assets = liabilities + equity" : "Out by " + peso(totals.asset - le)}));
      state.csv.bs = {name: "ritehome-balance-sheet-" + asOf + ".csv", rows: csv};
    });
  }

  // ---------- VAT and income tax ----------
  // Graduated income tax rates for individuals, 2023 onwards (TRAIN law, second schedule).
  function incomeTax(t){
    t = Math.max(0, t);
    if(t <= 250000) return 0;
    if(t <= 400000) return (t - 250000) * 0.15;
    if(t <= 800000) return 22500 + (t - 400000) * 0.20;
    if(t <= 2000000) return 102500 + (t - 800000) * 0.25;
    if(t <= 8000000) return 402500 + (t - 2000000) * 0.30;
    return 2202500 + (t - 8000000) * 0.35;
  }
  function loadVAT(){
    var y = Number($("vatYear").value) || yearOf(todayISO());
    var to = String(y) === todayISO().slice(0, 4) ? todayISO() : y + "-12-31";
    $("vatTitle").textContent = String(y); $("taxTitle").textContent = y + ", Jan 1 – " + dateFmt(to);
    return Promise.all([rpc("acct_vat_quarters", {p_year: y}), rpc("acct_income_statement", {p_from: y + "-01-01", p_to: to})]).then(function(r){
      var qs = r[0], s = isSections(r[1]);
      var body = qs.map(function(q){
        var btn = (q.output_vat || q.input_vat) ? h("button", {class: "btn ghost small", type: "button", text: "Prepare entry", onclick: function(){ prepareVatEntry(q, y); }}) : "";
        return tr(["Q" + q.quarter + " · " + dateFmt(q.period_start) + " – " + dateFmt(q.period_end), n(money(q.vatable_sales)), n(money(q.non_vat_sales)),
          n(money(q.output_vat)), n(money(q.input_vat)), n(acc(q.vat_still_due)), n(money(q.tax_withheld_by_clients)), h("td", {class: "no-print"}, btn)]);
      });
      var t = function(k){ return num(sum(qs, function(q){ return q[k]; })); };
      body.push(tr(["Year", n(money(t("vatable_sales"))), n(money(t("non_vat_sales"))), n(money(t("output_vat"))), n(money(t("input_vat"))),
        n(acc(t("vat_still_due"))), n(money(t("tax_withheld_by_clients"))), ""], "grand"));
      put("vatTable", table(["Quarter", "VATable sales (net of VAT)", "Non-VAT sales", "Output VAT", "Input VAT", "VAT due", "Tax withheld by clients", ""], body));
      state.csv.vat = {name: "ritehome-vat-" + y + ".csv", rows: [[COMPANY], ["VAT and withholding by quarter, " + y], [],
        ["Quarter", "From", "To", "VATable sales (net)", "Non-VAT sales", "Output VAT", "Input VAT", "VAT due", "Tax withheld by clients"]]
        .concat(qs.map(function(q){ return ["Q" + q.quarter, q.period_start, q.period_end, c2(q.vatable_sales), c2(q.non_vat_sales), c2(q.output_vat), c2(q.input_vat), c2(q.vat_still_due), c2(q.tax_withheld_by_clients)]; }))
        .concat([["Year", "", "", c2(t("vatable_sales")), c2(t("non_vat_sales")), c2(t("output_vat")), c2(t("input_vat")), c2(t("vat_still_due")), c2(t("tax_withheld_by_clients"))]])};

      var cwt = t("tax_withheld_by_clients");
      var itemized = Math.max(0, s.net), osd = Math.max(0, s.tRev * 0.6);
      var taxI = num(incomeTax(itemized)), taxO = num(incomeTax(osd));
      function opt(title, lines, tax, best){
        return h("div", {class: "opt" + (best ? " best" : "")}, [h("h3", {text: title + (best ? " · lower" : "")}),
          table(null, lines.map(function(l){ return tr([l[0], n(l[1])], l[2]); }).concat([
            tr(["Income tax on that", n(money(tax))]), tr(["Less tax withheld by clients", n(acc(-cwt))]),
            tr(["Estimated still to pay", n(acc(Math.max(0, tax - cwt)))], "grand")]))]);
      }
      put("taxBox", h("div", null, [h("div", {class: "acct-tax"}, [
        opt("Itemized deductions", [["Sales", money(s.tRev)], ["Less cost of sales and expenses in the books", acc(-(s.tCos + s.tExp))], ["Taxable income", money(itemized), "total"]], taxI, taxI <= taxO),
        opt("Optional standard deduction (40%)", [["Sales", money(s.tRev)], ["Less 40% of sales", acc(-s.tRev * 0.4)], ["Taxable income", money(osd), "total"]], taxO, taxO < taxI)]),
        h("p", {class: "acct-note", text: "An estimate for planning, at the graduated rates for individuals (2023 onwards). The 8% option isn't available to a VAT-registered business. " +
          "Itemized only holds if every cost has a valid receipt in Ritehome's name; the books here also include owner-entered journal figures the firm may disallow. " +
          "The choice of deduction is made on the first quarterly return of the year and the accounting firm's figure is the one that counts."})]));
    });
  }
  function prepareVatEntry(q, y){
    var s = state.config.settings, lines = [], due = num(q.vat_still_due);
    if(due >= 0){
      if(q.output_vat) lines.push({account: s.output_vat_account, debit: num(q.output_vat)});
      if(q.input_vat) lines.push({account: s.input_vat_account, credit: num(q.input_vat)});
      if(due > 0) lines.push({account: state.byCode["2110"] ? "2110" : s.output_vat_account, credit: due});
    } else {
      // More input than output VAT: offset what output there is; the excess input VAT carries over.
      lines.push({account: s.output_vat_account, debit: num(q.output_vat)}, {account: s.input_vat_account, credit: num(q.output_vat)});
    }
    resetEntry({date: q.period_end, memo: "VAT settlement Q" + q.quarter + " " + y, ref: "2550Q", lines: lines});
    location.hash = "journal";
    msg("Settlement entry filled in for Q" + q.quarter + ". Check it against the filed return, then post. Record the payment separately (Dr VAT payable, Cr bank).");
  }

  // ---------- journal ----------
  function blankLine(){ return {account: "", debit: "", credit: "", memo: ""}; }
  function resetEntry(pre){
    pre = pre || {};
    $("entryDate").value = pre.date || todayISO();
    $("entryRef").value = pre.ref || ""; $("entryMemo").value = pre.memo || ""; $("entryProject").value = "";
    state.lines = (pre.lines || []).map(function(l){ return {account: l.account, debit: l.debit ? String(l.debit) : "", credit: l.credit ? String(l.credit) : "", memo: l.memo || ""}; });
    while(state.lines.length < 2) state.lines.push(blankLine());
    renderLines();
  }
  function renderLines(){
    var body = $("entryLines"); body.textContent = "";
    state.lines.forEach(function(l, i){
      var sel = h("select", {"aria-label": "Account, line " + (i + 1)}); fillAccounts(sel, {blank: "Choose account"}); sel.value = l.account;
      sel.addEventListener("change", function(){ l.account = sel.value; totals(); });
      function amt(k){
        var inp = h("input", {class: "amt", type: "number", min: "0", step: "0.01", inputmode: "decimal", value: l[k], "aria-label": (k === "debit" ? "Debit" : "Credit") + ", line " + (i + 1)});
        inp.addEventListener("input", function(){ l[k] = inp.value; totals(); });
        return inp;
      }
      var memo = h("input", {type: "text", maxlength: "200", value: l.memo, "aria-label": "Line note, line " + (i + 1)});
      memo.addEventListener("input", function(){ l.memo = memo.value; });
      var rm = h("button", {class: "btn ghost small", type: "button", text: "Remove", "aria-label": "Remove line " + (i + 1), disabled: state.lines.length <= 2,
        onclick: function(){ state.lines.splice(i, 1); renderLines(); }});
      body.appendChild(h("tr", null, [h("td", null, sel), h("td", null, amt("debit")), h("td", null, amt("credit")), h("td", null, memo), h("td", null, rm)]));
    });
    totals();
  }
  function entryProblem(){
    var used = state.lines.filter(function(l){ return l.account || Number(l.debit) || Number(l.credit); });
    if(used.length < 2) return "Add at least two lines.";
    for(var i = 0; i < used.length; i++){
      var d = Number(used[i].debit) || 0, c = Number(used[i].credit) || 0;
      if(!used[i].account) return "Choose an account for every line.";
      if(d < 0 || c < 0 || (d > 0) === (c > 0)) return "Each line takes a debit or a credit, not both.";
    }
    var dr = num(sum(used, function(l){ return l.debit; })), cr = num(sum(used, function(l){ return l.credit; }));
    if(dr !== cr) return "Out by " + peso(dr - cr) + ".";
    if(!$("entryDate").value) return "Choose a date.";
    if(!$("entryMemo").value.trim()) return "Say what the entry is for.";
    return "";
  }
  function totals(){
    var dr = num(sum(state.lines, function(l){ return l.debit; })), cr = num(sum(state.lines, function(l){ return l.credit; }));
    $("entryDr").textContent = money(dr); $("entryCr").textContent = money(cr);
    var p = entryProblem();
    put("entryDiff", h("span", {class: "pill " + (p ? (dr === cr ? "neutral" : "bad") : "good"), text: p || "Balanced"}));
    $("postEntry").disabled = !!p;
  }
  function postEntry(e){
    e.preventDefault();
    if(entryProblem()) return;
    var lines = state.lines.filter(function(l){ return l.account; }).map(function(l){
      return {account: l.account, debit: num(l.debit), credit: num(l.credit), memo: l.memo.trim()};
    });
    RitehomeBusy($("postEntry"), true);
    rpc("acct_post_entry", {p_date: $("entryDate").value, p_memo: $("entryMemo").value.trim(), p_lines: lines,
      p_ref: $("entryRef").value.trim(), p_project: $("entryProject").value || null}).then(function(id){
      $("postEntry").removeAttribute("aria-busy");
      msg("Entry #" + id + " posted.");
      resetEntry();
      return loadJournal();
    }).catch(function(err){ $("postEntry").removeAttribute("aria-busy"); fail(err); totals(); });
  }
  function loadJournal(){
    var from = $("jFrom").value || null, to = $("jTo").value || null;
    return rpc("acct_journal", {p_from: from, p_to: to}).then(function(list){
      $("jCount").textContent = list.length ? String(list.length) : "";
      var wrap = h("div");
      if(!list.length) wrap.appendChild(h("p", {class: "muted", text: "No journal entries in this range. Tracker expenses, fuel and client payments post themselves; see the Ledger."}));
      list.forEach(function(en){
        var total = sum(en.lines || [], function(l){ return l.debit; });
        var rows = (en.lines || []).map(function(l){
          return tr([{cls: "code", text: l.account}, acctName(l.account) + (l.memo ? " · " + l.memo : ""), n(l.debit ? money(l.debit) : ""), n(l.credit ? money(l.credit) : "")]);
        });
        var meta = "#" + en.id + (en.ref ? " · " + en.ref : "") + (en.project_id ? " · " + (state.projectName[en.project_id] || en.project_id) : "") +
          " · posted " + dateFmt(en.created_at) + (en.created_by_name ? " by " + en.created_by_name : "");
        var right = en.voided_at
          ? h("span", {class: "pill bad", text: "Void: " + en.void_reason + (en.voided_by_name ? " (" + en.voided_by_name + ")" : "")})
          : h("button", {class: "btn ghost small danger no-print", type: "button", text: "Void", onclick: function(){ voidEntry(en); }});
        wrap.appendChild(h("article", {class: "acct-entry" + (en.voided_at ? " void" : "")}, [
          h("header", null, [h("div", null, [h("strong", {text: dateFmt(en.entry_date) + " · " + en.memo}), h("div", {class: "meta", text: meta})]),
            h("div", null, [h("span", {class: "mono", text: peso(total) + " "}), right])]),
          table(null, rows)]));
      });
      put("journalList", wrap);
    });
  }
  function voidEntry(en){
    var reason = window.prompt("Why is entry #" + en.id + " (" + en.memo + ") void? This is kept with the entry.");
    if(reason == null) return;
    if(!reason.trim()){ msg("A reason is needed to void an entry.", true); return; }
    rpc("acct_void_entry", {p_id: en.id, p_reason: reason.trim()}).then(function(){ msg("Entry #" + en.id + " voided."); return loadJournal(); }).catch(fail);
  }
  function glCSV(){
    var from = $("jFrom").value || null, to = $("jTo").value || null;
    return rpc("acct_ledger", {p_from: from, p_to: to, p_account: null}).then(function(rows){
      download("ritehome-general-ledger-" + (from || "start") + "-to-" + (to || "end") + ".csv", [[COMPANY], ["General ledger, " + (from || "start") + " to " + (to || "end")], [],
        ["Date", "Source", "Source ID", "Ref", "Account code", "Account", "Description", "Project", "Debit", "Credit"]]
        .concat(rows.map(function(r){ return [r.entry_date, SOURCE_LABEL[r.source] || r.source, r.source_id, r.ref, r.account_code, acctName(r.account_code), r.memo,
          r.project_id ? (state.projectName[r.project_id] || r.project_id) : "", c2(r.debit), c2(r.credit)]; })));
    });
  }

  // ---------- ledger ----------
  function loadLedger(){
    var code = $("ledAccount").value, from = $("ledFrom").value, to = $("ledTo").value || todayISO();
    if(!code){ put("ledTable", h("p", {class: "muted", text: "Choose an account."})); return Promise.resolve(); }
    var a = state.byCode[code] || {}, debitSide = a.normal_side !== "credit", pl = /^(revenue|cost_of_sales|expense)$/.test(a.type);
    $("ledTitle").textContent = code + " " + (a.name || "") + " · " + dateFmt(from) + " – " + dateFmt(to);
    return rpc("acct_ledger", {p_from: null, p_to: to, p_account: code}).then(function(rows){
      var sign = function(r){ return (debitSide ? 1 : -1) * (r.debit - r.credit); };
      var open = num(sum(rows.filter(function(r){ return from && r.entry_date < from && (!pl || yearOf(r.entry_date) === yearOf(from)); }), sign));
      var bal = open, body = [tr(["", "", "Opening balance" + (pl ? " (this year)" : ""), "", "", n(acc(open))], "sub")];
      var csv = [[COMPANY], ["Ledger " + code + " " + (a.name || "") + ", " + (from || "start") + " to " + to], [], ["Date", "Source", "Description", "Debit", "Credit", "Balance"],
        ["", "", "Opening balance", "", "", c2(open)]];
      rows.filter(function(r){ return !from || r.entry_date >= from; }).forEach(function(r){
        bal = num(bal + sign(r));
        var src = (SOURCE_LABEL[r.source] || r.source) + (r.source === "journal" ? " #" + r.source_id : "");
        body.push(tr([dateFmt(r.entry_date), src, r.memo + (r.ref ? " · " + r.ref : ""), n(r.debit ? money(r.debit) : ""), n(r.credit ? money(r.credit) : ""), n(acc(bal))]));
        csv.push([r.entry_date, src, r.memo, c2(r.debit), c2(r.credit), c2(bal)]);
      });
      body.push(tr(["", "", "Closing balance", "", "", n(acc(bal))], "grand"));
      csv.push(["", "", "Closing balance", "", "", c2(bal)]);
      put("ledTable", table(["Date", "Source", "Description", "Debit", "Credit", "Balance"], body));
      state.csv.ledger = {name: "ritehome-ledger-" + code + "-" + (from || "start") + "-to-" + to + ".csv", rows: csv};
    });
  }

  // ---------- VAT tags ----------
  function loadTags(){
    return rpc("acct_vat_tags").then(function(t){ state.tags = t; renderTags(); });
  }
  function renderTags(){
    var t = state.tags; if(!t) return;
    var def = t.default_project_vat === "non_vat" ? "non-VAT" : "VATable";
    put("tagProjects", t.projects.length ? table(["Project", "Status", "VAT treatment"], t.projects.map(function(p){
      var sel = h("select", {"aria-label": "VAT treatment for " + p.name}, [h("option", {value: "", text: "Not confirmed (" + def + ")"}),
        h("option", {value: "vatable", text: "VATable"}), h("option", {value: "non_vat", text: "Non-VAT"})]);
      sel.value = p.treatment || "";
      sel.addEventListener("change", function(){
        rpc("acct_tag_project", {p_project: p.id, p_treatment: sel.value || null}).then(function(){ p.treatment = sel.value || null; msg(p.name + ": " + (sel.options[sel.selectedIndex].text) + "."); }).catch(fail);
      });
      return tr([p.name, p.status, h("td", null, sel)]);
    })) : h("p", {class: "muted", text: "No projects yet."}));

    var q = $("tagSearch").value.trim().toLowerCase(), only = $("tagUntagged").checked;
    var list = t.purchases.filter(function(p){
      if(only && p.vat_invoice) return false;
      if(!q) return true;
      return (p.description + " " + p.category + " " + (state.projectName[p.project_id] || "")).toLowerCase().indexOf(q) >= 0;
    });
    var rate = state.config && state.config.settings ? Number(state.config.settings.vat_rate) : 0.12;
    put("tagPurchases", list.length ? table(["Date", "Purchase", "Project", "Amount", "VAT invoice", "VAT on it"], list.slice(0, 400).map(function(p){
      var box = h("input", {type: "checkbox", "aria-label": "VAT invoice for " + p.description}); box.checked = !!p.vat_invoice;
      var vat = h("input", {class: "amt", type: "number", min: "0", step: "0.01", placeholder: money(Math.abs(p.amount) * rate / (1 + rate)),
        value: p.input_vat_entered != null ? p.input_vat_entered : "", disabled: !p.vat_invoice, "aria-label": "VAT amount for " + p.description});
      function save(){
        var v = vat.value === "" ? null : Number(vat.value);
        if(v != null && (!isFinite(v) || v < 0 || v > Math.abs(p.amount))){ msg("The VAT can't be negative or more than the purchase.", true); return; }
        rpc("acct_tag_purchase", {p_collection: p.collection, p_doc: p.doc_id, p_vat_invoice: box.checked, p_input_vat: box.checked ? v : null}).then(function(){
          p.vat_invoice = box.checked; p.input_vat_entered = box.checked ? v : null; vat.disabled = !box.checked;
          if(!box.checked) vat.value = "";
          msg(p.description + (box.checked ? ": VAT invoice." : ": no VAT invoice."));
        }).catch(function(e){ box.checked = !!p.vat_invoice; fail(e); });
      }
      box.addEventListener("change", save); vat.addEventListener("change", save);
      return tr([dateFmt(p.purchase_date), p.description + (p.collection === "companyFuel" ? "" : " · " + p.category),
        p.project_id ? (state.projectName[p.project_id] || p.project_id) : (p.collection === "companyFuel" ? "Company fuel" : "—"),
        n(money(p.amount)), h("td", null, box), h("td", null, vat)]);
    })) : h("p", {class: "muted", text: "No purchases match."}));
  }

  // ---------- settings ----------
  function fillSettings(){
    var s = state.config && state.config.settings; if(!s) return;
    $("sBooksStart").value = s.books_start || ""; $("sLocked").value = s.locked_through || ""; $("sDefaultVat").value = s.default_project_vat;
    $("sReceipts").value = s.receipts_account; $("sPaidFrom").value = s.expenses_paid_from; $("sFuel").value = s.fuel_account;
    var box = $("sCategories"); box.textContent = "";
    var keys = CATEGORY_KEYS.concat(Object.keys(s.category_accounts || {}).filter(function(k){ return CATEGORY_KEYS.indexOf(k) < 0; }));
    keys.forEach(function(k){
      var sel = h("select", {"data-category": k}); fillAccounts(sel); sel.value = (s.category_accounts || {})[k] || "";
      box.appendChild(h("label", null, [k.charAt(0).toUpperCase() + k.slice(1), sel]));
    });
    put("accountsTable", table(["Code", "Account", "Type", "Normal balance", "Active"], state.accounts.map(function(a){
      var box = h("input", {type: "checkbox", "aria-label": "Account " + a.code + " active"}); box.checked = !!a.active;
      box.addEventListener("change", function(){
        rpc("acct_save_account", {p_code: a.code, p_name: a.name, p_type: a.type, p_active: box.checked, p_normal_side: null})
          .then(function(){ msg(a.code + " " + a.name + (box.checked ? " is active." : " is inactive. Its history stays in the books.")); return loadConfig(); })
          .catch(function(e){ box.checked = !box.checked; fail(e); });
      });
      return tr([{cls: "code", text: a.code}, a.name, TYPE_ONE[a.type], a.normal_side, h("td", null, box)]);
    })));
  }
  function saveSettings(e){
    e.preventDefault();
    var cats = {};
    document.querySelectorAll("#sCategories select").forEach(function(s){ if(s.value) cats[s.getAttribute("data-category")] = s.value; });
    rpc("acct_save_settings", {p: {books_start: $("sBooksStart").value, locked_through: $("sLocked").value, default_project_vat: $("sDefaultVat").value,
      receipts_account: $("sReceipts").value, expenses_paid_from: $("sPaidFrom").value, fuel_account: $("sFuel").value, category_accounts: cats}})
      .then(function(){ msg("Settings saved."); return loadConfig(); }).catch(fail);
  }
  function saveAccount(e){
    e.preventDefault();
    var code = $("aCode").value.trim(), name = $("aName").value.trim();
    if(!/^\d{4}$/.test(code) || !name){ msg("An account needs a 4-digit code and a name.", true); return; }
    var existing = state.byCode[code];
    rpc("acct_save_account", {p_code: code, p_name: name, p_type: $("aType").value, p_active: existing ? existing.active : true, p_normal_side: $("aSide").value || null})
      .then(function(){ msg((existing ? "Updated " : "Added ") + code + " " + name + "."); $("accountForm").reset(); return loadConfig(); }).catch(fail);
  }

  // ---------- tabs and start-up ----------
  var LOADERS = {status: loadStatus, tb: loadTB, is: loadIS, bs: loadBS, vat: loadVAT, journal: loadJournal, ledger: loadLedger, tags: loadTags, settings: function(){ fillSettings(); return Promise.resolve(); }};
  // Grey placeholder rows in a tab's tables while its figures load (styles in shell.css).
  var SKELETON = {status: ["statusKpis:kpis", "issueList:list", "arTable"], tb: ["tbTable"], is: ["isTable"], bs: ["bsTable"],
    vat: ["vatTable", "taxBox"], journal: ["journalList"], ledger: ["ledTable"], tags: ["tagProjects", "tagPurchases"]};
  function skeleton(tab){
    (SKELETON[tab] || []).forEach(function(spec){
      var p = spec.split(":"), box = $(p[0]);
      box.textContent = "";
      if(p[1] === "kpis"){ for(var i = 0; i < 6; i++) box.appendChild(h("div", {class: "sk sk-kpi", "aria-hidden": "true"})); return; }
      var wrap = p[1] === "list" ? box : box.appendChild(h("div", {class: "sk-rows", "aria-hidden": "true"}));
      ["w60", "w100", "w90", "w100", "w80", "w100"].forEach(function(w){ wrap.appendChild(h(p[1] === "list" ? "li" : "div", {class: "sk sk-line " + w, "aria-hidden": "true"})); });
    });
    if(tab === "status") $("issueCount").textContent = "";
  }

  function show(){
    var tab = (location.hash || "").slice(1);
    if(!LOADERS[tab]) tab = "status";
    state.tab = tab;
    skeleton(tab);
    document.querySelectorAll(".acct-tab").forEach(function(s){ s.hidden = s.id !== "tab-" + tab; });
    document.querySelectorAll(".acct-tabs button").forEach(function(b){
      if(b.getAttribute("data-tab") === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    return LOADERS[tab]().catch(fail);
  }
  function reload(){ skeleton(state.tab); return LOADERS[state.tab]().catch(fail); }

  function gate(title, text, link){
    $("gate").hidden = false; $("app").hidden = true;
    $("gateTitle").textContent = title; $("gateText").textContent = text || ""; $("gateLinkRow").hidden = !link;
    document.body.classList.add("gated"); document.body.classList.remove("connecting");
  }
  function start(){
    var t = todayISO(), y = yearOf(t);
    ["statusAsOf", "tbAsOf", "bsAsOf", "isTo", "ledTo"].forEach(function(id){ $(id).value = t; });
    ["isFrom", "jFrom", "ledFrom"].forEach(function(id){ $(id).value = y + "-01-01"; });
    $("jTo").value = y + "-12-31";
    var vy = $("vatYear"); [y, y - 1, y - 2].forEach(function(v){ vy.appendChild(h("option", {value: String(v), text: String(v)})); });
    document.querySelectorAll(".acct-tabs button").forEach(function(b){ b.addEventListener("click", function(){ location.hash = b.getAttribute("data-tab"); }); });
    window.addEventListener("hashchange", show);
    ["statusAsOf", "tbAsOf", "bsAsOf", "isFrom", "isTo", "vatYear", "jFrom", "jTo", "ledAccount", "ledFrom", "ledTo"].forEach(function(id){ $(id).addEventListener("change", reload); });
    $("tagSearch").addEventListener("input", renderTags); $("tagUntagged").addEventListener("change", renderTags);
    document.querySelectorAll("[data-csv]").forEach(function(b){ b.addEventListener("click", function(){
      var k = b.getAttribute("data-csv");
      if(k === "gl"){ glCSV().catch(fail); return; }
      var c = state.csv[k]; if(c) download(c.name, c.rows); else msg("Nothing to export yet.", true);
    }); });
    $("addLine").addEventListener("click", function(){ state.lines.push(blankLine()); renderLines(); });
    $("clearEntry").addEventListener("click", function(){ resetEntry(); });
    $("entryForm").addEventListener("submit", postEntry);
    ["entryDate", "entryMemo"].forEach(function(id){ $(id).addEventListener("input", totals); });
    $("settingsForm").addEventListener("submit", saveSettings);
    $("accountForm").addEventListener("submit", saveAccount);
    $("printBtn").addEventListener("click", function(){ window.print(); });
    return loadConfig().then(function(){
      resetEntry();
      $("gate").hidden = true; $("app").hidden = false; document.body.classList.remove("gated", "connecting");
      return show();
    });
  }

  $("forgetKeyBtn").addEventListener("click", function(){
    client.auth.signOut().then(function(){ location.href = home(); });
  });
  document.body.classList.add("gated", "connecting");   // skeleton of the page while the session is checked
  client.auth.getSession().then(function(r){
    var session = r && r.data && r.data.session;
    if(!session){ $("gateLink").href = home(); return gate("Sign in first", "Sign in on the staff portal, then come back to Accounting from the menu.", true); }
    return rpc("my_role").then(function(role){
      if(role !== "admin") return gate("Accounting is for admins", role ? "Your account can use the project tools, not the books." : "This account hasn't been activated yet.");
      return start();
    });
  }).catch(function(e){ gate("Couldn't open the books", e && e.message ? e.message : String(e)); });
})();
