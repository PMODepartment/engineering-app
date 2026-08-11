// ============================================================================
// Planners Dashboard — Shared live-collaboration layer (PDCollab)
// ----------------------------------------------------------------------------
// Google-Sheets / Teams-style presence + live cell editing, built on Supabase
// Realtime. Generic on purpose: every module is a shared-shell + module, so the
// transport (presence, cursor broadcast, live row changes) lives here ONCE and
// each module supplies only two small things — "serialize my current selection"
// and "apply a remote row change to my grid".
//
// A schedule/register is a grid of DISCRETE cells, not a rich-text document, so
// there is no operational-transform/CRDT merge to do: conflicting cell edits are
// last-write-wins, exactly like Sheets. That is why this file is small.
//
// Three Realtime primitives (all in supabase-js, no extra deps):
//   • Presence          — who has this project open (topbar avatars).
//   • Broadcast 'sel'    — ephemeral "I'm editing row R, field F" cursor.
//   • Postgres Changes   — another user saved → every open client patches its
//                          grid live instead of only on reload. RLS still applies.
//
// PREREQUISITE (server): Realtime must be enabled for each collaborated table —
// see migrations/2026-07-26-realtime-collab.sql. Presence/broadcast work without
// it; only the live-value stream (postgres_changes) needs it.
// ============================================================================
(function () {
  'use strict';

  var PALETTE = ['#EE3124', '#1a73e8', '#137333', '#b06000', '#8430ce',
                 '#0b8043', '#c5221f', '#e37400', '#1967d2', '#a50e0e'];

  function colorFor(id) {
    id = String(id || ''); var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  function initials(name) {
    name = String(name || '?').trim();
    var p = name.split(/\s+/);
    var s = ((p[0] && p[0][0]) || '') + ((p[1] && p[1][0]) || '');
    return (s || name.slice(0, 2)).toUpperCase();
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function sb() {
    return (window.AppAuth && AppAuth.getSB && AppAuth.getSB()) || window.__sb || null;
  }

  // --- base styles (injected once, so no per-module CSS edits are needed) -----
  var STYLE_ID = 'pd-collab-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      '.pd-collab-avatars{display:inline-flex;align-items:center;margin:0 4px}' +
      '.pd-collab-av{width:28px;height:28px;border-radius:50%;display:inline-flex;align-items:center;' +
        'justify-content:center;font-size:11px;font-weight:700;color:#fff;border:2px solid var(--pd-card,#fff);' +
        'margin-left:-6px;box-shadow:0 1px 2px rgba(0,0,0,.2);cursor:default;position:relative}' +
      '.pd-collab-av:first-child{margin-left:0}' +
      '.pd-collab-av.editing::after{content:"";position:absolute;right:-1px;bottom:-1px;width:8px;height:8px;' +
        'border-radius:50%;background:#137333;border:2px solid var(--pd-card,#fff)}' +
      '.pd-collab-av.me{outline:2px solid var(--pd-line,#ccc)}' +
      '.pd-collab-more{width:28px;height:28px;border-radius:50%;display:inline-flex;align-items:center;' +
        'justify-content:center;font-size:11px;font-weight:700;background:var(--pd-bg,#eee);' +
        'color:var(--pd-muted,#666);border:2px solid var(--pd-card,#fff);margin-left:-6px}' +
      // remote-cell markers a module can reuse via paintCell()/clearCells()
      '.pd-collab-cell{position:relative}' +
      '.pd-collab-flag{position:absolute;top:-9px;left:-1px;z-index:6;font-size:9px;line-height:1;font-weight:700;' +
        'color:#fff;padding:2px 5px;border-radius:4px 4px 4px 0;white-space:nowrap;pointer-events:none;' +
        'box-shadow:0 1px 2px rgba(0,0,0,.25)}';
    var st = document.createElement('style'); st.id = STYLE_ID; st.textContent = css;
    document.head.appendChild(st);
  }

  // --- presence avatar strip (returns HTML) -----------------------------------
  // members: [{id,name,color,sel,self}]. Optional opts.max (default 6).
  function avatarsHTML(members, opts) {
    opts = opts || {}; ensureStyle();
    if (!members || !members.length) return '';
    var max = opts.max || 6;
    var shown = members.slice(0, max), extra = members.length - shown.length;
    var html = shown.map(function (m) {
      var editing = m.sel && (m.sel.editing || m.sel.field != null);
      var title = (m.self ? m.name + ' (you)' : m.name) + (editing ? ' — editing' : '');
      return '<span class="pd-collab-av' + (editing ? ' editing' : '') + (m.self ? ' me' : '') + '"' +
        ' style="background:' + (m.color || colorFor(m.id)) + '" title="' + esc(title) + '">' +
        esc(initials(m.name)) + '</span>';
    }).join('');
    if (extra > 0) html += '<span class="pd-collab-more" title="' + extra + ' more">+' + extra + '</span>';
    return '<span class="pd-collab-avatars">' + html + '</span>';
  }

  // --- module helpers to paint / clear a remote user's active cell ------------
  // paintCell(td, {name,color}) outlines the cell + shows a name flag; returns a
  // cleanup fn. clearAll() removes every flag this layer painted under `root`.
  function paintCell(td, member) {
    if (!td) return function () {};
    ensureStyle();
    var color = member.color || colorFor(member.id);
    td.classList.add('pd-collab-cell');
    td.style.boxShadow = 'inset 0 0 0 2px ' + color;
    // Grid cells clip overflow (ellipsis / frozen columns); the name flag sits just
    // above the cell, so unclip while painted and restore the prior value on clear.
    td.setAttribute('data-pd-ov', td.style.overflow || '');
    td.style.overflow = 'visible';
    var flag = document.createElement('span');
    flag.className = 'pd-collab-flag'; flag.style.background = color;
    flag.textContent = initials(member.name); flag.title = member.name;
    flag.setAttribute('data-pd-collab', '1');
    td.appendChild(flag);
    return function () { _clearCell(td, flag); };
  }
  function _clearCell(td, flag) {
    td.style.boxShadow = ''; td.classList.remove('pd-collab-cell');
    if (td.hasAttribute('data-pd-ov')) { td.style.overflow = td.getAttribute('data-pd-ov'); td.removeAttribute('data-pd-ov'); }
    if (flag && flag.parentNode) flag.parentNode.removeChild(flag);
  }
  function clearCells(root) {
    (root || document).querySelectorAll('[data-pd-collab]').forEach(function (f) {
      _clearCell(f.parentNode || document.createElement('div'), f);
    });
  }

  // --- the channel ------------------------------------------------------------
  // opts: { key, table, projectId, self:{id,name,color},
  //         onPresence(members[]), onSelection({id,name,color,sel}),
  //         onRemoteChange(payload), onStatus('online'|'offline'|'error') }
  function join(opts) {
    opts = opts || {};
    var client = sb();
    if (!client || !client.channel) {
      return { setSelection: function () {}, leave: function () {}, dead: true, members: function () { return []; } };
    }
    var self = opts.self || {};
    var selfId = self.id || ('anon-' + Math.random().toString(36).slice(2));
    var myColor = self.color || colorFor(selfId);
    var myName = self.name || 'Someone';
    var ch = client.channel('collab:' + opts.key, { config: { presence: { key: selfId } } });
    var trackState = { name: myName, color: myColor, sel: null };
    var selTimer = null, lastMembers = [];

    function buildMembers() {
      var out = [], st = {};
      try { st = ch.presenceState() || {}; } catch (e) { st = {}; }
      Object.keys(st).forEach(function (k) {
        var arr = st[k] || [], meta = arr[0] || {};
        // A key can carry several presence refs (same user in >1 tab, or a channel
        // re-join). arr[0] may be a stale sel:null entry that masks an active cursor,
        // so prefer the most-informative ref: one whose sel is set.
        for (var qi = 0; qi < arr.length; qi++) { if (arr[qi] && arr[qi].sel) { meta = arr[qi]; break; } }
        out.push({ id: k, name: meta.name || 'Someone', color: meta.color || colorFor(k), sel: meta.sel || null, self: k === selfId });
      });
      // stable order: me first, then by name
      out.sort(function (a, b) { return (b.self - a.self) || String(a.name).localeCompare(String(b.name)); });
      lastMembers = out; return out;
    }

    function onPresenceChange() { if (opts.onPresence) opts.onPresence(buildMembers()); }
    ch.on('presence', { event: 'sync' }, onPresenceChange);
    // Belt-and-braces: some clients/networks deliver join/leave more reliably than a full
    // 'sync' diff — re-render the roster on those too so presence never goes stale one-way.
    ch.on('presence', { event: 'join' }, onPresenceChange);
    ch.on('presence', { event: 'leave' }, onPresenceChange);
    ch.on('broadcast', { event: 'sel' }, function (p) {
      var d = (p && p.payload) || {};
      if (d.id === selfId) return;
      if (opts.onSelection) opts.onSelection(d);
    });
    // Live-value stream: subscribe to one table (opts.table) or several
    // (opts.tables — for modules whose data spans multiple tables, e.g.
    // productivity_activities + productivity_entries). payload.table tells the
    // module which one changed. Backward compatible: opts.table still works.
    var _tables = (opts.tables && opts.tables.length) ? opts.tables : (opts.table ? [opts.table] : []);
    if (_tables.length && opts.projectId != null && opts.onRemoteChange) {
      _tables.forEach(function (tbl) {
        ch.on('postgres_changes',
          { event: '*', schema: 'public', table: tbl, filter: 'project_id=eq.' + opts.projectId },
          function (payload) { opts.onRemoteChange(payload); });
      });
    }

    function doSubscribe() {
      ch.subscribe(function (status) {
        if (status === 'SUBSCRIBED') {
          try { ch.track(trackState); } catch (e) {}   // (re)announce presence — also runs after a reconnect
          if (opts.onStatus) opts.onStatus('online');
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          if (opts.onStatus) opts.onStatus(status === 'CLOSED' ? 'offline' : 'error');
        }
      });
    }
    // CRITICAL for the live-value stream: postgres_changes is RLS-protected, so the socket must
    // carry the user's JWT or the DB change events are silently dropped (presence/broadcast still
    // work without it — which is exactly the "cursors work but live updates lag" symptom). Set the
    // token from the current session BEFORE subscribing; fall back to subscribing anyway.
    try {
      var gs = client.auth && client.auth.getSession && client.auth.getSession();
      if (gs && gs.then) {
        gs.then(function (res) {
          var tok = res && res.data && res.data.session && res.data.session.access_token;
          if (tok) { try { client.realtime.setAuth(tok); } catch (e) {} }
          doSubscribe();
        }, function () { doSubscribe(); });
      } else { doSubscribe(); }
    } catch (e) { doSubscribe(); }
    // Keep the socket token fresh across hourly JWT refreshes so the stream doesn't silently die
    // mid-session (the change events would just stop arriving).
    try {
      if (client.auth && client.auth.onAuthStateChange) {
        client.auth.onAuthStateChange(function (_evt, session) {
          if (session && session.access_token) { try { client.realtime.setAuth(session.access_token); } catch (e) {} }
        });
      }
    } catch (e) {}

    // sel = {rowId, field, editing} | null. Broadcast immediately (throttled) for
    // snappy cursors, and fold into presence so a late joiner sees it on sync.
    function setSelection(sel) {
      trackState.sel = sel;
      if (selTimer) clearTimeout(selTimer);
      selTimer = setTimeout(function () {
        try { ch.track(trackState); } catch (e) {}
        try { ch.send({ type: 'broadcast', event: 'sel', payload: { id: selfId, name: myName, color: myColor, sel: sel } }); } catch (e) {}
      }, 70);
    }

    return {
      setSelection: setSelection,
      members: function () { return lastMembers.slice(); },
      leave: function () { try { ch.untrack(); } catch (e) {} try { client.removeChannel(ch); } catch (e) {} },
      selfId: selfId, color: myColor, channel: ch
    };
  }

  window.PDCollab = {
    join: join, colorFor: colorFor, initials: initials,
    avatarsHTML: avatarsHTML, paintCell: paintCell, clearCells: clearCells
  };
})();
