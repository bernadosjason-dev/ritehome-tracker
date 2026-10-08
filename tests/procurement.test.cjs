const {test}=require('node:test');
const assert=require('node:assert/strict');
const {normalize,summary,consolidate}=require('../procurement.js');
const {createBackend}=require('./fuel.test.cjs');
const bom={id:'bom1',name:'BOM 01',date:'2026-10-08',draftsman:'Technical draftsman',items:[{id:'sheets',material:'Plywood',spec:'18mm 4x8',unit:'sheets',quantity:24}]};
const order=(id,supplier,quantity,status='confirmed',received=0)=>({id,reference:'PO-'+id,supplier,date:'2026-10-08',status,notes:'',lines:[{itemId:'sheets',quantity,received,unitPrice:1000}]});
const state=(orders=[],boms=[bom])=>normalize({boms,orders});
test('16 of 24 sheets confirmed at supplier A leaves 8 still to procure',()=>{
 const r=summary(state([order('a','Supplier A',16)]))[0];assert.equal(r.required,24);assert.equal(r.ordered,16);assert.equal(r.remaining,8);assert.equal(r.unallocated,8);assert.equal(r.awaitingDelivery,16);
});
test('requested PO reserves supplier quantity but does not count as confirmed procurement',()=>{
 const r=summary(state([order('a','Supplier A',16,'requested')]))[0];assert.equal(r.requested,16);assert.equal(r.ordered,0);assert.equal(r.remaining,24);assert.equal(r.unallocated,8);
});
test('second supplier fulfills balance; partial delivery and cancellation remain separate',()=>{
 let r=summary(state([order('a','Supplier A',16,'confirmed',8),order('b','Supplier B',8)]))[0];assert.equal(r.remaining,0);assert.equal(r.received,8);assert.equal(r.awaitingDelivery,16);
 r=summary(state([order('a','Supplier A',16),order('b','Supplier B',8,'cancelled')]))[0];assert.equal(r.remaining,8);assert.equal(r.unallocated,8);
});
test('five BOMs preserve separate quantities and units and scope correctly',()=>{
 const boms=Array.from({length:5},(_,n)=>({...bom,id:'bom'+n,name:'BOM '+n,items:[{...bom.items[0],id:'material'+n,unit:n===4?'boxes':'sheets',quantity:n+1}]}));
 const value=state([],boms);assert.equal(summary(value).length,5);assert.equal(summary(value,'bom4')[0].unit,'boxes');assert.equal(summary(value,'bom4')[0].required,5);
});
test('invalid or excessive POs and inconsistent deliveries cannot be saved',()=>{
 for(const orders of [[order('a','A',25)],[order('a','A',16),order('b','B',9,'requested')],[order('a','A',16,'requested',1)],[order('a','A',16,'confirmed',17)],[order('a','A',16,'cancelled',1)]])assert.throws(()=>state(orders));
 assert.throws(()=>state([{...order('a','A',1),lines:[{itemId:'missing',quantity:1}]}]));
 assert.throws(()=>state([order('a','A',16),{...order('b','B',8),reference:'PO-a'}]));
 assert.throws(()=>state([], [{...bom,items:[{...bom.items[0],quantity:0}]}]));
 assert.throws(()=>state([], [{...bom,date:'2026-02-30'}]));
});
test('server saves atomically with revision checks and idempotent lost-response retries',()=>{
 const b=createBackend();const project=b.request({action:'addProject',data:{name:'Procurement test'}}).id;
 assert.equal(b.request({action:'getProcurement',projectId:project}).revision,0);
 const req={action:'saveProcurement',projectId:project,revision:0,mutationId:'pr-00000000-0000-4000-8000-000000000001',data:state([order('a','Supplier A',16)])};
 const saved=b.request(req);assert.equal(saved.ok,true);assert.equal(saved.revision,1);
 assert.equal(b.request(req).revision,1,'duplicate request does not change revision');
 assert.equal(b.request({...req,mutationId:'pr-00000000-0000-4000-8000-000000000002'}).code,'conflict');
 assert.equal(b.request({...req,data:state([])}).code,'invalid_argument','reusing same mutation with different data is rejected');
 assert.equal(b.request({...req,key:'wrong'}).code,'bad_key');
 assert.equal(b.request({action:'getProcurement',projectId:'missing'}).code,'not_found');
 assert.equal(b.request({...req,revision:1,mutationId:'pr-00000000-0000-4000-8000-000000000003',data:{boms:[bom],orders:[order('a','A',25)]}}).code,'invalid_argument');
 assert.equal(b.request({action:'getProcurement',projectId:project}).data.orders[0].supplier,'Supplier A');
});
test('server preserves PO material identity and prevents cancellation of delivered lines',()=>{
 const b=createBackend();const project=b.request({action:'addProject',data:{name:'History test'}}).id;
 const req={action:'saveProcurement',projectId:project,revision:0,mutationId:'pr-00000000-0000-4000-8000-000000000001',data:state([order('a','A',16,'confirmed',8)])};
 assert.equal(b.request(req).ok,true);
 assert.equal(b.request({...req,revision:1,mutationId:'pr-00000000-0000-4000-8000-000000000002',data:state([], [{...bom,items:[{...bom.items[0],spec:'different'}]}])}).code,'invalid_argument');
 assert.equal(b.request({...req,revision:1,mutationId:'pr-00000000-0000-4000-8000-000000000002',data:state([order('a','A',16,'cancelled')])}).code,'invalid_argument');
});

test('consolidated remaining summary combines identical materials but preserves units and specifications',()=>{
 const boms=[bom,{...bom,id:'bom2',name:'BOM 02',items:[{...bom.items[0],id:'moreSheets',quantity:10}]},{...bom,id:'bom3',name:'BOM 03',items:[{...bom.items[0],id:'thinSheets',spec:'12mm 4x8',quantity:2},{...bom.items[0],id:'boxes',unit:'boxes',quantity:1}]}];
 const rows=consolidate(summary(state([order('a','A',16)],boms)));
 assert.equal(rows.length,3);const merged=rows.find(r=>r.spec==='18mm 4x8'&&r.unit==='sheets');assert.equal(merged.required,34);assert.equal(merged.remaining,18);assert.equal(merged.bom,'BOM 01 / BOM 02');
});

test('procurement chunks are safe for Sheet formulas and corrupted storage is not overwritten',()=>{
 const b=createBackend(),project=b.request({action:'addProject',data:{name:'Integrity test'}}).id;
 const req={action:'saveProcurement',projectId:project,revision:0,mutationId:'pr-00000000-0000-4000-8000-000000000001',data:state([])};
 assert.equal(b.request(req).ok,true);
 const row=b.sheets.get('Procurement').rows[1];row.slice(4).forEach(chunk=>assert(chunk.startsWith('json:')));
 row[1]='corrupted';assert.equal(b.request({action:'getProcurement',projectId:project}).code,'data_loss');
 assert.equal(b.request({...req,revision:1,mutationId:'pr-00000000-0000-4000-8000-000000000002'}).code,'data_loss');
});
test('browser and Apps Script share the same procurement validation functions',()=>{
 const fs=require('fs'),path=require('path'),source=fs.readFileSync(path.join(__dirname,'../procurement.js'),'utf8');
 const core=source.slice(source.indexOf('  function clean('),source.indexOf('  var logic='));assert(fs.readFileSync(path.join(__dirname,'../backend/Code.gs'),'utf8').includes(core));
});

test('large multi-BOM records round-trip through safe Sheet chunks without truncation',()=>{
 const b=createBackend(),project=b.request({action:'addProject',data:{name:'Large BOM test'}}).id;
 const boms=Array.from({length:5},(_,n)=>({...bom,id:'largeBOM'+n,name:'Large BOM '+n,items:Array.from({length:40},(_,i)=>({id:'largeItem'+n+'_'+i,material:'Material '+n+' '+i+' '+ 'x'.repeat(90),spec:'='.repeat(190),unit:'pcs',quantity:1}))}));
 const data=state([],boms),req={action:'saveProcurement',projectId:project,revision:0,mutationId:'pr-00000000-0000-4000-8000-000000000001',data};
 assert.equal(b.request(req).ok,true);const record=b.sheets.get('Procurement').rows[1];assert(record[5].length>5,'second JSON chunk used');record.slice(4).forEach(chunk=>assert(chunk.length<=45005));
 assert.equal(JSON.stringify(b.request({action:'getProcurement',projectId:project}).data),JSON.stringify(data));
});
