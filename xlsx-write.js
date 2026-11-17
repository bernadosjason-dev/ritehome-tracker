/* Ritehome: a small .xlsx writer (one sheet) on the vendored fflate. Every cell is text unless it is a number given
   with {n: value}, so ID numbers keep their dashes and Excel never turns them into numbers. Used for government files
   (the Pag-IBIG remittance), so the layout is exactly what the caller lays out: rows of cells, nothing guessed. */
(function(root){
  "use strict";
  function esc(s){ return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ""); }
  function col(i){ var s = ""; i++; while(i > 0){ var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  // rows: array of arrays; a cell is a string, null/undefined (empty), {n: number} (two decimals) or {s: string, b: true} (bold).
  function sheetXml(rows, widths){
    var out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'];
    if(widths && widths.length) out.push("<cols>" + widths.map(function(w, i){ return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join("") + "</cols>");
    out.push("<sheetData>");
    rows.forEach(function(row, r){
      var cells = [];
      (row || []).forEach(function(c, i){
        if(c == null || c === "") return;
        var ref = col(i) + (r + 1);
        if(typeof c === "object" && c.n != null){
          var v = Number(c.n); if(!isFinite(v)) throw new Error("Not a number in " + ref);
          cells.push('<c r="' + ref + '" s="1"><v>' + Math.round(v * 100) / 100 + "</v></c>");
        } else {
          var t = typeof c === "object" ? c.s : c, s = typeof c === "object" && c.b ? ' s="2"' : "";
          cells.push('<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + esc(t) + "</t></is></c>");
        }
      });
      out.push('<row r="' + (r + 1) + '">' + cells.join("") + "</row>");
    });
    out.push("</sheetData></worksheet>");
    return out.join("");
  }
  function build(opts){
    var ff = root.fflate; if(!ff || !ff.zipSync) throw new Error("The Excel writer could not load. Reload the page and try again.");
    var u = ff.strToU8, name = esc(opts.sheet || "Sheet1").slice(0, 31);
    var files = {
      "[Content_Types].xml": u('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'),
      "_rels/.rels": u('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
      "xl/workbook.xml": u('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + name + '" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      "xl/_rels/workbook.xml.rels": u('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
      "xl/styles.xml": u('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf numFmtId="4" applyNumberFormat="1"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>'),
      "xl/worksheets/sheet1.xml": u(sheetXml(opts.rows, opts.widths))
    };
    return ff.zipSync(files, {level: 6});
  }
  function download(filename, opts){
    var bytes = build(opts);
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], {type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));
    a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return bytes;
  }
  // The Pag-IBIG remittance file in the layout of Ritehome's own monthly sheet.
  function pagibigRows(f){
    var e = f.employer, rows = [
      [{s: "Employer ID No.", b: true}, e.id],
      [{s: "Employer/Business Name", b: true}, String(e.name || "").toUpperCase()],
      [{s: "Employer/Business Address", b: true}, String(e.address || "").toUpperCase()],
      [{s: "Contact Number", b: true}, e.phones],
      [{s: "Email Address", b: true}, e.email],
      [], [],
      ["Pag-IBIG MID NO.", "MP2 ACCOUNT NO.", "MEMBERSHIP PROGRAM", "LAST NAME", "FIRST NAME", "NAME EXTENSION", "MIDDLE NAME", "PERCOV", "EE SHARE", "ER SHARE", "REMARKS"].map(function(t){ return {s: t, b: true}; })];
    f.rows.forEach(function(x){
      rows.push([x.mid, x.mp2, x.program, String(x.last_name).toUpperCase(), String(x.first_name).toUpperCase(), String(x.name_ext).toUpperCase(),
        String(x.middle_name).toUpperCase(), f.percov, {n: x.ee}, {n: x.er}, x.remarks]);
    });
    rows.push([]);
    rows.push([{s: "TOTAL", b: true}, f.totals.members + (f.totals.members === 1 ? " member" : " members"), null, null, null, null, null, null, {n: f.totals.ee}, {n: f.totals.er}]);
    return rows;
  }
  root.RitehomeXlsx = {build: build, download: download, pagibigRows: pagibigRows, sheetXml: sheetXml};
  if(typeof module !== "undefined" && module.exports) module.exports = root.RitehomeXlsx;
})(typeof window !== "undefined" ? window : globalThis);
