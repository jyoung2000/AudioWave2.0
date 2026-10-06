/*
 * The mockup's search, on stock songs: not the app's code, a small stand-in for it.
 *
 * The header field searches as the shell does (music-player/src/shell/search, NP-FIND-003): typing
 * dims the last results and says "Press ⏎ to search"; Enter searches and draws Songs (five, then "See
 * all"), Artists and Albums, every row with the platforms it is on, a page at a time — ‹ › and Page
 * Up/Down turn the page, which says "Page N of M"; the arrows move through every section; Enter or a click on a cover previews a song (the ring fills over
 * 30 seconds, without sound); + adds it (✓); Clear or Escape closes. Every row is a copy of a row the
 * app drew in the captured "search" state, so it wears the app's own CSS. "See all", an artist, an
 * album, a song's title, Filter and the fields switch lead to the captured states for them (the
 * navigator follows those clicks), which show the stock search for "harbour".
 *
 * The list's own Search field (#libFind) filters the rows on show as you type, as it does in the app.
 *
 * The songs, artists and albums are the stock list in the <script data-mock-data="search"> above
 * (scripts/mockups/fixtures/search-catalogue.json, invented artists and albums).
 */
(function () {
  'use strict';
  var DATA = JSON.parse(document.querySelector('script[data-mock-data="search"]').textContent);
  var CLIP = DATA.clip;
  var PREVIEW = { songs: 5, artists: 3, albums: 3 };
  var self = document.currentScript;
  if (self) self.remove();
  var dataEl = document.querySelector('script[data-mock-data="search"]');
  if (dataEl) dataEl.remove();

  var S = { found: null, hot: -1, state: 'idle', lastQ: '', added: {}, page: 0 };
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
  function search(q) {
    var songs = DATA.songs.filter(function (s) { return matches(s, q); });
    return {
      songs: songs,
      artists: DATA.artists.filter(function (a) { return songs.some(function (s) { return s.a === a.name; }); }),
      albums: DATA.albums.filter(function (al) { return songs.some(function (s) { return s.al === al.title; }); }),
    };
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /* ---- the popover, as the app drew it in the "search" state ---- */

  function captured() {
    var t = window.mockup.template(DATA.template);
    return t ? t.content.querySelector('#srch') : null;
  }
  function proto(selector) {
    var p = captured();
    return p ? p.querySelector(selector) : null;
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
  function msg(html) { $('srchBody').innerHTML = '<div class="srch__msg">' + html + '</div>'; }

  function stamp(r, i) {
    r.id = 'srchOpt' + i;
    r.setAttribute('data-i', String(i));
    r.setAttribute('aria-selected', 'false');
    r.classList.remove('is-hot');
    return r;
  }
  function picture(r, src) {
    var img = r.querySelector('.srch__art img');
    if (img && src) img.src = src;
  }
  function badges(r, names) {
    var box = r.querySelector('.srch__pfs');
    var one = proto('.srch__pfs .srch__badge');
    if (!box || !one) return;
    box.replaceChildren();
    names.forEach(function (n) { var b = one.cloneNode(true); b.textContent = n; box.appendChild(b); });
    box.title = 'On ' + names.join(', ');
  }

  function songRow(song, i) {
    var r = stamp(proto('.srch__sec[aria-label="Songs"] .srch__row:not(.srch__more)').cloneNode(true), i);
    var key = song.a + '|' + song.t;
    var art = r.querySelector('.srch__art');
    if (art) {
      art.setAttribute('data-preview', String(i));
      art.setAttribute('aria-pressed', 'false');
      art.setAttribute('aria-label', 'Preview ' + song.t + ', ' + CLIP + ' seconds');
      art.classList.remove('is-preview');
      art.style.removeProperty('--p');
    }
    picture(r, song.art);
    r.querySelector('.srch__title').textContent = song.t;
    badges(r, song.pfs);
    r.querySelector('.srch__sub').textContent = song.a + ' — ' + song.al + ' · ' + song.year;
    r.querySelector('.srch__time').textContent = fmt(song.d);
    r.querySelector('.srch__bpm').textContent = song.bpm ? song.bpm + ' bpm' : '';
    var genre = r.querySelector('.srch__genre');
    if (genre) genre.remove();
    var add = r.querySelector('.srch__add');
    if (add) {
      var done = !!S.added[key];
      add.textContent = done ? '✓' : '+';
      add.setAttribute('aria-label', done ? song.t + ' is already in your library' : 'Add ' + song.t + ' to your library');
      if (done) { add.setAttribute('aria-disabled', 'true'); add.removeAttribute('data-add'); }
      else { add.removeAttribute('aria-disabled'); add.setAttribute('data-add', String(i)); }
    }
    return r;
  }
  function artistRow(a, i) {
    var r = stamp(proto('.srch__row--artist').cloneNode(true), i);
    picture(r, a.art);
    r.querySelector('.srch__title').textContent = a.name;
    r.querySelector('.srch__sub').textContent = a.sub;
    return r;
  }
  function albumRow(al, i) {
    var r = stamp(proto('.srch__row--album').cloneNode(true), i);
    picture(r, al.art);
    r.querySelector('.srch__title').textContent = al.title;
    r.querySelector('.srch__sub').textContent = al.sub;
    return r;
  }
  function moreRow(n, i) {
    var r = stamp(proto('.srch__more').cloneNode(true), i);
    r.querySelector('.srch__morelabel').textContent = 'See all songs (' + n + ')';
    return r;
  }
  function section(label, rows) {
    var sec = proto('.srch__sec').cloneNode(true);
    sec.setAttribute('aria-label', label);
    sec.replaceChildren();
    var cap = proto('.srch__sec .srch__cap').cloneNode(true);
    cap.textContent = label;
    sec.appendChild(cap);
    rows.forEach(function (r) { sec.appendChild(r); });
    return sec;
  }

  function render() {
    var count = $('srchCount');
    var live = $('srchLive');
    $('srch').classList.remove('is-stale');
    var back = $('srchBack');
    if (back) back.hidden = true;
    if (S.state === 'loading') {
      count.textContent = 'Searching…';
      msg(spinner() + '<span>Searching…</span>');
      live.textContent = 'Searching';
    } else if (S.state === 'empty') {
      count.innerHTML = '<b>Results:</b> 0 songs';
      msg('No matches for “' + esc(S.lastQ) + '”.');
      live.textContent = 'No results';
    } else if (S.state === 'list') {
      var f = S.found;
      var words = plural(f.songs.length, 'song', 'songs') + ' · ' + plural(f.artists.length, 'artist', 'artists') + ' · ' + plural(f.albums.length, 'album', 'albums');
      count.innerHTML = '<b>Results:</b> ' + words;
      var list = document.createElement('div');
      list.setAttribute('role', 'listbox');
      list.id = 'srchList';
      list.setAttribute('aria-label', 'Search results');
      var i = 0;
      var pg = S.page;
      var cut = function (list, n) { return list.slice(pg * n, pg * n + n); };
      var songs = cut(f.songs, PREVIEW.songs).map(function (s) { return songRow(s, i++); });
      if (songs.length && f.songs.length > PREVIEW.songs) songs.push(moreRow(f.songs.length, i++));
      var artists = cut(f.artists, PREVIEW.artists).map(function (a) { return artistRow(a, i++); });
      var albums = cut(f.albums, PREVIEW.albums).map(function (a) { return albumRow(a, i++); });
      if (songs.length) list.appendChild(section('Songs', songs));
      if (artists.length) list.appendChild(section('Artists', artists));
      if (albums.length) list.appendChild(section('Albums', albums));
      $('srchBody').replaceChildren(list);
      applyHot();
      var n = pages();
      var foot = $('srchFoot');
      if (foot) {
        foot.hidden = n < 2;
        var d = '';
        for (var k = 0; k < n; k++) d += '<i' + (k === pg ? ' class="is-on"' : '') + '></i>';
        $('srchDots').innerHTML = d;
        $('srchPrev').disabled = pg === 0;
        $('srchNext').disabled = pg >= n - 1;
        if ($('srchPageOf')) $('srchPageOf').textContent = 'Page ' + (pg + 1) + ' of ' + n;
      }
      live.textContent = words + (n > 1 ? ', page ' + (pg + 1) + ' of ' + n : '');
    }
  }

  function rows() { return $('srchBody').querySelectorAll('.srch__row[data-i]'); }
  function pages() {
    var f = S.found;
    if (!f) return 1;
    return Math.max(1, Math.ceil(f.songs.length / PREVIEW.songs), Math.ceil(f.artists.length / PREVIEW.artists), Math.ceil(f.albums.length / PREVIEW.albums));
  }
  function turn(by) {
    var p = Math.max(0, Math.min(pages() - 1, S.page + by));
    if (p === S.page) return;
    stopPreview();
    S.page = p;
    S.hot = -1;
    render();
  }
  function applyHot() {
    var all = rows();
    for (var i = 0; i < all.length; i++) {
      all[i].classList.toggle('is-hot', i === S.hot);
      all[i].setAttribute('aria-selected', String(i === S.hot));
    }
    if (S.hot >= 0) $('q').setAttribute('aria-activedescendant', 'srchOpt' + S.hot);
    else $('q').removeAttribute('aria-activedescendant');
  }
  function move(by) {
    var n = rows().length;
    if (!n) return;
    S.hot = S.hot < 0 ? (by > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, S.hot + by));
    applyHot();
    var on = rows()[S.hot];
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }

  var searchTimer = 0;
  function go(q) {
    stopPreview();
    S.lastQ = q;
    S.hot = -1;
    S.page = 0;
    S.state = 'loading';
    open();
    render();
    clearTimeout(searchTimer);
    // A moment of "Searching…", as a real lookup takes.
    searchTimer = setTimeout(function () {
      S.found = search(q);
      S.state = S.found.songs.length ? 'list' : 'empty';
      render();
    }, 450);
  }

  function markStale() {
    var q = $('q').value.trim();
    var stale = !!q && q !== S.lastQ && S.state === 'list';
    $('srch').classList.toggle('is-stale', stale);
    if (stale) $('srchCount').textContent = 'Press ⏎ to search';
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
    var r = $('srchBody').querySelector('.srch__row[data-i="' + i + '"]');
    var t = r && r.querySelector('.srch__title');
    var song = t && S.found && S.found.songs.filter(function (s) { return s.t === t.textContent; })[0];
    if (!song) return;
    S.added[song.a + '|' + song.t] = true;
    render();
  }

  /* ---- picking up a state the navigator just drew ---- */

  function adopt(e) {
    stopPreview();
    var q = $('q');
    if (!q) return;
    var p = $('srch');
    var id = e && e.detail ? e.detail.id : window.mockup.current();
    if (p && !p.hidden && q.value.trim() && (id === 'search' || id === 'search-keys' || id === 'search-page-2' || id === 'search-stale')) {
      // The captured overview states: carry on from what they show.
      S.lastQ = id === 'search-stale' ? 'harbour' : q.value.trim();
      S.found = search(S.lastQ);
      S.state = S.found.songs.length ? 'list' : 'empty';
      var hot = p.querySelector('.srch__row.is-hot');
      S.hot = hot ? Number(hot.getAttribute('data-i')) : -1;
      var on = p.querySelectorAll('#srchDots i');
      S.page = 0;
      for (var k = 0; k < on.length; k++) if (on[k].classList.contains('is-on')) S.page = k;
    } else if (p && !p.hidden && q.value.trim()) {
      S.lastQ = q.value.trim();
      S.found = search(S.lastQ);
      S.state = 'view';
    } else {
      S = { found: null, hot: -1, state: 'idle', lastQ: '', added: S.added, page: 0 };
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
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if ((e.key === 'PageDown' || e.key === 'PageUp') && showing) {
      e.preventDefault();
      if (S.state === 'list') turn(e.key === 'PageDown' ? 1 : -1);
      else move(e.key === 'PageDown' ? 5 : -5);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      var hot = showing && S.hot >= 0 ? $('srchBody').querySelector('.srch__row[data-i="' + S.hot + '"]') : null;
      if (hot && !$('srch').classList.contains('is-stale')) {
        var art = hot.querySelector('.srch__art[data-preview]');
        if (e.metaKey || e.ctrlKey) addRow(S.hot);
        else if (art) preview(art);
        else hot.click(); // an artist, an album or "See all": the navigator follows it
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

  // Clicks inside the popover: handled here before the navigator reads them as "away". (The
  // navigator has already followed any click it wired to another state.)
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
    if (t.closest('input, label')) return;
    e.preventDefault();
    e.stopPropagation();
    if (t.closest('#srchPrev')) { turn(-1); return; }
    if (t.closest('#srchNext')) { turn(1); return; }
    if (t.closest('#srchClear')) { $('q').value = ''; S.state = 'idle'; S.lastQ = ''; close(); $('q').focus(); return; }
    var add = t.closest('[data-add]');
    if (add) { addRow(Number(add.getAttribute('data-add'))); return; }
    var art = t.closest('.srch__art[data-preview]');
    if (art) { preview(art); return; }
    var r = t.closest('.srch__row[data-i]');
    if (r) {
      S.hot = Number(r.getAttribute('data-i'));
      applyHot();
      var a = r.querySelector('.srch__art[data-preview]');
      if (a) preview(a);
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
