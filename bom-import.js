/* Excel BOM import. Reads OOXML values only; never runs formulas, macros or links. */
(function(root){
  'use strict';
  var MAX_FILE=5*1024*1024,MAX_XML=20*1024*1024;
  function xml(bytes){
    if(!bytes)throw Error('This workbook is missing a required Excel component. Save it as .xlsx and try again.');
    var text=new TextDecoder().decode(bytes);
    if(/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('This workbook contains unsupported XML declarations.');
    var doc=new DOMParser().parseFromString(text,'application/xml');
    if(doc.getElementsByTagName('parsererror').length)throw Error('This workbook contains damaged XML. Save a fresh .xlsx copy.');
    return doc;
  }
  function nodes(el,name){return Array.from(el.getElementsByTagNameNS('*',name));}
  function content(el,name){var n=nodes(el,name)[0];return n?n.textContent:'';}
  function label(v){return String(v==null?'':v).trim();}
  function key(v){return label(v).toLowerCase().replace(/[^a-z0-9]/g,'');}
  function column(ref){var m=/^([A-Z]+)[1-9][0-9]*$/.exec(ref||'');if(!m)throw Error('Invalid Excel cell address.');var n=0;for(var c of m[1])n=n*26+c.charCodeAt(0)-64;if(n>100)throw Error('BOM sheets support up to 100 columns.');return n-1;}
  function read(buffer){
    if(buffer.byteLength>MAX_FILE)throw Error('Choose an Excel file of 5 MB or less.');
    if(!root.fflate)throw Error('The Excel reader could not load. Reload the page and try again.');
    var total=0,count=0,files;
    try{files=root.fflate.unzipSync(new Uint8Array(buffer),{filter:function(f){
      if(++count>1000)throw Error('This workbook contains too many components.');
      var keep=/^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(f.name);
      if(keep){total+=f.originalSize;if(total>MAX_XML)throw Error('The workbook expands beyond the 20 MB reading limit.');}return keep;
    }});}catch(e){throw Error('Cannot read this Excel file. '+(e.message||'Save a fresh .xlsx copy.'));}
    var workbook=xml(files['xl/workbook.xml']),relationships=xml(files['xl/_rels/workbook.xml.rels']);
    var rels=Object.create(null);
    nodes(relationships,'Relationship').forEach(function(r){if(r.getAttribute('TargetMode')==='External')return;var path=r.getAttribute('Target')||'';if(path[0]==='/')path=path.slice(1);else path='xl/'+path.replace(/^\.\//,'');if(/^xl\/worksheets\/[^/]+\.xml$/.test(path))rels[r.getAttribute('Id')]=path;});
    var strings=files['xl/sharedStrings.xml']?nodes(xml(files['xl/sharedStrings.xml']),'si').map(function(si){return nodes(si,'t').map(function(t){return t.textContent;}).join('');}):[];
    var sheets=nodes(workbook,'sheet').filter(function(s){return !s.getAttribute('state')||s.getAttribute('state')==='visible';}).map(function(s){return {name:s.getAttribute('name'),path:rels[s.getAttribute('r:id')||s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id')]};});
    if(!sheets.length||sheets.length>50)throw Error('Choose a workbook with 1–50 visible sheets.');
    return {sheets:sheets,parse:function(index){
      var sheet=sheets[index];if(!sheet)throw Error('Choose a worksheet.');
      var doc=xml(files[sheet.path]),rows=[],cellCount=0;
      var source=nodes(doc,'row');if(source.length>10000)throw Error('A BOM sheet may contain at most 10,000 rows.');
      source.forEach(function(row){var cells=[];nodes(row,'c').forEach(function(c){
        if(++cellCount>100000)throw Error('This sheet contains too many cells.');
        var type=c.getAttribute('t'),v=content(c,'v');
        var value=type==='s'?strings[Number(v)]:type==='inlineStr'?nodes(c,'t').map(function(t){return t.textContent;}).join(''):v;
        if((!type||type==='n')&&v!==''&&Number.isFinite(Number(v)))value=Number(v);
        if(nodes(c,'f').length&&v==='')value={error:'Formula has no saved result. Recalculate and save in Excel first.'};
        if(type==='e')value={error:'Excel cell error: '+v};
        cells[column(c.getAttribute('r'))]=value;
      });rows.push({number:row.getAttribute('r'),cells:cells});});
      return extract(rows);
    }};
  }
  function extract(rows){
    var items=[],issues=[],skipped=0,headers=null,section='',recognized=0;
    rows.forEach(function(row){
      var c=row.cells,keys=c.map(key),q=keys.findIndex(function(k){return /^(qty|quantity|requiredquantity|requiredqty)$/.test(k);});
      if(q>=0){
        var m=keys.findIndex(function(k){return /^(material|materials|materialname|description|item|items|edgebandcolor)$/.test(k);}),u=keys.findIndex(function(k){return /^(unit|uom)$/.test(k);});
        headers=m>=0&&u>=0?{material:m,quantity:q,unit:u,keys:keys}:null;
        if(!headers)issues.push('Row '+row.number+': the table needs Material, Quantity and Unit headers.');else recognized++;
        return;
      }
      var first=c.map(label).find(function(v){return v;})||'';
      if(/^[A-Z]\.\s+/.test(first)){section=first.replace(/^[A-Z]\.\s+/,'');headers=null;return;}
      if(!headers||/^(?:grand\s*)?(?:sub\s*)?total\b/i.test(first))return;
      var raw=c[headers.quantity];
      if(raw&&typeof raw==='object'){issues.push('Row '+row.number+': '+raw.error);return;}
      if(label(raw)===''){skipped++;return;}
      var text=label(raw),quantity=Number(text.replace(/,/g,''));
      if((typeof raw!=='number'&&!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(text))||!Number.isFinite(quantity)||quantity<0||quantity>1e12){issues.push('Row '+row.number+': quantity must be a positive number or zero.');return;}
      if(quantity===0){skipped++;return;}
      if(quantity<0.000001){issues.push('Row '+row.number+': the minimum material quantity is 0.000001.');return;}
      var mc=headers.material;
      // Ritehome merges the Material heading over the item number and name columns.
      if((!label(c[mc])||/^\d+$/.test(label(c[mc])))&&mc+1<headers.quantity&&label(c[mc+1]))mc++;
      var material=label(c[mc]),unit=label(c[headers.unit]),spec=[];
      for(var i=mc+1;i<c.length;i++){
        var k=headers.keys[i]||'';
        if(i===headers.quantity||i===headers.unit||/^(price|unitprice|amount|total|cost|stockstatus|note)$/.test(k))continue;
        var relevant=(i<headers.quantity)||/^(spec|specification|specificationsize|size|thk|thickness|width|length|code|reference|referencebrand|brand|remarks|description)$/.test(k);
        if(relevant&&label(c[i])){if(typeof c[i]==='object'){issues.push('Row '+row.number+': '+c[i].error);return;}spec.push(label(c[i]));}
      }
      if(section)spec.push(section);
      var item={material:material,spec:spec.join(' · '),unit:unit,quantity:quantity};
      if(!material||!unit||typeof c[mc]==='object'||typeof c[headers.unit]==='object'){issues.push('Row '+row.number+': material and unit must be readable text.');return;}
      if(material.length>150||item.spec.length>200||unit.length>30){issues.push('Row '+row.number+': material, specification or unit is too long. Shorten it in Excel.');return;}
      items.push(item);
    });
    if(items.length>300)issues.push('A BOM supports at most 300 material rows. Split this sheet into smaller BOMs.');
    if(!recognized)issues.push('No material table found. Use Material, Specification, Quantity and Unit column headers.');
    if(!items.length&&!issues.length)issues.push('No materials with positive quantities found on this sheet. Choose another sheet.');
    var date='';
    rows.slice(0,6).some(function(row){return row.cells.some(function(cell){
      var match=label(cell).match(/^(?:Date:\s*)?(\d{1,2})\/(\d{1,2})\/(\d{4})$/i);
      if(!match)return false;var iso=match[3]+'-'+match[1].padStart(2,'0')+'-'+match[2].padStart(2,'0');var d=new Date(iso+'T00:00:00Z');
      if(Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===iso){date=iso;return true;}return false;
    });});
    return {items:items,issues:issues,skipped:skipped,date:date};
  }
  root.BomImport={read:read,maxFileSize:MAX_FILE};
})(typeof globalThis!=='undefined'?globalThis:this);
