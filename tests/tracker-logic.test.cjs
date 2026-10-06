const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const context=vm.createContext({window:{}});
vm.runInContext(script.slice(0,script.indexOf('  // ---------- sample project ----------'))+'\nglobalThis.logic={normBilling,billingSummary,computeTotals,expenseStats,laborBreakdown,dayDiff,addDaysISO};})();',context);
const logic=context.logic;
test('50/40/10 billing sums exactly to contract and accounts for withheld tax',()=>{
 const billing=logic.normBilling({billing:{dp:{received:45001,withheld:5000},progress:{received:0},retention:{received:0}}});
 const result=logic.billingSummary(100001,billing);
 assert.equal(result.rows.reduce((s,r)=>s+r.scheduled,0),100001);
 assert.equal(result.rows[0].owed,0);assert.equal(result.rows[1].scheduled,40000);assert.equal(result.rows[2].scheduled,10000);
 assert.equal(result.received,45001);assert.equal(result.withheld,5000);assert.equal(result.balance,50000);
});
test('project spending and receipt totals distinguish verified, pending and missing records',()=>{
 const records=[{amount:100.25,category:'transportation',date:'2026-10-03',receipt:'photo'}, {amount:200.5,category:'materials',date:'2026-10-02',noReceipt:true,headConfirmed:true}, {amount:300,category:'labor',date:'2026-10-01',noReceipt:true}, {amount:50,category:'food',date:'2026-09-30'}];
 const stats=logic.expenseStats(records);
 assert.equal(stats.totalSpent,650.75);assert.equal(stats.itemCount,4);assert.equal(stats.lastDate,'2026-10-03');
 assert.equal(stats.fuelSpent,100.25);assert.equal(stats.laborCost,300);assert.equal(stats.materialsSpent,200.5);
 assert.equal(stats.receiptVerified,2);assert.equal(stats.receiptUnconfirmed,1);assert.equal(stats.receiptMissing,1);
});
test('pakyawan, daily-rate and legacy labor payments are counted once',()=>{
 const records=[{category:'labor',amount:500,laborType:'pakyawan',pakyawanId:'contract'}, {category:'labor',amount:600,laborType:'fabrication',hours:8}, {category:'labor',amount:400}, {category:'materials',amount:1000}];
 const result=logic.laborBreakdown(records,[{id:'contract',amount:2000}],1000);
 assert.equal(result.total,1500);assert.equal(result.committed,3000);assert.equal(result.contractPaid,900);
 assert.equal(result.teams.fabrication.cost,600);assert.equal(result.teams.fabrication.hours,8);assert.equal(result.other.paid,0);
});
test('date math crosses leap days and year boundaries correctly',()=>{
 assert.equal(logic.dayDiff('2024-02-28','2024-03-01'),2);
 assert.equal(logic.dayDiff('2026-12-31','2027-01-01'),1);
 assert.equal(logic.addDaysISO('2026-12-31',1),'2027-01-01');
 assert.equal(logic.addDaysISO('2024-03-01',-1),'2024-02-29');
});
