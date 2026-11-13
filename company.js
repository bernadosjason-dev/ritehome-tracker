/* Company profile (company.html at /company, admin and bookkeeper). Phase 5a of the CRM master prompt.
   Data and every rule: supabase/migrations/20261123000020_company_profile.sql
     company_get()               the profile, the document register (with days to expiry), can_archive
     company_profile_save(p)     the fields sent, the authorised people
     company_document_save(p)    a new document (its file must already be in the bucket) or edits to one
     company_document_archive()  the admin removes a document (kept, out of the list)
   Files: the private 'company-files' bucket (logo/<uuid>.<ext>, documents/<uuid>.<ext>, 10 MB, PDF or
   image), uploaded once and read through short signed links. A failed save keeps the form and the
   uploaded file, so a retry doesn't upload twice. */
(function(){
  'use strict';
  var SUPABASE_URL = "https://laxavfldivkhufeubgmb.supabase.co";
  var SUPABASE_KEY = "sb_publishable_8vOuny8cDkb-vtwyOP7vnA_VqFYc5T1";
  var BUCKET = "company-files";
  var DOC_MAX = 10 * 1024 * 1024, LOGO_MAX = 2 * 1024 * 1024;
  var EXT = {"application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"};
  var KINDS = [["mayors_permit", "Mayor's / business permit"], ["dti_sec", "DTI or SEC registration"], ["bir", "BIR (2303, books, receipts)"],
    ["barangay", "Barangay clearance"], ["government_ids", "SSS, PhilHealth, Pag-IBIG"], ["contract", "Contract or agreement"],
    ["insurance", "Insurance"], ["bank", "Bank"], ["other", "Other"]];
  var KIND = {}; KINDS.forEach(function(k){ KIND[k[0]] = k[1]; });

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: false}});
  var state = {data: null, auth: [], pendingFile: null, editing: null};

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
  function put(id, node){ var el = $(id); el.textContent = ""; if(node) el.appendChild(node); }
  function rpc(name, args){
    return client.rpc(name, args || {}).then(function(r){
      if(r.error){ if(window.RitehomeRefused) window.RitehomeRefused(client, "Company", name, r.error); throw new Error(r.error.message || "The request failed."); }
      return r.data;
    });
  }
  function msg(text, bad){
    var m = $("acctMsg"); m.textContent = text; m.hidden = !text; m.classList.toggle("bad", !!bad);
    clearTimeout(msg.t); if(text && !bad) msg.t = setTimeout(function(){ m.hidden = true; }, 5000);
  }
  function busy(b, on){ if(window.RitehomeBusy) window.RitehomeBusy(b, on); else b.disabled = on; }
  function uuid(){
    if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var x = Array.prototype.map.call(b, function(n){ return (n + 256).toString(16).slice(1); }).join("");
    return x.slice(0, 8) + "-" + x.slice(8, 12) + "-" + x.slice(12, 16) + "-" + x.slice(16, 20) + "-" + x.slice(20);
  }
  // Storage errors in words a person can act on.
  function storageWords(err){
    var t = String((err && (err.message || err.error)) || err || ""), code = String(err && (err.statusCode || err.status) || "");
    if(code === "413" || /maximum allowed size|too large|payload/i.test(t)) return "The file is over the limit (10 MB for documents, 2 MB for the logo).";
    if(code === "403" || /row-level security|not authorized|unauthorized/i.test(t)) return "Your account can't upload company files. Ask the admin.";
    if(/mime|content type|not supported/i.test(t)) return "Only PDF, PNG, JPG or WebP files can be uploaded.";
    if(/fetch|network|failed to/i.test(t)) return "The upload didn't go through (no connection?). Your entries are kept: try again.";
    return t || "The upload failed. Your entries are kept: try again.";
  }
  function fileKey(f){ return [f.name, f.size, f.lastModified].join("|"); }
  function upload(folder, file, max){
    if(!EXT[file.type]) return Promise.reject(new Error("Only PDF, PNG, JPG or WebP files can be uploaded."));
    if(file.size > max) return Promise.reject(new Error("The file is " + (file.size / 1048576).toFixed(1) + " MB; the limit is " + (max / 1048576) + " MB."));
    var path = folder + "/" + uuid() + "." + EXT[file.type];
    return client.storage.from(BUCKET).upload(path, file, {contentType: file.type, upsert: false}).then(function(r){
      if(r.error) throw new Error(storageWords(r.error));
      return path;
    }, function(e){ throw new Error(storageWords(e)); });
  }
  function signed(path, seconds){
    return client.storage.from(BUCKET).createSignedUrl(path, seconds || 300).then(function(r){
      if(r.error || !r.data) throw new Error("Couldn't open the file: " + ((r.error && r.error.message) || "no link"));
      return r.data.signedUrl;
    });
  }

  var dayFmt = new Intl.DateTimeFormat("en-PH", {month: "short", day: "numeric", year: "numeric", timeZone: "UTC"});
  function fmtDay(d){ return d ? dayFmt.format(new Date(d + "T00:00:00Z")) : ""; }
  function plural(n, one, many){ return n + " " + (n === 1 ? one : many); }
  function expiry(d){
    if(!d.expires_on) return h("span", {class: "status-pill neutral", text: "No expiry"});
    var n = d.days_left;
    if(n < 0) return h("span", {class: "status-pill bad", text: "Expired " + (n === -1 ? "yesterday" : plural(-n, "day", "days") + " ago")});
    if(n === 0) return h("span", {class: "status-pill bad", text: "Expires today"});
    if(n <= 30) return h("span", {class: "status-pill warn", text: "Expires in " + plural(n, "day", "days")});
    return h("span", {class: "status-pill good", text: "Valid until " + fmtDay(d.expires_on)});
  }

  // ---------- documents ----------
  function renderDocs(){
    var docs = state.data.documents || [];
    var expired = docs.filter(function(d){ return d.expires_on && d.days_left < 0; }).length;
    var soon = docs.filter(function(d){ return d.expires_on && d.days_left >= 0 && d.days_left <= 30; }).length;
    $("coTitle").textContent = expired ? plural(expired, "document", "documents") + " expired"
      : soon ? plural(soon, "document expires", "documents expire") + " within 30 days" : "Company profile";
    if(!docs.length){ put("docList", h("p", {class: "muted", text: "No documents yet. Start with the ones that expire: the mayor's permit and barangay clearance."})); return; }
    put("docList", h("div", {class: "co-docs"}, docs.map(function(d){
      if(state.editing === d.id) return editRow(d);
      var open = h("button", {class: "btn ghost small", type: "button", text: "Open"});
      open.addEventListener("click", function(){
        var w = window.open("", "_blank");
        signed(d.file_path, 300).then(function(u){ if(w) w.location = u; else location.href = u; })
          .catch(function(e){ if(w) w.close(); msg(e.message, true); });
      });
      var edit = h("button", {class: "btn ghost small", type: "button", text: "Edit"});
      edit.addEventListener("click", function(){ state.editing = d.id; renderDocs(); });
      var remove = state.data.can_archive ? h("button", {class: "btn ghost small", type: "button", text: "Remove"}) : null;
      if(remove) remove.addEventListener("click", function(){
        if(!window.confirm("Remove “" + d.title + "” from the register? The file is kept and the activity log records who removed it.")) return;
        busy(remove, true);
        rpc("company_document_archive", {p_id: d.id}).then(function(){ msg(d.title + " removed."); return load(); })
          .catch(function(e){ busy(remove, false); msg(e.message, true); });
      });
      return h("article", {class: "co-doc", "data-id": d.id}, [
        h("div", {class: "co-doc-main"}, [h("strong", {text: d.title}), expiry(d)]),
        h("div", {class: "co-doc-meta muted"}, [KIND[d.kind] || d.kind, " · ", d.file_name || "file",
          " · added by " + (d.uploader || "someone")]),
        d.notes ? h("p", {class: "co-doc-notes", text: d.notes}) : null,
        h("div", {class: "co-actions"}, [open, edit, remove])
      ]);
    })));
  }
  function kindSelect(value){
    var s = h("select", {"aria-label": "Kind"}); KINDS.forEach(function(k){ s.appendChild(h("option", {value: k[0], text: k[1]})); }); s.value = value || "other"; return s;
  }
  function editRow(d){
    var title = h("input", {maxlength: "120", value: d.title, "aria-label": "Title"}), kind = kindSelect(d.kind);
    var exp = h("input", {type: "date", value: d.expires_on || "", "aria-label": "Expires on"});
    var notes = h("input", {maxlength: "1000", value: d.notes || "", "aria-label": "Notes"});
    var save = h("button", {class: "btn small", type: "button", text: "Save"}), cancel = h("button", {class: "btn ghost small", type: "button", text: "Cancel"});
    cancel.addEventListener("click", function(){ state.editing = null; renderDocs(); });
    save.addEventListener("click", function(){
      if(!title.value.trim()){ title.focus(); msg("Give the document a title.", true); return; }
      busy(save, true);
      rpc("company_document_save", {p: {id: d.id, title: title.value, kind: kind.value, expires_on: exp.value, notes: notes.value}})
        .then(function(){ state.editing = null; msg(title.value.trim() + " saved."); return load(); })
        .catch(function(e){ busy(save, false); msg(e.message, true); });
    });
    return h("article", {class: "co-doc editing", "data-id": d.id}, [h("div", {class: "co-grid"}, [
      h("label", null, ["Title ", title]), h("label", null, ["Kind ", kind]), h("label", null, ["Expires on ", exp]), h("label", {class: "wide"}, ["Notes ", notes])]),
      h("div", {class: "co-actions"}, [save, cancel])]);
  }
  function wireDocForm(){
    KINDS.forEach(function(k){ $("dKind").appendChild(h("option", {value: k[0], text: k[1]})); });
    $("dKind").value = "mayors_permit";
    $("docAddBtn").addEventListener("click", function(){ $("docForm").hidden = false; $("docAddBtn").hidden = true; $("dFile").focus(); });
    $("docCancel").addEventListener("click", function(){ $("docForm").reset(); $("docForm").hidden = true; $("docAddBtn").hidden = false; $("docError").textContent = ""; state.pendingFile = null; });
    $("dFile").addEventListener("change", function(){
      var f = $("dFile").files[0];
      if(f && !$("dTitle").value.trim()) $("dTitle").value = f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").slice(0, 120);
    });
    $("docForm").addEventListener("submit", function(e){
      e.preventDefault();
      var f = $("dFile").files[0], btn = $("docSave"); $("docError").textContent = "";
      if(!f){ $("docError").textContent = "Choose the file first."; return; }
      if(!$("dTitle").value.trim()){ $("docError").textContent = "Give the document a title."; $("dTitle").focus(); return; }
      busy(btn, true);
      // A retry after a failed save reuses the file already uploaded.
      var up = state.pendingFile && state.pendingFile.key === fileKey(f) ? Promise.resolve(state.pendingFile.path)
        : upload("documents", f, DOC_MAX).then(function(path){ state.pendingFile = {key: fileKey(f), path: path}; return path; });
      up.then(function(path){
        return rpc("company_document_save", {p: {title: $("dTitle").value, kind: $("dKind").value, file_path: path, file_name: f.name,
          size_bytes: f.size, expires_on: $("dExpires").value, notes: $("dNotes").value}});
      }).then(function(){
        var t = $("dTitle").value.trim();
        state.pendingFile = null; $("docForm").reset(); $("docForm").hidden = true; $("docAddBtn").hidden = false; busy(btn, false);
        msg(t + " added to the register.");
        return load();
      }).catch(function(err){ busy(btn, false); $("docError").textContent = err.message + " Nothing you entered was lost."; });
    });
  }

  // ---------- profile ----------
  function authRow(p){
    var row = h("div", {class: "co-auth-row"}, [
      h("input", {"data-a": "name", maxlength: "120", placeholder: "Name", value: p.name || "", "aria-label": "Name"}),
      h("input", {"data-a": "position", maxlength: "120", placeholder: "Position", value: p.position || "", "aria-label": "Position"}),
      h("input", {"data-a": "phone", maxlength: "40", placeholder: "Phone", value: p.phone || "", "aria-label": "Phone"}),
      h("input", {"data-a": "email", maxlength: "160", placeholder: "Email", value: p.email || "", "aria-label": "Email"})]);
    var rm = h("button", {class: "btn ghost small", type: "button", text: "Remove", "aria-label": "Remove this person"});
    rm.addEventListener("click", function(){ row.remove(); dirty(); });
    row.appendChild(rm);
    row.querySelectorAll("input").forEach(function(i){ i.addEventListener("input", dirty); });
    return row;
  }
  function dirty(){ $("profSave").disabled = false; }
  function renderProfile(){
    var p = state.data.profile || {};
    document.querySelectorAll("#profForm [data-f]").forEach(function(i){
      var k = i.getAttribute("data-f"), v = p[k];
      i.value = v === true ? "true" : v === false ? "false" : v == null ? "" : v;
    });
    put("authList", h("div", null, (p.authorized || []).map(authRow)));
    $("profSave").disabled = true;
    $("profSub").textContent = p.updated_at ? "Last changed " + new Date(p.updated_at).toLocaleString("en-PH", {timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"})
      + (p.updated_by_name ? " by " + p.updated_by_name : "") + "." : "";
    showLogo(p.logo_path);
  }
  function showLogo(path){
    if(!path){ put("logoBox", h("span", {class: "muted", text: "No logo yet"})); return; }
    signed(path, 3600).then(function(u){ put("logoBox", h("img", {src: u, alt: "Company logo"})); })
      .catch(function(){ put("logoBox", h("span", {class: "muted", text: "Logo saved (couldn't show it just now)"})); });
  }
  function wireProfile(){
    document.querySelectorAll("#profForm [data-f]").forEach(function(i){ i.addEventListener(i.tagName === "SELECT" ? "change" : "input", dirty); });
    $("authAdd").addEventListener("click", function(){
      var list = $("authList").firstChild || $("authList").appendChild(h("div"));
      if(list.children.length >= 10){ msg("List at most 10 authorised people.", true); return; }
      var r = authRow({}); list.appendChild(r); r.querySelector("input").focus(); dirty();
    });
    $("profForm").addEventListener("submit", function(e){
      e.preventDefault();
      var p = {}, btn = $("profSave"); $("profError").textContent = "";
      document.querySelectorAll("#profForm [data-f]").forEach(function(i){ p[i.getAttribute("data-f")] = i.value; });
      p.authorized = Array.prototype.map.call(document.querySelectorAll("#authList .co-auth-row"), function(r){
        var o = {}; r.querySelectorAll("[data-a]").forEach(function(i){ o[i.getAttribute("data-a")] = i.value; }); return o;
      });
      busy(btn, true);
      rpc("company_profile_save", {p: p}).then(function(){ busy(btn, false); btn.disabled = true; msg("Company details saved."); return load(); })
        .catch(function(err){ busy(btn, false); btn.disabled = false;
          $("profError").textContent = (/check constraint/.test(err.message) ? "Check the email (name@domain) and the website (starting https://)." : err.message) + " Nothing you entered was lost."; });
    });
    $("logoFile").addEventListener("change", function(){
      var f = $("logoFile").files[0]; if(!f) return;
      msg("Uploading the logo…");
      var saved;
      upload("logo", f, LOGO_MAX).then(function(path){ saved = path; return rpc("company_profile_save", {p: {logo_path: path}}); })
        .then(function(){ $("logoFile").value = ""; msg("Logo saved."); showLogo(saved); return load(); })
        .catch(function(e){ $("logoFile").value = ""; msg(e.message, true); });
    });
  }

  function load(){
    return rpc("company_get").then(function(d){
      var keepDirty = !$("profSave").disabled;
      state.data = d || {profile: {}, documents: []};
      renderDocs();
      if(!keepDirty) renderProfile();   // never wipe details someone is typing
    });
  }
  function start(){
    wireDocForm(); wireProfile();
    return load().then(function(){ $("gate").hidden = true; $("app").hidden = false; document.body.classList.remove("gated", "connecting"); });
  }
  function gate(title, text, signIn){
    $("gateTitle").textContent = title; $("gateText").textContent = text || "";
    $("gateLinkRow").hidden = !signIn; $("gate").hidden = false; $("app").hidden = true;
    document.body.classList.remove("connecting");
  }
  function home(){ return window.RitehomeLinks ? window.RitehomeLinks.href("all") : "tracker.html"; }
  if(window.RitehomeLinks && window.RitehomeLinks.href("company") === "/company" && /company\.html$/.test(location.pathname)){
    try { history.replaceState(history.state, "", "/company" + location.hash); } catch(e){}
  }
  $("forgetKeyBtn").addEventListener("click", function(){ client.auth.signOut().then(function(){ location.href = home(); }); });
  document.body.classList.add("gated", "connecting");
  client.auth.getSession().then(function(r){
    var session = r && r.data && r.data.session;
    if(!session){ $("gateLink").href = home(); return gate("Sign in first", "Sign in on the staff portal, then open Company profile from the menu.", true); }
    if(session.user && session.user.user_metadata && session.user.user_metadata.must_change_password){ $("gateLink").href = home(); return gate("Choose your password first", "Your account still has the temporary password. Open the portal's front page to choose your own.", true); }
    return client.rpc("my_roles").then(function(r2){
      var roles = (r2 && r2.data) || [];
      if(window.RitehomeAccess) window.RitehomeAccess.apply(roles, client);
      if(roles.indexOf("admin") < 0 && roles.indexOf("bookkeeper") < 0) return gate("The company profile is for the admin and the bookkeeper", roles.length ? "Your account can use the Schedule and Attendance." : "This account hasn't been activated yet.");
      return start();
    });
  }).catch(function(e){ gate("Couldn't open the company profile", e && e.message ? e.message : String(e)); });
})();
