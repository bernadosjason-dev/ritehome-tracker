/* Attendance: clock in and out with a selfie and a GPS fix; the admin reviews the day and the month.
   Data and rules: supabase/migrations/20261116000013_attendance.sql (and the punches table in
   portal_core). The face check runs here in the browser (vendor/face-api) to make a 128-number
   template; the comparison with the reference template happens in the database. */
(function(){
  'use strict';
  var SUPABASE_URL = "https://laxavfldivkhufeubgmb.supabase.co";
  var SUPABASE_KEY = "sb_publishable_8vOuny8cDkb-vtwyOP7vnA_VqFYc5T1";
  var BUCKET = "attendance-selfies";
  var KINDS = [["am_in", "Morning in", "Clock in · morning"], ["am_out", "Morning out", "Clock out · lunch"],
    ["pm_in", "Afternoon in", "Clock in · afternoon"], ["pm_out", "Afternoon out", "Clock out · end of day"]];
  var KIND = {}; KINDS.forEach(function(k){ KIND[k[0]] = k; });
  var ROLE = {admin: "Admin", designer: "Designer", sales: "Sales", bookkeeper: "Bookkeeper", purchaser: "Purchaser", fabrication: "Workshop", installer: "Installer"};

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: false}});
  var state = {me: null, tab: "mine", day: null, month: [], flash: null, roles: [], manage: false,
    pay: null, dayPay: {}, payRows: [], rates: [], settings: null, period: null};
  // Pay (v3.3, supabase/migrations/20261126000023_salary.sql): every figure is computed in pay_day_calc().
  var STATUS = {present: "Worked", incomplete: "Missing a punch", in_progress: "Working", leave_paid: "Paid leave", leave_unpaid: "Unpaid leave",
    absent: "Absent", holiday: "Holiday", rest_day: "Rest day", scheduled: "Ahead", not_yet: "Not in yet", unaccounted: "Unaccounted"};
  var EMPLOY = {regular: "Regular", probationary: "Probationary", contractual: "Contractual", project_based: "Project-based", part_time: "Part-time"};
  var pesoFmt = new Intl.NumberFormat("en-PH", {style: "currency", currency: "PHP"});
  function peso(n){ return pesoFmt.format(Number(n) || 0); }
  function mins(m){ m = Number(m) || 0; var hh = Math.floor(m / 60), mm = m % 60; return hh ? hh + " h" + (mm ? " " + mm + " min" : "") : mm + " min"; }
  var LEAVE = {vacation: "Vacation leave", sick: "Sick leave", emergency: "Emergency leave", bereavement: "Bereavement leave",
    maternity_paternity: "Maternity / paternity leave", unpaid: "Unpaid leave", other: "Leave"};

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
  function put(id, node){ var el = typeof id === "string" ? $(id) : id; el.textContent = ""; if(node) el.appendChild(node); }
  // A call that may not exist yet (before migration 23 is applied): no figures, no error, nothing reported.
  function quiet(name, args){ return client.rpc(name, args || {}).then(function(r){ return r.error ? null : r.data; }, function(){ return null; }); }
  function rpc(name, args){
    return client.rpc(name, args || {}).then(function(r){
      if(r.error){ if(window.RitehomeRefused) window.RitehomeRefused(client, "Attendance", name, r.error); throw new Error(r.error.message || "The request failed."); }
      return r.data;
    });
  }
  function msg(text, bad){
    var m = $("acctMsg"); m.textContent = text; m.hidden = !text; m.classList.toggle("bad", !!bad);
    clearTimeout(msg.t); if(text && !bad) msg.t = setTimeout(function(){ m.hidden = true; }, 6000);
  }
  function fail(e){ msg(e && e.message ? e.message : String(e), true); }
  function busy(b, on){ if(window.RitehomeBusy) window.RitehomeBusy(b, on); else if(b) b.disabled = !!on; }
  function clock(iso){ return new Date(iso).toLocaleTimeString("en-PH", {hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila"}); }
  function dayName(d){ return new Date(d + "T00:00:00+08:00").toLocaleDateString("en-PH", {weekday: "short", month: "short", day: "numeric", timeZone: "Asia/Manila"}); }
  function far(m){ return m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m"; }
  function pills(p, full){
    var out = [], f = p.flags || [];
    if(f.indexOf("late") >= 0) out.push(["warn", "Late"]);
    if(f.indexOf("early_out") >= 0) out.push(["warn", "Left early"]);
    if(f.indexOf("off_site") >= 0) out.push(["", "Off site · " + far(p.office_distance_m)]);
    if(f.indexOf("face_mismatch") >= 0) out.push(["bad", full ? "Face doesn't match" : "Photo to be checked"]);
    if(f.indexOf("no_face_check") >= 0) out.push(["warn", full ? "Face not checked" : "Photo to be checked"]);
    if(f.indexOf("low_gps_accuracy") >= 0) out.push(["warn", "Weak GPS"]);
    return out.length ? h("span", {class: "pills"}, out.map(function(x){ return h("span", {class: "pill " + x[0], text: x[1]}); })) : null;
  }

  // ---------- the face template, made on this device ----------
  // Tests replace this with a stand-in (a headless browser has no face to show the camera).
  var Face = window.RitehomeFaceStub || (function(){
    var ready;
    function load(){
      if(!ready) ready = new Promise(function(res, rej){
        var s = document.createElement("script"); s.src = "vendor/face-api-1.7.15.js";
        s.onload = res; s.onerror = function(){ rej(new Error("The face check didn't load.")); };
        document.head.appendChild(s);
      }).then(function(){
        var f = window.faceapi, base = "vendor/face-models";
        return Promise.all([f.nets.tinyFaceDetector.loadFromUri(base), f.nets.faceLandmark68TinyNet.loadFromUri(base), f.nets.faceRecognitionNet.loadFromUri(base)]);
      });
      return ready;
    }
    return {warm: load, describe: function(canvas){
      return load().then(function(){
        return window.faceapi.detectSingleFace(canvas, new window.faceapi.TinyFaceDetectorOptions({inputSize: 416, scoreThreshold: 0.5})).withFaceLandmarks(true).withFaceDescriptor();
      }).then(function(r){ return r ? Array.prototype.slice.call(r.descriptor) : null; });
    }};
  })();
  window.RitehomeAttendance = {describe: function(c){ return Face.describe(c); }};

  function locate(){
    return new Promise(function(res, rej){
      if(!navigator.geolocation) return rej(new Error("This browser can't give a location. Use Chrome or Safari on your phone."));
      navigator.geolocation.getCurrentPosition(function(p){ res({lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy}); },
        function(e){ rej(new Error(e.code === 1 ? "Location is switched off for this site. Allow it in your browser's settings, then try again." : "Couldn't get your location. Step outside or near a window and try again.")); },
        {enableHighAccuracy: true, timeout: 20000, maximumAge: 0});
    });
  }

  // ---------- camera: resolves {blob, descriptor} or null when cancelled ----------
  function takePhoto(title, needFace, withLocation){
    return new Promise(function(done){
      var video = $("camVideo"), canvas = $("camCanvas"), stream = null, descriptor = null, where = null, whereErr = null, finished = false;
      var lines = {};
      function line(key, text, cls){
        if(!lines[key]){ lines[key] = h("li"); $("camStatus").appendChild(lines[key]); }
        lines[key].textContent = text; lines[key].className = cls || "";
      }
      function stop(){ if(stream){ stream.getTracks().forEach(function(t){ t.stop(); }); stream = null; } video.srcObject = null; }
      function close(result){ if(finished) return; finished = true; stop(); $("cam").hidden = true; done(result); }
      function ready(){ $("camUse").disabled = (needFace && !descriptor) || (withLocation && !where); }
      function live(){
        descriptor = null; canvas.hidden = true; video.hidden = false; $("camShoot").hidden = false; $("camUse").hidden = true; $("camRetake").hidden = true;
        line("face", needFace ? "Face the light, no cap or mask." : "Look at the camera.", "");
        if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ $("camShoot").textContent = "Open the camera"; return; }
        navigator.mediaDevices.getUserMedia({video: {facingMode: "user", width: {ideal: 640}, height: {ideal: 480}}, audio: false})
          .then(function(s){ if(finished){ s.getTracks().forEach(function(t){ t.stop(); }); return; } stream = s; video.srcObject = s; $("camShoot").textContent = "Take photo"; })
          .catch(function(){ $("camShoot").textContent = "Open the camera"; line("face", "The camera is blocked for this site. Tap “Open the camera” to take the photo another way.", "bad"); });
      }
      function shot(source, w, h0){
        var scale = Math.min(1, 640 / w); canvas.width = Math.round(w * scale); canvas.height = Math.round(h0 * scale);
        canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
        stop(); video.hidden = true; canvas.hidden = false; $("camShoot").hidden = true; $("camUse").hidden = false; $("camRetake").hidden = false;
        $("camUse").disabled = true; line("face", "Checking the photo…", "");
        Face.describe(canvas).then(function(d){ descriptor = d; }, function(){ descriptor = null; }).then(function(){
          if(finished) return;
          line("face", descriptor ? "Face found." : needFace ? "No face found. Move into better light and retake." : "No clear face found. You can still clock in; the admin will check this photo.", descriptor ? "ok" : needFace ? "bad" : "");
          ready();
        });
      }
      $("camTitle").textContent = title; put("camStatus", null); $("cam").hidden = false;
      $("camShoot").onclick = function(){
        if(stream && video.videoWidth) return shot(video, video.videoWidth, video.videoHeight);
        $("camFile").value = ""; $("camFile").click();
      };
      $("camFile").onchange = function(){
        var f = $("camFile").files[0]; if(!f) return;
        var img = new Image(); img.onload = function(){ shot(img, img.naturalWidth, img.naturalHeight); URL.revokeObjectURL(img.src); };
        img.onerror = function(){ line("face", "That file isn't a photo.", "bad"); }; img.src = URL.createObjectURL(f);
      };
      $("camRetake").onclick = live;
      $("camCancel").onclick = function(){ close(null); };
      $("camUse").onclick = function(){
        canvas.toBlob(function(blob){ close({blob: blob, descriptor: descriptor, where: where}); }, "image/jpeg", 0.82);
      };
      if(withLocation){
        line("where", "Finding your location…", "");
        locate().then(function(w){ where = w; if(!finished){ line("where", "Location found, within " + Math.round(w.accuracy) + " m.", "ok"); if(!$("camUse").hidden) ready(); } },
          function(e){ whereErr = e; if(!finished) line("where", e.message, "bad"); });
      }
      live();
    });
  }
  function upload(blob, name){
    var path = state.me.id + "/" + name + "-" + Date.now() + ".jpg";
    return client.storage.from(BUCKET).upload(path, blob, {contentType: "image/jpeg", upsert: false}).then(function(r){
      if(r.error) throw new Error("The photo didn't upload (" + (r.error.message || "network") + "). Try again.");
      return path;
    });
  }

  // ---------- my attendance ----------
  function nextKind(){
    var done = {}; state.me.punches.forEach(function(p){ done[p.kind] = 1; });
    var last = -1; KINDS.forEach(function(k, i){ if(done[k[0]]) last = i; });
    var hour = Number(new Date().toLocaleString("en-US", {hour: "numeric", hour12: false, timeZone: "Asia/Manila"}));
    if(last < 0 && hour >= 12) last = 1;                       // arriving after lunch: start with the afternoon
    for(var i = last + 1; i < KINDS.length; i++) if(!done[KINDS[i][0]]) return KINDS[i][0];
    return null;
  }
  function loadMine(){ return Promise.all([rpc("attendance_me"), quiet("pay_me"), quiet("payslips_mine")]).then(function(r){ state.me = r[0]; state.pay = r[1]; state.slips = r[2] || []; renderMine(); }); }
  // One payslip: pay, then what was taken, then net. Shared by the staff card and the run view.
  function slipBody(l, adjustments){
    var rows = [["Basic pay", l.basic_pay], ["Holiday and rest-day premiums", l.premium], ["Overtime", l.overtime_pay], ["Allowance", l.allowance]];
    (adjustments || []).forEach(function(a){ if(a.kind !== "deduction") rows.push([a.reason, a.amount]); });
    var less = [["SSS", l.sss_ee], ["PhilHealth", l.ph_ee], ["Pag-IBIG", l.pi_ee]].filter(function(x){ return Number(x[1]); })
      .concat([["Withholding tax" + (l.mwe ? " (minimum wage earner: none)" : ""), l.tax]]);
    (adjustments || []).forEach(function(a){ if(a.kind === "deduction") less.push([a.reason, a.amount]); });
    function tr(x, neg){ return h("tr", null, [h("td", {text: x[0]}), h("td", {class: "num", text: (neg && Number(x[1]) ? "− " : "") + peso(x[1])})]); }
    return h("table", {class: "acct-table slip-table"}, [h("tbody", null, [].concat(
      rows.filter(function(x){ return Number(x[1]); }).map(function(x){ return tr(x); }),
      [h("tr", {class: "sum"}, [h("td", {text: "Gross pay"}), h("td", {class: "num", text: peso(l.gross)})])],
      less.map(function(x){ return tr(x, true); }),
      [h("tr", {class: "sum net"}, [h("td", {text: "Net pay"}), h("td", {class: "num", text: peso(l.net)})])],
      !Number(l.sss_ee) && !Number(l.ph_ee) && !Number(l.pi_ee) ? [h("tr", null, h("td", {colspan: "2", class: "muted small", text: "SSS, PhilHealth and Pag-IBIG for the month come off the 16–end payslip."}))] : []))]);
  }
  function renderSlips(){
    var slips = state.slips || [];
    $("slipsCard").hidden = !slips.length;
    put("slipsList", slips.length ? h("div", {class: "slips"}, slips.map(function(l, i){
      var d = h("details", {class: "slip", open: i === 0}, [
        h("summary", null, [h("strong", {text: dayName(l.period_start) + " – " + dayName(l.period_end)}),
          h("span", {class: "muted", text: (l.status === "released" ? "Released" : "Approved · release ") + " " + dayName(l.release_date)}), h("strong", {class: "amt", text: peso(l.net)})]),
        h("div", {class: "slip-body"}, [
          h("div", {class: "slip-head"}, [h("strong", {text: "Ritehome Modular Systems · Payslip"}), h("span", {class: "muted", text: l.name + " · " + dayName(l.period_start) + " to " + dayName(l.period_end) + ", " + l.period_end.slice(0, 4)})]),
          h("p", {class: "muted small", text: l.days_worked + (l.days_worked === 1 ? " day" : " days") + " worked · " + (l.salary_type === "daily" ? peso(l.daily_rate) + " a day" : "monthly rate")}),
          slipBody(l, l.adjustments),
          h("div", {class: "acct-actions no-print"}, h("button", {class: "btn ghost small", type: "button", text: "Print", onclick: function(){ printSlip(d); }}))])]);
      return d;
    })) : null);
  }
  function printSlip(el){
    document.querySelectorAll(".slip.print-me").forEach(function(x){ x.classList.remove("print-me"); });
    el.open = true; el.classList.add("print-me"); document.body.classList.add("print-slip");
    window.print(); setTimeout(function(){ document.body.classList.remove("print-slip"); el.classList.remove("print-me"); }, 500);
  }
  function renderMyPay(){
    var pay = state.pay, card = $("myPayCard");
    card.hidden = !pay || !pay.rate;
    if(card.hidden) return;
    var per = pay.period, todayRow = pay.days.filter(function(d){ return d.date === pay.today; })[0];
    $("myPaySub").textContent = "Cutoff " + dayName(per.start) + " to " + dayName(per.end) + ". Estimates from your attendance until the admin approves the cutoff; late and early minutes are deducted by the minute.";
    put("myPayKpis", h("div", {style: "display:contents"}, [
      ["This cutoff so far", peso(pay.to_date), "Up to today"], ["Today", todayRow ? peso(todayRow.total) : "—", todayRow ? STATUS[todayRow.status] || todayRow.status : ""],
      ["Release", dayName(per.release), "Pay day for this cutoff"],
      ["Your rate", pay.rate.salary_type === "daily" ? peso(pay.rate.rate) + " a day" : peso(pay.rate.rate) + " a month", pay.rate.daily_allowance > 0 ? "+ " + peso(pay.rate.daily_allowance) + " allowance a day" : EMPLOY[pay.rate.employment_type] || ""]
    ].map(function(x, i){ return h("div", {class: "kpi" + (i ? "" : " lead")}, [h("span", {class: "label", text: x[0]}), h("span", {class: "val", text: x[1]}), h("span", {class: "sub", text: x[2]})]); })));
    var shown = pay.days.filter(function(d){ return d.status !== "scheduled"; }).slice().reverse();
    put("myPayDays", h("div", {class: "acct-scroll"}, h("table", {class: "acct-table"}, [
      h("thead", null, h("tr", null, ["Day", "Status", "Late / early", "Overtime", "Estimate"].map(function(t, i){ return h("th", {class: i > 1 ? "num" : null, text: t}); }))),
      h("tbody", null, shown.map(function(d){
        return h("tr", null, [h("td", {text: dayName(d.date)}), h("td", {text: (STATUS[d.status] || d.status) + (d.holiday ? " · " + d.holiday + " holiday" : "")}),
          h("td", {class: "num", text: d.late_minutes + d.undertime_minutes ? mins(d.late_minutes + d.undertime_minutes) : "—"}),
          h("td", {class: "num", text: d.overtime_minutes ? mins(d.overtime_minutes) : "—"}), h("td", {class: "num", text: peso(d.total)})]);
      }))])));
  }
  function renderMine(){
    var me = state.me, started = !!me.consent_at && me.enrolled;
    $("noticeCard").hidden = !!me.consent_at;
    $("enrollCard").hidden = !me.consent_at || me.enrolled;
    $("todayCard").hidden = !started; $("historyCard").hidden = !started || !me.days.length;
    renderMyPay(); renderSlips();
    var recs = me.records || [];
    $("recordsCard").hidden = !recs.length;
    put("recordsList", recs.length ? h("ul", {class: "rec-list"}, recs.map(function(x){
      return h("li", null, [h("b", {text: dayName(x.date) + " · "}), recordWords(x), x.by ? h("span", {class: "muted", text: " · by " + x.by}) : null]);
    })) : null);
    if(!started) return;
    var done = {}; me.punches.forEach(function(p){ done[p.kind] = p; });
    // Punches only move forward through the day: after the afternoon ones, the morning can't be filled in.
    var next = nextKind(), last = -1; KINDS.forEach(function(k, i){ if(done[k[0]]) last = i; });
    var left = next ? KINDS.filter(function(k, i){ return !done[k[0]] && i > last; }) : [];
    $("todayTitle").textContent = dayName(me.today);
    $("todayHint").textContent = next ? "Next: " + KIND[next][1].toLowerCase() + "."
      : me.punches.length === 4 ? "All four punches are in. See you tomorrow." : "You're clocked out for today. A missed punch? Tell the admin.";
    $("punchBtn").hidden = !next; $("punchBtn").textContent = next ? KIND[next][2] : "";
    var sel = $("punchKind"); sel.textContent = "";
    left.forEach(function(k){ sel.appendChild(h("option", {value: k[0], text: k[1]})); });
    if(next) sel.value = next;
    sel.parentNode.hidden = left.length < 2;
    put("todaySlots", h("div", {style: "display:contents"}, KINDS.map(function(k){
      var p = done[k[0]], glow = p && state.flash === k[0] ? (state.flash = null, " just-saved") : "";
      return h("div", {class: "slot" + (p ? "" : " empty") + glow, "data-kind": k[0]}, [h("span", {class: "k", text: k[1]}), h("span", {class: "t", text: p ? clock(p.at) : "—"}), p ? pills(p, false) : null]);
    })));
    put("historyTable", me.days.length ? h("div", {class: "acct-scroll"}, h("table", {class: "acct-table"}, [
      h("thead", null, h("tr", null, ["Day"].concat(KINDS.map(function(k){ return k[1]; })).map(function(t){ return h("th", {text: t}); }))),
      h("tbody", null, me.days.map(function(d){
        var by = {}; d.punches.forEach(function(p){ by[p.kind] = p; });
        return h("tr", null, [h("td", {text: dayName(d.date)})].concat(KINDS.map(function(k){
          var p = by[k[0]]; return p ? h("td", null, h("div", {class: "cellp"}, [h("span", {class: "t", text: clock(p.at)}), pills(p, false)])) : h("td", {class: "none", text: "—"});
        })));
      }))])) : null);
  }
  function punch(){
    var kind = $("punchKind").value || nextKind(); if(!kind) return;
    takePhoto(KIND[kind][2], false, true).then(function(shot){
      if(!shot) return;
      busy($("punchBtn"), true); msg("Saving your " + KIND[kind][1].toLowerCase() + "…");
      return upload(shot.blob, state.me.today + "-" + kind).then(function(path){
        return rpc("attendance_punch", {p_kind: kind, p_lat: shot.where.lat, p_lng: shot.where.lng, p_accuracy: Math.round(shot.where.accuracy * 10) / 10, p_selfie_path: path, p_descriptor: shot.descriptor});
      }).then(function(p){
        busy($("punchBtn"), false); state.flash = kind;
        var notes = [];
        if(p.flags.indexOf("late") >= 0) notes.push("marked late");
        if(p.flags.indexOf("off_site") >= 0) notes.push(far(p.office_distance_m) + " from the office");
        if(p.flags.indexOf("face_mismatch") >= 0 || p.flags.indexOf("no_face_check") >= 0) notes.push("the admin will check the photo");
        msg(KIND[kind][1] + " recorded at " + clock(p.at) + (notes.length ? " (" + notes.join(", ") + ")." : "."));
        return loadMine();
      });
    }).catch(function(e){ busy($("punchBtn"), false); fail(e); });
  }
  function enroll(){
    takePhoto("Your reference photo", true, false).then(function(shot){
      if(!shot) return;
      busy($("enrollBtn"), true);
      return upload(shot.blob, "reference").then(function(path){ return rpc("attendance_enroll", {p_descriptor: shot.descriptor, p_selfie_path: path}); })
        .then(function(){ busy($("enrollBtn"), false); msg("Reference photo saved. You can clock in now."); return loadMine(); });
    }).catch(function(e){ busy($("enrollBtn"), false); fail(e); });
  }

  // ---------- records the office adds (attendance_records: 20261125000022) ----------
  function recordWords(x){
    if(x.kind === "absent") return "Absent" + (x.remarks ? ": " + x.remarks : "");
    if(x.kind === "leave") return (LEAVE[x.leave_type] || "Leave") + (x.paid ? " (paid)" : " (unpaid)") + (x.remarks ? ": " + x.remarks : "");
    if(x.kind === "overtime") return "Overtime approved: " + mins(x.minutes) + (x.remarks ? " (" + x.remarks + ")" : "");
    if(x.kind === "correction") return (KIND[x.punch_kind] ? KIND[x.punch_kind][1] : "Punch") + " corrected to " + clock(x.at) + ": " + x.remarks;
    return "Remark: " + x.remarks;
  }
  function canRecord(p){ return state.manage && (!p.self || state.day.can_review); }   // only the admin records their own
  function voidRecord(p, x){
    var why = window.prompt("Void this record for " + p.name + "?\n\n" + recordWords(x) + "\n\nIt stays in the history. Why is it void?", "");
    if(why == null) return;
    rpc("attendance_record_void", {p_id: x.id, p_reason: why}).then(function(){ msg("Voided. Add the right record if one is needed."); return loadTeam(); }).catch(fail);
  }
  function recordForm(p){
    var kinds = [["correction", "Correction to a punch"], ["leave", "Leave"], ["absent", "Absent"], ["remark", "Remark"]];
    if(state.day.can_review) kinds.push(["overtime", "Approve overtime"]);   // the admin alone approves overtime
    var kind = h("select", {"aria-label": "Kind of record"}, kinds.map(function(o){ return h("option", {value: o[0], text: o[1]}); }));
    var otMin = h("select", {"aria-label": "Overtime"}, [30, 60, 90, 120, 150, 180, 210, 240, 300, 360].map(function(m){ return h("option", {value: String(m), text: mins(m)}); }));
    var otRow = h("div", {class: "rec-row"}, [h("label", null, ["Overtime after 5 PM", otMin])]);
    var punchK = h("select", {"aria-label": "Punch"}, KINDS.map(function(k){ return h("option", {value: k[0], text: k[1]}); }));
    var time = h("input", {type: "time", "aria-label": "Corrected time", value: "08:00"});
    var leave = h("select", {"aria-label": "Kind of leave"}, Object.keys(LEAVE).map(function(k){ return h("option", {value: k, text: LEAVE[k]}); }));
    var paid = h("select", {"aria-label": "Paid"}, [h("option", {value: "true", text: "Paid"}), h("option", {value: "false", text: "Unpaid"})]);
    var remarks = h("input", {maxlength: "1000", "aria-label": "Remarks", placeholder: "Reason or remark"});
    var corrRow = h("div", {class: "rec-row"}, [h("label", null, ["Punch", punchK]), h("label", null, ["Right time", time])]);
    var leaveRow = h("div", {class: "rec-row"}, [h("label", null, ["Kind", leave]), h("label", null, ["Pay", paid])]);
    var err = h("p", {class: "form-error", role: "alert"});
    function sync(){ corrRow.hidden = kind.value !== "correction"; leaveRow.hidden = kind.value !== "leave"; otRow.hidden = kind.value !== "overtime";
      remarks.placeholder = kind.value === "correction" ? "Why (required): e.g. forgot to clock in, seen in the office" : kind.value === "remark" ? "The remark (required)" : "Remarks (optional)"; }
    kind.addEventListener("change", sync); leave.addEventListener("change", function(){ if(leave.value === "unpaid") paid.value = "false"; });
    var save = h("button", {class: "btn", type: "button", text: "Save record"});
    save.addEventListener("click", function(){
      err.textContent = ""; busy(save, true);
      rpc("attendance_record_add", {p: {user_id: p.id, date: state.day.date, kind: kind.value, punch_kind: punchK.value, time: time.value,
        leave_type: leave.value, paid: paid.value, minutes: otMin.value, remarks: remarks.value}})
        .then(function(){ $("look").hidden = true; msg(p.name + ": recorded for " + dayName(state.day.date) + "."); return loadTeam(); })
        .catch(function(e){ busy(save, false); err.textContent = (e && e.message ? e.message : String(e)) + " Nothing you entered was lost."; });
    });
    sync();
    put("lookBox", h("div", {style: "display:contents"}, [
      h("h2", {id: "lookTitle", text: p.name + " · " + dayName(state.day.date)}),
      h("p", {class: "muted small", text: "Punches are never changed. A correction is added beside the punch and the month counts the corrected time. A wrong record is voided, never deleted."}),
      h("div", {class: "rec-form"}, [h("label", null, ["Record", kind]), corrRow, leaveRow, otRow, h("label", null, ["Remarks", remarks])]), err,
      h("div", {class: "acct-actions"}, [save, h("button", {class: "btn ghost", type: "button", text: "Cancel", onclick: function(){ $("look").hidden = true; }})])]));
    $("look").hidden = false; kind.focus();
  }

  // ---------- admin: the team's day ----------
  function signed(path){
    return client.storage.from(BUCKET).createSignedUrl(path, 300).then(function(r){ if(r.error || !r.data) throw new Error("That photo can't be opened."); return r.data.signedUrl; });
  }
  function loadTeam(){
    return Promise.all([rpc("attendance_day", {p_date: $("teamDate").value}),
      state.roles.indexOf("admin") >= 0 ? rpc("attendance_old_selfies", {p_days: 90}) : Promise.resolve([]),
      quiet("pay_days", {p: {from: $("teamDate").value, to: $("teamDate").value}})]).then(function(r){
      state.day = r[0]; state.old = r[1] || []; state.dayPay = {};
      (r[2] || []).forEach(function(x){ state.dayPay[x.user_id] = x; });
      state.hasPay = !!r[2]; renderTeam();
    });
  }
  // The day's estimate beside the attendance status: the total, and what moved it.
  function payCell(x){
    if(!x || !x.rate) return h("td", {class: "num none", text: x ? "No rate" : "—"});
    var bits = [];
    if(x.deductions > 0) bits.push("− " + peso(x.deductions) + " (" + mins(x.late_minutes + x.undertime_minutes + x.unworked_minutes) + ")");
    if(x.premium > 0) bits.push("+ " + peso(x.premium) + (x.holiday ? " holiday" : " rest day"));
    if(x.overtime_pay > 0) bits.push("+ " + peso(x.overtime_pay) + " overtime");
    return h("td", {class: "num pay-cell", "data-pay": x.status}, [h("strong", {text: peso(x.total)}), h("div", {class: "muted", text: STATUS[x.status] || x.status}),
      bits.length ? h("div", {class: "muted", text: bits.join(" · ")}) : null]);
  }
  function needsLook(p){ return !p.reviewed_at && (p.flags || []).some(function(f){ return f === "face_mismatch" || f === "no_face_check" || f === "low_gps_accuracy"; }); }
  function renderTeam(){
    var people = state.day.people, all = [];
    people.forEach(function(p){ p.punches.forEach(function(x){ all.push(x); }); });
    var review = all.filter(needsLook).length, present = people.filter(function(p){ return p.punches.length; }).length;
    var late = all.filter(function(x){ return x.flags.indexOf("late") >= 0; }).length, off = people.filter(function(p){ return p.punches.some(function(x){ return x.flags.indexOf("off_site") >= 0; }); }).length;
    var admin = !!state.day.can_review, away = people.filter(function(p){ return p.records.some(function(x){ return x.kind === "absent" || x.kind === "leave"; }); }).length;
    var k = [admin ? ["Photos to check", String(review), review ? "Open each one below" : "Nothing waiting", review > 0] : ["On leave or absent", String(away), "Recorded for this day"],
      ["Clocked in", present + " of " + people.length, people.length - present ? people.length - present + " not yet" : "Everyone"],
      ["Late", String(late), "After 8 AM or 1 PM"], ["Off site", String(off), "More than " + state.day_radius + " m from the office"]];
    if(state.hasPay){
      var est = Object.keys(state.dayPay).reduce(function(t, id){ return t + Number(state.dayPay[id].total || 0); }, 0);
      k.push(["Estimated pay", peso(est), "This day, everyone with a rate"]);
    }
    put("teamKpis", h("div", {style: "display:contents"}, k.map(function(x){
      return h("div", {class: "kpi"}, [h("span", {class: "label", text: x[0]}), h("span", {class: "val" + (x[3] ? " neg" : ""), text: x[1]}), h("span", {class: "sub", text: x[2]})]);
    })));
    $("teamCount").textContent = String(people.length);
    put("teamTable", h("div", {class: "acct-scroll"}, h("table", {class: "acct-table"}, [
      h("thead", null, h("tr", null, ["Person"].concat(KINDS.map(function(k){ return k[1]; })).concat(state.hasPay ? ["Estimated pay"] : []).concat(["Recorded by the office"]).map(function(t){ return h("th", {class: t === "Estimated pay" ? "num" : null, text: t}); }))),
      h("tbody", null, people.map(function(p){
        var by = {}, fix = {}; p.punches.forEach(function(x){ by[x.kind] = x; });
        p.records.forEach(function(x){ if(x.kind === "correction") fix[x.punch_kind] = x; });
        return h("tr", {"data-person": p.name}, [h("td", null, [h("strong", {text: p.name || "Unnamed"}), h("div", {class: "muted", style: "font-size:12.5px", text: ROLE[p.role] || ""})])].concat(KINDS.map(function(k){
          var x = by[k[0]], c = fix[k[0]];
          var corrected = c ? h("span", {class: "fix", title: c.remarks, text: (x ? "→ " : "") + clock(c.at) + " corrected"}) : null;
          if(!x) return h("td", {class: c ? null : "none"}, c ? h("div", {class: "cellp"}, [corrected]) : "—");
          return h("td", null, h("div", {class: "cellp"}, [h("span", {class: "t" + (c ? " was" : ""), text: clock(x.at)}), corrected, pills(x, true),
            admin ? h("button", {class: "link", type: "button", text: x.reviewed_at ? "Checked" : needsLook(x) ? "Check photo" : "Photo", "aria-label": p.name + " " + k[1] + " photo", onclick: function(){ look(p, x); }}) : null]));
        })).concat(state.hasPay ? [payCell(state.dayPay[p.id])] : []).concat([h("td", {class: "recs"}, [h("ul", {class: "rec-list"}, p.records.map(function(x){
          return h("li", null, [recordWords(x), h("span", {class: "muted", text: " · " + (x.by || "")}),
            canRecord(p) ? h("button", {class: "link", type: "button", text: "Void", "aria-label": "Void " + recordWords(x), onclick: function(){ voidRecord(p, x); }}) : null]);
        })), canRecord(p) ? h("button", {class: "btn ghost small", type: "button", text: "Record…", "aria-label": "Record for " + p.name, onclick: function(){ recordForm(p); }}) : null])]));
      }))])));
    $("faceCard").hidden = !admin;
    put("faceTable", h("div", {class: "acct-scroll"}, h("table", {class: "acct-table"}, [
      h("thead", null, h("tr", null, ["Person", "Notice", "Reference photo", ""].map(function(t){ return h("th", {text: t}); }))),
      h("tbody", null, people.map(function(p){
        return h("tr", {"data-face": p.name}, [h("td", {text: p.name || "Unnamed"}),
          h("td", null, h("span", {class: "pill " + (p.consent_at ? "good" : "warn"), text: p.consent_at ? "Agreed" : "Not yet"})),
          h("td", null, p.enrolled ? h("button", {class: "link", type: "button", style: "text-decoration:underline;background:none;border:0;padding:0;cursor:pointer;font:inherit", text: "Taken " + dayName(p.face_enrolled_at.slice(0, 10)),
            onclick: function(){ look(p, null); }}) : h("span", {class: "muted", text: "Not taken"})),
          h("td", null, p.enrolled ? h("button", {class: "btn ghost small", type: "button", text: "Reset", "aria-label": "Reset " + p.name + "'s reference photo", onclick: function(){ resetFace(p); }}) : null)]);
      }))])));
    var old = state.old;
    $("oldCard").hidden = !old.length;
    if(old.length) put("oldCard", h("div", null, [h("h2", {text: old.length + " photo" + (old.length === 1 ? " is" : "s are") + " older than 90 days"}),
      h("p", {class: "muted small", text: "The attendance notice promises staff their photos are deleted after 90 days. The times stay."}),
      h("div", {class: "acct-actions"}, h("button", {class: "btn", type: "button", text: "Delete these photos", onclick: clearOld}))]));
  }
  function clearOld(e){
    var old = state.old, b = e.currentTarget; busy(b, true);
    client.storage.from(BUCKET).remove(old.map(function(o){ return o.path; })).then(function(r){
      if(r.error) throw new Error("The photos couldn't be deleted (" + r.error.message + ").");
      return rpc("attendance_selfies_cleared", {p_ids: old.map(function(o){ return o.id; })});
    }).then(function(n){ msg(n + " old photo" + (n === 1 ? "" : "s") + " deleted."); return loadTeam(); }).catch(function(err){ busy(b, false); fail(err); });
  }
  function resetFace(p){
    if(!confirm("Reset " + p.name + "'s reference photo? They'll take a new one at their next clock-in.")) return;
    rpc("attendance_face_reset", {p_user: p.id}).then(function(){ msg(p.name + "'s reference photo is reset."); return loadTeam(); }).catch(fail);
  }
  function photoBox(path, caption){
    var view = h("div", {class: "cam-view"}, path ? h("span", {class: "muted", style: "color:#aaa;font-size:13px", text: "Loading…"}) : h("span", {style: "color:#aaa;font-size:13px", text: "No photo"}));
    if(path) signed(path).then(function(url){ put(view, h("img", {src: url, alt: caption})); }).catch(function(){ put(view, h("span", {style: "color:#aaa;font-size:13px", text: "Photo deleted"})); });
    return h("figure", null, [view, h("figcaption", {text: caption})]);
  }
  function look(p, x){
    var note = x ? h("input", {maxlength: "1000", value: x.admin_note || "", placeholder: "Note (optional)", "aria-label": "Review note"}) : null;
    var score = x && x.face_match != null ? Math.round(x.face_match * 100) + "% similar (flagged under " + Math.round(state.day.threshold * 100) + "%)" : "Not checked";
    put("lookBox", h("div", {style: "display:contents"}, [
      h("h2", {id: "lookTitle", text: x ? p.name + " · " + KIND[x.kind][1] + " · " + clock(x.at) : p.name + "'s reference photo"}),
      h("div", {class: "look-pair"}, x ? [photoBox(x.selfie_path, "This punch"), photoBox(p.face_selfie_path, "Reference photo")] : [photoBox(p.face_selfie_path, "Reference photo")]),
      x ? h("dl", {class: "look-facts"}, [h("dt", {text: "Face"}), h("dd", {text: score}),
        h("dt", {text: "Place"}), h("dd", null, [far(x.office_distance_m) + " from the office, GPS within " + (x.accuracy_m == null ? "?" : Math.round(x.accuracy_m)) + " m · ",
          h("a", {href: "https://www.google.com/maps?q=" + x.lat + "," + x.lng, target: "_blank", rel: "noopener", text: "Map"})]),
        x.reviewed_at ? h("dt", {text: "Checked"}) : null, x.reviewed_at ? h("dd", {text: dayName(x.reviewed_at.slice(0, 10))}) : null]) : null,
      note ? h("label", null, ["Note", note]) : null,
      h("div", {class: "acct-actions"}, [
        x ? h("button", {class: "btn", type: "button", text: x.reviewed_at ? "Save note" : "Mark as checked", onclick: function(e){
          busy(e.currentTarget, true);
          rpc("attendance_review", {p_id: x.id, p_note: note.value}).then(function(){ $("look").hidden = true; msg(p.name + "'s " + KIND[x.kind][1].toLowerCase() + " is checked."); return loadTeam(); }).catch(function(err){ busy(e.currentTarget, false); fail(err); });
        }}) : null,
        h("button", {class: "btn ghost", type: "button", text: "Close", onclick: function(){ $("look").hidden = true; }})])]));
    $("look").hidden = false;
  }

  // ---------- admin: the month ----------
  // [heading, value, shown red when above zero]
  var MONTH_COLS = [["Person"], ["Days", function(m){ return m.days; }], ["Hours", function(m){ return Number(m.hours).toFixed(2); }],
    ["Late", function(m){ return m.lates; }], ["Left early", function(m){ return m.early_outs; }], ["Incomplete", function(m){ return m.incomplete_days; }],
    ["Absent", function(m){ return m.absences || 0; }], ["Paid leave", function(m){ return m.leave_paid || 0; }], ["Unpaid leave", function(m){ return m.leave_unpaid || 0; }],
    ["Corrections", function(m){ return m.corrections || 0; }], ["Unaccounted", function(m){ return m.unaccounted || 0; }, true], ["To check", function(m){ return m.to_review; }]];
  function loadMonth(){
    return rpc("attendance_month", {p_month: $("monthPick").value + "-01"}).then(function(rows){ state.month = rows || []; renderMonth(); });
  }
  function renderMonth(){
    $("monthTitle").textContent = new Date($("monthPick").value + "-01T00:00:00+08:00").toLocaleDateString("en-PH", {month: "long", year: "numeric", timeZone: "Asia/Manila"});
    put("monthTable", h("div", {class: "acct-scroll"}, h("table", {class: "acct-table"}, [
      h("thead", null, h("tr", null, MONTH_COLS.map(function(c, i){ return h("th", {class: i ? "num" : null, text: c[0]}); }))),
      h("tbody", null, state.month.map(function(m){
        return h("tr", {"data-person": m.name}, [h("td", null, [m.name || "Unnamed", h("span", {class: "muted", text: " · " + (ROLE[m.role] || "")})])].concat(
          MONTH_COLS.slice(1).map(function(c){ var v = c[1](m); return h("td", {class: "num" + (c[2] && Number(v) > 0 ? " neg" : ""), text: String(v)}); })));
      }))])));
  }
  function monthCsv(){
    var rows = [["Person", "Role"].concat(MONTH_COLS.slice(1).map(function(c){ return c[0]; }))].concat(state.month.map(function(m){
      return [m.name, ROLE[m.role] || m.role].concat(MONTH_COLS.slice(1).map(function(c){ return c[1](m); })); }));
    var csv = rows.map(function(r){ return r.map(function(c){ return '"' + String(c == null ? "" : c).replace(/"/g, '""') + '"'; }).join(","); }).join("\r\n");
    var a = h("a", {href: URL.createObjectURL(new Blob(["﻿" + csv], {type: "text/csv"})), download: "ritehome-attendance-" + $("monthPick").value + ".csv"});
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- pay (admin and bookkeeper) ----------
  function loadPay(){
    var first = state.period ? Promise.resolve() : quiet("pay_period", {p_date: state.me.today}).then(function(per){
      state.period = per || {start: state.me.today.slice(0, 8) + "01", end: state.me.today};
      $("payFrom").value = state.period.start; $("payTo").value = state.me.today < state.period.end ? state.me.today : state.period.end;
    });
    return first.then(function(){ return Promise.all([loadPayDays(), quiet("salary_rates_list"), quiet("payroll_settings_get")]); }).then(function(r){
      state.rates = r[1] || []; state.settings = r[2]; renderRates(); renderSettings();
      return Promise.all([loadStatutory(), loadRuns()]);
    });
  }
  function loadPayDays(){
    return quiet("pay_days", {p: {from: $("payFrom").value, to: $("payTo").value}}).then(function(rows){
      if(rows == null){ state.payRows = []; put("payTable", h("p", {class: "muted", text: "Pay isn't switched on yet (the database update for v3.3 hasn't been applied), or the range is over 62 days."})); return; }
      state.payRows = rows;
      var people = {}, roles = {};
      rows.forEach(function(x){ people[x.user_id] = x.name; roles[x.role] = 1; });
      fill($("payPerson"), Object.keys(people).sort(function(a, b){ return String(people[a]).localeCompare(people[b]); }).map(function(id){ return [id, people[id] || "Unnamed"]; }));
      fill($("payRole"), Object.keys(roles).map(function(r){ return [r, ROLE[r] || r]; }));
      fill($("payType"), Object.keys(EMPLOY).map(function(t){ return [t, EMPLOY[t]]; }));
      renderPay();
    });
  }
  function fill(sel, opts){ var keep = sel.value; sel.length = 1; opts.forEach(function(o){ sel.appendChild(h("option", {value: o[0], text: o[1]})); }); sel.value = keep; if(sel.value !== keep) sel.value = ""; }
  function dayMatches(x, f){
    if(!f) return true;
    if(f === "worked") return x.worked_minutes > 0;
    if(f === "leave") return x.status === "leave_paid" || x.status === "leave_unpaid";
    if(f === "holiday") return !!x.holiday || x.rest_day;
    if(f === "overtime") return x.overtime_minutes > 0;
    return x.status === f;
  }
  function payFiltered(){
    var who = $("payPerson").value, role = $("payRole").value, type = $("payType").value, st = $("payStatus").value;
    return state.payRows.filter(function(x){
      return (!who || x.user_id === who) && (!role || x.role === role) && (!type || (x.rate && x.rate.employment_type === type)) && dayMatches(x, st);
    });
  }
  function renderPay(){
    var rows = payFiltered(), by = {}, order = [];
    rows.forEach(function(x){
      var p = by[x.user_id];
      if(!p){ p = by[x.user_id] = {name: x.name, role: x.role, days: [], worked: 0, minutes: 0, late: 0, ded: 0, prem: 0, ot: 0, otMin: 0, allow: 0, total: 0, unacc: 0, rated: false}; order.push(x.user_id); }
      p.days.push(x); p.rated = p.rated || !!x.rate;
      if(x.worked_minutes > 0) p.worked++;
      p.minutes += x.worked_minutes; p.late += x.late_minutes + x.undertime_minutes + x.unworked_minutes;
      p.ded += Number(x.deductions); p.prem += Number(x.premium); p.ot += Number(x.overtime_pay); p.otMin += x.overtime_minutes;
      p.allow += Number(x.allowance); p.total += Number(x.total); if(x.status === "unaccounted" && x.rate) p.unacc++;   // only people who are paid
    });
    var T = order.reduce(function(t, id){ var p = by[id]; t.total += p.total; t.ded += p.ded; t.late += p.late; t.ot += p.ot; t.otMin += p.otMin; t.unacc += p.unacc; return t; }, {total: 0, ded: 0, late: 0, ot: 0, otMin: 0, unacc: 0});
    var noRate = order.filter(function(id){ return !by[id].rated; }).length;
    put("payKpis", h("div", {style: "display:contents"}, [
      ["Estimated pay", peso(T.total), dayName($("payFrom").value) + " to " + dayName($("payTo").value)],
      ["Deducted", peso(T.ded), mins(T.late) + " late, early or not worked"],
      ["Overtime", peso(T.ot), T.otMin ? mins(T.otMin) + " approved" : "None approved"],
      ["Unaccounted days", String(T.unacc), T.unacc ? "Record leave or absence before payroll" : "Every working day accounted for", T.unacc > 0]
    ].map(function(x, i){ return h("div", {class: "kpi" + (i ? "" : " lead")}, [h("span", {class: "label", text: x[0]}), h("span", {class: "val" + (x[3] ? " neg" : ""), text: x[1]}), h("span", {class: "sub", text: x[2]})]); })));
    $("payTitle").textContent = "Estimated pay" + (state.period ? " · release " + dayName(state.period.release) : "");
    $("paySub").textContent = "Estimates from attendance until the cutoff is approved. Late, undertime and halves without both punches are deducted by the minute, never a whole day." +
      (noRate ? " " + noRate + (noRate === 1 ? " person has" : " people have") + " no rate yet: set it under Rates." : "");
    put("payTable", order.length ? h("div", {class: "pay-people"}, order.map(function(id){
      var p = by[id];
      return h("details", {class: "pay-person", "data-person": p.name}, [
        h("summary", null, [h("span", {class: "who"}, [h("strong", {text: p.name || "Unnamed"}), h("span", {class: "muted", text: " · " + (ROLE[p.role] || p.role) + (p.rated ? "" : " · no rate")})]),
          h("span", {class: "facts muted", text: p.worked + (p.worked === 1 ? " day" : " days") + " · " + (p.minutes / 60).toFixed(1) + " h" + (p.ded ? " · − " + peso(p.ded) : "") + (p.ot ? " · OT " + peso(p.ot) : "") + (p.unacc ? " · " + p.unacc + " unaccounted" : "")}),
          h("strong", {class: "amt", text: peso(p.total)})]),
        h("div", {class: "acct-scroll"}, h("table", {class: "acct-table"}, [
          h("thead", null, h("tr", null, ["Day", "Status", "Worked", "Late / early / missing", "Deducted", "Premium", "Overtime", "Allowance", "Estimate"].map(function(t, i){ return h("th", {class: i > 1 ? "num" : null, text: t}); }))),
          h("tbody", null, p.days.map(function(x){
            return h("tr", {"data-day": x.date}, [h("td", {text: dayName(x.date)}), h("td", {text: (STATUS[x.status] || x.status) + (x.holiday ? " · " + x.holiday + " holiday" : "") + (x.holiday_pay_eligible === false ? " (no holiday pay: absent the working day before)" : "")}),
              h("td", {class: "num", text: x.worked_minutes ? mins(x.worked_minutes) : "—"}),
              h("td", {class: "num", text: x.late_minutes + x.undertime_minutes + x.unworked_minutes ? mins(x.late_minutes + x.undertime_minutes + x.unworked_minutes) : "—"}),
              h("td", {class: "num" + (x.deductions > 0 ? " neg" : ""), text: x.deductions > 0 ? "− " + peso(x.deductions) : "—"}),
              h("td", {class: "num", text: x.premium > 0 ? peso(x.premium) : "—"}),
              h("td", {class: "num", text: x.overtime_pay > 0 ? peso(x.overtime_pay) + " (" + mins(x.overtime_minutes) + ")" : "—"}),
              h("td", {class: "num", text: x.allowance > 0 ? peso(x.allowance) : "—"}), h("td", {class: "num", text: peso(x.total)})]);
          }))]))]);
    })) : h("p", {class: "muted", text: "No days match."}));
  }
  function payCsv(){
    var head = ["Person", "Role", "Employment", "Day", "Status", "Holiday", "Daily rate", "Worked min", "Late min", "Undertime min", "Missing min", "Overtime min", "Basic", "Deducted", "Premium", "Overtime pay", "Allowance", "Estimate"];
    var rows = [head].concat(payFiltered().map(function(x){
      return [x.name, ROLE[x.role] || x.role, x.rate ? EMPLOY[x.rate.employment_type] : "no rate", x.date, STATUS[x.status] || x.status, x.holiday || "", x.daily_rate,
        x.worked_minutes, x.late_minutes, x.undertime_minutes, x.unworked_minutes, x.overtime_minutes, x.basic, x.deductions, x.premium, x.overtime_pay, x.allowance, x.total];
    }));
    var csv = rows.map(function(r){ return r.map(function(c){ return '"' + String(c == null ? "" : c).replace(/"/g, '""') + '"'; }).join(","); }).join("\r\n");
    var a = h("a", {href: URL.createObjectURL(new Blob(["﻿" + csv], {type: "text/csv"})), download: "ritehome-pay-" + $("payFrom").value + "-to-" + $("payTo").value + ".csv"});
    document.body.appendChild(a); a.click(); a.remove();
  }
  function renderRates(){
    var admin = state.roles.indexOf("admin") >= 0;
    put("ratesTable", state.rates.length ? h("div", {class: "acct-scroll"}, h("table", {class: "acct-table"}, [
      h("thead", null, h("tr", null, ["Person", "Rate", "Daily equivalent", "Allowance a day", "Employment", "Since", ""].map(function(t, i){ return h("th", {class: i && i < 4 ? "num" : null, text: t}); }))),
      h("tbody", null, state.rates.filter(function(p){ return p.active; }).map(function(p){
        var c = p.current, may = !p.self || admin;
        return h("tr", {"data-rate": p.name}, [
          h("td", null, [h("strong", {text: p.name || "Unnamed"}), h("div", {class: "muted", style: "font-size:12.5px", text: ROLE[p.role] || ""}),
            p.history.length > 1 ? h("details", {class: "rate-hist"}, [h("summary", {text: p.history.length + " rates on record"}), h("ul", {class: "rec-list"}, p.history.map(function(x){
              return h("li", {text: dayName(x.effective_from) + ": " + peso(x.rate) + (x.salary_type === "daily" ? " a day" : " a month") + (x.notes ? " · " + x.notes : "") + " · by " + x.by});
            }))]) : null]),
          h("td", {class: "num", text: c ? peso(c.rate) + (c.salary_type === "daily" ? " a day" : " a month") : "—"}),
          h("td", {class: "num", text: c ? peso(c.daily_equivalent) : "—"}), h("td", {class: "num", text: c && c.daily_allowance > 0 ? peso(c.daily_allowance) : "—"}),
          h("td", {text: c ? EMPLOY[c.employment_type] || c.employment_type : "—"}), h("td", {text: c ? dayName(c.effective_from) : "No rate yet"}),
          h("td", null, may ? h("button", {class: "btn ghost small", type: "button", text: c ? "Change…" : "Set rate…", "aria-label": "Rate for " + p.name, onclick: function(){ rateForm(p); }}) : h("span", {class: "muted small", text: "The admin sets yours"}))]);
      }))])) : h("p", {class: "muted", text: "Rates show here once the v3.3 database update is applied."}));
  }
  function rateForm(p){
    var c = p.current || {};
    var from = h("input", {type: "date", "aria-label": "Starts on", value: state.me.today});
    var type = h("select", {"aria-label": "Paid by"}, [["daily", "Daily rate"], ["monthly", "Monthly rate"]].map(function(o){ return h("option", {value: o[0], text: o[1]}); }));
    type.value = c.salary_type || "daily";
    var rate = h("input", {inputmode: "decimal", "aria-label": "Rate in pesos", value: c.rate != null ? String(c.rate) : "", placeholder: "e.g. 610"});
    var allow = h("input", {inputmode: "decimal", "aria-label": "Allowance a day", value: c.daily_allowance != null ? String(c.daily_allowance) : "0"});
    var emp = h("select", {"aria-label": "Employment"}, Object.keys(EMPLOY).map(function(k){ return h("option", {value: k, text: EMPLOY[k]}); }));
    emp.value = c.employment_type || "regular";
    var notes = h("input", {maxlength: "500", "aria-label": "Notes", placeholder: "e.g. Regularised; corrected typo"});
    var err = h("p", {class: "form-error", role: "alert"}), save = h("button", {class: "btn", type: "button", text: "Save rate"});
    save.addEventListener("click", function(){
      err.textContent = "";
      var amount = rate.value.replace(/[,\s₱]/g, ""), al = (allow.value || "0").replace(/[,\s₱]/g, "");
      if(!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0){ err.textContent = "Enter the rate in pesos, e.g. 610 or 18780.50."; rate.focus(); return; }
      if(!/^\d+(\.\d{1,2})?$/.test(al)){ err.textContent = "Enter the allowance in pesos, or 0."; allow.focus(); return; }
      busy(save, true);
      rpc("salary_rate_add", {p: {user_id: p.id, effective_from: from.value, salary_type: type.value, rate: amount, daily_allowance: al, employment_type: emp.value, notes: notes.value}})
        .then(function(){ $("look").hidden = true; msg(p.name + ": new rate from " + dayName(from.value) + "."); return loadPay(); })
        .catch(function(e){ busy(save, false); err.textContent = (e && e.message ? e.message : String(e)) + " Nothing you entered was lost."; });
    });
    put("lookBox", h("div", {style: "display:contents"}, [
      h("h2", {id: "lookTitle", text: "Rate for " + p.name}),
      h("p", {class: "muted small", text: "Starts on the date you choose; days before it keep the old rate. A monthly rate is counted per day as monthly × 12 ÷ " + (state.settings ? state.settings.divisor : 313) + "."}),
      h("div", {class: "rec-form"}, [h("div", {class: "rec-row"}, [h("label", null, ["Starts on", from]), h("label", null, ["Paid by", type])]),
        h("div", {class: "rec-row"}, [h("label", null, ["Rate (₱)", rate]), h("label", null, ["Allowance a day (₱)", allow])]),
        h("label", null, ["Employment", emp]), h("label", null, ["Notes", notes])]), err,
      h("div", {class: "acct-actions"}, [save, h("button", {class: "btn ghost", type: "button", text: "Cancel", onclick: function(){ $("look").hidden = true; }})])]));
    $("look").hidden = false; rate.focus();
  }
  var SETTINGS = [["divisor", "Working days a year (monthly rate ÷)"], ["regular_unworked", "Regular holiday, not worked"], ["regular_worked", "Regular holiday, worked"],
    ["regular_rest_worked", "Regular holiday on a Sunday, worked"], ["special_unworked", "Special day, not worked"], ["special_worked", "Special day, worked"],
    ["special_rest_worked", "Special day on a Sunday, worked"], ["rest_day_worked", "Sunday, worked"], ["ot_rate", "Overtime, ordinary day"], ["ot_rest_holiday_rate", "Overtime on a Sunday or holiday (× that day's rate)"]];
  function renderSettings(){
    var st = state.settings;
    if(!st){ put("settingsBox", h("p", {class: "muted", text: "Shown once the v3.3 database update is applied."})); return; }
    var inputs = {}, edit = !!st.can_edit;
    var rule = h("select", {"aria-label": "Pay day on a Sunday or holiday", disabled: !edit}, [["earlier", "Paid the working day before"], ["later", "Paid the working day after"]].map(function(o){ return h("option", {value: o[0], text: o[1]}); }));
    rule.value = st.payday_rule;
    var timing = h("select", {"aria-label": "Government contributions deducted", disabled: !edit}, [["second", "All on the 16–end payday"], ["split", "Half each payday"]].map(function(o){ return h("option", {value: o[0], text: o[1]}); }));
    var allowTax = h("select", {"aria-label": "Allowance taxable", disabled: !edit}, [["true", "Taxable"], ["false", "Not taxable (de minimis)"]].map(function(o){ return h("option", {value: o[0], text: o[1]}); }));
    var hasRuns = st.contributions_timing != null;
    if(hasRuns){ timing.value = st.contributions_timing; allowTax.value = String(st.allowance_taxable); }
    var save = h("button", {class: "btn", type: "button", text: "Save settings", disabled: true});
    function dirty(){ save.disabled = rule.value === st.payday_rule && (!hasRuns || (timing.value === st.contributions_timing && allowTax.value === String(st.allowance_taxable)))
      && SETTINGS.every(function(x){ return Number(inputs[x[0]].value) === Number(st[x[0]]); }); }
    rule.addEventListener("change", dirty); timing.addEventListener("change", dirty); allowTax.addEventListener("change", dirty);
    var grid = SETTINGS.map(function(x){
      var i = inputs[x[0]] = h("input", {inputmode: "decimal", value: String(st[x[0]]), "aria-label": x[1], disabled: !edit});
      i.addEventListener("input", dirty);
      return h("label", null, [x[1], i]);
    });
    save.addEventListener("click", function(){
      var body = {payday_rule: rule.value}; SETTINGS.forEach(function(x){ body[x[0]] = inputs[x[0]].value; });
      if(hasRuns){ body.contributions_timing = timing.value; body.allowance_taxable = allowTax.value === "true"; }
      busy(save, true);
      rpc("payroll_settings_save", {p: body}).then(function(s){ state.settings = s; msg("Payroll settings saved."); state.period = null; return loadPay(); })
        .catch(function(e){ busy(save, false); fail(e); });
    });
    put("settingsBox", h("div", {style: "display:contents"}, [
      h("p", {class: "muted small", text: "The Labor Code's rates, as multiples of the daily rate. Defaults until the accountant signs them off." + (edit ? "" : " Only the admin changes them.")}),
      h("div", {class: "rec-form pay-settings"}, [h("label", null, ["Pay day on a Sunday or holiday", rule])].concat(hasRuns ? [h("label", null, ["Government contributions deducted", timing]), h("label", null, ["Daily allowance", allowTax])] : [], grid)),
      edit ? h("div", {class: "acct-actions"}, save) : null]));
  }

  // ---------- payroll runs (v4.1, migration 25) ----------
  var RUN_STATUS = {draft: ["warn", "Draft"], submitted: ["warn", "Waiting for the admin"], approved: ["good", "Approved"], released: ["good", "Released"], void: ["", "Void"]};
  function loadRuns(){
    return quiet("payroll_runs_list").then(function(r){
      state.runs = r; $("runsCard").hidden = !r;
      if(!r) return;
      if(!$("runDate").value) $("runDate").value = state.me.today;
      renderRuns();
      if(state.openRun) return openRun(state.openRun);
      put("runBox", null);
    });
  }
  function renderRuns(){
    var runs = state.runs.runs;
    put("runsList", runs.length ? h("div", {class: "acct-scroll"}, h("table", {class: "acct-table"}, [
      h("thead", null, h("tr", null, ["Cutoff", "Status", "People", "Net pay", "Release", ""].map(function(t, i){ return h("th", {class: i === 2 || i === 3 ? "num" : null, text: t}); }))),
      h("tbody", null, runs.map(function(x){
        var st = RUN_STATUS[x.status] || ["", x.status];
        return h("tr", {"data-run": x.period_start + (x.status === "void" ? "-void" : "")}, [
          h("td", {text: dayName(x.period_start) + " – " + dayName(x.period_end) + ", " + x.period_end.slice(0, 4)}),
          h("td", null, [h("span", {class: "pill " + st[0], text: st[1]}), x.pending_adjustments ? h("div", {class: "muted", style: "font-size:12.5px", text: x.pending_adjustments + " adjustment" + (x.pending_adjustments === 1 ? "" : "s") + " waiting"}) : null]),
          h("td", {class: "num", text: String(x.totals.people || 0)}), h("td", {class: "num", text: peso(x.totals.net)}),
          h("td", {text: x.status === "released" ? "Released " + dayName(x.released_at.slice(0, 10)) : dayName(x.release_date)}),
          h("td", null, h("button", {class: "btn ghost small", type: "button", text: "Open", "aria-label": "Open payroll " + x.period_start, onclick: function(){ openRun(x.id); }}))]);
      }))])) : h("p", {class: "muted", text: "No payroll prepared yet."}));
  }
  function openRun(id){
    state.openRun = id;
    return rpc("payroll_run_get", {p_run: id}).then(renderRun).catch(fail);
  }
  function runAct(name, args, done){
    return function(e){
      var b = e && e.currentTarget; busy(b, true);
      rpc(name, args()).then(function(r){ msg(done); state.runs = null; return loadRuns(); }).catch(function(err){ busy(b, false); fail(err); });
    };
  }
  function renderRun(R){
    var admin = !!R.can_approve, draft = R.status === "draft", T = R.totals || {}, st = RUN_STATUS[R.status] || ["", R.status];
    var pendingRules = R.lines.some(function(l){ return ["sss", "philhealth", "pagibig", "withholding"].some(function(k){ return l.basis[k] && l.basis[k].rule_status && l.basis[k].rule_status !== "approved"; }); });
    var actions = [];
    if(draft){
      actions.push(h("button", {class: "btn ghost", type: "button", text: "Recompute", onclick: runAct("payroll_run_recompute", function(){ return {p_run: R.id}; }, "Recomputed from attendance.")}));
      actions.push(h("button", {class: "btn", type: "button", text: "Submit for approval", onclick: runAct("payroll_run_submit", function(){ return {p_run: R.id}; }, "Submitted to the admin.")}));
    }
    if(R.status === "submitted" && admin){
      actions.push(h("button", {class: "btn", type: "button", text: "Approve payroll", onclick: function(e){
        var note = window.prompt("Approve the " + R.period_start + " to " + R.period_end + " payroll (net " + peso(T.net) + ")? A note, if any:", ""); if(note == null) return;
        runAct("payroll_run_decide", function(){ return {p_run: R.id, p_decision: "approved", p_note: note}; }, "Payroll approved.")(e); }}));
      actions.push(h("button", {class: "btn ghost", type: "button", text: "Return…", onclick: function(e){
        var note = window.prompt("What needs fixing?", ""); if(note == null) return;
        runAct("payroll_run_decide", function(){ return {p_run: R.id, p_decision: "returned", p_note: note}; }, "Returned to the bookkeeper.")(e); }}));
    }
    if(R.status === "approved") actions.push(h("button", {class: "btn", type: "button", text: "Record release…", onclick: function(e){
      var ref = window.prompt("The release reference: the bank batch number, or “cash, signed payroll sheet”.", ""); if(ref == null) return;
      runAct("payroll_run_release", function(){ return {p_run: R.id, p_ref: ref}; }, "Release recorded.")(e); }}));
    if(admin && ["draft", "submitted", "approved"].indexOf(R.status) >= 0) actions.push(h("button", {class: "btn ghost danger", type: "button", text: "Void…", onclick: function(e){
      var why = window.prompt("Void this payroll run? It stays in the history. Why?", ""); if(why == null) return;
      runAct("payroll_run_void", function(){ return {p_run: R.id, p_reason: why}; }, "Payroll run voided.")(e); state.openRun = null; }}));
    actions.push(h("button", {class: "btn ghost", type: "button", text: "Download CSV", onclick: function(){ runCsv(R); }}));
    var who = [R.preparer ? "Prepared by " + R.preparer : "", R.submitter ? "submitted by " + R.submitter : "", R.approver ? "approved by " + R.approver : "",
      R.releaser ? "released by " + R.releaser + " (" + R.release_ref + ")" : "", R.void_reason ? "void: " + R.void_reason : ""].filter(Boolean).join(" · ");
    put("runBox", h("div", {class: "run-box", "data-open-run": R.period_start}, [
      h("div", {class: "run-title"}, [h("h3", {text: "Payroll " + dayName(R.period_start) + " – " + dayName(R.period_end) + ", " + R.period_end.slice(0, 4)}), h("span", {class: "pill " + st[0], text: st[1]})]),
      h("p", {class: "muted small", text: who + ". Pay day " + dayName(R.release_date) + ". Contributions: " + (R.contributions_timing === "second" ? "the whole month on the 16–end cutoff" : "half each cutoff") + "."}),
      R.returned_note ? h("p", {class: "gov-warn", text: "Returned: " + R.returned_note}) : null,
      pendingRules ? h("p", {class: "muted small", text: "Some statutory rules used here are still waiting for the accountant's review."}) : null,
      h("div", {class: "kpis"}, [["Net pay", peso(T.net), (T.people || 0) + " people"], ["Gross pay", peso(T.gross), "Before deductions"],
        ["Employee contributions", peso(T.employee_contributions), "SSS, PhilHealth, Pag-IBIG"], ["Employer contributions", peso(T.employer_contributions), "Not taken from pay"],
        ["Withholding tax", peso(T.tax), "To remit with BIR 1601-C"]].map(function(x){ return h("div", {class: "kpi"}, [h("span", {class: "label", text: x[0]}), h("span", {class: "val", text: x[1]}), h("span", {class: "sub", text: x[2]})]); })),
      h("div", {class: "acct-actions"}, actions),
      h("div", {class: "acct-scroll"}, h("table", {class: "acct-table run-lines"}, [
        h("thead", null, h("tr", null, ["Person", "Days", "Basic", "Premiums + OT", "Allowance", "Adjustments", "Gross", "SSS", "PhilHealth", "Pag-IBIG", "Tax", "Net"].map(function(t, i){ return h("th", {class: i ? "num" : null, text: t}); }))),
        h("tbody", null, R.lines.map(function(l){
          var adj = Number(l.adj_taxable) + Number(l.adj_nontaxable) - Number(l.adj_deductions);
          return h("tr", {"data-line": l.name}, [h("td", null, [h("strong", {text: l.name}), l.unaccounted_days ? h("div", {class: "neg", style: "font-size:12.5px", text: l.unaccounted_days + " unaccounted days"}) : null,
              l.mwe ? h("div", {class: "muted", style: "font-size:12.5px", text: "Minimum wage earner"}) : null]),
            h("td", {class: "num", text: String(l.days_worked)}), h("td", {class: "num", text: peso(l.basic_pay)}),
            h("td", {class: "num", text: peso(Number(l.premium) + Number(l.overtime_pay))}), h("td", {class: "num", text: peso(l.allowance)}),
            h("td", {class: "num", text: adj ? (adj < 0 ? "− " : "") + peso(Math.abs(adj)) : "—"}), h("td", {class: "num", text: peso(l.gross)}),
            h("td", {class: "num", text: peso(l.sss_ee)}), h("td", {class: "num", text: peso(l.ph_ee)}), h("td", {class: "num", text: peso(l.pi_ee)}),
            h("td", {class: "num", text: peso(l.tax)}), h("td", {class: "num", text: peso(l.net)})]);
        }))])),
      adjustmentsBox(R)]));
  }
  function adjustmentsBox(R){
    var admin = !!R.can_approve, draft = R.status === "draft", KIND = {taxable_earning: "Taxable earning", nontaxable_earning: "Non-taxable earning", deduction: "Deduction"};
    var list = R.adjustments.length ? h("ul", {class: "rec-list adj-list"}, R.adjustments.map(function(a){
      return h("li", {"data-adj": a.reason}, [h("b", {text: a.person + ": "}), KIND[a.kind] + " " + peso(a.amount) + " · " + a.reason + (a.reference ? " (" + a.reference + ")" : ""),
        h("span", {class: "muted", text: " · by " + a.by + " · " + (a.status === "pending" ? "waiting for the admin" : a.status + (a.decider ? " by " + a.decider : ""))}),
        admin && draft && a.status === "pending" ? h("span", null, [
          h("button", {class: "link", type: "button", text: "Approve", "aria-label": "Approve " + a.reason, onclick: runAct("payroll_adjustment_decide", function(){ return {p_id: a.id, p_decision: "approved", p_note: ""}; }, "Adjustment approved.")}),
          h("button", {class: "link", type: "button", text: "Reject", "aria-label": "Reject " + a.reason, onclick: runAct("payroll_adjustment_decide", function(){ return {p_id: a.id, p_decision: "rejected", p_note: ""}; }, "Adjustment rejected.")})]) : null]);
    })) : h("p", {class: "muted small", text: "No adjustments."});
    if(!draft) return h("div", {class: "adj-box"}, [h("h3", {text: "Adjustments"}), list]);
    var who = h("select", {"aria-label": "Adjustment for"}, R.lines.map(function(l){ return h("option", {value: l.user_id, text: l.name}); }));
    var kind = h("select", {"aria-label": "Kind of adjustment"}, Object.keys(KIND).map(function(k){ return h("option", {value: k, text: KIND[k]}); }));
    var amount = h("input", {inputmode: "decimal", "aria-label": "Adjustment amount", placeholder: "Amount"});
    var reason = h("input", {maxlength: "500", "aria-label": "Adjustment reason", placeholder: "Reason (required): e.g. cash advance Oct 20"});
    var ref = h("input", {maxlength: "300", "aria-label": "Adjustment reference", placeholder: "Reference (optional)"});
    var err = h("p", {class: "form-error", role: "alert"}), add = h("button", {class: "btn ghost", type: "button", text: "Add adjustment"});
    add.addEventListener("click", function(){
      err.textContent = ""; busy(add, true);
      rpc("payroll_adjustment_add", {p: {run_id: R.id, user_id: who.value, kind: kind.value, amount: amount.value.replace(/[,\s₱]/g, ""), reason: reason.value, reference: ref.value}})
        .then(function(r){ msg("Adjustment added: it waits for the admin."); renderRun(r); state.runs = null; loadRuns(); })
        .catch(function(e){ busy(add, false); err.textContent = (e && e.message ? e.message : String(e)) + " Nothing you entered was lost."; });
    });
    return h("div", {class: "adj-box"}, [h("h3", {text: "Adjustments"}), h("p", {class: "muted small", text: "Every adjustment waits for the admin's approval before it counts."}), list,
      h("div", {class: "rec-form adj-form"}, [h("div", {class: "rec-row"}, [h("label", null, ["Person", who]), h("label", null, ["Kind", kind])]),
        h("div", {class: "rec-row"}, [h("label", null, ["Amount (₱)", amount]), h("label", null, ["Reference", ref])]), h("label", null, ["Reason", reason])]), err,
      h("div", {class: "acct-actions"}, add)]);
  }
  function runCsv(R){
    var head = ["Person", "Role", "Employment", "Salary type", "Daily rate", "Days worked", "Minutes deducted", "Basic pay", "Premiums", "Overtime", "Allowance", "Taxable adjustments", "Non-taxable adjustments", "Gross", "Taxable", "SSS EE", "SSS ER", "SSS EC", "PhilHealth EE", "PhilHealth ER", "Pag-IBIG EE", "Pag-IBIG ER", "Minimum wage earner", "Withholding tax", "Deductions", "Net"];
    var rows = [head].concat(R.lines.map(function(l){ return [l.name, ROLE[l.role] || l.role, EMPLOY[l.employment_type] || l.employment_type, l.salary_type, l.daily_rate, l.days_worked, l.deducted_minutes,
      l.basic_pay, l.premium, l.overtime_pay, l.allowance, l.adj_taxable, l.adj_nontaxable, l.gross, l.taxable, l.sss_ee, l.sss_er, l.sss_ec, l.ph_ee, l.ph_er, l.pi_ee, l.pi_er, l.mwe ? "yes" : "no", l.tax, l.adj_deductions, l.net]; }));
    var csv = rows.map(function(r){ return r.map(function(c){ return '"' + String(c == null ? "" : c).replace(/"/g, '""') + '"'; }).join(","); }).join("\r\n");
    var a = h("a", {href: URL.createObjectURL(new Blob(["﻿" + csv], {type: "text/csv"})), download: "ritehome-payroll-" + R.period_start + "-to-" + R.period_end + ".csv"});
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- government contributions and statutory rules (v4.0, migration 24) ----------
  var AGENCY_ORDER = ["BIR", "SSS", "PhilHealth", "Pag-IBIG", "DOLE"];
  function loadStatutory(){
    var today = state.me.today;
    return Promise.all([quiet("statutory_overview", {p_date: today}), quiet("statutory_rules_list")]).then(function(r){
      state.gov = r[0]; state.rules = r[1];
      $("govCard").hidden = !state.gov; $("rulesCard").hidden = !state.rules;
      if(!state.gov) return;
      return Promise.all(state.gov.people.map(function(p){
        return p.monthly == null ? null : quiet("statutory_month_estimate", {p_user: p.id, p_date: today});
      })).then(function(est){ state.gov.people.forEach(function(p, i){ p.est = est[i]; }); renderGov(); renderRules(); });
    });
  }
  function pending(x){ return x && x.rule_status && x.rule_status !== "approved"; }
  function renderGov(){
    var g = state.gov, admin = state.roles.indexOf("admin") >= 0, low = g.people.filter(function(p){ return p.below_minimum; });
    var unapproved = g.people.some(function(p){ return p.est && [p.sss, p.philhealth, p.pagibig, p.est.withholding].some(pending); });
    $("govSub").textContent = "A full month at each person's rate, from the statutory rules below. Payroll runs will use actual pay. The employer's share is never taken from the employee." +
      (g.minimum_wage ? " Minimum wage here: " + peso(g.minimum_wage) + " a day." : "") + (unapproved ? " Some rules are still waiting for the accountant's review: these are estimates." : "");
    var warn = low.length ? h("p", {class: "gov-warn", role: "alert", text: low.map(function(p){ return p.name; }).join(", ") + (low.length === 1 ? " is" : " are") +
      " paid below the " + peso(g.minimum_wage) + " daily minimum wage (Wage Order RX-24). Raise the rate from the date it should have applied, and ask the accountant about back pay."}) : null;
    function pair(x){ return x && x.employee != null ? peso(x.employee) + " / " + peso(x.employer) : "—"; }
    put("govTable", h("div", {style: "display:contents"}, [warn, h("div", {class: "acct-scroll"}, h("table", {class: "acct-table"}, [
      h("thead", null, h("tr", null, ["Person", "A month at their rate", "SSS (employee / employer)", "PhilHealth", "Pag-IBIG", "Tax withheld a month", "Government numbers"].map(function(t, i){ return h("th", {class: i && i < 6 ? "num" : null, text: t}); }))),
      h("tbody", null, g.people.map(function(p){
        var n = p.numbers || {}, have = ["tin", "sss_no", "philhealth_no", "pagibig_no"].filter(function(k){ return n[k]; }).length, may = !p.self || admin;
        var tax = p.est ? (p.est.withholding.exempt ? "None (minimum wage earner)" : peso(p.est.withholding.tax)) : "—";
        return h("tr", {"data-gov": p.name}, [
          h("td", null, [h("strong", {text: p.name || "Unnamed"}), p.below_minimum ? h("div", {class: "neg", style: "font-size:12.5px", text: "Below minimum wage"}) : p.mwe ? h("div", {class: "muted", style: "font-size:12.5px", text: "Minimum wage earner" + (p.mwe_decided ? "" : " (from the rate)")}) : null]),
          h("td", {class: "num", text: p.monthly != null ? peso(p.monthly) : "No rate"}),
          h("td", {class: "num", text: pair(p.sss)}), h("td", {class: "num", text: pair(p.philhealth)}), h("td", {class: "num", text: pair(p.pagibig)}),
          h("td", {class: "num", text: tax}),
          h("td", null, [h("span", {class: "muted small", text: have + " of 4 "}), may ? h("button", {class: "btn ghost small", type: "button", text: "Edit…", "aria-label": "Government numbers for " + p.name, onclick: function(){ govForm(p); }}) : null])]);
      }))]))]));
  }
  function govForm(p){
    var n = p.numbers || {}, f = {};
    var fields = [["tin", "TIN", "123-456-789-000"], ["sss_no", "SSS number", "34-1234567-8"], ["philhealth_no", "PhilHealth number", "12-345678901-2"], ["pagibig_no", "Pag-IBIG MID number", "1212-3456-7890"]];
    fields.forEach(function(x){ f[x[0]] = h("input", {"aria-label": x[1], value: n[x[0]] || "", placeholder: x[2], inputmode: "numeric", autocomplete: "off"}); });
    var hired = h("input", {type: "date", "aria-label": "Hired on", value: n.hired_on || ""}), birth = h("input", {type: "date", "aria-label": "Birth date", value: n.birth_date || ""});
    var mwe = h("select", {"aria-label": "Minimum wage earner"}, [["", "Decide from the rate"], ["true", "Yes: exempt from withholding tax"], ["false", "No"]].map(function(o){ return h("option", {value: o[0], text: o[1]}); }));
    mwe.value = n.minimum_wage_earner == null ? "" : String(n.minimum_wage_earner);
    var err = h("p", {class: "form-error", role: "alert"}), save = h("button", {class: "btn", type: "button", text: "Save"});
    save.addEventListener("click", function(){
      err.textContent = ""; busy(save, true);
      var body = {user_id: p.id, birth_date: birth.value, hired_on: hired.value, minimum_wage_earner: mwe.value};
      fields.forEach(function(x){ body[x[0]] = f[x[0]].value; });
      rpc("employee_statutory_save", {p: body}).then(function(){ $("look").hidden = true; msg(p.name + ": government numbers saved."); return loadStatutory(); })
        .catch(function(e){ busy(save, false); err.textContent = (e && e.message ? e.message : String(e)) + " Nothing you entered was lost."; });
    });
    put("lookBox", h("div", {style: "display:contents"}, [
      h("h2", {id: "lookTitle", text: "Government numbers · " + p.name}),
      h("p", {class: "muted small", text: "Digits are enough; the dashes are added. Only the admin and the bookkeeper see these, and the person sees their own."}),
      h("div", {class: "rec-form"}, [h("div", {class: "rec-row"}, [h("label", null, ["TIN", f.tin]), h("label", null, ["SSS number", f.sss_no])]),
        h("div", {class: "rec-row"}, [h("label", null, ["PhilHealth number", f.philhealth_no]), h("label", null, ["Pag-IBIG MID number", f.pagibig_no])]),
        h("div", {class: "rec-row"}, [h("label", null, ["Hired on", hired]), h("label", null, ["Birth date", birth])]),
        h("label", null, ["Minimum wage earner", mwe])]), err,
      h("div", {class: "acct-actions"}, [save, h("button", {class: "btn ghost", type: "button", text: "Cancel", onclick: function(){ $("look").hidden = true; }})])]));
    $("look").hidden = false; f.tin.focus();
  }
  function renderRules(){
    var R = state.rules; if(!R) return;
    var rows = R.rules.slice().sort(function(a, b){ return AGENCY_ORDER.indexOf(a.agency) - AGENCY_ORDER.indexOf(b.agency) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) || (a.effective_from < b.effective_from ? 1 : -1); });
    var waiting = rows.filter(function(r){ return r.status === "pending_review"; }).length;
    put("rulesTable", h("div", {style: "display:contents"}, [
      waiting ? h("p", {class: "muted small", text: waiting + (waiting === 1 ? " rule is" : " rules are") + " waiting for review." + (R.can_approve ? " Approve each one only after the accountant has checked it against its source, and name them." : " The admin approves them after the accountant checks.")}) : null,
      h("div", {class: "acct-scroll"}, h("table", {class: "acct-table"}, [
        h("thead", null, h("tr", null, ["Agency", "Rule", "From", "Source", "Checked", "Status", ""].map(function(t){ return h("th", {text: t}); }))),
        h("tbody", null, rows.map(function(r){
          var st = r.status === "approved" ? ["good", "Approved"] : r.status === "retired" ? ["", "Retired"] : ["warn", "Waiting for review"];
          return h("tr", {"data-rule": r.code + "@" + r.effective_from}, [h("td", {text: r.agency}),
            h("td", null, [h("strong", {text: r.name}), r.in_force ? h("div", {class: "muted", style: "font-size:12.5px", text: "In force today"}) : null,
              r.notes ? h("div", {class: "muted", style: "font-size:12.5px", text: r.notes}) : null]),
            h("td", {text: dayName(r.effective_from) + ", " + r.effective_from.slice(0, 4) + (r.effective_to ? " to " + r.effective_to : "")}),
            h("td", null, r.source_url ? h("a", {href: r.source_url, target: "_blank", rel: "noopener noreferrer", text: r.source_title}) : r.source_title),
            h("td", {text: r.verified_on + " · " + r.verified_by}),
            h("td", null, [h("span", {class: "pill " + st[0], text: st[1]}), r.approval_note ? h("div", {class: "muted", style: "font-size:12.5px", text: (r.approver ? r.approver + ": " : "") + r.approval_note}) : null]),
            h("td", null, R.can_approve && r.status === "pending_review" ? h("button", {class: "btn ghost small", type: "button", text: "Approve…", "aria-label": "Approve " + r.name, onclick: function(){ decideRule(r, "approved"); }})
              : R.can_approve && r.status === "approved" ? h("button", {class: "btn ghost small", type: "button", text: "Retire…", "aria-label": "Retire " + r.name, onclick: function(){ decideRule(r, "retired"); }}) : null)]);
        }))]))]));
  }
  function decideRule(r, decision){
    var note = window.prompt(decision === "approved" ? "Approve “" + r.name + "”?\n\nWho checked it against " + r.source_title + "? (e.g. “A. Cruz, CPA, 2026-11-20”)" : "Retire “" + r.name + "”? Why?", "");
    if(note == null) return;
    rpc("statutory_rule_decide", {p_id: r.id, p_decision: decision, p_note: note}).then(function(){ msg(decision === "approved" ? "Rule approved." : "Rule retired."); return loadStatutory(); }).catch(fail);
  }

  // ---------- start ----------
  function show(tab){
    state.tab = tab;
    ["mine", "team", "month", "pay"].forEach(function(t){ $("tab-" + t).hidden = t !== tab; });
    document.querySelectorAll("#attTabs button").forEach(function(b){ if(b.getAttribute("data-tab") === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
    return (tab === "team" ? loadTeam() : tab === "month" ? loadMonth() : tab === "pay" ? loadPay() : loadMine()).catch(fail);
  }
  function gate(title, text, link){
    $("gate").hidden = false; $("app").hidden = true;
    $("gateTitle").textContent = title; $("gateText").textContent = text || ""; $("gateLinkRow").hidden = !link;
    document.body.classList.add("gated"); document.body.classList.remove("connecting");
  }
  function start(){
    $("noticeAccept").addEventListener("click", function(){ busy($("noticeAccept"), true); rpc("accept_attendance_notice").then(function(){ busy($("noticeAccept"), false); return loadMine(); }).catch(function(e){ busy($("noticeAccept"), false); fail(e); }); });
    $("enrollBtn").addEventListener("click", enroll);
    $("punchBtn").addEventListener("click", punch);
    $("punchKind").addEventListener("change", function(){ $("punchBtn").textContent = KIND[$("punchKind").value][2]; });
    return loadMine().then(function(){
      var me = state.me; state.day_radius = me.office.radius_m;
      if(state.manage){
        $("attTabs").hidden = false; $("teamDate").value = me.today; $("monthPick").value = me.today.slice(0, 7);
        $("attTabs").addEventListener("click", function(e){ var b = e.target.closest("[data-tab]"); if(b) show(b.getAttribute("data-tab")); });
        $("teamDate").addEventListener("change", function(){ loadTeam().catch(fail); });
        $("monthPick").addEventListener("change", function(){ loadMonth().catch(fail); });
        $("monthCsv").addEventListener("click", monthCsv);
        ["payFrom", "payTo"].forEach(function(id){ $(id).addEventListener("change", function(){ loadPayDays().catch(fail); }); });
        ["payPerson", "payRole", "payType", "payStatus"].forEach(function(id){ $(id).addEventListener("change", renderPay); });
        $("payCsv").addEventListener("click", payCsv);
        $("runPrepare").addEventListener("click", function(e){
          var b = e.currentTarget; busy(b, true);
          rpc("payroll_run_prepare", {p_date: $("runDate").value}).then(function(r){ busy(b, false); msg("Payroll prepared from attendance: check it, then submit."); state.openRun = r.id; return loadRuns(); })
            .catch(function(err){ busy(b, false); fail(err); });
        });
      }
      $("gate").hidden = true; $("app").hidden = false; document.body.classList.remove("gated", "connecting");
      if(me.consent_at && Face.warm) Face.warm().catch(function(){});   // fetch the face models while the person reads the page
    });
  }
  function home(){ return window.RitehomeLinks ? window.RitehomeLinks.href("all") : "tracker.html"; }
  if(window.RitehomeLinks && window.RitehomeLinks.href("attendance") === "/attendance" && /attendance\.html$/.test(location.pathname)){
    try { history.replaceState(history.state, "", "/attendance" + location.hash); } catch(e){}
  }
  $("forgetKeyBtn").addEventListener("click", function(){ client.auth.signOut().then(function(){ location.href = home(); }); });
  document.body.classList.add("gated", "connecting");
  client.auth.getSession().then(function(r){
    var session = r && r.data && r.data.session;
    if(!session){ $("gateLink").href = home(); return gate("Sign in first", "Sign in on the staff portal, then open Attendance from the menu.", true); }
    if(session.user && session.user.user_metadata && session.user.user_metadata.must_change_password){ $("gateLink").href = home(); return gate("Choose your password first", "Your account still has the temporary password. Open the staff portal to set your own.", true); }
    return rpc("my_roles").then(function(roles){
      roles = roles || [];
      if(window.RitehomeAccess) window.RitehomeAccess.apply(roles, client);
      if(!roles.length) return gate("Your account isn't active yet", "Ask the admin to switch it on.");
      state.roles = roles; state.manage = roles.indexOf("admin") >= 0 || roles.indexOf("bookkeeper") >= 0;
      return start();
    });
  }).catch(function(e){ gate("Couldn't open attendance", e && e.message ? e.message : String(e)); });
})();
