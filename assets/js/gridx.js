// ============================================================================
// GridX — the shared Excel-like grid layer (window.GridX)
// ----------------------------------------------------------------------------
// One engine, used by every register that shows a table of editable rows:
// drawing-register and material-submittal today. It exists because the two
// modules were drifting into two implementations of the same behaviour, which is
// the maintenance trap this app has hit before (three copies of one toolbar in the
// procurement app, each fixed separately).
//
// WHAT IT PROVIDES
//   • a cell cursor with rectangular ranges (click, shift-click, drag)
//   • keyboard nav: arrows, Tab, Home/End, Ctrl+Arrow jump-to-data-edge
//   • type-to-replace, F2, Enter
//   • Ctrl+C / Ctrl+V through the REAL system clipboard as TSV, so a block
//     round-trips with Excel in both directions
//   • Ctrl+D fill down, Ctrl+Z undo (batched), Del clears a range
//   • drag-to-resize columns, double-click to fit one, fit-all and reset
//
// WHAT IT DOES NOT KNOW
//   Anything about drawings, submittals, phases or status vocabularies. The host
//   supplies row identity, how a value is read, how a value becomes a patch, and
//   how a patch is persisted. That boundary is the whole point: a register-specific
//   rule (a derived counter that must not be typed into, a legacy status spelling)
//   belongs in the host's valueOf/patchFor, never in here.
//
// ⚠️ THE COORDINATE SPACE IS DATA ROWS ONLY. `opts.rowIds()` is the row axis and the
// editable `td[data-f]` cells of `opts.rowSel` are the column axis. GROUP / SECTION
// HEADER ROWS MUST STAY OUTSIDE IT — they carry no `data-f` cells, so a range can
// never select one and a paste can never land on one. If you add a decorative row,
// keep it attribute-free the same way; the moment it carries a data-f cell it
// becomes addressable and the model breaks.
// ============================================================================

(function () {
  'use strict';

  function GridXInstance(opts) {
    this.o = opts;
    this.cur = null;        // {id, f}
    this.anchor = null;     // {id, f} — the other corner
    this.undo = [];
    this.UNDO_MAX = 50;
    this.dragging = false;
    this._wired = false;
  }

  var P = GridXInstance.prototype;

  // ---- host accessors, all guarded so a partly-configured host cannot throw ----
  P.rowIds  = function (){ try { return this.o.rowIds() || []; } catch (e) { return []; } };
  P.rowOf   = function (id){ try { return this.o.rowOf(id) || null; } catch (e) { return null; } };
  P.canWrite= function (){ return this.o.canWrite ? !!this.o.canWrite() : true; };
  P.toast   = function (m, k){ if (this.o.toast) this.o.toast(m, k); };
  P.valueOf = function (row, f){
    var v = this.o.valueOf(row, f);
    return v == null ? '' : String(v);
  };

  P.grid = function (){
    return typeof this.o.grid === 'function' ? this.o.grid()
         : (typeof this.o.grid === 'string' ? document.querySelector(this.o.grid) : this.o.grid);
  };
  P.rowSel = function (){ return this.o.rowSel || 'tr[data-id]'; };
  P.editCls = function (){ return this.o.editableClass || 'gx-ed'; };

  // Columns are read off the DOM rather than declared, so they can never drift from
  // what is actually rendered.
  P.cols = function (){
    var g = this.grid(); if (!g) return [];
    var tr = g.querySelector(this.rowSel()); if (!tr) return [];
    return Array.prototype.map.call(tr.querySelectorAll('td[data-f]'), function (td){
      return { f: td.dataset.f, t: td.dataset.t || 'text' };
    });
  };
  P.colKeys = function (){ return this.cols().map(function (c){ return c.f; }); };
  P.td = function (id, f){
    var g = this.grid(); if (!g) return null;
    return g.querySelector(this.rowSel().replace('[data-id]', '') + '[data-id="' + cssEsc(id) + '"] td[data-f="' + cssEsc(f) + '"]')
        || g.querySelector('[data-id="' + cssEsc(id) + '"] td[data-f="' + cssEsc(f) + '"]');
  };
  P.editable = function (id, f){
    var td = this.td(id, f);
    return !!td && td.classList.contains(this.editCls());
  };

  // ---- selection ------------------------------------------------------------
  P.range = function (){
    if (!this.cur) return { ids: [], fs: [] };
    var ids = this.rowIds(), cols = this.colKeys();
    var a = this.anchor || this.cur;
    var r1 = ids.indexOf(a.id), r2 = ids.indexOf(this.cur.id);
    var c1 = cols.indexOf(a.f), c2 = cols.indexOf(this.cur.f);
    if (r1 < 0 || r2 < 0 || c1 < 0 || c2 < 0) return { ids: [this.cur.id], fs: [this.cur.f] };
    return { ids: ids.slice(Math.min(r1,r2), Math.max(r1,r2)+1),
             fs:  cols.slice(Math.min(c1,c2), Math.max(c1,c2)+1) };
  };
  P.paint = function (){
    var g = this.grid(); if (!g) return;
    g.querySelectorAll('td.gx-cur,td.gx-rng').forEach(function (td){ td.classList.remove('gx-cur','gx-rng'); });
    if (!this.cur) { this.info(0,0,0); return; }
    var rg = this.range(), self = this;
    rg.ids.forEach(function (id){ rg.fs.forEach(function (f){
      var td = self.td(id, f); if (td) td.classList.add('gx-rng');
    }); });
    var cd = this.td(this.cur.id, this.cur.f);
    if (cd){ cd.classList.remove('gx-rng'); cd.classList.add('gx-cur'); }
    this.info(rg.ids.length * rg.fs.length, rg.ids.length, rg.fs.length);
  };
  // An explicit readout: a highlight alone leaves the user guessing whether the block
  // they dragged is really selected.
  P.info = function (n, nr, nc){
    var el = this.o.infoEl ? document.querySelector(this.o.infoEl) : null;
    if (el) el.textContent = n > 1 ? (n + ' cells (' + nr + ' × ' + nc + ')') : '';
  };
  P.setCur = function (id, f, extend){
    if (!id || !f) return;
    this.cur = { id: id, f: f };
    if (!extend || !this.anchor) this.anchor = extend ? (this.anchor || { id:id, f:f }) : { id:id, f:f };
    this.paint();
    var td = this.td(id, f);
    if (td && td.scrollIntoView) td.scrollIntoView({ block:'nearest', inline:'nearest' });
    if (this.o.onSelectRows) this.o.onSelectRows(this.range().ids, id);
  };
  P.clear = function (){ this.cur = null; this.anchor = null; this.paint(); };
  P.active = function (){ var g = this.grid(); return !!(this.cur && g && g.querySelector('td.gx-cur')); };

  // Excel's Ctrl+Arrow: from a filled cell ride the block and stop at the last filled
  // cell before a gap; from an empty one (or when the next is empty) skip to the next
  // filled cell.
  P.jumpEdge = function (id, f, dr, dc){
    var ids = this.rowIds(), cols = this.colKeys(), self = this;
    var ri = ids.indexOf(id), ci = cols.indexOf(f);
    if (ri < 0 || ci < 0) return { id:id, f:f };
    function filled(r, c){
      var row = self.rowOf(ids[r]);
      return !!(row && self.valueOf(row, cols[c]).trim());
    }
    var lim = dr ? ids.length : cols.length;
    var pos = dr ? ri : ci, step = dr || dc;
    var next = pos + step;
    if (next < 0 || next >= lim) return { id:ids[ri], f:cols[ci] };
    var want = filled(ri, ci) && (dr ? filled(next, ci) : filled(ri, next));
    var p = pos;
    while (true) {
      var q = p + step;
      if (q < 0 || q >= lim) break;
      var fl = dr ? filled(q, ci) : filled(ri, q);
      if (want && !fl) break;
      p = q;
      if (!want && fl) break;
    }
    return dr ? { id:ids[p], f:cols[ci] } : { id:ids[ri], f:cols[p] };
  };
  P.move = function (dr, dc, extend, jump){
    var ids = this.rowIds(), cols = this.cols();
    if (!this.cur) { if (ids.length && cols.length) this.setCur(ids[0], cols[0].f, false); return; }
    var t;
    if (jump) t = this.jumpEdge(this.cur.id, this.cur.f, dr, dc);
    else {
      var keys = cols.map(function (c){ return c.f; });
      var ri = Math.max(0, Math.min(ids.length-1,  ids.indexOf(this.cur.id) + dr));
      var ci = Math.max(0, Math.min(keys.length-1, keys.indexOf(this.cur.f) + dc));
      t = { id: ids[ri], f: keys[ci] };
    }
    this.setCur(t.id, t.f, extend);
  };

  // ---- clipboard ------------------------------------------------------------
  P.tsv = function (){
    var rg = this.range(), self = this;
    return rg.ids.map(function (id){
      var row = self.rowOf(id);
      return rg.fs.map(function (f){
        // A tab or newline inside a value would silently add a column or a row on the
        // way back in, so they flatten to spaces.
        return (row ? self.valueOf(row, f) : '').replace(/[\t\r\n]+/g, ' ');
      }).join('\t');
    }).join('\n');
  };
  P.paste = async function (text){
    if (!this.cur || !this.canWrite()) return;
    var block = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map(function (l){ return l.split('\t'); });
    var ids = this.rowIds(), cols = this.cols();
    var keys = cols.map(function (c){ return c.f; }), types = {};
    cols.forEach(function (c){ types[c.f] = c.t; });
    var r0 = ids.indexOf(this.cur.id), c0 = keys.indexOf(this.cur.f);
    if (r0 < 0 || c0 < 0) return;
    var batch = [], writes = [], skipped = 0;
    for (var i = 0; i < block.length; i++) {
      var ri = r0 + i; if (ri >= ids.length) break;          // clamped, never wrapped
      for (var j = 0; j < block[i].length; j++) {
        var ci = c0 + j; if (ci >= keys.length) break;
        var id = ids[ri], f = keys[ci];
        if (!this.editable(id, f)) { skipped++; continue; }
        var row = this.rowOf(id); if (!row) continue;
        var val = String(block[i][j] == null ? '' : block[i][j]).trim();
        if (this.valueOf(row, f) === val) continue;           // no-op keeps undo clean
        batch.push({ id:id, f:f, t:types[f], prev:this.valueOf(row, f) });
        writes.push({ row:row, f:f, t:types[f], val:val });
      }
    }
    if (!writes.length){
      this.toast(skipped ? 'Nothing pasted — those cells are calculated and cannot be typed into'
                         : 'Nothing to paste', 'warn');
      return;
    }
    this.push(batch);
    await this.apply(writes);
    this.toast('Pasted ' + writes.length + ' cell' + (writes.length>1?'s':'') +
               (skipped ? ' · ' + skipped + ' skipped (calculated)' : ''), 'ok');
  };
  P.apply = async function (writes){
    for (var i = 0; i < writes.length; i++) {
      var w = writes[i];
      await this.o.persist(w.row, this.o.patchFor(w.row, w.f, w.t, w.val));
    }
    if (this.o.afterWrite) await this.o.afterWrite();
  };
  P.push = function (batch){
    if (!batch || !batch.length) return;
    this.undo.push(batch);
    if (this.undo.length > this.UNDO_MAX) this.undo.shift();
  };
  P.undoLast = async function (){
    var batch = this.undo.pop();
    if (!batch){ this.toast('Nothing to undo', 'warn'); return; }
    var writes = [], self = this;
    batch.forEach(function (b){
      var row = self.rowOf(b.id); if (!row) return;
      writes.push({ row:row, f:b.f, t:b.t, val:String(b.prev == null ? '' : b.prev) });
    });
    await this.apply(writes);
    this.toast('Undid ' + writes.length + ' cell' + (writes.length>1?'s':''), 'ok');
  };
  P.fillDown = async function (){
    var rg = this.range();
    if (rg.ids.length < 2){ this.toast('Select the cell to copy plus the rows to fill', 'warn'); return; }
    var types = {}; this.cols().forEach(function (c){ types[c.f] = c.t; });
    var src = this.rowOf(rg.ids[0]), self = this;
    var batch = [], writes = [], skipped = 0;
    rg.fs.forEach(function (f){
      var val = src ? self.valueOf(src, f) : '';
      rg.ids.slice(1).forEach(function (id){
        if (!self.editable(id, f)) { skipped++; return; }
        var row = self.rowOf(id); if (!row) return;
        if (self.valueOf(row, f) === val) return;
        batch.push({ id:id, f:f, t:types[f], prev:self.valueOf(row, f) });
        writes.push({ row:row, f:f, t:types[f], val:val });
      });
    });
    if (!writes.length){
      this.toast(skipped ? 'Those cells are calculated and cannot be filled' : 'Nothing to fill', 'warn');
      return;
    }
    this.push(batch);
    await this.apply(writes);
    this.toast('Filled ' + writes.length + ' cell' + (writes.length>1?'s':''), 'ok');
  };
  P.clearRange = async function (){
    if (!this.canWrite()) return;
    var rg = this.range(), types = {}, self = this;
    this.cols().forEach(function (c){ types[c.f] = c.t; });
    var batch = [], writes = [];
    rg.ids.forEach(function (id){ rg.fs.forEach(function (f){
      if (!self.editable(id, f)) return;
      var row = self.rowOf(id); if (!row) return;
      if (!self.valueOf(row, f)) return;
      batch.push({ id:id, f:f, t:types[f], prev:self.valueOf(row, f) });
      writes.push({ row:row, f:f, t:types[f], val:'' });
    }); });
    if (!writes.length) return;
    this.push(batch);
    await this.apply(writes);
  };

  // ---- keyboard -------------------------------------------------------------
  // Returns true when the event was consumed, so a host with its own ROW-level
  // shortcuts can keep them for when no cell cursor is active.
  P.onKey = function (e){
    if (!this.cur) return false;
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag==='input'||tag==='select'||tag==='textarea'||e.target.isContentEditable) return false;
    var mod = e.ctrlKey || e.metaKey, self = this;

    if (e.key === 'Escape'){ this.clear(); if (this.o.onEscape) this.o.onEscape(); return true; }
    if (mod && /^[aA]$/.test(e.key)){
      e.preventDefault();
      var ids = this.rowIds(), cols = this.cols();
      if (ids.length && cols.length){
        this.anchor = { id: ids[0], f: cols[0].f };
        this.cur    = { id: ids[ids.length-1], f: cols[cols.length-1].f };
        this.paint();
        if (this.o.onSelectRows) this.o.onSelectRows(ids, this.cur.id);
      }
      return true;
    }
    if (mod && /^[dD]$/.test(e.key)){ e.preventDefault(); this.fillDown(); return true; }
    if (mod && /^[zZ]$/.test(e.key)){ e.preventDefault(); this.undoLast(); return true; }
    // Ctrl+C / Ctrl+V are handled by the document copy/paste listeners so the real
    // system clipboard is used (and Excel interop works) — nothing to do here.
    if (mod && /^[cvxCVX]$/.test(e.key)) return true;

    var dirs = { ArrowUp:[-1,0], ArrowDown:[1,0], ArrowLeft:[0,-1], ArrowRight:[0,1] };
    if (dirs[e.key]){ e.preventDefault(); this.move(dirs[e.key][0], dirs[e.key][1], e.shiftKey, mod); return true; }
    if (e.key === 'Tab'){ e.preventDefault(); this.move(0, e.shiftKey?-1:1, false, false); return true; }
    if (e.key === 'Home'){
      e.preventDefault();
      var c0 = this.cols()[0];
      if (c0) this.setCur(mod ? this.rowIds()[0] : this.cur.id, c0.f, e.shiftKey);
      return true;
    }
    if (e.key === 'End'){
      e.preventDefault();
      var cl = this.cols(), idl = this.rowIds();
      if (cl.length) this.setCur(mod ? idl[idl.length-1] : this.cur.id, cl[cl.length-1].f, e.shiftKey);
      return true;
    }
    if (e.key === 'Delete' || e.key === 'Backspace'){ e.preventDefault(); this.clearRange(); return true; }
    if (e.key === 'F2'){ e.preventDefault(); this.edit(); return true; }
    if (e.key === 'Enter'){
      e.preventDefault();
      if (this.editable(this.cur.id, this.cur.f)) this.edit(); else this.move(1,0,false,false);
      return true;
    }
    // Type-to-replace, exactly like Excel: a printable key opens the editor seeded
    // with that character instead of being swallowed.
    if (!mod && !e.altKey && e.key.length === 1){
      if (this.editable(this.cur.id, this.cur.f)){ e.preventDefault(); this.edit(e.key); }
      return true;
    }
    return true;
  };
  P.edit = function (seed){
    if (!this.o.beginEdit) return;
    var td = this.td(this.cur.id, this.cur.f);
    if (td) this.o.beginEdit(td, seed);
  };

  // ---- wiring ---------------------------------------------------------------
  // Called after every host re-render: re-binds the mouse handlers on the (new) grid
  // element and re-paints the cursor so an edit does not lose the user's position.
  P.attach = function (){
    var g = this.grid(), self = this;
    if (!g) return;
    g.onmousedown = function (e){
      var td = e.target.closest && e.target.closest('td[data-f]');
      if (!td) return;
      // Leave the host's own controls (checkbox, buttons, selects) working.
      if (e.target.closest('input,select,button,a,label')) return;
      var tr = td.closest('[data-id]'); if (!tr) return;
      self.setCur(tr.dataset.id, td.dataset.f, e.shiftKey);
      if (g.focus) g.focus();
      self.dragging = true;
    };
    g.onmousemove = function (e){
      if (!self.dragging) return;
      var td = e.target.closest && e.target.closest('td[data-f]');
      if (!td) return;
      var tr = td.closest('[data-id]'); if (!tr) return;
      if (self.cur && self.cur.id === tr.dataset.id && self.cur.f === td.dataset.f) return;
      self.cur = { id: tr.dataset.id, f: td.dataset.f };
      self.paint();
    };
    if (!this._wired) {
      this._wired = true;
      document.addEventListener('mouseup', function (){ self.dragging = false; });
      document.addEventListener('copy', function (e){
        if (!self.active()) return;
        var t = (e.target.tagName||'').toLowerCase();
        if (t==='input'||t==='select'||t==='textarea') return;
        e.clipboardData.setData('text/plain', self.tsv());
        e.preventDefault();
      });
      document.addEventListener('paste', function (e){
        if (!self.active() || !self.canWrite()) return;
        var t = (e.target.tagName||'').toLowerCase();
        if (t==='input'||t==='select'||t==='textarea') return;
        var txt = e.clipboardData.getData('text/plain');
        if (!txt) return;
        e.preventDefault();
        self.paste(txt);
      });
    }
    if (this.cur) this.paint();
  };

  // ==========================================================================
  // Column widths — drag to resize, double-click a grip to fit that column,
  // plus fit-all and reset. Widths live as CSS custom properties (--<prefix><key>)
  // on a persistent host element and are stored per user+project.
  // ==========================================================================
  function Columns(opts){
    this.o = opts;
    this.w = {};
    this.loadedKey = null;
  }
  var C = Columns.prototype;
  C.host = function (){
    return typeof this.o.host === 'function' ? this.o.host()
         : (typeof this.o.host === 'string' ? document.querySelector(this.o.host) : this.o.host);
  };
  C.prefix = function (){ return this.o.varPrefix || '--c-'; };
  C.load = function (){
    var key = this.o.storageKey();
    if (this.loadedKey === key) { this.apply(); return; }
    this.loadedKey = key;
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { saved = {}; }
    var self = this; this.w = {};
    Object.keys(this.o.defaults).forEach(function (k){
      var n = parseFloat(saved[k]);
      self.w[k] = (!isNaN(n) && n > 0) ? n : self.o.defaults[k];
    });
    this.apply();
  };
  C.save = function (){ try { localStorage.setItem(this.o.storageKey(), JSON.stringify(this.w)); } catch (e) {} };
  C.apply = function (){
    var h = this.host(); if (!h) return;
    var self = this;
    Object.keys(this.w).forEach(function (k){ h.style.setProperty(self.prefix()+k, self.w[k]+'px'); });
  };
  C.min = function (k){ return (this.o.mins && this.o.mins[k]) || 40; };
  C.set = function (k, px){
    var h = this.host(); if (!h) return;
    this.w[k] = Math.max(this.min(k), Math.min(px, this.o.max || 900));
    h.style.setProperty(this.prefix()+k, this.w[k]+'px');
  };
  // The widest rendered cell in that column, which is what "fit" means.
  C.measure = function (k){
    var h = this.host(); if (!h) return 0;
    var widest = 0;
    h.querySelectorAll('td.'+this.o.cellClass(k)+', th.'+this.o.cellClass(k)).forEach(function (el){
      widest = Math.max(widest, el.scrollWidth);
    });
    return widest;
  };
  C.fit = function (k){
    var widest = this.measure(k);
    if (!widest) return;
    this.set(k, widest + (this.o.pad == null ? 16 : this.o.pad));
    this.save();
  };
  C.fitAll = function (){
    var self = this;
    Object.keys(this.o.defaults).forEach(function (k){ self.fit(k); });
  };
  C.reset = function (){
    var self = this;
    Object.keys(this.o.defaults).forEach(function (k){ self.set(k, self.o.defaults[k]); });
    this.save();
  };
  // Bind every grip in the (re-rendered) header. A grip carries data-<gripAttr>=key.
  C.wire = function (){
    var h = this.host(); if (!h) return;
    var self = this, attr = this.o.gripAttr || 'colw';
    h.querySelectorAll('['+'data-'+attr+']').forEach(function (grip){
      var key = grip.dataset[attr];
      grip.onmousedown = function (e){
        e.preventDefault(); e.stopPropagation();
        var startX = e.clientX, startW = self.w[key] || self.o.defaults[key];
        document.body.classList.add('gx-resizing');
        function mv(ev){ self.set(key, startW + (ev.clientX - startX)); }
        function up(){
          document.removeEventListener('mousemove', mv);
          document.removeEventListener('mouseup', up);
          document.body.classList.remove('gx-resizing');
          self.save();
          if (self.o.onResize) self.o.onResize();
        }
        document.addEventListener('mousemove', mv);
        document.addEventListener('mouseup', up);
      };
      grip.ondblclick = function (e){
        e.preventDefault(); e.stopPropagation();
        self.fit(key);
        if (self.o.onResize) self.o.onResize();
      };
      grip.onclick = function (e){ e.stopPropagation(); };
    });
  };

  // CSS.escape isn't universal; ids here are uuids or short codes, but a value with a
  // quote would still break the selector, so it is escaped rather than trusted.
  function cssEsc(v){
    v = String(v == null ? '' : v);
    // ⚠️ window.CSS.escape, not the bare global: testing `window.CSS` and then calling
    // `CSS.escape` is only equivalent in a browser, and diverges anywhere the global
    // binding isn't installed.
    return (window.CSS && window.CSS.escape) ? window.CSS.escape(v) : v.replace(/["\\\]]/g, '\\$&');
  }

  window.GridX = {
    create: function (opts){ return new GridXInstance(opts); },
    columns: function (opts){ return new Columns(opts); }
  };
})();
