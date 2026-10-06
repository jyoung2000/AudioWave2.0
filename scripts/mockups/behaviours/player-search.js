/*
 * The mockup's search, on stock songs: not the app's code, a small stand-in for it.
 *
 * The header field searches as the shell does (music-player/index.html, "search"): typing dims the
 * last results and says "Press ⏎ to search"; Enter searches; five rows a page with dots, ‹ › and
 * Page Up/Down; arrow keys move the highlight; Enter or a click previews the highlighted row (the
 * ring fills over 30 seconds, without sound); + adds it (✓); Clear or Escape closes. Every row is a
 * copy of the row the app drew in the captured "search" state, so it wears the app's own CSS.
 *
 * The list's own Search field (#libFind) filters the rows on show as you type, as it does in the app.
 *
 * The songs are the stock list in the <script data-mock-data="search"> above
 * (scripts/mockups/fixtures/search-catalogue.json, invented artists and albums).
 */
(function () {
  'use strict';
  var DATA = JSON.parse(document.querySelector('script[data-mock-data="search"]').textContent);
  var PAGE = DATA.page;
  var CLIP = DATA.clip;
  var self = document.currentScript;
  if (self) self.remove();
  var dataEl = document.querySelector('script[data-mock-data="search"]');
  if (dataEl) dataEl.remove();

  var S = { results: [], page: 0, hot: -1, state: 'idle', lastQ: '', added: {} };
  var previewing = null;

  function $(id) { return document.getElementById(id); }
  function esc(t) {
    return String(t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(sec) { return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }
  function matches(song, q) {
    var hay = (song.t + ' ' + song.a + ' ' + song.al).toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every(function (w) { return hay.indexOf(w) >= 0; });
  }
  function pages() { return Math.ceil(S.results.length / PAGE); }
  function visible() { return S.results.slice(S.page * PAGE, S.page * PAGE + PAGE); }

  /* ---- the popover, as the app drew it in the "search" state ---- */

  function captured() {
    var t = window.mockup.template(DATA.template);
    return t ? t.content.querySelector('#srch') : null;
  }
  function protoRow() {
    var pop = captured();
    return pop ? pop.querySelector('.srch__row') : null;
  }
  /* In other states the closed popover was written out empty: put the app's markup back. */
  function pop() {
    var el = $('srch');
    if (el && !el.querySelector('#srchBody')) {
      var copy = captured();
      if (!copy) return null;
      copy = copy.cloneNode(true);
      copy.hidden = true;
      el.replaceWith(copy);
      el = copy;
    }
    return el;
  }
  function open() { var p = pop(); if (!p) return; p.hidden = false; $('q').setAttribute('aria-expanded', 'true'); }
  function close() {
    stopPreview();
    var p = $('srch');
    if (!p) return;
    p.hidden = true;
    p.classList.remove('is-stale');
    S.hot = -1;
    $('q').setAttribute('aria-expanded', 'false');
  }

  function spinner() {
    var s = '<span class="srch__spin" aria-hidden="true">';
    for (var i = 0; i < 12; i++) s += '<i style="transform:rotate(' + i * 30 + 'deg);animation-delay:' + (i / 12 - 1).toFixed(3) + 's"></i>';
    return s + '</span>';
  }
  function msg(html) { $('srchBody').innerHTML = '<div class="srch__msg">' + html + '</div>'; $('srchFoot').hidden = true; }

  function row(song, i) {
    var r = protoRow().cloneNode(true);
    var key = song.a + '|' + song.t;
    r.id = 'srchOpt' + i;
    r.setAttribute('data-i', String(i));
    r.setAttribute('aria-selected', 'false');
    r.classList.remove('is-hot');
    var art = r.querySelector('.srch__art');
    if (art) {
      art.setAttribute('data-preview', String(i));
      art.setAttribute('aria-pressed', 'false');
      art.setAttribute('aria-label', 'Preview ' + song.t + ', ' + CLIP + ' seconds');
      art.classList.remove('is-preview');
      art.style.removeProperty('--p');
      var img = art.querySelector('img');
      if (img) img.src = song.art;
    }
    r.querySelector('.srch__title').textContent = song.t;
    r.querySelector('.srch__sub').textContent = song.a + ' — ' + song.al;
    r.querySelector('.srch__time').textContent = fmt(song.d);
    r.querySelector('.srch__bpm').textContent = song.bpm ? song.bpm + ' bpm' : '';
    var add = r.querySelector('.srch__add');
    if (add) {
      var done = !!S.added[key];
      add.textContent = done ? '✓' : '+';
      add.setAttribute('aria-label', done ? song.t + ' is already in your library' : 'Add ' + song.t + ' to your library');
      if (done) { add.setAttribute('aria-disabled', 'true'); add.removeAttribute('data-add'); }
      else { add.removeAttribute('aria-disabled'); add.setAttribute('data-add', String(i)); }
    }
    var q = encodeURIComponent(song.a + ' ' + song.t);
    r.querySelectorAll('.srch__pf').forEach(function (a) {
      a.href = a.href.replace(/([?&](?:search_query|q)=).*$/, '$1' + q);
      a.setAttribute('aria-label', 'Find ' + song.t + ' on ' + (a.getAttribute('aria-label') || '').replace(/^.* on /, ''));
    });
    return r;
  }

  function render() {
    var count = $('srchCount');
    var live = $('srchLive');
    $('srch').classList.remove('is-stale');
    if (S.state === 'loading') {
      count.textContent = 'Searching…';
      msg(spinner() + '<span>Searching…</span>');
      live.textContent = 'Searching';
    } else if (S.state === 'empty') {
      count.innerHTML = '<b>Results:</b> 0 songs';
      msg('No matches for “' + esc(S.lastQ) + '”.');
      live.textContent = 'No results';
    } else if (S.state === 'list') {
      var n = S.results.length;
      count.innerHTML = '<b>Results:</b> ' + n + (n === 1 ? ' song' : ' songs');
      var list = document.createElement('div');
      list.setAttribute('role', 'listbox');
      list.id = 'srchList';
      list.setAttribute('aria-label', 'Search results');
      visible().forEach(function (s, i) { list.appendChild(row(s, i)); });
      $('srchBody').replaceChildren(list);
      var pg = pages();
      $('srchFoot').hidden = pg < 2;
      if (pg > 1) {
        var d = '';
        for (var i = 0; i < pg; i++) d += '<i' + (i === S.page ? ' class="is-on"' : '') + '></i>';
        $('srchDots').innerHTML = d;
        $('srchPrev').disabled = S.page === 0;
        $('srchNext').disabled = S.page === pg - 1;
      }
      applyHot();
      live.textContent = n + ' results' + (pg > 1 ? ', page ' + (S.page + 1) + ' of ' + pg : '');
    }
  }

  function applyHot() {
    var rows = $('srchBody').querySelectorAll('.srch__row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('is-hot', i === S.hot);
      rows[i].setAttribute('aria-selected', String(i === S.hot));
    }
    if (S.hot >= 0) $('q').setAttribute('aria-activedescendant', 'srchOpt' + S.hot);
    else $('q').removeAttribute('aria-activedescendant');
  }

  function turn(by, hotAt) {
    var p = Math.min(pages() - 1, Math.max(0, S.page + by));
    if (p === S.page) return;
    stopPreview();
    S.page = p;
    S.hot = hotAt === undefined ? -1 : hotAt;
    render();
  }

  var searchTimer = 0;
  function go(q) {
    stopPreview();
    S.lastQ = q;
    S.page = 0;
    S.hot = -1;
    S.state = 'loading';
    open();
    render();
    clearTimeout(searchTimer);
    // A moment of "Searching…", as a real lookup takes.
    searchTimer = setTimeout(function () {
      S.results = DATA.songs.filter(function (s) { return matches(s, q); });
      S.state = S.results.length ? 'list' : 'empty';
      render();
    }, 450);
  }

  function markStale() {
    var q = $('q').value.trim();
    var stale = !!q && q !== S.lastQ && S.state === 'list';
    $('srch').classList.toggle('is-stale', stale);
    if (stale) $('srchCount').textContent = 'Press ⏎ to search';
    else if (S.state === 'list') render();
  }

  /* ---- preview: the ring fills over the clip, without sound ---- */

  function stopPreview() {
    if (!previewing) return;
    cancelAnimationFrame(previewing.raf);
    previewing.el.classList.remove('is-preview');
    previewing.el.setAttribute('aria-pressed', 'false');
    previewing.el.style.removeProperty('--p');
    previewing = null;
  }
  function preview(el) {
    var same = previewing && previewing.el === el;
    stopPreview();
    if (same || !el) return;
    var start = performance.now();
    previewing = { el: el, raf: 0 };
    el.classList.add('is-preview');
    el.setAttribute('aria-pressed', 'true');
    (function tick(now) {
      var p = Math.min(1, (now - start) / (CLIP * 1000));
      el.style.setProperty('--p', p.toFixed(4));
      if (p >= 1) { stopPreview(); return; }
      previewing.raf = requestAnimationFrame(tick);
    })(start);
  }

  function addRow(i) {
    var s = visible()[i];
    if (!s) return;
    S.added[s.a + '|' + s.t] = true;
    render();
  }

  /* ---- picking up a state the navigator just drew ---- */

  function adopt() {
    stopPreview();
    var q = $('q');
    if (!q) return;
    var p = $('srch');
    if (p && !p.hidden && p.querySelector('.srch__row[data-i]') && q.value.trim()) {
      // The captured "search" states: carry on from what they show.
      S.lastQ = q.value.trim();
      S.results = DATA.songs.filter(function (s) { return matches(s, S.lastQ); });
      S.state = S.results.length ? 'list' : 'empty';
      var dots = p.querySelectorAll('#srchDots i');
      S.page = 0;
      for (var i = 0; i < dots.length; i++) if (dots[i].classList.contains('is-on')) S.page = i;
      var hot = p.querySelector('.srch__row.is-hot');
      S.hot = hot ? Number(hot.getAttribute('data-i')) : -1;
    } else if (p && !p.hidden && q.value.trim()) {
      S.lastQ = q.value.trim();
      S.results = [];
      S.state = 'empty';
    } else {
      S = { results: [], page: 0, hot: -1, state: 'idle', lastQ: '', added: S.added };
    }
  }
  document.addEventListener('mockup:show', adopt);

  /* ---- wiring (on the document: each state is a fresh copy of the markup) ---- */

  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    if (t.id === 'libFind') { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); t.value = ''; filterList(''); } return; }
    if (t.id !== 'q') return;
    var showing = $('srch') && !$('srch').hidden;
    if (e.key === 'Escape') {
      if (showing) { e.preventDefault(); e.stopPropagation(); close(); }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!showing) { if (S.state !== 'idle') { e.preventDefault(); open(); render(); } return; }
      if (S.state !== 'list') return;
      e.preventDefault();
      var n = visible().length;
      if (e.key === 'ArrowDown') { if (S.hot < n - 1) { S.hot++; applyHot(); } else if (S.page < pages() - 1) turn(1, 0); }
      else { if (S.hot > 0) { S.hot--; applyHot(); } else if (S.page > 0) turn(-1, PAGE - 1); }
      return;
    }
    if ((e.key === 'PageDown' || e.key === 'PageUp') && showing && S.state === 'list') {
      e.preventDefault();
      turn(e.key === 'PageDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (showing && S.state === 'list' && S.hot >= 0) {
        if (e.metaKey || e.ctrlKey) addRow(S.hot);
        else preview($('srchBody').querySelector('.srch__row[data-i="' + S.hot + '"] .srch__art'));
        return;
      }
      var q = t.value.trim();
      if (q) go(q);
    }
  }, true);

  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    if (t.id === 'libFind') { filterList(t.value); return; }
    if (t.id !== 'q') return;
    if (!t.value.trim()) { S.state = 'idle'; S.lastQ = ''; close(); return; }
    if ($('srch') && !$('srch').hidden) markStale();
  }, true);

  document.addEventListener('focusin', function (e) {
    if (!(e.target instanceof Element) || e.target.id !== 'q') return;
    var p = $('srch');
    if (p && p.hidden && S.state !== 'idle' && e.target.value.trim()) { open(); render(); markStale(); }
  });

  // Clicks inside the popover: handled here before the navigator reads them as "away".
  document.addEventListener('click', function (e) {
    var t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    var inPop = t.closest('#srch');
    if (!inPop) {
      // A click away closes it, as in the app; in the captured search states the navigator does that.
      if (!t.closest('#searchBox') && $('srch') && !$('srch').hidden && !window.mockup.template(window.mockup.current()).hasAttribute('data-mock-dismiss')) close();
      if (t.closest('#libFindClear')) { var f = $('libFind'); f.value = ''; filterList(''); f.focus(); }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (t.closest('#srchClear')) { $('q').value = ''; S.state = 'idle'; S.lastQ = ''; close(); $('q').focus(); return; }
    if (t.closest('#srchPrev')) { turn(-1); return; }
    if (t.closest('#srchNext')) { turn(1); return; }
    var add = t.closest('[data-add]');
    if (add) { addRow(Number(add.getAttribute('data-add'))); return; }
    var art = t.closest('.srch__art[data-preview]');
    if (art) { preview(art); return; }
    var r = t.closest('.srch__row[data-i]');
    if (r && !t.closest('a')) {
      S.hot = Number(r.getAttribute('data-i'));
      applyHot();
      preview(r.querySelector('.srch__art'));
    }
  }, true);

  /* ---- the list's own Search field: filters the rows on show, live ---- */

  function filterList(value) {
    var q = String(value || '').trim().toLowerCase();
    var clear = $('libFindClear');
    if (clear) clear.hidden = !value;
    var body = $('libraryRows');
    if (!body) return;
    var shown = 0;
    body.querySelectorAll('tr').forEach(function (tr) {
      if (tr.hasAttribute('data-mock-empty')) return;
      var hit = !q || tr.textContent.toLowerCase().indexOf(q) >= 0;
      tr.hidden = !hit;
      if (hit) shown++;
    });
    var empty = body.querySelector('tr[data-mock-empty]');
    if (q && !shown) {
      if (!empty) {
        empty = document.createElement('tr');
        empty.setAttribute('data-mock-empty', '');
        empty.innerHTML = '<td class="lib-empty" colspan="9"></td>';
        body.appendChild(empty);
      }
      empty.firstChild.textContent = 'No songs match “' + q + '”.';
      empty.hidden = false;
    } else if (empty) {
      empty.hidden = true;
    }
    var live = $('libFindLive');
    if (live) live.textContent = q ? shown + (shown === 1 ? ' song matches ' : ' songs match ') + '“' + q + '”' : '';
  }

  if (window.mockup && window.mockup.current()) adopt();
})();
