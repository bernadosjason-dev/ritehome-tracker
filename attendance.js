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
  var state = {me: null, tab: "mine", day: null, month: [], flash: null};

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
  function loadMine(){ return rpc("attendance_me").then(function(me){ state.me = me; renderMine(); }); }
  function renderMine(){
    var me = state.me, started = !!me.consent_at && me.enrolled;
    $("noticeCard").hidden = !!me.consent_at;
    $("enrollCard").hidden = !me.consent_at || me.enrolled;
    $("todayCard").hidden = !started; $("historyCard").hidden = !started || !me.days.length;
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

  // ---------- admin: the team's day ----------
  function signed(path){
    return client.storage.from(BUCKET).createSignedUrl(path, 300).then(function(r){ if(r.error || !r.data) throw new Error("That photo can't be opened."); return r.data.signedUrl; });
  }
  function loadTeam(){
    return Promise.all([rpc("attendance_day", {p_date: $("teamDate").value}), rpc("attendance_old_selfies", {p_days: 90})]).then(function(r){
      state.day = r[0]; state.old = r[1] || []; renderTeam();
    });
  }
  function needsLook(p){ return !p.reviewed_at && (p.flags || []).some(function(f){ return f === "face_mismatch" || f === "no_face_check" || f === "low_gps_accuracy"; }); }
  function renderTeam(){
    var people = state.day.people, all = [];
    people.forEach(function(p){ p.punches.forEach(function(x){ all.push(x); }); });
    var review = all.filter(needsLook).length, present = people.filter(function(p){ return p.punches.length; }).length;
    var late = all.filter(function(x){ return x.flags.indexOf("late") >= 0; }).length, off = people.filter(function(p){ return p.punches.some(function(x){ return x.flags.indexOf("off_site") >= 0; }); }).length;
    var k = [["Photos to check", String(review), review ? "Open each one below" : "Nothing waiting", review > 0], ["Clocked in", present + " of " + people.length, people.length - present ? people.length - present + " not yet" : "Everyone"],
      ["Late", String(late), "After 8 AM or 1 PM"], ["Off site", String(off), "More than " + state.day_radius + " m from the office"]];
    put("teamKpis", h("div", {style: "display:contents"}, k.map(function(x){
      return h("div", {class: "kpi"}, [h("span", {class: "label", text: x[0]}), h("span", {class: "val" + (x[3] ? " neg" : ""), text: x[1]}), h("span", {class: "sub", text: x[2]})]);
    })));
    $("teamCount").textContent = String(people.length);
    put("teamTable", h("div", {class: "acct-scroll"}, h("table", {class: "acct-table"}, [
      h("thead", null, h("tr", null, ["Person"].concat(KINDS.map(function(k){ return k[1]; })).map(function(t){ return h("th", {text: t}); }))),
      h("tbody", null, people.map(function(p){
        var by = {}; p.punches.forEach(function(x){ by[x.kind] = x; });
        return h("tr", {"data-person": p.name}, [h("td", null, [h("strong", {text: p.name || "Unnamed"}), h("div", {class: "muted", style: "font-size:12.5px", text: ROLE[p.role] || ""})])].concat(KINDS.map(function(k){
          var x = by[k[0]];
          if(!x) return h("td", {class: "none", text: "—"});
          return h("td", null, h("div", {class: "cellp"}, [h("span", {class: "t", text: clock(x.at)}), pills(x, true),
            h("button", {class: "link", type: "button", text: x.reviewed_at ? "Checked" : needsLook(x) ? "Check photo" : "Photo", "aria-label": p.name + " " + k[1] + " photo", onclick: function(){ look(p, x); }})]));
        })));
      }))])));
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
  function loadMonth(){
    return rpc("attendance_month", {p_month: $("monthPick").value + "-01"}).then(function(rows){ state.month = rows || []; renderMonth(); });
  }
  function renderMonth(){
    $("monthTitle").textContent = new Date($("monthPick").value + "-01T00:00:00+08:00").toLocaleDateString("en-PH", {month: "long", year: "numeric", timeZone: "Asia/Manila"});
    put("monthTable", h("div", {class: "acct-scroll"}, h("table", {class: "acct-table"}, [
      h("thead", null, h("tr", null, ["Person", "Days", "Hours", "Late", "Left early", "Incomplete", "To check"].map(function(t, i){ return h("th", {class: i ? "num" : null, text: t}); }))),
      h("tbody", null, state.month.map(function(m){
        return h("tr", null, [h("td", null, [m.name || "Unnamed", h("span", {class: "muted", text: " · " + (ROLE[m.role] || "")})])].concat(
          [m.days, Number(m.hours).toFixed(2), m.lates, m.early_outs, m.incomplete_days, m.to_review].map(function(v){ return h("td", {class: "num", text: String(v)}); })));
      }))])));
  }
  function monthCsv(){
    var rows = [["Person", "Role", "Days", "Hours", "Late", "Left early", "Incomplete days", "To check"]].concat(state.month.map(function(m){
      return [m.name, ROLE[m.role] || m.role, m.days, Number(m.hours).toFixed(2), m.lates, m.early_outs, m.incomplete_days, m.to_review]; }));
    var csv = rows.map(function(r){ return r.map(function(c){ return '"' + String(c == null ? "" : c).replace(/"/g, '""') + '"'; }).join(","); }).join("\r\n");
    var a = h("a", {href: URL.createObjectURL(new Blob(["﻿" + csv], {type: "text/csv"})), download: "ritehome-attendance-" + $("monthPick").value + ".csv"});
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- start ----------
  function show(tab){
    state.tab = tab;
    ["mine", "team", "month"].forEach(function(t){ $("tab-" + t).hidden = t !== tab; });
    document.querySelectorAll("#attTabs button").forEach(function(b){ if(b.getAttribute("data-tab") === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
    return (tab === "team" ? loadTeam() : tab === "month" ? loadMonth() : loadMine()).catch(fail);
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
      if(me.role === "admin"){
        $("attTabs").hidden = false; $("teamDate").value = me.today; $("monthPick").value = me.today.slice(0, 7);
        $("attTabs").addEventListener("click", function(e){ var b = e.target.closest("[data-tab]"); if(b) show(b.getAttribute("data-tab")); });
        $("teamDate").addEventListener("change", function(){ loadTeam().catch(fail); });
        $("monthPick").addEventListener("change", function(){ loadMonth().catch(fail); });
        $("monthCsv").addEventListener("click", monthCsv);
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
      return start();
    });
  }).catch(function(e){ gate("Couldn't open attendance", e && e.message ? e.message : String(e)); });
})();
