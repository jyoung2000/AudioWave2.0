/*
 * The mockup's search, on stock songs: not the app's code, a small stand-in for it.
 *
 * The header field searches as the shell does (music-player/src/shell/search, NP-FIND-003): typing
 * dims the last results and says "Press ⏎ to search"; Enter searches and draws a calm overview —
 * Songs (five), Artists, Albums and Playlists (three each), each with "See all N" — every row with
 * the platforms it is on, and no pager; the arrows move through every section; Enter or a click on a
 * cover previews a song (the ring fills over 30 seconds, without sound); + adds it (✓); Clear or
 * Escape closes. Every row is a copy of a row the app drew in the captured "search" state, so it
 * wears the app's own CSS. "See all", an artist, an album, a song's title, a song's "…", Filter and
 * the fields switch lead to the captured states for them (the navigator follows those clicks), which
 * show the stock search for "harbour".
 *
 * On a type page (the captured "search-see-all" and "search-playlists" states) the type's own field
 * searches that type on the stock list, and the footer's ‹ › move a page at a time — 25 songs or 12
 * playlists — with "Page N of M" following the scroll (NP-FIND-004).
 *
 * The list's own Search field (#libFind) filters the rows on show as you type, as it does in the app.
 *
 * The songs, artists, albums and playlists are the stock list in the <script data-mock-data="search">
 * above (scripts/mockups/fixtures/search-catalogue.json, invented artists and albums).
 */
(function () {
  'use strict';
  var DATA = JSON.parse(document.querySelector('script[data-mock-data="search"]').textContent);
  var CLIP = DATA.clip;
  var PREVIEW = { songs: 5, artists: 3, albums: 3, playlists: 3 };
  var PAGE_ROWS = { songs: 25, playlists: 12 };
  var TYPE_STATE = { 'search-see-all': 'songs', 'search-playlists': 'playlists' };
  var self = document.currentScript;
  if (self) self.remove();
  var dataEl = document.querySelector('script[data-mock-data="search"]');
  if (dataEl) dataEl.remove();

  var S = { found: null, hot: -1, state: 'idle', lastQ: '', added: {}, type: null, typeQ: '', page: 0 };
  var previewing = null;

  function $(id) { return document.getElementById(id); }
  function esc(t) {
    return String(t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(sec) { return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }
  function words(q) { return String(q).toLowerCase().split(/\s+/).filter(Boolean); }
  function matches(song, q) {
    var hay = (song.t + ' ' + song.a + ' ' + song.al).toLowerCase();
    return words(q).every(function (w) { return hay.indexOf(w) >= 0; });
  }
  function playlistMatches(pl, q) {
    var hay = pl.title.toLowerCase();
    if (words(q).every(function (w) { return hay.indexOf(w) >= 0; })) return true;
    return pl.songs.some(function (t) {
      var s = DATA.songs.filter(function (x) { return x.t === t; })[0];
      return s && matches(s, q);
    });
  }
  function search(q) {
    var songs = DATA.songs.filter(function (s) { return matches(s, q); });
    return {
      songs: songs,
      artists: DATA.artists.filter(function (a) { return songs.some(function (s) { return s.a === a.name; }); }),
      albums: DATA.albums.filter(function (al) { return songs.some(function (s) { return s.al === al.title; }); }),
      playlists: (DATA.playlists || []).filter(function (pl) { return playlistMatches(pl, q); }),
    };
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /* ---- the popover, as the app drew it in the "search" state ---- */

  function captured(id) {
    var t = window.mockup.template(id || DATA.template);
    return t ? t.content.querySelector('#srch') : null;
  }
  function proto(selector, id) {
    var p = captured(id);
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
    r.removeAttribute('data-page');
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
    r.querySelector('.srch__sub').textContent = (song.who || song.a) + ' — ' + song.al + ' · ' + song.year;
    var x = r.querySelector('.srch__x');
    if (x && !song.x) x.remove();
    if (!x && song.x) {
      var mark = document.createElement('span');
      mark.className = 'srch__x';
      mark.title = 'Explicit';
      mark.setAttribute('aria-label', 'explicit');
      mark.textContent = 'E';
      r.querySelector('.srch__title').after(mark);
    }
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
    var menu = r.querySelector('.srch__menu');
    if (menu) { menu.setAttribute('data-menu', String(i)); menu.setAttribute('aria-label', 'More for ' + song.t); }
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
  function playlistRow(pl, i) {
    var p = proto('.srch__row--pl') || proto('.srch__row--pl', 'search-playlists');
    if (!p) return null;
    var r = stamp(p.cloneNode(true), i);
    picture(r, pl.art);
    r.querySelector('.srch__title').textContent = pl.title;
    r.querySelector('.srch__sub').textContent = pl.sub;
    r.setAttribute('aria-label', pl.title + ', ' + pl.sub + '. Opens in the music list');
    return r;
  }
  function moreRow(section, n, i) {
    var r = stamp(proto('.srch__more').cloneNode(true), i);
    r.querySelector('.srch__morelabel').textContent = 'See all ' + n + ' ' + section;
    r.setAttribute('aria-label', 'See all ' + n + ' ' + section + ': open a page of ' + section + ' alone');
    return r;
  }
  function section(label, rows) {
    var sec = proto('.srch__sec').cloneNode(true);
    sec.setAttribute('aria-label', label);
    sec.replaceChildren();
    var cap = proto('.srch__sec .srch__cap').cloneNode(true);
    cap.textContent = label;
    sec.appendChild(cap);
    rows.forEach(function (r) { if (r) sec.appendChild(r); });
    return sec;
  }
  function list(label) {
    var el = document.createElement('div');
    el.setAttribute('role', 'listbox');
    el.id = 'srchList';
    el.setAttribute('aria-label', label);
    return el;
  }

  /* ---- the overview: no pager (NP-FIND-003) ---- */

  function render() {
    var count = $('srchCount');
    var live = $('srchLive');
    $('srch').classList.remove('is-stale');
    var back = $('srchBack');
    if (back) back.hidden = true;
    var foot = $('srchFoot');
    if (foot) foot.hidden = true;
    var type = $('srchType');
    if (type) type.hidden = true;
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
      var said = [plural(f.songs.length, 'song', 'songs'), plural(f.artists.length, 'artist', 'artists'), plural(f.albums.length, 'album', 'albums'), plural(f.playlists.length, 'playlist', 'playlists')].join(' · ');
      count.innerHTML = '<b>Results:</b> ' + said;
      var out = list('Search results');
      var i = 0;
      var songs = f.songs.slice(0, PREVIEW.songs).map(function (s) { return songRow(s, i++); });
      if (songs.length && f.songs.length > PREVIEW.songs) songs.push(moreRow('songs', f.songs.length, i++));
      var artists = f.artists.slice(0, PREVIEW.artists).map(function (a) { return artistRow(a, i++); });
      if (artists.length && f.artists.length > PREVIEW.artists) artists.push(moreRow('artists', f.artists.length, i++));
      var albums = f.albums.slice(0, PREVIEW.albums).map(function (a) { return albumRow(a, i++); });
      if (albums.length && f.albums.length > PREVIEW.albums) albums.push(moreRow('albums', f.albums.length, i++));
      var playlists = f.playlists.slice(0, PREVIEW.playlists).map(function (p) { return playlistRow(p, i++); });
      if (playlists.length && f.playlists.length > PREVIEW.playlists) playlists.push(moreRow('playlists', f.playlists.length, i++));
      if (songs.length) out.appendChild(section('Songs', songs));
      if (artists.length) out.appendChild(section('Artists', artists));
      if (albums.length) out.appendChild(section('Albums', albums));
      if (playlists.length) out.appendChild(section('Playlists', playlists));
      $('srchBody').replaceChildren(out);
      applyHot();
      live.textContent = said;
    } else if (S.state === 'type') {
      renderType();
    }
  }

  /* ---- a type page: the type's field, the list, and the pager (NP-FIND-004) ---- */

  function typeRows() {
    var f = search(S.typeQ || S.lastQ);
    return S.type === 'playlists' ? f.playlists : f.songs;
  }
  function renderType() {
    var rows = typeRows();
    var n = PAGE_ROWS[S.type] || 25;
    var noun = S.type === 'playlists' ? ['playlist', 'playlists'] : ['song', 'songs'];
    var label = S.type === 'playlists' ? 'Playlists' : 'Songs';
    var back = $('srchBack');
    if (back) back.hidden = false;
    var type = $('srchType');
    if (type) {
      type.hidden = false;
      type.querySelectorAll('.srch__segbtn').forEach(function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-type') === (S.type === 'playlists' ? 'playlists' : 'tracks'))); });
    }
    var q = $('srchTypeQ');
    if (q && document.activeElement !== q) q.value = S.typeQ || S.lastQ;
    $('srchCount').innerHTML = '<b>' + label + ':</b> ' + plural(rows.length, noun[0], noun[1]) + ' for “' + esc(S.typeQ || S.lastQ) + '”';
    var out = list('All ' + label.toLowerCase());
    var i = 0;
    rows.forEach(function (r, k) {
      var el = S.type === 'playlists' ? playlistRow(r, i) : songRow(r, i);
      if (!el) return;
      el.setAttribute('data-page', String(Math.floor(k / n)));
      out.appendChild(el);
      i++;
    });
    var body = $('srchBody');
    body.replaceChildren(out);
    if (rows.length) {
      var end = document.createElement('div');
      end.className = 'srch__end';
      end.textContent = 'That’s all ' + plural(rows.length, noun[0], noun[1]) + '.';
      body.appendChild(end);
    } else {
      msg('No ' + noun[1] + ' for “' + esc(S.typeQ || S.lastQ) + '”.');
    }
    applyHot();
    paintPager();
    $('srchLive').textContent = plural(rows.length, noun[0], noun[1]) + ', page ' + (S.page + 1) + ' of ' + pages();
  }
  function pages() {
    var n = PAGE_ROWS[S.type] || 25;
    return Math.max(1, Math.ceil(typeRows().length / n));
  }
  function paintPager() {
    var foot = $('srchFoot');
    if (!foot) return;
    foot.hidden = !typeRows().length;
    var of = pages();
    if ($('srchPrev')) $('srchPrev').disabled = S.page === 0;
    if ($('srchNext')) $('srchNext').disabled = S.page >= of - 1;
    if ($('srchPageOf')) $('srchPageOf').textContent = 'Page ' + (S.page + 1) + ' of ' + of;
  }
  function turn(by) {
    var to = S.page + by;
    if (to < 0 || to >= pages()) return;
    var row = $('srchBody').querySelector('.srch__row[data-page="' + to + '"]');
    if (!row) return;
    var body = $('srchBody');
    body.scrollTop = row.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
    S.page = to;
    S.hot = Number(row.getAttribute('data-i'));
    applyHot();
    paintPager();
  }
  function pageFromScroll() {
    var body = $('srchBody');
    var rows = body.querySelectorAll('.srch__row[data-page]');
    if (!rows.length) return;
    var top = body.getBoundingClientRect().top;
    var page = Number(rows[rows.length - 1].getAttribute('data-page'));
    var atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 2;
    if (!atEnd) for (var i = 0; i < rows.length; i++) if (rows[i].getBoundingClientRect().bottom - top > 1) { page = Number(rows[i].getAttribute('data-page')); break; }
    if (page !== S.page) { S.page = page; paintPager(); }
  }

  function rows() { return $('srchBody').querySelectorAll('.srch__row[data-i]'); }
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
    S.type = null;
    S.typeQ = '';
    S.page = 0;
    S.state = 'loading';
    open();
    render();
    clearTimeout(searchTimer);
    // A moment of "Searching…", as a real lookup takes.
    searchTimer = setTimeout(function () {
      S.found = search(q);
      S.state = S.found.songs.length || S.found.playlists.length ? 'list' : 'empty';
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
    var song = t && DATA.songs.filter(function (s) { return s.t === t.textContent; })[0];
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
    if (p && !p.hidden && q.value.trim() && (id === 'search' || id === 'search-keys' || id === 'search-stale')) {
      // The captured overview states: carry on from what they show.
      S.lastQ = id === 'search-stale' ? 'harbour' : q.value.trim();
      S.found = search(S.lastQ);
      S.state = S.found.songs.length ? 'list' : 'empty';
      S.type = null;
      var hot = p.querySelector('.srch__row.is-hot');
      S.hot = hot ? Number(hot.getAttribute('data-i')) : -1;
    } else if (p && !p.hidden && q.value.trim() && TYPE_STATE[id]) {
      // A captured type page: the type's rows are the stock ones for its words; the pager works on them.
      S.lastQ = q.value.trim();
      S.type = TYPE_STATE[id];
      var tq = $('srchTypeQ');
      S.typeQ = tq && tq.value.trim() ? tq.value.trim() : S.lastQ;
      S.found = search(S.lastQ);
      S.state = 'type';
      S.page = 0;
      S.hot = -1;
    } else if (p && !p.hidden && q.value.trim()) {
      S.lastQ = q.value.trim();
      S.found = search(S.lastQ);
      S.state = 'view';
      S.type = null;
    } else {
      S = { found: null, hot: -1, state: 'idle', lastQ: '', added: S.added, type: null, typeQ: '', page: 0 };
    }
  }
  document.addEventListener('mockup:show', adopt);

  /* ---- wiring (on the document: each state is a fresh copy of the markup) ---- */

  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    if (t.id === 'libFind') { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); t.value = ''; filterList(''); } return; }
    if (t.id === 'srchTypeQ') {
      if (e.key === 'Enter' && S.state === 'type') { e.preventDefault(); e.stopPropagation(); S.typeQ = t.value.trim(); S.page = 0; S.hot = -1; renderType(); }
      else if (e.key === 'PageDown' || e.key === 'PageUp') { e.preventDefault(); turn(e.key === 'PageDown' ? 1 : -1); }
      return;
    }
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
      // The overview has no pages (NP-FIND-003); a type page turns its pages; a long list moves five rows.
      if (S.state === 'type') turn(e.key === 'PageDown' ? 1 : -1);
      else if (S.state !== 'list') move(e.key === 'PageDown' ? 5 : -5);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      var hot = showing && S.hot >= 0 ? $('srchBody').querySelector('.srch__row[data-i="' + S.hot + '"]') : null;
      if (hot && !$('srch').classList.contains('is-stale')) {
        var art = hot.querySelector('.srch__art[data-preview]');
        if (e.metaKey || e.ctrlKey) addRow(S.hot);
        else if (art) preview(art);
        else hot.click(); // an artist, an album, a playlist or "See all": the navigator follows it
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

  document.addEventListener('scroll', function (e) {
    if (e.target instanceof Element && e.target.id === 'srchBody' && S.state === 'type') pageFromScroll();
  }, true);

  // Clicks inside the popover: handled here before the navigator reads them as "away". (The
  // navigator has already followed any click it wired to another state.)
  document.addEventListener('click', function (e) {
    var t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    var inPop = t.closest('#srch');
    if (!inPop) {
      // A click away closes it, as in the app; in the captured search states the navigator does that.
      if (!t.closest('#searchBox') && !t.closest('#ctx') && $('srch') && !$('srch').hidden && !window.mockup.template(window.mockup.current()).hasAttribute('data-mock-dismiss')) close();
      if (t.closest('#libFindClear')) { var f = $('libFind'); f.value = ''; filterList(''); f.focus(); }
      return;
    }
    if (t.closest('input, label, .srch__segbtn, .srch__menu')) return;
    if (t.closest('#srchTypeForm button')) { e.preventDefault(); e.stopPropagation(); var tq = $('srchTypeQ'); if (tq && S.state === 'type') { S.typeQ = tq.value.trim(); S.page = 0; S.hot = -1; renderType(); } return; }
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
