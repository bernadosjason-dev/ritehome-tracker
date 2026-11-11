(function(){
 'use strict';
 // Short addresses (portal.ritehomemodular.com/fuel, /projects, /procurement; "/" is the dashboard)
 // come from vercel.json rewrites. Hosts without them (the old GitHub Pages copy) keep ?portal=.
 var CLEAN=/(^|\.)ritehomemodular\.com$|\.vercel\.app$|^(127\.0\.0\.1|localhost)$/.test(location.hostname);
 var params=new URLSearchParams(location.search),seg=location.pathname.split('/').pop().replace(/\.html$/,'');
 var value=params.get('portal')||seg;
 var mode=['fuel','projects','procurement'].includes(value)?value:'all';
 window.RitehomePortal={mode:mode,clean:CLEAN};document.documentElement.dataset.portal=mode;
 // Old bookmarks and links (tracker.html?portal=fuel&v=...) tidy themselves to the short form, keeping
 // any other parameters and the #p= project link. Nothing reloads.
 if(CLEAN&&(/\/(tracker|index)\.html$/.test(location.pathname)||params.has('portal')||params.has('v'))){
  params.delete('portal');params.delete('v');
  var rest=params.toString();
  try{history.replaceState(history.state,'','/'+(mode==='all'?'':mode)+(rest?'?'+rest:'')+location.hash);}catch(e){}
 }
 document.addEventListener('DOMContentLoaded',function(){
  var names={fuel:'Fuel tracker',projects:'Project tracker',procurement:'Procurement tracker',all:'Staff portal'},name=names[mode];
  document.title=name+' · Ritehome';
  document.querySelector('.workspace-brand small').textContent=mode==='all'?'Projects · Procurement · Company fuel':name+' · Company workspace';
  if(mode==='all')return;
  document.querySelector('#gateScreen h1').textContent=name;
  document.querySelector('#dashboardScreen .hero h1').textContent=name;
  document.querySelector('#dashboardScreen .hero .sub').textContent=mode==='fuel'?'Track gasoline, diesel, receipts and admin confirmation across the company.':mode==='procurement'?'Start a procurement job, add a BOM, then request supplier POs. This workspace is separate from general projects.':'Manage client jobs, budgets, billing, labor and expenses.';
  if(mode==='procurement'){var backButton=document.getElementById('backBtn');backButton.textContent='All procurement jobs';backButton.dataset.uiIcon='arrow';}
  document.querySelectorAll('[data-ui-target]').forEach(function(button){
   var target=button.dataset.uiTarget;
   if(mode==='fuel')button.hidden=target!=='companyFuelCard';
   else if(mode==='projects')button.hidden=target==='companyFuelCard'||target==='procurementCard';
   else button.hidden=target==='companyFuelCard'||target==='arSection'||target==='expenseCard';
  });
 });
})();
