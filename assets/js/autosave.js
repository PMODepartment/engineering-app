// ============================================================================
// Autosave — shared debounced-autosave wiring for Add/Edit modals.
// Reuses each module's own Save button handler (which already knows how to
// build the payload + write via PDSync/Supabase); autosave just calls it on a
// debounce and suppresses the close/redirect side effects it normally does on
// a manual click, so the modal stays open while the planner keeps typing.
// ============================================================================
window.Autosave = (function () {
  function wire(opts) {
    // opts: { root, modal, saveBtn, indicator, delay }
    //   root      element to listen for input/change on
    //   modal     the UI.modal() return value (has .close, .el)
    //   saveBtn   the <button> whose onclick performs the real save
    //   indicator element to show status text in (optional)
    //   delay     debounce ms (default 1200)
    var root = opts.root, modal = opts.modal, saveBtn = opts.saveBtn;
    var ind = opts.indicator, delay = opts.delay || 1200;
    var timer = null, dirty = false, saving = false, again = false, stopped = false;

    function status(s) {
      if (!ind) return;
      ind.textContent = s;
      ind.className = 'pd-autosave pd-autosave-' +
        (s === 'Saved' ? 'ok' : s === 'Saving…' ? 'busy' : /error/i.test(s) ? 'err' : 'idle');
    }

    function schedule() {
      if (stopped) return;
      dirty = true;
      status('Unsaved changes…');
      clearTimeout(timer);
      timer = setTimeout(flush, delay);
    }

    async function flush() {
      if (stopped || !dirty) return;
      if (saving) { again = true; return; }
      dirty = false; saving = true; status('Saving…');
      var realClose = modal.close;
      modal.close = function () {};   // autosave never closes the modal
      try {
        await saveBtn.onclick();
        status('Saved');
      } catch (e) {
        status('Error — will retry');
        dirty = true;
      } finally {
        modal.close = realClose;
        saving = false;
        if (again) { again = false; schedule(); }
      }
    }

    root.addEventListener('input', schedule);
    root.addEventListener('change', schedule);

    return {
      cancel: function () { stopped = true; clearTimeout(timer); },
      flushNow: flush
    };
  }
  return { wire: wire };
})();
