/* Builds the portal's left menu (shell.css) around the existing tracker page.
   It only adds navigation: the workspaces are tracker.html's portal modes (short addresses
   /projects, /procurement, /fuel on the live site, ?portal= elsewhere) and leads.html, schedule.html, accounting.html, and Sign out reuses the page's own button (#forgetKeyBtn). */
(function(){
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var PATHS = {
    dash: 'M3 3h8v10H3V3M13 3h8v6h-8V3M13 11h8v10h-8V11M3 15h8v6H3v-6',
    projects: 'M3 7h18v13H3V7M8 7V4h8v3',
    procurement: 'M3 6h11v12H3V6M14 10h4l3 4v4h-7M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
    fuel: 'M4 21V3h10v18M3 21h12M7 6h4v5H7V6M14 12h3v6h3V9l-3-3',
    pipeline: 'M3 5h5v14H3V5M10 5h5v9h-5V5M17 5h4v6h-4V5',
    calendar: 'M4 5h16v16H4V5M4 10h16M9 3v4M15 3v4',
    gantt: 'M4 6h9M7 12h11M5 18h7M3 3v18',
    attendance: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7v5l3 2',
    team: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M2 21c0-4 3-6 7-6s7 2 7 6M17 11a3 3 0 1 0 0-6M22 21c0-3-2-5-5-5',
    leads: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8M12 12h.01',
    books: 'M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2V4M5 18a2 2 0 0 1 2-2h12M9 8h6M9 11h4',
    menu: 'M4 7h16M4 12h16M4 17h16'
  };
  function icon(name){
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.7'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
    var p = document.createElementNS(NS, 'path'); p.setAttribute('d', PATHS[name]); s.appendChild(p);
    return s;
  }
  function el(tag, cls, text){ var e = document.createElement(tag); if(cls) e.className = cls; if(text != null) e.textContent = text; return e; }
  // Short addresses where vercel.json serves them (see portal.js); the long form elsewhere.
  var CLEAN = /(^|\.)ritehomemodular\.com$|\.vercel\.app$|^(127\.0\.0\.1|localhost)$/.test(location.hostname);
  function href(mode){
    if(mode === 'accounting') return CLEAN ? '/accounting' : 'accounting.html';
    if(mode === 'leads') return CLEAN ? '/leads' : 'leads.html';
    if(mode === 'schedule') return CLEAN ? '/schedule' : 'schedule.html';
    if(CLEAN) return mode === 'all' ? '/' : '/' + mode;
    return mode === 'all' ? 'tracker.html' : 'tracker.html?portal=' + mode;
  }
  window.RitehomeLinks = {href: href};
  function brand(){
    var a = el('a', 'side-brand'); a.href = href('all');
    var logo = el('img', 'side-logo'); logo.src = 'brand/logo-mark-light.png'; logo.alt = ''; logo.width = 430; logo.height = 894;
    a.appendChild(logo);
    var t = el('span'); t.appendChild(el('strong', null, 'RITEHOME')); t.appendChild(el('small', null, 'Staff portal'));
    a.appendChild(t);
    return a;
  }
  // Who is signed in: supabase-js keeps the session under this key; best effort only.
  function signedInEmail(){
    try {
      var raw = localStorage.getItem('sb-laxavfldivkhufeubgmb-auth-token');
      var s = raw && JSON.parse(raw);
      return (s && s.user && s.user.email) || '';
    } catch(e){ return ''; }
  }

  // Grey placeholders shaped like the page that's loading (body.connecting shows it; shell.css).
  function buildSkeleton(mode){
    var s = el('div', 'app-skeleton no-print'); s.setAttribute('role', 'status'); s.setAttribute('aria-live', 'polite');
    s.appendChild(el('span', 'sk-sr', 'Loading…'));
    function blk(cls){ var b = el('div', 'sk ' + cls); b.setAttribute('aria-hidden', 'true'); return b; }
    function card(lines){
      var c = el('div', 'sk-card'); c.setAttribute('aria-hidden', 'true');
      c.appendChild(blk('sk-line w40 tall'));
      for(var i = 0; i < lines; i++) c.appendChild(blk('sk-line ' + ['w100', 'w80', 'w90', 'w60'][i % 4]));
      return c;
    }
    s.appendChild(blk('sk-title')); s.appendChild(blk('sk-line w60'));
    if(mode === 'fuel' || mode === 'procurement'){
      var form = el('div', 'sk-cards one'); form.appendChild(card(3)); s.appendChild(form);
      var rows = el('div', 'sk-cards one'); rows.appendChild(card(7)); s.appendChild(rows);
    } else {
      var k = el('div', 'sk-kpis');
      for(var i = 0; i < 4; i++) k.appendChild(blk('sk-kpi'));
      s.appendChild(k);
      var cards = el('div', 'sk-cards');
      cards.appendChild(card(5)); cards.appendChild(card(5));
      s.appendChild(cards);
    }
    return s;
  }

  function build(){
    var mode = (window.RitehomePortal && window.RitehomePortal.mode) || 'all';
    var side = el('aside', 'app-side no-print'); side.id = 'appSide'; side.setAttribute('aria-label', 'Portal menu');
    side.appendChild(brand());
    side.appendChild(el('div', 'side-label', 'Workspaces'));
    [['all', 'Dashboard', 'dash'], ['leads', 'Leads', 'leads'], ['projects', 'Projects', 'projects'], ['schedule', 'Schedule', 'gantt'], ['procurement', 'Procurement', 'procurement'],
     ['fuel', 'Company fuel', 'fuel'], ['accounting', 'Accounting', 'books']].forEach(function(n){
      var a = el('a', 'side-link'); a.href = href(n[0]); a.appendChild(icon(n[2])); a.appendChild(document.createTextNode(n[1]));
      if(n[0] === mode) a.setAttribute('aria-current', 'page');
      side.appendChild(a);
    });
    side.appendChild(el('div', 'side-label', 'Coming next'));
    [['Project files', 'pipeline'], ['Attendance', 'attendance'], ['Team accounts', 'team']].forEach(function(n){
      var d = el('div', 'side-link soon'); d.setAttribute('aria-disabled', 'true');
      d.appendChild(icon(n[1])); d.appendChild(document.createTextNode(n[0])); d.appendChild(el('span', 'soon-tag', 'Soon'));
      side.appendChild(d);
    });
    var foot = el('div', 'side-foot');
    var who = el('div', 'side-who'); who.id = 'sideWho';
    var out = el('button', 'side-out', 'Sign out'); out.type = 'button'; out.id = 'sideSignOut';
    out.addEventListener('click', function(){ var b = document.getElementById('forgetKeyBtn'); if(b) b.click(); });
    foot.appendChild(who); foot.appendChild(out); side.appendChild(foot);

    var top = el('div', 'app-top no-print');
    var menuBtn = el('button'); menuBtn.type = 'button'; menuBtn.setAttribute('aria-label', 'Open menu');
    menuBtn.setAttribute('aria-controls', 'appSide'); menuBtn.setAttribute('aria-expanded', 'false'); menuBtn.appendChild(icon('menu'));
    top.appendChild(menuBtn); top.appendChild(brand());
    var scrim = el('div', 'side-scrim');
    var skeleton = buildSkeleton(mode);

    function setOpen(open){
      document.body.classList.toggle('side-open', open);
      menuBtn.setAttribute('aria-expanded', String(open));
    }
    menuBtn.addEventListener('click', function(){ setOpen(!document.body.classList.contains('side-open')); });
    scrim.addEventListener('click', function(){ setOpen(false); });
    document.addEventListener('keydown', function(e){ if(e.key === 'Escape') setOpen(false); });

    document.body.classList.add('has-side');
    document.body.insertBefore(scrim, document.body.firstChild);
    document.body.insertBefore(side, document.body.firstChild);
    var wrap = document.querySelector('.wrap');
    if(wrap){ wrap.insertBefore(top, wrap.firstChild); wrap.insertBefore(skeleton, top.nextSibling); }

    function refreshWho(){
      var fk = document.getElementById('forgetKeyBtn');
      out.textContent = fk && fk.textContent.trim() === 'Sign out' ? 'Sign out' : (fk ? fk.textContent.trim() || 'Sign out' : 'Sign out');
      var email = signedInEmail();
      who.textContent = email ? 'Signed in as ' + email : '';
    }
    refreshWho();
    document.addEventListener('DOMContentLoaded', refreshWho);   // #forgetKeyBtn comes later in the page
    // the page sets the button label and the session after boot
    new MutationObserver(refreshWho).observe(document.body, {attributes: true, attributeFilter: ['class']});
  }
  // Loaded as the first thing inside .wrap: build now, before any content can paint without the
  // menu. (Waiting for DOMContentLoaded let the browser paint a frame without it.)
  if(document.body && document.querySelector('.wrap')) build(); else document.addEventListener('DOMContentLoaded', build);
})();
