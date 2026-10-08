/* Shared procurement validation and browser UI. Also embedded in Apps Script for server validation. */
(function(root){
  'use strict';
  function clean(v,max){var s=String(v==null?'':v).trim();if(s.length>max)throw Error('Text is too long (maximum '+max+' characters).');return s;}
  function number(v,zero){if(typeof v!=='number'||!Number.isFinite(v)||v<0||(!zero&&v===0))throw Error('Quantities must be valid '+(zero?'nonnegative':'positive')+' numbers.');var n=Math.round(v*1000000)/1000000;if(!Number.isFinite(n)||n>1000000000000||(!zero&&n===0))throw Error('Quantity or price is outside the supported range.');return n;}
  function date(v){v=clean(v,10);var d=new Date(v+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==v)throw Error('Enter a valid date.');return v;}
  function id(v){v=clean(v,80);if(!/^[A-Za-z0-9_-]{1,80}$/.test(v))throw Error('Invalid record ID.');return v;}
  function normalize(value){
    if(!value||!Array.isArray(value.boms)||!Array.isArray(value.orders)||value.boms.length>100||value.orders.length>500)throw Error('Invalid procurement data or too many BOMs/POs.');
    var ids={},items={},refs={},bomNames={};
    function unique(v){v=id(v);if(ids[v])throw Error('Duplicate record ID.');ids[v]=true;return v;}
    var boms=value.boms.map(function(b){
      var name=clean(b.name,100);if(!name)throw Error('BOM name is required.');if(bomNames[name.toLowerCase()])throw Error('Use a distinct reference for each BOM.');bomNames[name.toLowerCase()]=true;
      if(!Array.isArray(b.items)||!b.items.length||b.items.length>300)throw Error('Each BOM needs 1–300 material rows.');
      return {id:unique(b.id),name:name,draftsman:clean(b.draftsman,100),date:date(b.date),items:b.items.map(function(i){
        var result={id:unique(i.id),material:clean(i.material,150),spec:clean(i.spec,200),unit:clean(i.unit,30),quantity:number(i.quantity,false)};
        if(!result.material||!result.unit)throw Error('Material name and unit are required.');items[result.id]=result;return result;
      })};
    });
    var allocated={},orders=value.orders.map(function(o){
      var ref=clean(o.reference,100),supplier=clean(o.supplier,150);if(!ref||!supplier)throw Error('PO reference and supplier are required.');
      var key=ref.toLowerCase();if(refs[key])throw Error('PO reference already exists.');refs[key]=true;
      if(['requested','confirmed','cancelled'].indexOf(o.status)<0)throw Error('Choose a valid PO status.');
      if(!Array.isArray(o.lines)||!o.lines.length||o.lines.length>300)throw Error('Each PO needs at least one material.');
      var seen={};
      var lines=o.lines.map(function(l){
        var itemId=id(l.itemId);if(!items[itemId])throw Error('A PO references a missing BOM material.');if(seen[itemId])throw Error('Use one row per BOM material in a PO.');seen[itemId]=true;
        var quantity=number(l.quantity,false),received=number(l.received==null?0:l.received,true),unitPrice=number(l.unitPrice==null?0:l.unitPrice,true);
        if(received>quantity)throw Error('Received quantity cannot exceed the ordered quantity.');
        if(o.status!=='confirmed'&&received>0)throw Error('Only supplier-confirmed POs can have deliveries.');
        if(o.status!=='cancelled')allocated[itemId]=(allocated[itemId]||0)+quantity;
        return {itemId:itemId,quantity:quantity,received:received,unitPrice:unitPrice};
      });
      return {id:unique(o.id),reference:ref,supplier:supplier,date:date(o.date),status:o.status,notes:clean(o.notes,500),lines:lines};
    });
    Object.keys(allocated).forEach(function(k){if(allocated[k]-items[k].quantity>0.000001)throw Error('PO requests exceed the BOM quantity for '+items[k].material+'. Reduce/cancel another request first.');});
    return {boms:boms,orders:orders};
  }
  function summary(value,bomId){
    var rows=[];
    value.boms.forEach(function(b){if(bomId&&b.id!==bomId)return;b.items.forEach(function(i){
      var requested=0,ordered=0,received=0;
      value.orders.forEach(function(o){if(o.status==='cancelled')return;o.lines.forEach(function(l){if(l.itemId!==i.id)return;if(o.status==='requested')requested+=l.quantity;else{ordered+=l.quantity;received+=l.received;}});});
      function n(v){return Math.round(Math.max(0,v)*1000000)/1000000;}
      rows.push({bomId:b.id,bom:b.name,id:i.id,material:i.material,spec:i.spec,unit:i.unit,required:i.quantity,requested:n(requested),ordered:n(ordered),received:n(received),remaining:n(i.quantity-ordered),unallocated:n(i.quantity-ordered-requested),awaitingDelivery:n(ordered-received)});
    });});return rows;
  }
  function consolidate(rows){
    var groups={};rows.forEach(function(r){
      var key=JSON.stringify([r.material.trim().toLowerCase(),r.spec.trim().toLowerCase(),r.unit.trim().toLowerCase()]);
      if(!groups[key])groups[key]={material:r.material,spec:r.spec,unit:r.unit,boms:[],required:0,requested:0,ordered:0,received:0,remaining:0,unallocated:0,awaitingDelivery:0};
      var g=groups[key];if(g.boms.indexOf(r.bom)<0)g.boms.push(r.bom);
      ['required','requested','ordered','received','remaining','unallocated','awaitingDelivery'].forEach(function(k){g[k]=Math.round((g[k]+r[k])*1000000)/1000000;});
    });return Object.keys(groups).map(function(k){var g=groups[k];g.bom=g.boms.join(' / ');return g;});
  }
  var logic={normalize:normalize,summary:summary,consolidate:consolidate};
  if(typeof module!=='undefined'&&module.exports)module.exports=logic;
  root.ProcurementLogic=logic;
  if(typeof document==='undefined')return;
  var model={projectId:null,data:{boms:[],orders:[]},revision:0,ready:false,busy:false,error:'',api:null,editingBom:null,editingPO:null,bomRequestId:null,poRequestId:null,pending:null};
  var $=function(id){return document.getElementById(id);},esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});};
  var today=function(){var d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');};
  var uid=function(){return 'pr-'+crypto.randomUUID();};
  var qty=function(n){return Number(n).toLocaleString('en-PH',{maximumFractionDigits:6});};
  var peso=function(n){return Number(n).toLocaleString('en-PH',{style:'currency',currency:'PHP'});};
  function blankForms(){
    $('pr-bom-form').reset();$('pr-po-form').reset();$('pr-bom-date').value=today();$('pr-po-date').value=today();
    $('pr-bom-items').innerHTML='';$('pr-po-items').innerHTML='';$('pr-paste').value='';model.editingBom=null;model.editingPO=null;model.bomRequestId=null;model.poRequestId=null;model.pending=null;model.error='';
    $('pr-bom-title').textContent='Add BOM';$('pr-po-title').textContent='Create PO request';$('pr-bom-details').open=false;$('pr-po-details').open=false;
  }
  function dirty(){return !!model.editingBom||!!model.editingPO||!!$('pr-bom-name').value.trim()||!!$('pr-po-ref').value.trim()||!!$('pr-paste').value.trim()||!!$('pr-bom-items').children.length||!!$('pr-po-items').children.length;}
  function render(){
    $('pr-fields-bom').disabled=!model.ready||model.busy||!model.api||!model.api.canWrite();$('pr-fields-po').disabled=$('pr-fields-bom').disabled;
    $('pr-status').textContent=model.error||(model.ready?'Procurement synced.':'Open a saved project and connect to load procurement.');$('pr-status').className='rc-status'+(model.error?' err':'');
    $('pr-export').disabled=!model.ready;$('pr-backup').disabled=!model.ready;var selected=$('pr-filter').value;
    $('pr-filter').innerHTML='<option value="">All BOMs</option>'+model.data.boms.map(function(b){return '<option value="'+esc(b.id)+'">'+esc(b.name)+'</option>';}).join('');$('pr-filter').value=selected;
    var rows=summary(model.data,$('pr-filter').value);if($('pr-group').checked)rows=consolidate(rows);var pending=rows.filter(function(r){return r.remaining>0;}).length;
    $('pr-totals').textContent=model.data.boms.length+' BOMs · '+model.data.orders.filter(function(o){return o.status==='requested';}).length+' requested POs · '+pending+' material lines still to procure · '+rows.filter(function(r){return r.awaitingDelivery>0;}).length+' lines awaiting delivery';
    $('pr-summary').innerHTML=rows.length?rows.map(function(r){return '<tr><td>'+esc(r.bom)+'</td><td>'+esc(r.material)+(r.spec?'<br><span class="muted">'+esc(r.spec)+'</span>':'')+'</td><td>'+esc(r.unit)+'</td>'+[r.required,r.requested,r.ordered,r.received,r.remaining,r.unallocated,r.awaitingDelivery].map(function(n){return '<td>'+qty(n)+'</td>';}).join('')+'</tr>';}).join(''):'<tr><td colspan="10">No BOM materials yet. Add the draftsman’s first BOM below.</td></tr>';
    $('pr-boms').innerHTML=model.data.boms.map(function(b){return '<div class="card"><strong>'+esc(b.name)+'</strong> · '+b.items.length+' materials · '+esc(b.draftsman||'Draftsman not recorded')+' · '+esc(b.date)+' <button class="btn ghost small" type="button" data-pr-bom="'+esc(b.id)+'" '+(!model.ready||model.busy||!model.api||!model.api.canWrite()?'disabled':'')+'>Edit BOM</button></div>';}).join('');
    $('pr-orders').innerHTML=model.data.orders.length?model.data.orders.map(function(o){
      var details=o.lines.map(function(l){var r=summary(model.data).find(function(r){return r.id===l.itemId;});return '<tr><td>'+esc(r.bom)+'</td><td>'+esc(r.material)+' '+esc(r.spec)+'</td><td>'+qty(l.quantity)+' '+esc(r.unit)+'</td><td>'+qty(l.received)+' '+esc(r.unit)+'</td><td>'+peso(l.unitPrice)+'</td></tr>';}).join('');
      return '<div class="card"><div class="card-head"><div><strong>'+esc(o.reference)+' · '+esc(o.supplier)+'</strong><div class="muted">'+esc(o.date)+' · '+({requested:'PO requested — awaiting supplier confirmation',confirmed:'Supplier confirmed',cancelled:'Cancelled'})[o.status]+' · '+peso(o.lines.reduce(function(s,l){return s+l.quantity*l.unitPrice;},0))+'</div></div><div><button type="button" class="btn ghost small" data-pr-po="'+esc(o.id)+'" '+(!model.ready||model.busy||!model.api||!model.api.canWrite()?'disabled':'')+'>Edit / record delivery</button> <button type="button" class="btn ghost small" data-pr-print="'+esc(o.id)+'">Print PO</button></div></div><div class="table-wrap"><table class="stack"><thead><tr><th>BOM</th><th>Material / specification</th><th>PO quantity</th><th>Received</th><th>Unit price</th></tr></thead><tbody>'+details+'</tbody></table></div><div class="muted">'+esc(o.notes)+'</div></div>';
    }).join(''):'<p class="muted">No purchase orders yet. Create one PO per supplier; split a material across as many suppliers as needed.</p>';
    labelTables();
  }
  function labelTables(){
    $('procurementCard').querySelectorAll('table.stack').forEach(function(table){
      var heads=Array.from(table.querySelectorAll('thead th')).map(function(th){return th.textContent.trim();});
      table.querySelectorAll('tbody tr').forEach(function(tr){Array.from(tr.cells).forEach(function(td,index){if(td.colSpan>1)return;td.classList.toggle('c-main',index===0);if(index>0)td.setAttribute('data-label',heads[index]||'');});});
    });
  }
  async function refresh(){
    if(!model.api||!model.api.canRead()||model.projectId==='sample'){model.ready=false;render();return;}
    var pid=model.projectId;
    try{var res=await model.api.get(pid);if(pid!==model.projectId||model.busy||res.revision<model.revision)return;model.data=normalize(res.data);model.revision=res.revision;model.ready=true;model.error='';render();}
    catch(e){if(pid!==model.projectId)return;model.ready=false;model.error=e.code==='invalid_argument'?'Update the Apps Script deployment to enable procurement tracking.':e.message||'Procurement could not load.';render();}
  }
  async function save(next,done){
    if(model.busy||!model.ready||!model.api.canWrite())return;
    try{next=normalize(next);}catch(e){model.error=e.message;render();return;}
    model.busy=true;model.error='';render();var pid=model.projectId,revision=model.revision,signature=JSON.stringify(next);
    var mutationId=model.pending&&model.pending.pid===pid&&model.pending.revision===revision&&model.pending.signature===signature?model.pending.id:uid();
    model.pending={pid:pid,revision:revision,signature:signature,id:mutationId};
    try{
      var res=await model.api.track(function(){return model.api.save(pid,next,revision,mutationId);},null,null);
      if(pid!==model.projectId)return;model.data=normalize(res.data);model.revision=res.revision;model.ready=true;model.error='';done();
    }catch(e){model.error=e.code==='conflict'?'Another officer changed this project. Refresh procurement, review the latest quantities, then save again. Your form is retained.':e.message||'Not saved. Your form is retained; try again.';}
    finally{model.busy=false;render();if(pid!==model.projectId)refresh();}
  }
  function copy(){return JSON.parse(JSON.stringify(model.data));}
  function bomRow(item){
    item=item||{};var tr=document.createElement('tr');tr.dataset.id=item.id||uid();
    tr.innerHTML='<td><input aria-label="Material" data-field="material" required maxlength="150" value="'+esc(item.material)+'"></td><td><input aria-label="Specification" data-field="spec" maxlength="200" value="'+esc(item.spec)+'"></td><td><input aria-label="Unit" data-field="unit" required maxlength="30" value="'+esc(item.unit||'pcs')+'"></td><td><input aria-label="Required quantity" data-field="quantity" type="number" min="0.000001" step="any" required value="'+esc(item.quantity)+'"></td><td><button type="button" class="btn ghost small" data-pr-remove>Remove</button></td>';$('pr-bom-items').appendChild(tr);
  }
  function poRow(line){
    line=line||{};var rows=summary(model.data),tr=document.createElement('tr');
    tr.innerHTML='<td><select aria-label="BOM material" data-field="itemId" required><option value="">Choose BOM material</option>'+rows.map(function(r){return '<option value="'+esc(r.id)+'">'+esc(r.bom+' · '+r.material+' · '+r.spec+' ('+r.unit+')')+'</option>';}).join('')+'</select></td><td><input aria-label="PO quantity" data-field="quantity" type="number" min="0.000001" step="any" required value="'+esc(line.quantity)+'"></td><td><input aria-label="Received quantity" data-field="received" type="number" min="0" step="any" required value="'+esc(line.received==null?0:line.received)+'"></td><td><input aria-label="Unit price" data-field="unitPrice" type="number" min="0" step="any" required value="'+esc(line.unitPrice==null?0:line.unitPrice)+'"></td><td><button type="button" class="btn ghost small" data-pr-remove>Remove</button></td>';tr.querySelector('select').value=line.itemId||'';$('pr-po-items').appendChild(tr);
  }
  function formLines(body,fields){return Array.from($(body).children).map(function(tr){var v={};fields.forEach(function(k){var el=tr.querySelector('[data-field="'+k+'"]');v[k]=el.type==='number'?Number(el.value):el.value;});if(body==='pr-bom-items')v.id=tr.dataset.id;return v;});}
  function printPO(id){
    var o=model.data.orders.find(function(o){return o.id===id;}),rows=summary(model.data);if(!o)return;
    var win=window.open('','_blank');if(!win){model.error='Allow pop-ups to print this PO.';render();return;}
    var title='PO '+o.reference,html='<!doctype html><html><head><title>'+esc(title)+'</title><style>body{font:14px Arial;padding:24px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #aaa;padding:8px;text-align:left}</style></head><body><h1>'+esc(title)+'</h1><p>Project: '+esc(model.api.projectName())+'<br>Supplier: '+esc(o.supplier)+'<br>Date: '+esc(o.date)+'<br>Status: '+esc(o.status)+'</p><table><tr><th>BOM</th><th>Material / specification</th><th>Quantity</th><th>Unit price</th><th>Total</th></tr>';
    o.lines.forEach(function(l){var r=rows.find(function(r){return r.id===l.itemId;});html+='<tr><td>'+esc(r.bom)+'</td><td>'+esc(r.material+' '+r.spec)+'</td><td>'+qty(l.quantity)+' '+esc(r.unit)+'</td><td>'+peso(l.unitPrice)+'</td><td>'+peso(l.quantity*l.unitPrice)+'</td></tr>';});html+='</table><p>Total: '+peso(o.lines.reduce(function(s,l){return s+l.quantity*l.unitPrice;},0))+'</p><p>'+esc(o.notes)+'</p></body></html>';win.document.write(html);win.document.close();win.focus();win.print();
  }
  function init(){
    var card=$('procurementCard');if(!card)return;
    $('pr-refresh').addEventListener('click',refresh);$('pr-filter').addEventListener('change',render);$('pr-group').addEventListener('change',render);
    $('pr-bom-add-row').addEventListener('click',function(){bomRow();});$('pr-po-add-row').addEventListener('click',function(){poRow();});
    card.addEventListener('click',function(e){
      var remove=e.target.closest('[data-pr-remove]');if(remove){remove.closest('tr').remove();return;}
      var b=e.target.closest('[data-pr-bom]'),o=e.target.closest('[data-pr-po]'),print=e.target.closest('[data-pr-print]');if(print){printPO(print.dataset.prPrint);return;}
      if((b||o)&&model.ready&&!model.busy&&model.api.canWrite()){
        if(dirty()&&!confirm('Discard unsaved procurement form details?'))return;blankForms();
        if(b){var bom=model.data.boms.find(function(v){return v.id===b.dataset.prBom;});model.editingBom=bom.id;$('pr-bom-name').value=bom.name;$('pr-bom-draftsman').value=bom.draftsman;$('pr-bom-date').value=bom.date;bom.items.forEach(bomRow);$('pr-bom-title').textContent='Edit BOM';$('pr-bom-details').open=true;}
        else{var po=model.data.orders.find(function(v){return v.id===o.dataset.prPo;});model.editingPO=po.id;$('pr-po-ref').value=po.reference;$('pr-po-supplier').value=po.supplier;$('pr-po-date').value=po.date;$('pr-po-state').value=po.status;$('pr-po-notes').value=po.notes;po.lines.forEach(poRow);$('pr-po-title').textContent='Edit PO / record delivery';$('pr-po-details').open=true;}
      }
    });
    ['pr-bom-clear','pr-po-clear'].forEach(function(id){$(id).addEventListener('click',function(){if(!dirty()||confirm('Discard unsaved procurement form details?'))blankForms();});});
    $('pr-paste-add').addEventListener('click',function(){
      var text=$('pr-paste').value.trim();if(!text)return;
      var lines=text.split(/\r?\n/).map(function(r){return r.split('\t');});
      try{var parsed=lines.map(function(c){if(c.length!==4||!c[0].trim()||!c[2].trim()||!Number.isFinite(Number(c[3]))||Number(c[3])<=0)throw Error('Paste four tab-separated columns: Material, Specification, Unit, Quantity. No header row.');return {material:c[0].trim(),spec:c[1].trim(),unit:c[2].trim(),quantity:Number(c[3])};});parsed.forEach(bomRow);$('pr-paste').value='';model.error='';}catch(e){model.error=e.message;}render();
    });
    $('pr-bom-form').addEventListener('submit',function(e){e.preventDefault();var next=copy(),bom={id:model.editingBom||model.bomRequestId||(model.bomRequestId=uid()),name:$('pr-bom-name').value,draftsman:$('pr-bom-draftsman').value,date:$('pr-bom-date').value,items:formLines('pr-bom-items',['material','spec','unit','quantity'])};var index=next.boms.findIndex(function(v){return v.id===bom.id;});if(index<0)next.boms.push(bom);else next.boms[index]=bom;save(next,blankForms);});
    $('pr-po-form').addEventListener('submit',function(e){e.preventDefault();var next=copy(),po={id:model.editingPO||model.poRequestId||(model.poRequestId=uid()),reference:$('pr-po-ref').value,supplier:$('pr-po-supplier').value,date:$('pr-po-date').value,status:$('pr-po-state').value,notes:$('pr-po-notes').value,lines:formLines('pr-po-items',['itemId','quantity','received','unitPrice'])};var index=next.orders.findIndex(function(v){return v.id===po.id;});if(index<0)next.orders.push(po);else next.orders[index]=po;save(next,blankForms);});
    $('pr-backup').addEventListener('click',function(){
      if(!model.ready)return;var output={app:'ritehome-procurement',version:1,projectId:model.projectId,projectName:model.api.projectName(),exportedAt:new Date().toISOString(),revision:model.revision,data:model.data};
      var url=URL.createObjectURL(new Blob([JSON.stringify(output,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='procurement-backup-'+model.projectId+'.json';a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);
    });
    $('pr-export').addEventListener('click',function(){if(!model.ready)return;function cell(s){s=String(s==null?'':s);if(/^[=+@\-\t\r\n]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}var csv=[['BOM','Material','Specification','Unit','Required','PO requested','Supplier confirmed','Received','Still to procure','No supplier allocated','Awaiting delivery']].concat(($('pr-group').checked?consolidate(summary(model.data,$('pr-filter').value)):summary(model.data,$('pr-filter').value)).map(function(r){return [r.bom,r.material,r.spec,r.unit,r.required,r.requested,r.ordered,r.received,r.remaining,r.unallocated,r.awaitingDelivery];})).map(function(r){return r.map(cell).join(',');}).join('\r\n');var blob=new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='procurement-'+model.projectId+'.csv';a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);});
    blankForms();render();setInterval(function(){if(model.projectId&&document.visibilityState==='visible'&&!card.closest('#projectScreen').hidden&&!model.busy&&!dirty())refresh();},30000);
  }
  root.ProcurementTracker={open:function(pid,api){if(!model.api)init();var changed=model.projectId!==pid;model.api=api;if(changed){model.projectId=pid;model.data={boms:[],orders:[]};model.ready=false;model.error='';blankForms();refresh();}else if(!model.ready&&api.canRead()&&!model.error)refresh();render();},close:function(){if(model.api){model.projectId=null;model.ready=false;model.data={boms:[],orders:[]};blankForms();render();}},dirty:dirty};
})(typeof globalThis!=='undefined'?globalThis:this);
