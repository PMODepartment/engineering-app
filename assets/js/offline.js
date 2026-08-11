// ============================================================================
// Planners Dashboard — Offline write queue + read cache (PDSync)
// ----------------------------------------------------------------------------
// Phase 2 of the collaboration work: edit with no connection, sync on reconnect.
// A shared layer (like PDCollab) so every module opts in the same way.
//
// MODEL — a register/schedule is a grid of discrete cells, so the conflict rule
// is FIELD-LEVEL LAST-WRITE-WINS: each queued op carries only the fields that
// changed, so replaying it sets just those fields. Two people (or your offline
// self + someone online) touching DIFFERENT fields of the same row both survive;
// only a genuine same-field clash resolves to whoever syncs last. No CRDT/OT.
//
// SAFETY — online behaviour is byte-identical to before: with a live connection
// and an empty queue, write() does the SAME direct Supabase op it always did. It
// only diverges to the IndexedDB queue when offline, when a write fails on the
// network, or when a backlog already exists (so ordering is preserved).
//
// Optimistic apply stays the CALLER's job (the modules already mutate their local
// row before writing) — PDSync only owns persistence, queueing and replay.
//
// No migration: this is entirely client-side.
// ============================================================================
(function () {
  'use strict';

  var DB = 'pd_sync', VER = 1, OUT = 'outbox', CACHE = 'cache';
  var _db = null, _ready = null, _pending = 0, _flushing = false, _flushTimer = null;
  var _listeners = [];

  function sbc() { return (window.AppAuth && AppAuth.getSB && AppAuth.getSB()) || window.__sb || null; }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // ---- IndexedDB plumbing ----------------------------------------------------
  function openDB() {
    if (_ready) return _ready;
    _ready = new Promise(function (res) {
      try {
        var rq = indexedDB.open(DB, VER);
        rq.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains(OUT)) db.createObjectStore(OUT, { keyPath: 'seq', autoIncrement: true });
          if (!db.objectStoreNames.contains(CACHE)) db.createObjectStore(CACHE, { keyPath: 'key' });
        };
        rq.onsuccess = function (e) { _db = e.target.result; _count().then(function (n) { _pending = n; emit(); res(_db); }); };
        rq.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
    return _ready;
  }
  function store(name, mode) { return _db.transaction(name, mode).objectStore(name); }
  function _count() { return new Promise(function (res) { if (!_db) return res(0); var r = store(OUT, 'readonly').count(); r.onsuccess = function () { res(r.result); }; r.onerror = function () { res(0); }; }); }
  function _all() { return new Promise(function (res) { if (!_db) return res([]); var out = [], r = store(OUT, 'readonly').openCursor(); r.onsuccess = function (e) { var c = e.target.result; if (c) { out.push(c.value); c.continue(); } else res(out); }; r.onerror = function () { res(out); }; }); }
  function _put(job) { return new Promise(function (res) { var r = store(OUT, 'readwrite').add(job); r.onsuccess = function () { _pending++; emit(); res(r.result); }; r.onerror = function () { res(null); }; }); }
  function _del(seqs) {
    return new Promise(function (res) {
      if (!_db || !seqs.length) return res();
      var s = store(OUT, 'readwrite'), left = seqs.length;
      function done() { if (--left <= 0) _count().then(function (n) { _pending = n; emit(); res(); }); }
      seqs.forEach(function (sq) { var r = s.delete(sq); r.onsuccess = done; r.onerror = done; });
    });
  }

  // ---- read cache (so a module can open + render OFFLINE) --------------------
  function cachePut(key, rows) {
    return openDB().then(function () { return new Promise(function (res) {
      if (!_db) return res();
      try { var r = store(CACHE, 'readwrite').put({ key: key, rows: rows, ts: Date.now() }); r.onsuccess = function () { res(); }; r.onerror = function () { res(); }; }
      catch (e) { res(); }
    }); });
  }
  function cacheGet(key) {
    return openDB().then(function () { return new Promise(function (res) {
      if (!_db) return res(null);
      try { var r = store(CACHE, 'readonly').get(key); r.onsuccess = function () { res(r.result || null); }; r.onerror = function () { res(null); }; }
      catch (e) { res(null); }
    }); });
  }

  // ---- status listeners ------------------------------------------------------
  function state() { return { online: navigator.onLine, pending: _pending, flushing: _flushing }; }
  function emit() { var st = state(); _listeners.forEach(function (f) { try { f(st); } catch (e) {} }); }
  function onStatus(f) { _listeners.push(f); try { f(state()); } catch (e) {} return function () { var i = _listeners.indexOf(f); if (i >= 0) _listeners.splice(i, 1); }; }

  function isNet(err) {
    if (!err) return false;
    var m = (err.message || err.msg || ('' + err)).toLowerCase();
    return /fetch|network|timeout|failed to|load failed|offline|connection|dns|econn/.test(m);
  }

  // ---- the one Supabase op --------------------------------------------------
  function doOp(job) {
    var c = sbc(); if (!c) return Promise.reject(new Error('network: no client'));
    if (job.op === 'update') return c.from(job.table).update(job.patch).eq('id', job.id);
    if (job.op === 'delete') return c.from(job.table).delete().eq('id', job.id);
    if (job.op === 'insert') return c.from(job.table).insert(job.patch);
    return Promise.reject(new Error('bad op ' + job.op));
  }

  // ---- write: apply is the caller's; we persist / queue / attempt ------------
  // job = { table, op:'update'|'insert'|'delete', id, patch }
  // returns { ok, queued, id }  (id = the row id, generated for offline inserts)
  function write(job) {
    return openDB().then(function () {
      job.ts = Date.now();
      if (job.op === 'insert' && job.patch && !job.patch.id) job.patch.id = uuid();
      var rid = (job.patch && job.patch.id) || job.id;
      // Preserve order: any backlog OR being offline → queue instead of racing ahead.
      if (!navigator.onLine || _pending > 0) {
        return _put(job).then(function () { scheduleFlush(); return { ok: true, queued: true, id: rid }; });
      }
      return Promise.resolve(doOp(job)).then(function (res) {
        if (res && res.error) {
          if (isNet(res.error)) return _put(job).then(function () { scheduleFlush(); return { ok: true, queued: true, id: rid }; });
          return { ok: false, error: res.error, id: rid };   // permanent error — surface, don't queue
        }
        return { ok: true, queued: false, id: rid };
      }, function () {   // threw → treat as network, queue it
        return _put(job).then(function () { scheduleFlush(); return { ok: true, queued: true, id: rid }; });
      });
    });
  }

  // Collapse queued ops per (table,id) into one effective op (last-write-wins per
  // field), tracking every seq it replaces so they're all cleared on success.
  function coalesce(jobs) {
    var g = {}, order = [];
    jobs.forEach(function (j) {
      var rid = j.op === 'insert' ? (j.patch && j.patch.id) : j.id;
      var key = j.table + '|' + rid;
      if (!(key in g)) { g[key] = { table: j.table, id: rid, state: null, seqs: [] }; order.push(key); }
      var e = g[key]; e.seqs.push(j.seq);
      if (j.op === 'insert') e.state = { op: 'insert', patch: Object.assign({}, j.patch) };
      else if (j.op === 'update') {
        if (e.state && (e.state.op === 'insert' || e.state.op === 'update')) Object.assign(e.state.patch, j.patch);
        else e.state = { op: 'update', patch: Object.assign({}, j.patch) };
      } else if (j.op === 'delete') {
        if (e.state && e.state.op === 'insert') e.state = null;   // insert+delete offline → nothing to send
        else e.state = { op: 'delete' };
      }
    });
    return order.map(function (k) { return g[k]; });
  }

  function scheduleFlush(delay) { if (_flushTimer) return; _flushTimer = setTimeout(function () { _flushTimer = null; flush(); }, delay || 400); }

  function flush() {
    return openDB().then(function () {
      if (_flushing || !navigator.onLine || _pending === 0) return;
      _flushing = true; emit();
      return _all().then(function (jobs) {
        var groups = coalesce(jobs);
        return groups.reduce(function (p, gr) {
          return p.then(function (stop) {
            if (stop) return true;
            if (!gr.state) return _del(gr.seqs).then(function () { return false; });   // no-op group
            var job = { table: gr.table, op: gr.state.op, id: gr.id, patch: gr.state.patch };
            return Promise.resolve(doOp(job)).then(function (res) {
              if (res && res.error) {
                if (isNet(res.error)) return true;   // network — stop, retry the whole backlog later
                if (window.UI && UI.toast) UI.toast('A queued change could not sync and was dropped: ' + res.error.message, 'warn');
                return _del(gr.seqs).then(function () { return false; });   // permanent error — drop, continue
              }
              return _del(gr.seqs).then(function () { return false; });
            }, function () { return true; });   // threw — stop
          });
        }, Promise.resolve(false));
      }).then(function () { _flushing = false; emit(); if (_pending > 0 && navigator.onLine) scheduleFlush(4000); },
             function () { _flushing = false; emit(); });
    });
  }

  window.addEventListener('online', function () { emit(); scheduleFlush(300); });
  window.addEventListener('offline', function () { emit(); });

  window.PDSync = {
    write: write, flush: flush, onStatus: onStatus,
    pendingCount: function () { return _pending; }, offlineCapable: function () { return true; },
    cachePut: cachePut, cacheGet: cacheGet, uuid: uuid
  };
  openDB();
})();
