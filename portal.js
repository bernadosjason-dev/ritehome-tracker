(function(){
 'use strict';
 var value=new URLSearchParams(location.search).get('portal');
 var mode=['fuel','projects','procurement'].includes(value)?value:'all';
 window.RitehomePortal={mode:mode};document.documentElement.dataset.portal=mode;
 document.addEventListener('DOMContentLoaded',function(){
  var names={fuel:'Fuel tracker',projects:'Project tracker',procurement:'Procurement tracker',all:'Company tracker'},name=names[mode];
  document.title=name+' · Ritehome';
  document.querySelector('.workspace-brand small').textContent=mode==='all'?'Projects · Procurement · Company fuel':name+' · Company workspace';
  var back=document.createElement('a');back.href='index.html';back.className='btn ghost portal-directory';back.textContent='All portals';document.querySelector('.workspace-bar').appendChild(back);
  if(mode==='all')return;
  document.querySelector('#gateScreen h1').textContent=name;
  document.querySelector('#dashboardScreen .hero h1').textContent=name;
  document.querySelector('#dashboardScreen .hero .eyebrow').textContent=mode==='fuel'?'Company vehicles & equipment':mode==='procurement'?'Independent procurement jobs':'Client projects';
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
