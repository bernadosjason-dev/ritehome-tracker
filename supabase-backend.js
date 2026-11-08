/* Supabase backend for tracker.html: every action of backend/Code.gs, with the same
   request fields, reply shapes and error codes, so the page's caching and screens
   don't change. tests/supabase-backend.test.cjs runs the same requests through this
   file and through Code.gs and compares the replies.

   Storage: the tracker_docs table (one row per document, see
   supabase/migrations/20261105000001_portal_core.sql) and the "receipts" bucket.
   Row-level security makes all of it admin-only; nothing here is a security check.
   Apps Script serialised writes with a script lock. Here a document's `revision`
   is the lock: every read-modify-write updates only the revision it read, and
   retries on a fresh copy if someone else saved in between. */
(function(root){
  'use strict';

  var RECEIPT_TYPES = {'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'};
  var MAX_RECEIPT_BYTES = 15 * 1024 * 1024;
  var RETRIES = 4;

  function codeError(code, message){ var e = new Error(message); e.code = code; return e; }
  function clone(v){ return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function objectOrThrow(v){
    if(!v || typeof v !== 'object' || Array.isArray(v)) throw codeError('invalid_argument', 'Expected an object.');
    return v;
  }
  function stripId(data){ var out = {}; Object.keys(data).forEach(function(k){ if(k !== 'id') out[k] = data[k]; }); return clone(out); }
  function withId(id, data){ var out = {id: id}; Object.keys(data || {}).forEach(function(k){ if(k !== 'id') out[k] = data[k]; }); return out; }
  function deepMerge(target, patch){
    var out = clone(target || {});
    Object.keys(patch).forEach(function(k){
      var v = patch[k];
      if(v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = deepMerge(out[k], v);
      else out[k] = v === undefined ? null : clone(v);
    });
    return out;
  }
  function hex(n){
    var bytes = new Uint8Array(n);
    root.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function(b){ return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function newId(prefix){ return prefix + '_' + hex(8); }
  function nowIso(){ return new Date().toISOString(); }
  function byteLength(file){ return file == null ? 0 : typeof file.size === 'number' ? file.size : file.length || 0; }
  // The page sends photos as base64 in `data`, exactly as it does to Code.gs; a caller may pass a Blob as `file` instead.
  function photoOf(req){
    if(req.file != null) return req.file;
    var bin = root.atob(String(req.data || ''));
    var bytes = new Uint8Array(bin.length);
    for(var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function makeActions(store, logic, opts){
    opts = opts || {};
    if(!logic) throw Error('ProcurementLogic (procurement.js) must load before the Supabase backend.');

    // Read-modify-write one document, retrying on a fresh copy when another save got there first.
    function mutate(collection, id, change, missing){
      function attempt(n){
        return store.get(collection, id).then(function(row){
          if(!row) throw missing;
          var next = change(row);
          return store.update(collection, id, next, row.revision).then(function(saved){
            if(saved) return saved;
            if(n >= RETRIES) throw codeError('conflict', 'Someone else is saving this record right now — try again.');
            return attempt(n + 1);
          });
        });
      }
      return attempt(1);
    }

    // ---------- projects and expenses ----------

    function expensesOf(projectId){
      return store.list('expenses', projectId).then(function(rows){
        var list = rows.map(function(r){ return withId(r.id, r.data); });
        list.sort(function(a, b){ return String(b.date || '').localeCompare(String(a.date || '')); });
        return list;
      });
    }
    function requireProject(projectId){
      return store.get('projects', projectId).then(function(row){
        if(!row) throw codeError('not_found', 'That project no longer exists.');
        return row;
      });
    }
    function trashReceipt(id){
      if(!id || String(id).indexOf('sb_') !== 0) return Promise.resolve();   // a Google Drive receipt from before the move
      return store.removeFile(String(id)).catch(function(){});
    }

    function saveReceiptFile(req){
      var type = String(req.mimeType || '');
      if(!RECEIPT_TYPES[type]) return Promise.reject(codeError('unsupported_type', 'Receipts must be JPG, PNG, WebP or GIF photos.'));
      var file;
      try { file = photoOf(req); } catch(err){ return Promise.reject(codeError('invalid_argument', 'The photo could not be read.')); }
      var size = byteLength(file);
      if(!size) return Promise.reject(codeError('invalid_argument', 'The photo is empty.'));
      if(size > MAX_RECEIPT_BYTES) return Promise.reject(codeError('too_large', 'The photo is too large.'));
      var id = 'sb_' + hex(16);
      return store.putFile(id, file, type).then(function(){ return id; });
    }

    var actions = {
      ping: function(){ return {}; },

      listProjects: function(){
        return store.list('projects').then(function(rows){
          var projects = rows.map(function(r){ return withId(r.id, r.data); });
          projects.sort(function(a, b){ return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
          return {projects: projects};
        });
      },

      getProject: function(req){
        var id = String(req.id || '');
        return Promise.all([store.get('projects', id), expensesOf(id)]).then(function(r){
          return {project: r[0] ? withId(id, r[0].data) : null, expenses: r[1]};
        });
      },

      addProject: function(req){
        var data = stripId(objectOrThrow(req.data));
        var id = newId('p');
        return store.insert('projects', id, data, null).then(function(){ return {id: id}; });
      },

      updateProject: function(req){
        var id = String(req.id || '');
        // Existence is checked before the patch, the same order as Code.gs.
        return mutate('projects', id, function(row){ return stripId(deepMerge(row.data, objectOrThrow(req.patch))); },
          codeError('not_found', 'That project no longer exists.')).then(function(){ return {}; });
      },

      deleteProject: function(req){
        var id = String(req.id || '');
        return store.list('expenses', id).then(function(rows){
          return store.removeChildren('expenses', id).then(function(){
            return store.remove('projects', id);
          }).then(function(){
            return Promise.all(rows.map(function(r){ return trashReceipt(r.data.receipt); }));
          });
        }).then(function(){ return {}; });
      },

      importProject: function(req){
        var data = stripId(objectOrThrow(req.data));
        var expenses = Array.isArray(req.expenses) ? req.expenses : [];
        expenses.forEach(objectOrThrow);
        var dupCheck = data.importedFrom
          ? store.list('projects').then(function(rows){ return rows.filter(function(r){ return r.data.importedFrom === data.importedFrom; })[0]; })
          : Promise.resolve(null);
        return dupCheck.then(function(dup){
          if(dup) return {id: dup.id, skipped: true};
          var id = newId('p');
          return store.insert('projects', id, data, null).then(function(){
            return store.insertMany(expenses.map(function(e){ return {collection: 'expenses', id: newId('e'), parent: id, data: stripId(e)}; }));
          }).then(function(){ return {id: id, expenses: expenses.length}; });
        });
      },

      addExpense: function(req){
        var projectId = String(req.projectId || '');
        var data = stripId(objectOrThrow(req.data));
        return requireProject(projectId).then(function(){
          var id = newId('e');
          return store.insert('expenses', id, data, projectId).then(function(){ return {id: id}; });
        });
      },

      updateExpense: function(req){
        var id = String(req.id || '');
        // Existence is checked before the patch, the same order as Code.gs.
        return mutate('expenses', id, function(row){ return stripId(deepMerge(row.data, objectOrThrow(req.patch))); },
          codeError('not_found', 'That expense no longer exists.')).then(function(){ return {}; });
      },

      deleteExpense: function(req){
        return store.remove('expenses', String(req.id || '')).then(function(){ return {}; });
      },

      uploadReceipt: function(req){
        return saveReceiptFile(req).then(function(id){ return {id: id}; });
      },

      // Keeps the photo even when reading it fails, like Code.gs, so the person can type the details.
      scanReceipt: function(req){
        return saveReceiptFile(req).then(function(id){
          var out = {id: id, fields: null};
          if(!opts.readReceipt){
            out.aiError = 'ai_not_configured';
            out.aiMessage = 'Receipt reading is not switched on for the Supabase tracker yet.';
            return out;
          }
          return Promise.resolve().then(function(){ return opts.readReceipt(String(req.data || ''), String(req.mimeType || '')); }).then(function(fields){
            out.fields = fields;
            return out;
          }, function(err){
            out.aiError = (err && err.code) || 'ai_failed';
            out.aiMessage = String((err && err.message) || err).slice(0, 300);
            return out;
          });
        });
      },

      deleteReceipt: function(req){
        return trashReceipt(String(req.id || '')).then(function(){ return {}; });
      },

      // ---------- company vehicles and fuel ----------

      listVehicles: function(){
        return store.list('companyVehicles').then(function(rows){ return {vehicles: rows.map(function(r){ return withId(r.id, r.data); })}; });
      },

      saveVehicle: function(req){
        var id = String(req.id || ''), d = objectOrThrow(req.data);
        if(!/^vehicle-[A-Za-z0-9-]{10,80}$/.test(id)) throw codeError('invalid_argument', 'A valid vehicle ID is required.');
        var name = String(d.name == null ? '' : d.name).trim(), plate = String(d.plate == null ? '' : d.plate).trim();
        if(!name || name.length > 100 || plate.length > 50) throw codeError('invalid_argument', 'Enter a vehicle name up to 100 characters and a plate up to 50 characters.');
        if(d.fuelType !== 'gasoline' && d.fuelType !== 'diesel') throw codeError('invalid_argument', 'Choose gasoline or diesel.');
        return store.list('companyVehicles').then(function(rows){
          var existing = rows.filter(function(r){ return r.id === id; })[0];
          if(req.create === true && existing){
            if(existing.data.name !== name || existing.data.fuelType !== d.fuelType || existing.data.plate !== plate) throw codeError('already_exists', 'This vehicle was already saved. Refresh, then edit the saved vehicle.');
            return {id: id};
          }
          if(req.create !== true && !existing) throw codeError('not_found', 'This vehicle no longer exists.');
          var duplicate = rows.some(function(r){ return r.id !== id && String(r.data.name || '').toLowerCase() === name.toLowerCase(); });
          if(duplicate) throw codeError('invalid_argument', 'That vehicle name already exists. Edit it, or use a distinct name or plate number.');
          var data = {name: name, fuelType: d.fuelType, plate: plate, updatedAt: nowIso()};
          var write = existing
            ? store.update('companyVehicles', id, data, existing.revision).then(function(saved){ if(!saved) throw codeError('conflict', 'Someone else is saving this vehicle right now — try again.'); })
            : store.insert('companyVehicles', id, data, null);
          return write.then(function(){ return {id: id}; });
        });
      },

      checkFuelReceiptStorage: function(){
        // Same destination and permissions as a real upload, then remove only this probe.
        var probe = 'sb_fuelphoto-check-' + hex(16);
        var png = photoOf({data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWOQAAAAASUVORK5CYII='});
        return store.putFile(probe, png, 'image/png').then(function(){
          return store.removeFile(probe).catch(function(){
            throw codeError('receipt_storage_unavailable', 'The receipt test photo uploaded, but cleanup failed. Ask the tracker admin to check the receipts storage permissions.');
          });
        }, function(err){
          throw codeError('receipt_storage_unavailable', 'Receipt upload failed in Supabase storage: ' + ((err && err.message) || 'unknown error') + '.');
        }).then(function(){ return {message: 'Receipt storage check passed: photo upload, sharing and cleanup work.'}; });
      },

      uploadFuelReceipt: function(req){
        var uploadId = String(req.uploadId || ''), type = String(req.mimeType || '');
        if(!/^fuelphoto-[A-Za-z0-9-]{10,80}$/.test(uploadId)) throw codeError('invalid_argument', 'A valid fuel photo upload ID is required.');
        if(!RECEIPT_TYPES[type]) throw codeError('unsupported_type', 'Use a JPG, PNG, WebP or GIF receipt photo.');
        var file;
        try { file = photoOf(req); } catch(err){ throw codeError('invalid_argument', 'The photo could not be read.'); }
        var size = byteLength(file);
        if(!size) throw codeError('invalid_argument', 'The photo is empty.');
        if(size > MAX_RECEIPT_BYTES) throw codeError('too_large', 'The photo is too large.');
        var id = 'sb_' + uploadId;   // the upload id names the file, so a retried upload finds the first copy
        return store.putFile(id, file, type).then(function(){ return {id: id}; }, function(err){
          if(err && err.code === 'already_exists') return {id: id};
          throw codeError('receipt_storage_unavailable', 'Receipt upload failed in Supabase storage. Ask the tracker admin to check the receipts storage, then try again.');
        });
      },

      listFuel: function(){
        return store.list('companyFuel').then(function(rows){ return {entries: rows.map(function(r){ return withId(r.id, r.data); })}; });
      },

      saveFuel: function(req){
        var id = String(req.id || '');
        if(!/^fuel-[A-Za-z0-9-]{10,80}$/.test(id)) throw codeError('invalid_argument', 'A valid fuel entry ID is required.');
        var input = objectOrThrow(req.data);
        return store.get('companyFuel', id).then(function(existing){
          var receiptFields = {};
          ['receipt', 'noReceipt', 'adminConfirmed', 'adminName'].forEach(function(k){ if(existing) receiptFields[k] = existing.data[k]; });
          var data = fuelData(Object.assign(receiptFields, input));
          // A repeated create after a lost response returns the original record, without duplicates.
          if(req.create === true && existing){
            var same = Object.keys(data).filter(function(k){ return k !== 'updatedAt'; }).every(function(k){
              return data[k] === existing.data[k] || (existing.data[k] == null && (data[k] === false || data[k] === '' || data[k] === null));
            });
            if(!same) throw codeError('already_exists', 'This purchase was already saved with different details. Refresh the ledger, then edit the saved purchase.');
            return {id: id};
          }
          if(req.create !== true && !existing) throw codeError('not_found', 'This fuel purchase no longer exists.');
          data.adminConfirmedAt = data.adminConfirmed ? (existing && existing.data.adminConfirmed && existing.data.adminName === data.adminName ? existing.data.adminConfirmedAt || data.updatedAt : data.updatedAt) : null;
          var write = existing
            ? store.update('companyFuel', id, data, existing.revision).then(function(saved){ if(!saved) throw codeError('conflict', 'Someone else is saving this purchase right now — try again.'); })
            : store.insert('companyFuel', id, data, null).catch(function(err){
                if(err && err.code === 'already_exists') return actions.saveFuel(req);   // two tabs created it at once: settle as a retry
                throw err;
              });
          return write.then(function(){ return {id: id}; });
        });
      },

      deleteFuel: function(req){
        return store.remove('companyFuel', String(req.id || '')).then(function(){ return {}; });
      },

      // ---------- procurement ----------

      getProcurement: function(req){
        return procurementRecord(String(req.projectId || '')).then(function(record){
          return {revision: record.revision, data: record.data};
        });
      },

      saveProcurement: function(req){
        var projectId = String(req.projectId || '');
        return procurementRecord(projectId).then(function(record){
          var mutationId = String(req.mutationId || '');
          if(!/^pr-[A-Za-z0-9_-]{10,80}$/.test(mutationId)) throw codeError('invalid_argument', 'A valid procurement change ID is required.');
          var data;
          try { data = logic.normalize(req.data); }
          catch(err){ throw codeError('invalid_argument', err.message); }
          if(record.mutationId === mutationId){
            if(JSON.stringify(record.data) !== JSON.stringify(data)) throw codeError('invalid_argument', 'This change ID was already used for different data.');
            return {revision: record.revision, data: record.data};
          }
          if(!Number.isInteger(req.revision) || req.revision !== record.revision) throw codeError('conflict', 'Procurement was changed by another officer. Refresh before saving.');
          var oldItems = {}, newItems = {};
          record.data.boms.forEach(function(b){ b.items.forEach(function(i){ oldItems[i.id] = i; }); });
          data.boms.forEach(function(b){ b.items.forEach(function(i){ newItems[i.id] = i; }); });
          record.data.orders.forEach(function(oldPO){
            var nextPO = data.orders.filter(function(o){ return o.id === oldPO.id; })[0];
            oldPO.lines.forEach(function(line){
              if(newItems[line.itemId] && oldItems[line.itemId] && ['material', 'spec', 'unit'].some(function(k){ return oldItems[line.itemId][k] !== newItems[line.itemId][k]; })) throw codeError('invalid_argument', 'A material already used in a PO cannot change its name, specification or unit. Add a new BOM line for changed materials.');
              if(line.received > 0 && (!nextPO || nextPO.status !== 'confirmed' || !nextPO.lines.some(function(l){ return l.itemId === line.itemId; }))) throw codeError('invalid_argument', 'A PO with recorded deliveries cannot be removed or cancelled. Preserve delivered material rows.');
            });
          });
          if(JSON.stringify(data).length > 180000) throw codeError('resource_exhausted', "This project's procurement record is too large. Ask the admin to archive older procurement before adding more.");
          var doc = {mutationId: mutationId, data: data};
          var write = record.exists
            ? store.update('procurement', projectId, doc, record.revision)
            : store.insert('procurement', projectId, doc, null).catch(function(err){ if(err && err.code === 'already_exists') return null; throw err; });
          return write.then(function(saved){
            if(!saved) throw codeError('conflict', 'Procurement was changed by another officer. Refresh before saving.');
            return {revision: record.revision + 1, data: data};
          });
        });
      },

      listProcurementJobs: function(){
        return store.list('procurementJobs').then(function(rows){
          var jobs = rows.map(function(r){ return withId(r.id, r.data); });
          jobs.sort(function(a, b){ return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
          return {jobs: jobs};
        });
      },

      getProcurementJob: function(req){
        var id = String(req.id || '');
        if(!/^pj-[A-Za-z0-9-]{10,80}$/.test(id)) throw codeError('invalid_argument', 'Choose an independent procurement job.');
        return store.get('procurementJobs', id).then(function(row){
          return {project: row ? withId(id, row.data) : null, expenses: []};
        });
      },

      saveProcurementJob: function(req){
        var id = String(req.id || '');
        if(!/^pj-[A-Za-z0-9-]{10,80}$/.test(id)) throw codeError('invalid_argument', 'A valid procurement job ID is required.');
        var patch = objectOrThrow(req.data);
        return store.get('procurementJobs', id).then(function(existing){
          var input = Object.assign({}, existing ? existing.data : {}, patch);
          var name = String(input.name || '').trim(), client = String(input.clientName || '').trim(), status = input.status || 'active';
          if(!name || name.length > 100 || client.length > 150 || ['active', 'completed'].indexOf(status) < 0) throw codeError('invalid_argument', 'Enter a job name, valid client/site and Open or Closed status.');
          if(req.create === true && existing){
            if(existing.data.name !== name || existing.data.clientName !== client || existing.data.status !== status) throw codeError('already_exists', 'This job was already created. Open it from the job list to edit its details.');
            return {id: id};
          }
          if(req.create !== true && !existing) throw codeError('not_found', 'That procurement job no longer exists.');
          var data = {name: name, clientName: client, status: status, createdAt: existing ? existing.data.createdAt : nowIso(), updatedAt: nowIso()};
          var write = existing
            ? store.update('procurementJobs', id, data, existing.revision).then(function(saved){ if(!saved) throw codeError('conflict', 'Someone else is saving this job right now — try again.'); })
            : store.insert('procurementJobs', id, data, null);
          return write.then(function(){ return {id: id}; });
        });
      }
    };

    function procurementRecord(projectId){
      var owner = /^pj-/.test(projectId)
        ? store.get('procurementJobs', projectId).then(function(r){ if(!r) throw codeError('not_found', 'That procurement job no longer exists.'); })
        : store.get('projects', projectId).then(function(r){ if(!r) throw codeError('not_found', 'That project no longer exists.'); });
      return owner.then(function(){ return store.get('procurement', projectId); }).then(function(row){
        if(!row) return {exists: false, revision: 0, mutationId: '', data: {boms: [], orders: []}};
        try {
          return {exists: true, revision: row.revision, mutationId: String(row.data.mutationId || ''), data: logic.normalize(row.data.data)};
        } catch(err){
          throw codeError('data_loss', "Procurement records could not be read. Ask the admin to restore this project's procurement data before editing.");
        }
      });
    }

    // Same rules as Code.gs fuelData_.
    function fuelData(value){
      var d = objectOrThrow(value);
      var date = String(d.date || '');
      var parsed = new Date(date + 'T00:00:00Z');
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw codeError('invalid_argument', 'A valid fuel date is required.');
      function textValue(name, max){
        var v = String(d[name] == null ? '' : d[name]).trim();
        if(v.length > max) throw codeError('invalid_argument', 'Fuel ' + name + ' is too long.');
        return v;
      }
      if(d.fuelType !== 'gasoline' && d.fuelType !== 'diesel') throw codeError('invalid_argument', 'Choose gasoline or diesel.');
      if(typeof d.liters !== 'number' || !isFinite(d.liters) || d.liters <= 0 || typeof d.amount !== 'number' || !isFinite(d.amount) || d.amount <= 0) throw codeError('invalid_argument', 'Liters and cost must be positive numbers.');
      var odometer = d.odometer == null ? null : d.odometer;
      if(odometer !== null && (typeof odometer !== 'number' || !isFinite(odometer) || odometer < 0)) throw codeError('invalid_argument', 'Odometer must be a nonnegative number.');
      var vehicle = textValue('vehicle', 100);
      if(!vehicle) throw codeError('invalid_argument', 'A vehicle or equipment name is required.');
      var receipt = d.receipt == null || d.receipt === '' ? null : String(d.receipt);
      if(receipt && !/^[A-Za-z0-9_-]{1,200}$/.test(receipt)) throw codeError('invalid_argument', 'A valid receipt photo ID is required.');
      var noReceipt = d.noReceipt === true, adminConfirmed = d.adminConfirmed === true;
      if(receipt && noReceipt) throw codeError('invalid_argument', 'A purchase cannot have a receipt photo and be marked no receipt.');
      if(adminConfirmed && (!noReceipt || receipt)) throw codeError('invalid_argument', 'Admin confirmation is only for purchases without a receipt photo.');
      var adminName = adminConfirmed ? textValue('adminName', 100) : '';
      if(adminConfirmed && !adminName) throw codeError('invalid_argument', 'Enter the admin who confirmed this purchase.');
      return {receipt: receipt, noReceipt: noReceipt, adminConfirmed: adminConfirmed, adminName: adminName, date: date, vehicle: vehicle, fuelType: d.fuelType, liters: d.liters, amount: d.amount, driver: textValue('driver', 100), odometer: odometer, vendor: textValue('vendor', 150), notes: textValue('notes', 500), updatedAt: nowIso()};
    }

    // Same envelope as Code.gs doPost: {ok:true, ...} or {ok:false, code, error}.
    return function call(action, req){
      req = req || {};
      if(!Object.prototype.hasOwnProperty.call(actions, action)) return Promise.resolve({ok: false, code: 'invalid_argument', error: 'Unknown action.'});
      return Promise.resolve().then(function(){ return actions[action](req); }).then(function(res){
        return Object.assign({ok: true}, res);
      }, function(err){
        return {ok: false, code: (err && err.code) || 'unavailable', error: String((err && err.message) || err)};
      });
    };
  }

  // ---------- stores ----------

  // In-memory store with the same semantics as tracker_docs (insertion order, revision counter,
  // duplicate-key errors). Used by the tests.
  function makeMemoryStore(){
    var rows = [], files = {};
    function find(c, id){ for(var i = 0; i < rows.length; i++) if(rows[i].collection === c && rows[i].id === id) return i; return -1; }
    function out(r){ return {id: r.id, parent_id: r.parent_id, data: clone(r.data), revision: r.revision}; }
    return {
      rows: rows, files: files,
      list: function(c, parent){ return Promise.resolve(rows.filter(function(r){ return r.collection === c && (parent === undefined || r.parent_id === parent); }).map(out)); },
      get: function(c, id){ var i = find(c, id); return Promise.resolve(i < 0 ? null : out(rows[i])); },
      insert: function(c, id, data, parent){
        if(find(c, id) >= 0) return Promise.reject(codeError('already_exists', 'That record already exists.'));
        var r = {collection: c, id: id, parent_id: parent == null ? null : parent, data: clone(data), revision: 1};
        rows.push(r); return Promise.resolve(out(r));
      },
      insertMany: function(list){
        var self = this;
        return list.reduce(function(p, r){ return p.then(function(){ return self.insert(r.collection, r.id, r.data, r.parent); }); }, Promise.resolve());
      },
      update: function(c, id, data, expectedRevision){
        var i = find(c, id);
        if(i < 0 || (expectedRevision != null && rows[i].revision !== expectedRevision)) return Promise.resolve(null);
        rows[i].data = clone(data); rows[i].revision += 1;
        return Promise.resolve(out(rows[i]));
      },
      remove: function(c, id){ var i = find(c, id); if(i >= 0) rows.splice(i, 1); return Promise.resolve(); },
      removeChildren: function(c, parent){ for(var i = rows.length - 1; i >= 0; i--) if(rows[i].collection === c && rows[i].parent_id === parent) rows.splice(i, 1); return Promise.resolve(); },
      putFile: function(path, file, type){
        if(files[path]) return Promise.reject(codeError('already_exists', 'That file already exists.'));
        files[path] = {file: file, type: type}; return Promise.resolve();
      },
      removeFile: function(path){ delete files[path]; return Promise.resolve(); }
    };
  }

  // The live store: supabase-js client against tracker_docs and the receipts bucket.
  function makeSupabaseStore(client, bucket){
    var T = 'tracker_docs', COLS = 'id,parent_id,data,revision', PAGE = 1000;
    bucket = bucket || 'receipts';
    function fail(error){
      var status = Number(error && error.status), storageStatus = Number(error && error.statusCode);
      var code = (error && error.code) || '';
      if(code === '23505' || status === 409 || storageStatus === 409 || /already exists|duplicate/i.test((error && error.message) || '')) return codeError('already_exists', 'That record already exists.');
      if(code === 'PGRST301' || code === 'PGRST303' || status === 401) return codeError('session_expired', 'Your sign-in expired. Sign in again.');
      if(code === '42501' || status === 403) return codeError('permission_denied', 'This account isn’t allowed to change tracker data.');
      return codeError('unavailable', (error && error.message) || 'The tracker database could not be reached.');
    }
    function check(res){ if(res.error) throw fail(res.error); return res.data; }
    return {
      list: function(c, parent){
        var all = [];
        function page(from){
          var q = client.from(T).select(COLS).eq('collection', c);
          if(parent !== undefined) q = q.eq('parent_id', parent);
          return q.order('seq', {ascending: true}).range(from, from + PAGE - 1).then(check).then(function(rows){
            all = all.concat(rows);
            return rows.length < PAGE ? all : page(from + PAGE);
          });
        }
        return page(0);
      },
      get: function(c, id){ return client.from(T).select(COLS).eq('collection', c).eq('id', id).maybeSingle().then(check); },
      insert: function(c, id, data, parent){
        return client.from(T).insert({collection: c, id: id, parent_id: parent == null ? null : parent, data: data}).select(COLS).single().then(check);
      },
      insertMany: function(list){
        if(!list.length) return Promise.resolve();
        return client.from(T).insert(list.map(function(r){ return {collection: r.collection, id: r.id, parent_id: r.parent == null ? null : r.parent, data: r.data}; })).then(check);
      },
      // Writes only if the stored revision is still the one that was read; null otherwise.
      update: function(c, id, data, expectedRevision){
        var q = client.from(T).update({data: data}).eq('collection', c).eq('id', id);
        if(expectedRevision != null) q = q.eq('revision', expectedRevision);
        return q.select(COLS).then(check).then(function(rows){ return rows && rows.length ? rows[0] : null; });
      },
      remove: function(c, id){ return client.from(T).delete().eq('collection', c).eq('id', id).then(check); },
      removeChildren: function(c, parent){ return client.from(T).delete().eq('collection', c).eq('parent_id', parent).then(check); },
      putFile: function(path, file, type){
        return client.storage.from(bucket).upload(path, file, {contentType: type, upsert: false, cacheControl: '31536000'}).then(check);
      },
      removeFile: function(path){ return client.storage.from(bucket).remove([path]).then(check); }
    };
  }

  root.RitehomeSupabaseBackend = {makeActions: makeActions, makeMemoryStore: makeMemoryStore, makeSupabaseStore: makeSupabaseStore, deepMerge: deepMerge};
})(typeof globalThis !== 'undefined' ? globalThis : this);
