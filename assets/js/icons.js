// ============================================================================
// Planners Dashboard — Shared icon set (Icons)
// ----------------------------------------------------------------------------
// Professional monochrome line icons (inline SVG, stroke = currentColor) used
// across the whole app in place of emoji. Two ways to use:
//   1. Static markup:  <span class="pd-ico" data-ico="home"></span>
//      (auto-hydrated on DOMContentLoaded)
//   2. Dynamic JS:      Icons.svg('home', 20)
// Keep dependency-free. Add new glyphs to PATHS below.
// ============================================================================

(function () {
  var PATHS = {
    // --- Navigation / chrome ---
    grid:        '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    home:        '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/>',
    settings:    '<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="17" r="2"/>',
    arrowLeft:   '<line x1="20" y1="12" x2="5" y2="12"/><polyline points="11 18 5 12 11 6"/>',
    arrowRight:  '<line x1="4" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/>',
    externalLink: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    chevronDown: '<polyline points="6 9 12 15 18 9"/>',
    search:      '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/>',
    plus:        '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    listView:    '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
    gridView:    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    sun:         '<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.2" y1="4.2" x2="5.6" y2="5.6"/><line x1="18.4" y1="18.4" x2="19.8" y2="19.8"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.2" y1="19.8" x2="5.6" y2="18.4"/><line x1="18.4" y1="5.6" x2="19.8" y2="4.2"/>',
    moon:        '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.5 6.5 0 0 0 9.8 9.8z"/>',

    // --- Workspace tree / hierarchy ---
    workspace:   '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    program:     '<rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/>',
    group:       '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 11a3 3 0 0 0 0-6"/><path d="M21 20c0-2.5-1.5-4.7-3.7-5.6"/>',
    org:         '<path d="M3 21V8l6-4 6 4v13"/><path d="M15 21V11l6 0v10"/><line x1="6" y1="9" x2="6" y2="9.01"/><line x1="9" y1="13" x2="9" y2="13.01"/>',

    // --- Project / module glyphs ---
    project:     '<path d="M3 21h18"/><path d="M5 21V8l7-4 7 4v13"/><line x1="9.5" y1="11" x2="9.5" y2="11.01"/><line x1="14.5" y1="11" x2="14.5" y2="11.01"/><line x1="9.5" y1="15" x2="9.5" y2="15.01"/><line x1="14.5" y1="15" x2="14.5" y2="15.01"/>',
    camera:      '<path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.5" r="3.2"/>',
    clipboard:   '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 4v1H9z"/><line x1="9" y1="10" x2="15" y2="10"/><line x1="9" y1="14" x2="15" y2="14"/>',
    contract:    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/>',
    risk:        '<path d="M12 4 2.5 20h19z"/><line x1="12" y1="10" x2="12" y2="14"/><line x1="12" y1="17" x2="12" y2="17.01"/>',
    compass:     '<circle cx="12" cy="12" r="9"/><polygon points="15.5 8.5 11 11 8.5 15.5 13 13"/>',
    ruler:       '<rect x="2.5" y="8" width="19" height="8" rx="1" transform="rotate(-45 12 12)"/><line x1="8" y1="9" x2="9.5" y2="10.5"/><line x1="11" y1="12" x2="12.5" y2="13.5"/><line x1="14" y1="15" x2="15.5" y2="16.5"/>',
    box:         '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5"/><line x1="12" y1="13" x2="12" y2="21"/>',
    calendar:    '<rect x="3" y="4.5" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2.5" x2="8" y2="6"/><line x1="16" y1="2.5" x2="16" y2="6"/>',
    trendingUp:  '<polyline points="3 17 9 11 13 15 21 7"/><polyline points="15 7 21 7 21 13"/>',
    users:       '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 11a3 3 0 0 0 0-6"/><path d="M21 20c0-2.5-1.5-4.7-3.7-5.6"/>',
    barChart:    '<line x1="6" y1="20" x2="6" y2="12"/><line x1="12" y1="20" x2="12" y2="5"/><line x1="18" y1="20" x2="18" y2="9"/><line x1="3" y1="20" x2="21" y2="20"/>',
    cash:        '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><line x1="6" y1="9" x2="6" y2="9.01"/><line x1="18" y1="15" x2="18" y2="15.01"/>',

    // --- KPI / misc ---
    user:        '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7"/>',
    calculator:  '<rect x="5" y="3" width="14" height="18" rx="2"/><rect x="8" y="6" width="8" height="3" rx="0.5"/><line x1="8.5" y1="13" x2="8.5" y2="13.01"/><line x1="12" y1="13" x2="12" y2="13.01"/><line x1="15.5" y1="13" x2="15.5" y2="13.01"/><line x1="8.5" y1="17" x2="8.5" y2="17.01"/><line x1="12" y1="17" x2="12" y2="17.01"/><line x1="15.5" y1="17" x2="15.5" y2="17.01"/>',
    triangleUp:  '<path d="M12 6 4 18h16z"/>',
    triangleDown:'<path d="M12 18 4 6h16z"/>',
    layers:      '<path d="M12 3 3 8l9 5 9-5z"/><path d="M3 13l9 5 9-5"/>',
    // A 0-or-100 progress unit marker (drawing-register level designation).
    target:      '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.2"/>',
    check:       '<polyline points="4 12.5 9 17.5 20 6.5"/>',
    bell:        '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    clock:       '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>',
    fileText:    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/>',
    history:     '<path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 9 8 9"/><polyline points="12 8 12 12 15 14"/>',
    x:           '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
    bulb:        '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.3 1 2.5h6c0-1.2.3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
    dot:         '<circle cx="12" cy="12" r="5"/>',
    mapPin:      '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="2.8"/>',
    refresh:     '<path d="M4 12a8 8 0 0 1 13.7-5.7L20 8"/><polyline points="20 3 20 8 15 8"/><path d="M20 12a8 8 0 0 1-13.7 5.7L4 16"/><polyline points="4 21 4 16 9 16"/>',
    filter:      '<polygon points="3 4 21 4 14 12.5 14 19 10 21 10 12.5"/>',
    chevronRight:'<polyline points="9 6 15 12 9 18"/>',
    download:    '<path d="M12 3v12"/><polyline points="7 11 12 16 17 11"/><line x1="4" y1="20" x2="20" y2="20"/>',
    upload:      '<path d="M12 21V9"/><polyline points="7 13 12 8 17 13"/><line x1="4" y1="4" x2="20" y2="4"/>',
    trash:       '<polyline points="3 6 5 6 21 6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
    pencil:      '<path d="M4 20h4L20 8a2.83 2.83 0 0 0-4-4L4 16z"/><line x1="14" y1="6" x2="18" y2="10"/>',
    link:        '<path d="M9 15l6-6"/><path d="M11 6l1-1a4 4 0 0 1 6 6l-1 1"/><path d="M13 18l-1 1a4 4 0 0 1-6-6l1-1"/>',
    pulse:       '<path d="M3 12h4l2-8 4 16 2-8h6"/>',
    undo:        '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    redo:        '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
    printer:     '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
    layout:      '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>',
    columns:     '<rect x="3" y="4" width="18" height="16" rx="1"/><line x1="9" y1="4" x2="9" y2="20"/><line x1="15" y1="4" x2="15" y2="20"/>',
    palette:     '<circle cx="13.5" cy="6.5" r="1"/><circle cx="17" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12" r="1"/><path d="M12 22a10 10 0 1 1 10-10c0 2.2-1.8 3-3.2 3H16a2 2 0 0 0-1.4 3.4c.3.3.4.7.4 1.1A2 2 0 0 1 12 22z"/>',
    eye:         '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    folder:      '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    eyeOff:      '<path d="M9.9 5.2A9.5 9.5 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.6 8.3 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4.4-1M3 3l18 18"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'
  };

  function svg(name, size) {
    var inner = PATHS[name];
    if (!inner) inner = PATHS.dot;
    var s = size || 18;
    return '<svg class="pd-ico" viewBox="0 0 24 24" width="' + s + '" height="' + s +
      '" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
  }

  function hydrate(root) {
    (root || document).querySelectorAll('[data-ico]').forEach(function (el) {
      if (el.dataset.icoDone) return;
      var size = el.dataset.icoSize ? parseInt(el.dataset.icoSize, 10) : 18;
      el.innerHTML = svg(el.dataset.ico, size);
      el.dataset.icoDone = '1';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { hydrate(); });
  } else { hydrate(); }

  window.Icons = { svg: svg, hydrate: hydrate, names: Object.keys(PATHS) };
})();
