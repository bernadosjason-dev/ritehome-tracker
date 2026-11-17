/* Ritehome: reads the office's SALES SUMMARY workbook (one year) into sales contracts for review before import (v4.8).
   The workbook never leaves the browser: readWorkbook() unzips it with the vendored fflate and reads cell values
   (Excel's saved results for formulas); extract() is plain logic (Node-tested) that finds:
     - the monthly list (a sheet named "MNTHLY SALES" or "Sales Sum."; month headings in column A, then rows of
       DATE | SC NO. | CUSTOMER | PROJECT | AMOUNT, with an optional note in column H),
     - the split by salesperson (any other sheet with "SC NO." headings; the name sits in the row(s) above each block).
   Nothing is guessed silently: every row that needed a judgement carries a flag the owner sees before importing. */
(function(root){
  'use strict';
  var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  var MAX_COL = 60, MAX_ROW = 5000;

  function txt(v){ return v == null ? '' : String(v).trim(); }
  function monthOf(v){ var t = txt(v).toLowerCase(); var i = MONTHS.indexOf(t); return i; }
  function isSc(v){ var t = txt(v); return /^\d{1,7}$/.test(t) && Number(t) > 0; }
  function iso(y, m, d){ return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }
  function validDate(y, m, d){ var dt = new Date(Date.UTC(y, m - 1, d)); return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d; }
  // "1.6.24", "01.05.26", "1..20.24", "1/6/2024", or an Excel date number.
  function parseDate(v){
    if(typeof v === 'number' && v > 20000 && v < 80000){
      var dt = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
      return {y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate()};
    }
    var t = txt(v).replace(/\s+/g, '');
    var m = /^(\d{1,2})[.\/-]+(\d{1,2})[.\/-]+(\d{2}|\d{4})$/.exec(t);
    if(!m) return null;
    var y = Number(m[3]); if(y < 100) y += 2000;
    var r = {y: y, m: Number(m[1]), d: Number(m[2])};
    return validDate(r.y, r.m, r.d) ? r : null;
  }
  // Amounts: numbers, "1,234.50", or a simple sum Excel didn't save a result for ("=243979+3047.75").
  function amountOf(v){
    if(v == null || v === '') return null;
    if(typeof v === 'number') return isFinite(v) ? Math.round(v * 100) / 100 : null;
    var t = txt(v).replace(/[,₱\s]/g, '');
    if(t.charAt(0) === '=') t = t.slice(1).replace(/^\+/, '');
    if(!/^[\d.+\-*\/()]+$/.test(t)) return null;
    var parts = t.split(/(?=[+-])/), sum = 0;
    for(var i = 0; i < parts.length; i++){ var n = Number(parts[i]); if(!isFinite(n)) return null; sum += n; }
    return Math.round(sum * 100) / 100;
  }
  function statusOf(note, client){
    var t = (txt(note) + ' ' + txt(client)).toLowerCase();
    if(/cancel/.test(t)) return 'cancelled';
    if(/hold|undecided/.test(t)) return 'on_hold';
    if(/waiting for (full )?payment|for (full )?payment|for collection|waiting for collection/.test(t)) return 'awaiting_payment';
    if(/paid/.test(t)) return 'paid';
    if(/ongoing|fabrication|installation|deployed|production/.test(t)) return 'ongoing';
    return null;
  }
  function isMonthly(s){ return /mnthly sales|monthly sales|sales sum/i.test(s.name); }
  function yearOf(sheet){
    for(var r = 0; r < Math.min(sheet.rows.length, 6); r++) for(var c = 0; c < (sheet.rows[r] || []).length; c++){
      var m = /\b(20\d\d)\b/.exec(txt(sheet.rows[r][c])); if(m && /summary|sales/i.test(txt(sheet.rows[r][c]))) return Number(m[1]);
    }
    return null;
  }
  // The salesperson for each SC number, from the blocks of any other sheet.
  function splitBySalesperson(sheets){
    var found = {};
    var NOT_NAME = /^(date|sc no\.?|client|customer|amount|total|quota.*|project)$/i;
    sheets.forEach(function(s){
      if(isMonthly(s)) return;
      var current = {};
      s.rows.forEach(function(row, r){
        (row || []).forEach(function(v, c){
          if(/^sc no\.?$/i.test(txt(v))){
            var name = '';
            for(var k = r - 1; k >= Math.max(0, r - 3) && !name; k--) [c - 1, c + 1, c].forEach(function(cc){
              var t = txt((s.rows[k] || [])[cc]);
              if(!name && t && t.length <= 20 && /^[A-Za-z][A-Za-z .'-]*$/.test(t) && !NOT_NAME.test(t) && monthOf(t) < 0) name = t;
            });
            current[c] = name;
          } else if(current[c] && isSc(v)){
            var sc = Number(txt(v)), amt = amountOf((row || [])[c + 2]);
            (found[sc] = found[sc] || []).push({name: current[c], amount: amt, sheet: s.name});
          }
        });
      });
    });
    return found;
  }
  function extract(sheets, opts){
    opts = opts || {};
    var monthly = sheets.filter(isMonthly)[0] || sheets.filter(function(s){
      return s.rows.some(function(row){ return /^sc no\.?$/i.test(txt((row || [])[1])) && /customer/i.test(txt((row || [])[2])); });
    })[0];
    if(!monthly) throw new Error('This workbook has no monthly sales list (a sheet like "MNTHLY SALES" with DATE, SC NO., CUSTOMER, PROJECT, AMOUNT).');
    var year = opts.year || yearOf(monthly), split = splitBySalesperson(sheets);
    var contracts = [], reserved = [], heading = -1, seen = {};
    monthly.rows.forEach(function(row, r){
      row = row || [];
      var mi = monthOf(row[0]);
      if(mi >= 0){ heading = mi; return; }
      if(!isSc(row[1])) return;
      var sc = Number(txt(row[1])), client = txt(row[2]);
      if(!client){ reserved.push(sc); return; }
      var flags = [], d = parseDate(row[0]), amount = amountOf(row[4]);
      if(seen[sc]){ flags.push('SC ' + sc + ' appears twice in the monthly list'); }
      seen[sc] = true;
      if(!year && d) year = d.y;
      if(!d){
        if(heading >= 0 && year){ d = {y: year, m: heading + 1, d: 1}; flags.push(txt(row[0]) ? 'date "' + txt(row[0]) + '" unreadable: set to the 1st of ' + MONTHS[heading] : 'no date: set to the 1st of ' + MONTHS[heading]); }
        else flags.push('no date');
      } else {
        if(year && d.y !== year){ flags.push('date "' + txt(row[0]) + '" says ' + d.y + ' in the ' + year + ' workbook: year set to ' + year); d = {y: year, m: d.m, d: d.d}; if(!validDate(d.y, d.m, d.d)) d = {y: year, m: d.m, d: 1}; }
        if(heading >= 0 && d.m !== heading + 1) flags.push('dated ' + MONTHS[d.m - 1] + ' but listed under ' + MONTHS[heading]);
      }
      if(amount == null) flags.push('no amount');
      var cands = split[sc] || [], names = {};
      cands.forEach(function(x){ names[x.name.toUpperCase()] = x; });
      var keys = Object.keys(names), salesperson = '';
      if(!keys.length) flags.push('not in the split by salesperson');
      else if(keys.length > 1) flags.push('salesperson unclear: ' + keys.join(' / '));
      else if(cands.length > 1 && cands.some(function(x){ return x.amount !== cands[0].amount; })) flags.push('salesperson unclear: SC ' + sc + ' typed more than once in the split');
      else if(names[keys[0]].amount != null && amount != null && Math.abs(names[keys[0]].amount - amount) > 1)
        flags.push('salesperson unclear: the split has ' + names[keys[0]].name + ' with ' + names[keys[0]].amount + ', the monthly list ' + amount);
      else salesperson = names[keys[0]].name;
      var note = txt(row[7]);
      contracts.push({sc_no: sc, contract_date: d ? iso(d.y, d.m, d.d) : '', date_text: txt(row[0]), client: client, description: txt(row[3]),
        amount: amount, salesperson: salesperson, status_note: note, status: statusOf(note, client), flags: flags});
    });
    var nums = contracts.map(function(c){ return c.sc_no; }).sort(function(a, b){ return a - b; }), missing = [];
    for(var i = 1; i < nums.length; i++) for(var n = nums[i - 1] + 1; n < nums[i]; n++) if(reserved.indexOf(n) < 0) missing.push(n);
    var total = contracts.reduce(function(a, c){ return a + (c.status === 'cancelled' ? 0 : c.amount || 0); }, 0);
    return {year: year, sheet: monthly.name, contracts: contracts, reserved: reserved, missing: missing, total: Math.round(total * 100) / 100,
      flagged: contracts.filter(function(c){ return c.flags.length; }).length};
  }

  // ---- the .xlsx reader (browser) ----
  function colIndex(ref){ var m = /^([A-Z]+)\d+$/.exec(ref || ''); if(!m) return -1; var n = 0; for(var i = 0; i < m[1].length; i++) n = n * 26 + m[1].charCodeAt(i) - 64; return n - 1; }
  function rowIndex(ref){ var m = /(\d+)$/.exec(ref || ''); return m ? Number(m[1]) - 1 : -1; }
  function readWorkbook(buffer){
    var ff = root.fflate; if(!ff) throw new Error('The Excel reader could not load. Reload the page and try again.');
    var files;
    try { files = ff.unzipSync(new Uint8Array(buffer), {filter: function(f){ return /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(f.name); }}); }
    catch(e){ throw new Error('That file is not an .xlsx workbook (save it from Excel as .xlsx and try again).'); }
    var dec = function(p){ return files[p] ? new DOMParser().parseFromString(ff.strFromU8(files[p]), 'application/xml') : null; };
    var all = function(doc, tag){ return doc ? Array.prototype.slice.call(doc.getElementsByTagNameNS('*', tag)) : []; };
    var wb = dec('xl/workbook.xml'), rels = dec('xl/_rels/workbook.xml.rels');
    if(!wb || !rels) throw new Error('That file is not an .xlsx workbook.');
    var target = {}; all(rels, 'Relationship').forEach(function(r){ target[r.getAttribute('Id')] = r.getAttribute('Target').replace(/^\/?xl\//, '').replace(/^\//, ''); });
    var shared = all(dec('xl/sharedStrings.xml'), 'si').map(function(si){ return all(si, 't').map(function(t){ return t.textContent; }).join(''); });
    return all(wb, 'sheet').map(function(s){
      var rid = s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      var doc = dec('xl/' + target[rid]), rows = [];
      all(doc, 'c').forEach(function(c){
        var ref = c.getAttribute('r'), ci = colIndex(ref), ri = rowIndex(ref);
        if(ci < 0 || ci >= MAX_COL || ri < 0 || ri >= MAX_ROW) return;
        var t = c.getAttribute('t'), vEl = all(c, 'v')[0], fEl = all(c, 'f')[0], v = vEl ? vEl.textContent : null, val = null;
        if(t === 's') val = v == null ? null : shared[Number(v)];
        else if(t === 'inlineStr') val = all(c, 't').map(function(x){ return x.textContent; }).join('');
        else if(t === 'str' || t === 'e') val = v;
        else if(t === 'b') val = v === '1';
        else if(v != null && v !== '') val = Number(v);
        else if(fEl) val = '=' + fEl.textContent;
        if(val == null || val === '') return;
        (rows[ri] = rows[ri] || [])[ci] = val;
      });
      for(var i = 0; i < rows.length; i++) rows[i] = rows[i] || [];
      return {name: s.getAttribute('name'), rows: rows};
    });
  }
  var api = {extract: extract, parseDate: parseDate, amountOf: amountOf, statusOf: statusOf, readWorkbook: readWorkbook, maxFileSize: 15 * 1024 * 1024};
  root.SalesImport = api;
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
