"""
Build music-player/index.html (the shell) from design/frontends/origin/airwave-now-playing.html.

The frontend file is read-only reference material; this script is the record of every edit the
player makes to it, each asserted against the exact text it replaces so a drift in the source is a
loud failure, not a silent one. Run it to regenerate the shell:  python scripts/make-shell.py

What changes, and why (see .agents/plans/2026-09-21-airwave-oneshot.md, Step C):
  1. the import map to jsdelivr goes: three.js is bundled by Vite through the bridge and Script D;
  2. the bridge module loads first and the app script waits for it (window.__npStart);
  3. window.LIBRARY is the real library the bridge loads, not sixteen invented rows;
  4. playback is the PlaybackEngine's: the transport asks window.NP_PLAYER, and its position is the
     element's, not a one-second clock;
  5. Statistics reads this player's history only; the generated demo year and its option are gone;
  6. the invented Live TV / TV / Movies catalogue, the demo history and the base64 demo clips go;
  7. the direct call to api.anthropic.com goes (no third-party accounts);
  8. Sources > Music gains the real "Add a folder" / "Add files" the bridge provides.
"""
from __future__ import annotations
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'design' / 'frontends' / 'origin' / 'airwave-now-playing.html'
DST = ROOT / 'music-player' / 'index.html'

text = SRC.read_text(encoding='utf-8')
edits = 0


def replace(old: str, new: str, count: int = 1) -> None:
    global text, edits
    n = text.count(old)
    assert n == count, f'expected {count} occurrence(s), found {n}: {old[:80]!r}'
    text = text.replace(old, new)
    edits += 1


def replace_between(start: str, end: str, new: str) -> None:
    """Replace from the line containing `start` up to and including the line containing `end`."""
    global text, edits
    i = text.index(start)
    i = text.rfind('\n', 0, i) + 1
    j = text.index(end, i) + len(end)
    j = text.index('\n', j - 1) + 1
    text = text[:i] + new + text[j:]
    edits += 1


# ---- 1. head: no CDN import map; the player's own metas and icons; the title ---------------------
replace_between('<script type="importmap">', '</script>', '')
replace('<title>Now Playing — status bar header</title>',
        '<title>Airwave</title>\n'
        '<meta name="color-scheme" content="light">\n'
        '<meta name="theme-color" content="#dfe4ea">\n'
        '<meta name="description" content="An offline-first music player for the music already on your device.">\n'
        '<meta name="mobile-web-app-capable" content="yes">\n'
        '<meta name="apple-mobile-web-app-capable" content="yes">\n'
        '<meta name="apple-mobile-web-app-title" content="Airwave">\n'
        '<link rel="icon" href="icon.svg" type="image/svg+xml">\n'
        '<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png">')
replace('<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">')

# ---- 2. the bridge loads first; the app script runs when it says so ------------------------------
# Script C opens with window.ALBUMS; it closes with applyMode(mode); })(); </script> before Script D.
replace('<script>\n  /* Both albums, in one place: the inline script reads the metadata, the 3D',
        '<script type="module" src="/src/shell/bridge.ts"></script>\n'
        '<script>\n'
        '  /* The app. It runs when the bridge has the library and the store ready (see\n'
        '     src/shell/bridge.ts), so what it reads at boot is real. */\n'
        '  window.__npStart = function () {\n'
        '  /* Both albums, in one place: the inline script reads the metadata, the 3D')
replace("    applyMode(mode);\n  })();\n</script>\n\n\n<script type=\"module\">\n/* ------------------------------------------------------------------\n   CD jewel case",
        "    applyMode(mode);\n  })();\n  };\n</script>\n\n\n<script type=\"module\">\n/* ------------------------------------------------------------------\n   CD jewel case")

# ---- 3. the library is the bridge's ---------------------------------------------------------------
replace_between("  window.LIBRARY = (function () {\n    var solo = { artist: 'Fennel Grove'",
                "        url: pf.url(encodeURIComponent(r[1].artist + ' ' + r[0])),\n      };\n    });\n  })();",
                "  /* The library: the tracks indexed from this device's folders and files, loaded by the bridge\n"
                "     before this runs. Rows arriving from search are appended by library:add as before. */\n"
                "  window.LIBRARY = window.LIBRARY || [];\n")
# the library module re-renders when the bridge changes the rows
replace("    document.addEventListener('library:add', function (e) {\n      var d = e.detail;\n      var have = null;",
        "    /* The bridge replaced the rows (a folder was added, a rescan finished): draw them. */\n"
        "    document.addEventListener('library:refresh', function () {\n"
        "      if (selectedId && !song(selectedId)) selectedId = null;\n"
        "      render();\n"
        "    });\n\n"
        "    document.addEventListener('library:add', function (e) {\n      var d = e.detail;\n      var have = null;")
# demo history
replace_between("    /* Demo listening history, in the same spirit as the songs and albums",
                "    var DEMO_HISTORY = ['song-13', 'song-6', 'song-2', 'song-11', 'song-15', 'song-4'];",
                "")
replace("      if (!state.history.length) state.history = DEMO_HISTORY.slice();\n", "")

# ---- 3b. the two albums are states, not an invented catalogue ------------------------------------------
# The jewel case keeps its generated art; the words on it come from what is really playing. Solo is the
# track chosen from the library; group is the shared session, which has no invented broadcast behind it.
replace("      title: 'Midnight Set, Side B',\n      artist: 'Fennel Grove',\n      album: 'Long Wave Sessions, Vol. 2',\n      live: false,\n      total: 178,\n      start: 23,\n      nowPlaying: 'Midnight Set',",
        "      title: 'Nothing playing',\n      artist: '',\n      album: '',\n      live: false,\n      total: 0,\n      start: 0,\n      nowPlaying: 'Choose a song from the library',")
replace("        spine: 'FENNEL GROVE — MIDNIGHT SET, SIDE B',\n        tracks: ['Ember Line', 'Slow Carousel', 'Paper Harbour', 'Midnight Set',\n                 'Side B', 'Long Wave', 'Fennel', 'Closing Hour'],\n        footer: 'Long Wave Recordings · LWR-042',",
        "        spine: '',\n        tracks: [],\n        footer: '',")
replace("      title: 'Harbour Lights',\n      artist: 'Cassette Bloom',\n      album: 'Live from Pier 9',\n      live: true,\n      start: 1247,          // seconds into the broadcast\n      nowPlaying: 'Harbour Lights',",
        "      title: 'No group session',\n      artist: '',\n      album: '',\n      live: false,\n      total: 0,\n      start: 0,\n      nowPlaying: 'Join a group in Settings ▸ Profile',")
replace("        spine: 'CASSETTE BLOOM — LIVE FROM PIER 9',\n        tracks: ['Signal Fade', 'Harbour Lights', 'Nine Below', 'Tideline',\n                 'Blue Hour', 'Gantry', 'Saltwater', 'Last Ferry'],\n        footer: 'Pier 9 Broadcasts · P9B-Live',",
        "        spine: '',\n        tracks: [],\n        footer: '',")
# the static markup applyMode() overwrites at boot says the same as the state does
replace('        <h2 class="player__title">Midnight Set, Side B</h2>\n        <p class="player__artist">Fennel Grove</p>\n        <p class="player__album">Long Wave Sessions, Vol. 2</p>',
        '        <h2 class="player__title">Nothing playing</h2>\n        <p class="player__artist"></p>\n        <p class="player__album"></p>')
# a chosen song is the solo session; there is no invented artist to route by
replace("      var target = window.ALBUMS.solo.artist === sg.artist ? 'solo' : 'group';", "      var target = 'solo';")
# the bar cannot divide by an empty album
replace("        var dur = total();\n        fill.style.width = (cur / dur) * 100 + '%';", "        var dur = total() || 1;\n        fill.style.width = (cur / dur) * 100 + '%';")

# ---- 4. playback is real --------------------------------------------------------------------------
# library:play → the engine plays the file; the transport still paints from the position it reports
replace("      window.ALBUMS[target].nowPlaying = sg.title;\n      pos[target] = 0;\n      playing = true;\n      applyMode(target);\n      setPlaying(true);\n    });",
        "      window.ALBUMS[target].nowPlaying = sg.title;\n      pos[target] = 0;\n      playing = true;\n      applyMode(target);\n      setPlaying(true);\n"
        "      /* A row from this device plays for real; the engine's position drives the bar from here. */\n"
        "      if (sg.local && window.NP_PLAYER) {\n"
        "        window.NP_PLAYER.play(sg.id).then(function (r) {\n"
        "          if (!r.ok) { setPlaying(false); if (r.reason) window.say(r.reason); }\n"
        "        });\n"
        "      }\n"
        "    });")
# play/pause reaches the engine
replace("      if (isLive()) { window.say(LIVE_MSG); return; }\n      setPlaying(!playing);\n    });",
        "      if (isLive()) { window.say(LIVE_MSG); return; }\n"
        "      if (engineDriven()) { if (playing) window.NP_PLAYER.pause(); else window.NP_PLAYER.resume(); }\n"
        "      setPlaying(!playing);\n    });")
# seeking by pointer and keyboard reaches the engine
replace("      pos[mode] = Math.min(total(),\n                  Math.max(0, ((e.clientX - r.left) / r.width) * total()));\n      paint();\n    }",
        "      pos[mode] = Math.min(total(),\n                  Math.max(0, ((e.clientX - r.left) / r.width) * total()));\n"
        "      if (engineDriven()) window.NP_PLAYER.seek(pos[mode]);\n      paint();\n    }")
replace("      else if (e.key === ' ') setPlaying(!playing);\n      else handled = false;\n      if (handled) { e.preventDefault(); paint(); }",
        "      else if (e.key === ' ') { if (engineDriven()) { if (playing) window.NP_PLAYER.pause(); else window.NP_PLAYER.resume(); } setPlaying(!playing); }\n"
        "      else handled = false;\n"
        "      if (handled) { e.preventDefault(); if (engineDriven() && e.key !== ' ') window.NP_PLAYER.seek(pos[mode]); paint(); }")
replace("      if (isLive()) { window.say(LIVE_MSG); return; }\n      pos[mode] = 0;\n      paint();\n    });",
        "      if (isLive()) { window.say(LIVE_MSG); return; }\n      pos[mode] = 0;\n      if (engineDriven()) window.NP_PLAYER.seek(0);\n      paint();\n    });")
replace("      reportHeard(mode, false); heardSecs[mode] = 0;\n      pos[mode] = repeatOn ? 0 : total();\n      if (!repeatOn) setPlaying(false);\n      paint();",
        "      reportHeard(mode, false); heardSecs[mode] = 0;\n      pos[mode] = repeatOn ? 0 : total();\n"
        "      if (engineDriven()) { if (repeatOn) window.NP_PLAYER.seek(0); else window.NP_PLAYER.pause(); }\n"
        "      if (!repeatOn) setPlaying(false);\n      paint();")
# the clock: the engine's position when a real file is playing, the old clock only for the broadcast
replace_between("    setInterval(function () {\n      if (!playing || dragging) return;\n      if (isLive()) { pos[mode] += 1; paint(); return; }   // broadcast clock climbs",
                "    }, 1000);",
                "    /* Whether the bar follows the audio element (a track from this device) or the broadcast\n"
                "       clock (the live session, which has no element here). */\n"
                "    function engineDriven() { return !!(window.NP_PLAYER && chosen[mode] && chosen[mode].local); }\n"
                "    function trackEnded() {\n"
                "      /* the end of the track, reached by playing rather than by seeking */\n"
                "      if (chosen[mode]) { reportHeard(mode, heardSecs[mode] >= total() * 0.9); heardSecs[mode] = 0; }\n"
                "      if (repeatOn) { pos[mode] = 0; if (engineDriven()) { window.NP_PLAYER.seek(0); window.NP_PLAYER.resume(); } paint(); }\n"
                "      else if (!document.dispatchEvent(new CustomEvent('transport:next', { cancelable: true }))) { /* the list played the next one */ }\n"
                "      else setPlaying(false);\n"
                "    }\n"
                "    if (window.NP_PLAYER) {\n"
                "      window.NP_PLAYER.onState(function (s) {\n"
                "        if (!engineDriven() || dragging) return;\n"
                "        var was = pos[mode];\n"
                "        pos[mode] = s.positionMs / 1000;\n"
                "        if (s.durationMs && chosen[mode]) chosen[mode].duration = Math.round(s.durationMs / 1000);\n"
                "        if (s.status === 'playing' && pos[mode] > was) heardSecs[mode] += pos[mode] - was;\n"
                "        if (s.status === 'playing' !== playing && s.status !== 'loading') setPlaying(s.status === 'playing');\n"
                "        if (s.status === 'error' && s.error) window.say(s.error);\n"
                "        paint();\n"
                "        if (s.status === 'ended') trackEnded();\n"
                "      });\n"
                "    }\n"
                "    setInterval(function () {\n"
                "      if (!playing || dragging) return;\n"
                "      if (isLive()) { pos[mode] += 1; paint(); return; }   // broadcast clock climbs\n"
                "      if (engineDriven()) return;                          // the element keeps this time\n"
                "      /* a row from somewhere else (a search result with a link) has no audio here: the bar\n"
                "         does not pretend to play it */\n"
                "      if (chosen[mode]) { setPlaying(false); window.say('Only tracks on this device play here. Open it where it lives.'); return; }\n"
                "      if (pos[mode] < total()) { pos[mode] += 1; paint(); if (pos[mode] >= total()) { if (repeatOn) { pos[mode] = 0; paint(); } else setPlaying(false); } }\n"
                "    }, 1000);\n")
# the chosen track remembers whether it is local
replace("      chosen[target] = { id: sg.id, title: sg.title, artist: sg.artist, album: sg.album, duration: sg.duration };",
        "      chosen[target] = { id: sg.id, title: sg.title, artist: sg.artist, album: sg.album, duration: sg.duration, local: !!sg.local };")
# the admissions
replace("  // It used to be scenery: the library's playback is simulated, so the slider",
        "  // It used to be scenery: before the engine, the library had no audio, so the slider")
replace("       track's own length, because the library's playback is simulated and",
        "       track's own length, because before the engine the library had no audio and")

# ---- 5. Statistics: this player's history only -----------------------------------------------------
replace("  var S = { src: 'demo', scope: 'all',", "  var S = { src: 'browser', scope: 'all',")
replace("  if (S.src === 'import') S.src = 'demo';  // an imported file is kept for the visit only",
        "  if (S.src === 'import' || S.src === 'demo') S.src = 'browser';  // an imported file is kept for the visit only")
replace("  var sets = { demo: null, browser: null, import: null };\n  var browserEvents = AW.readBrowserHistory();\n"
        "  /* The player's own history is the default whenever there is one; the demo\n     year is there to show the page, and says so. */\n"
        "  if (!S.srcChosen) S.src = browserEvents ? 'browser' : 'demo';\n"
        "  function dataset() {\n"
        "    if (S.src === 'browser' && browserEvents) return sets.browser || (sets.browser = new AW.Dataset(browserEvents, 'This player’s history'));\n"
        "    if (S.src === 'import' && sets.import) return sets.import;\n"
        "    S.src = 'demo';\n"
        "    return sets.demo || (sets.demo = new AW.Dataset(AW.buildDemo(), 'Demo year'));\n  }",
        "  var sets = { browser: null, import: null };\n"
        "  /* What this player has recorded, and nothing generated: an empty history is an empty year. */\n"
        "  var browserEvents = AW.readBrowserHistory() || [];\n"
        "  if (!S.srcChosen) S.src = 'browser';\n"
        "  function dataset() {\n"
        "    if (S.src === 'import' && sets.import) return sets.import;\n"
        "    S.src = 'browser';\n"
        "    return sets.browser || (sets.browser = new AW.Dataset(browserEvents, 'This player’s history'));\n  }")
replace('              <option value="demo">Demo year</option>\n', '')
# The genre list's empty state, which the demo year never showed: a list holds list items or is not a
# list (axe aria-required-children), and with no search typed there is nothing to "match".
replace("    }).join('') : '<p class=\"glist__empty\">Nothing matches “' + esc(q) + '”.</p>');",
        "    }).join('') : '<p class=\"glist__empty\">' + (q ? 'Nothing matches “' + esc(q) + '”.' : 'Nothing recorded in this period yet.') + '</p>');\n"
        "    $('gList').setAttribute('role', shown.length ? 'list' : 'group');")
# reopening Statistics re-reads the history; an empty one is an empty year, never a fallback
replace("    browserEvents = AW.readBrowserHistory(); sets.browser = null;\n"
        "    if (!S.srcChosen && S.src !== 'import') S.src = browserEvents ? 'browser' : 'demo';\n"
        "    if (S.src === 'browser' && !browserEvents) S.src = 'demo';",
        "    browserEvents = AW.readBrowserHistory() || []; sets.browser = null;\n"
        "    if (!S.srcChosen && S.src !== 'import') S.src = 'browser';")
replace("    $('dataNote').textContent = (S.src === 'demo'\n"
        "      ? 'You are looking at a generated demo year: ' + fmt.int(ds.events.length) + ' plays and sessions from ' + fmt.date(ds.start, true) + ' to today, with genres, tags and sound data. Import your own history to replace it for this visit.'\n"
        "      : S.src === 'browser'",
        "    $('dataNote').textContent = (S.src === 'browser' && !ds.events.length\n"
        "      ? 'Nothing has been recorded yet. Plays and sessions appear here as you listen; nothing is generated to fill the space.'\n"
        "      : S.src === 'browser'")
# the generated year itself is not shipped
replace_between("  /* ---------------- the demo library ---------------- */", "    return ev;\n  };", "")

# three.js comes from the bridge (window.THREE, bundled by Vite); there is no CDN import to fall back to
replace("      var load = ready.then(function () { return Promise.all([import('three'), import('three/addons/controls/OrbitControls.js')]); })\n"
        "        .then(function (m) { window.THREE = Object.assign({}, m[0], { OrbitControls: m[1].OrbitControls }); });",
        "      var load = ready.then(function () { if (!window.NP_THREE) throw new Error('three.js was not bundled'); return window.NP_THREE(); });")

# ---- 6. no invented catalogue, no demo clips ---------------------------------------------------------
replace_between("    var CHANNELS = [\n      { id: 'ch2',", "    ];", "    /* Channels, shows and films arrive from the companion; until it sends any, these are empty. */\n    var CHANNELS = [];\n")
replace_between("    var SHOWS = [\n      { id: 'sh1'", "    ];", "    var SHOWS = [];\n")
replace_between("    var MOVIES = [\n      { id: 'mv1'", "    ];", "    var MOVIES = [];\n")
# the base64 clips: the whole line
i = text.index('window.VP_DEMO = ')
line_start = text.rfind('\n', 0, i) + 1
line_end = text.index('\n', i)
assert line_end - line_start > 100_000, 'the VP_DEMO line is not the long one'
text = text[:line_start] + "window.VP_DEMO = {};  /* no sample clips ship; every title needs a real source */" + text[line_end:]
edits += 1

# ---- 7. no third-party account ------------------------------------------------------------------------
# The search chain loses its web-search leg (a direct call to api.anthropic.com), and the pasted-link
# resolver its fallback to the same. The remaining legs are the companion, iTunes and oEmbed.
replace_between("    /* in-artifact: the platform injects credentials; everywhere else this",
                "              function (e) { clearTimeout(t); throw e; });\n    }",
                "    /* No web-search leg: it needed a third-party account, and this player keeps none. */\n"
                "    function anthropic() { return Promise.reject(new Error('no web-search provider')); }\n")
replace("      var chain = [companionSearch, itunesSearch, anthropicSearch];", "      var chain = [companionSearch, itunesSearch];")
replace("     viewer (strict CSP: only api.anthropic.com is fetchable), a downloaded", "     viewer (strict CSP), a downloaded")

# ---- 8. Sources > Music: the real library controls ---------------------------------------------------------
replace('            <label for="srcMusic">Library folder</label>\n'
        '            <input class="prefs__field" type="text" id="srcMusic" placeholder="C:\\Users\\you\\Music" spellcheck="false">\n'
        '          </div>\n'
        '          <p class="prefs__hint">Scanned by the companion app. Until it is running, the built-in library is used.</p>',
        '            <span class="prefs__label">On this device</span>\n'
        '            <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">\n'
        '              <button class="prefs__btn" type="button" id="libAddFolder">Add a folder…</button>\n'
        '              <button class="prefs__btn" type="button" id="libAddFiles">Add files…</button>\n'
        '              <input type="file" id="libFiles" accept="audio/*" multiple hidden>\n'
        '              <button class="prefs__btn" type="button" id="libRescan">Rescan</button>\n'
        '            </div>\n'
        '          </div>\n'
        '          <p class="prefs__hint" id="libSourceNote">Music is indexed where it already is; nothing is copied. A folder is remembered where the browser allows it, files for this visit.</p>\n'
        '          <ul class="prefs__list" id="libRoots" aria-label="Music folders"></ul>\n'
        '          <div class="prefs__row">\n'
        '            <label for="srcMusic">Companion folder</label>\n'
        '            <input class="prefs__field" type="text" id="srcMusic" placeholder="C:\\Users\\you\\Music" spellcheck="false">\n'
        '          </div>\n'
        '          <p class="prefs__hint">The folder the companion app scans on its PC, for the library it shares through the hub.</p>')

# the wiring for those controls lives at the end of Script C, before the transport's closing
replace("    /* Leaving the page is the last chance to say how far a track got. */\n    window.addEventListener('pagehide', function () { reportHeard(mode, false); });\n\n    applyMode(mode);\n  })();\n  };\n</script>",
        "    /* Leaving the page is the last chance to say how far a track got. */\n    window.addEventListener('pagehide', function () { reportHeard(mode, false); });\n\n    applyMode(mode);\n  })();\n\n"
        "  /* Sources > Music: the library on this device, through the bridge. */\n"
        "  (function () {\n"
        "    var lib = window.NP_LIBRARY; if (!lib) return;\n"
        "    var folderBtn = document.getElementById('libAddFolder'), filesBtn = document.getElementById('libAddFiles');\n"
        "    var fileInput = document.getElementById('libFiles'), rescanBtn = document.getElementById('libRescan');\n"
        "    var list = document.getElementById('libRoots'), note = document.getElementById('libSourceNote');\n"
        "    if (!lib.supportsFolders()) { folderBtn.hidden = true; rescanBtn.hidden = true; note.textContent = 'This browser cannot keep a folder, so files are added for this visit only.'; }\n"
        "    function esc(t) { return String(t).replace(/[&<>\"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[c]; }); }\n"
        "    function paintRoots() {\n"
        "      lib.roots().then(function (roots) {\n"
        "        list.innerHTML = roots.length ? roots.map(function (r) {\n"
        "          return '<li class=\"prefs__item\"><span>' + esc(r.displayName) + '</span><span class=\"prefs__status\">' + r.trackCount + (r.trackCount === 1 ? ' track' : ' tracks') + (r.lastScanError ? ' · ' + esc(r.lastScanError) : '') + '</span>' +\n"
        "            '<button class=\"prefs__btn\" type=\"button\" data-forget=\"' + esc(r.id) + '\">Forget</button></li>';\n"
        "        }).join('') : '<li class=\"prefs__item prefs__status\">No folders or files yet. Add some and they are indexed here.</li>';\n"
        "      });\n"
        "    }\n"
        "    function done(r, verb) { window.say(r.added ? verb + ' ' + r.added + ' track' + (r.added === 1 ? '' : 's') : (r.reason || 'Nothing new was found')); if (r.reason && r.added) window.say(r.reason); paintRoots(); }\n"
        "    folderBtn.addEventListener('click', function () { folderBtn.disabled = true; lib.addFolder().then(function (r) { folderBtn.disabled = false; done(r, 'Added'); }); });\n"
        "    filesBtn.addEventListener('click', function () { fileInput.click(); });\n"
        "    fileInput.addEventListener('change', function () { var files = [].slice.call(fileInput.files || []); fileInput.value = ''; if (files.length) lib.addFiles(files).then(function (r) { done(r, 'Added'); }); });\n"
        "    rescanBtn.addEventListener('click', function () { rescanBtn.disabled = true; lib.rescan().then(function (r) { rescanBtn.disabled = false; done(r, 'Found'); }); });\n"
        "    list.addEventListener('click', function (e) { var b = e.target.closest('[data-forget]'); if (!b) return; if (!confirm('Forget this source? Your files are not touched; only the index is removed.')) return; lib.forgetRoot(b.getAttribute('data-forget')).then(paintRoots); });\n"
        "    paintRoots();\n"
        "  })();\n"
        "  };\n</script>")

# ---- 8b. Back Up Now does not claim a request reached anyone ----------------------------------------------
# There is no route by which this player can start a backup on another machine; the companion runs
# its own from Settings > Backup. The pane measures and says so, rather than logging "requested".
replace("      b.last = Date.now(); cfgSave();\n"
        "      connAdd({ at: new Date().toTimeString().slice(0, 8), who: 'Backup', text: what + ' → ' + BK_TO[b.to], ok: true, result: 'requested' });\n"
        "      paintBackup();\n"
        "      document.getElementById('bkMsg').textContent = 'Requested: ' + what + ' to the ' + (b.to === 'both' ? 'container and this PC' : BK_TO[b.to].toLowerCase()) + '. The companion app does the copying and shows it in its Transfers view.';\n"
        "      setStatus('Backup requested.');",
        "      connAdd({ at: new Date().toTimeString().slice(0, 8), who: 'Backup', text: what + ' → ' + BK_TO[b.to], ok: true, result: 'measured only' });\n"
        "      paintBackup();\n"
        "      document.getElementById('bkMsg').textContent = 'This backup would hold ' + what + ' and fit where it goes. Nothing was sent: the copying starts in the companion app, under Settings ▸ Backup on the PC that keeps the folders. Its figures are these figures.';\n"
        "      setStatus('Backup measured.');")

# ---- 9. the hub credential carries what HubClient needs ---------------------------------------------------
replace("              hubAcct = { base: base, credentialId: d.json.credentialId, secret: d.json.secret, scopes: d.json.scopes || [], hubName: d.json.hubName || c.hubName, deviceId: d.json.deviceId };",
        "              hubAcct = { base: base, credentialId: d.json.credentialId, secret: d.json.secret, scopes: d.json.scopes || [], hubName: d.json.hubName || c.hubName, deviceId: d.json.deviceId,\n"
        "                hubId: d.json.hubId || (conn.hub && conn.hub.id && conn.hub.id.hubId) || null, hubFingerprint: c.hubFingerprint || (conn.hub && conn.hub.id && conn.hub.id.fingerprint) || null };")

# ---- 10. Script D waits for the bridge (it reads ALBUMS, which the app defines) -------------------------------
m = re.search(r"<script type=\"module\">\n/\* -+\n   CD jewel case.*?\n(import [^\n]*\n(?:import [^\n]*\n)*)", text, re.S)
assert m, 'Script D imports'
# No top-level await (the single-file IIFE build cannot carry one), and three.js stays out of the
# first load: the static imports become dynamic ones inside the wait, so the 975 KB chunk is fetched
# when the scene is drawn, as the React app kept it (tests/perf/bundle-budget.test.ts).
d_end = text.index("</script>", m.end())
imports = m.group(1)
assert imports.startswith("import * as THREE from 'three';"), imports
dynamic = ("/* The app defines what this scene reads; the bridge says when it has run. */\n"
           "window.NP_READY.then(async function () {\n"
           "const [THREE, { RoomEnvironment }, { RectAreaLightUniformsLib }, { RoundedBoxGeometry }, BufferGeometryUtils] = await Promise.all([\n"
           "  import('three'), import('three/addons/environments/RoomEnvironment.js'), import('three/addons/lights/RectAreaLightUniformsLib.js'),\n"
           "  import('three/addons/geometries/RoundedBoxGeometry.js'), import('three/addons/utils/BufferGeometryUtils.js')]);\n")
text = text[:m.start(1)] + dynamic + text[m.end():d_end] + "});\n" + text[d_end:]
edits += 1

# ---- 11. the helper that served this page is found with nothing configured -------------------------------
# A helper injects its token meta into the page it serves. Then its own origin is the first place to
# look, and Connections asks at once rather than waiting for a click (the React player did the same).
replace("      if (!typed) for (var i = 0; i < HELPER_SCAN; i++) tries.push('http://127.0.0.1:' + (HELPER_PORT + i));",
        "      var servedBy = document.querySelector('meta[name=\"np-helper-token\"]') && /^https?:$/.test(location.protocol) ? location.origin : null;\n"
        "      if (!typed && servedBy) tries.push(servedBy);\n"
        "      if (!typed) for (var i = 0; i < HELPER_SCAN; i++) if ('http://127.0.0.1:' + (HELPER_PORT + i) !== servedBy) tries.push('http://127.0.0.1:' + (HELPER_PORT + i));")
replace("    document.getElementById('cfgConnect').addEventListener('click', testApp);",
        "    document.getElementById('cfgConnect').addEventListener('click', testApp);\n"
        "    /* Served by a helper: it is the companion's helper, and it answers now. */\n"
        "    if (document.querySelector('meta[name=\"np-helper-token\"]') && /^https?:$/.test(location.protocol)) testApp();")

# ---- 12. the Download key fetches for real, through the helper, with the reason stated ---------------------
# In the mockup it was a toggle that saved nothing. A row from this device is already here; a row
# that came from a link is fetched by the helper once the person says why they may have the file —
# the helper refuses without that, and so does this (lib/tools-core.ts runFetch).
replace("      var saved = dlBtn.getAttribute('aria-pressed') !== 'true';\n"
        "      dlBtn.setAttribute('aria-pressed', String(saved));\n"
        "      dlBtn.setAttribute('aria-label', saved ? 'Saved offline' : 'Download for offline');\n"
        "      dlBtn.querySelector('.dl-arrow').hidden = saved;\n"
        "      dlBtn.querySelector('.dl-check').hidden = !saved;",
        "      var c = chosen[mode];\n"
        "      if (!c) { window.say('Choose a song first'); return; }\n"
        "      if (c.local) { window.say('This song is already on this device'); return; }\n"
        "      var sg = (window.LIBRARY || []).filter(function (s) { return s.id === c.id; })[0];\n"
        "      if (!sg || !sg.url || !/^https?:/.test(sg.url)) { window.say('This row has no link to fetch from'); return; }\n"
        "      openFetch(sg);")
replace("    /* switching modes by hand clears that mode's chosen track, which is how\n       a group session gets back to the live edge */",
        "    /* The fetch sheet: why you may have this file, then the helper fetches it and it joins the\n"
        "       library as a real track. Built once, on first use. */\n"
        "    var BASES = [['user-owned', 'It is mine', 'Something you made or uploaded yourself.'],\n"
        "      ['creator-download', 'The creator offers it', 'The uploader turned downloads on, or says it may be downloaded.'],\n"
        "      ['public-domain', 'Public domain', 'Old enough, or released deliberately into the public domain.'],\n"
        "      ['licensed', 'Licensed to me', 'A Creative Commons licence that permits it, or a licence you hold.'],\n"
        "      ['purchased-export', 'I bought it', 'You paid for this and are fetching your own copy.']];\n"
        "    var fetchSheet = null;\n"
        "    function openFetch(sg) {\n"
        "      if (!fetchSheet) {\n"
        "        fetchSheet = document.createElement('dialog');\n"
        "        fetchSheet.className = 'sheet'; fetchSheet.id = 'npFetch'; fetchSheet.setAttribute('aria-labelledby', 'npFetchTitle');\n"
        "        fetchSheet.innerHTML = '<form method=\"dialog\" class=\"sheet__form\"><div class=\"sheet__body\">' +\n"
        "          '<p class=\"sheet__title\" id=\"npFetchTitle\">Fetch this song</p>' +\n"
        "          '<p class=\"sheet__msg\" id=\"npFetchMsg\"></p>' +\n"
        "          '<fieldset class=\"np-fetch__bases\"><legend class=\"sheet__msg\">Why you may have it</legend>' +\n"
        "          BASES.map(function (b, i) { return '<label class=\"np-fetch__basis\"><input type=\"radio\" name=\"npBasis\" value=\"' + b[0] + '\"> <b>' + b[1] + '</b> — ' + b[2] + '</label>'; }).join('') +\n"
        "          '</fieldset><p class=\"sheet__msg\" id=\"npFetchState\" role=\"status\"></p></div>' +\n"
        "          '<div class=\"sheet__actions\"><button class=\"sheet__btn\" type=\"button\" id=\"npFetchCancel\">Cancel</button>' +\n"
        "          '<button class=\"sheet__btn sheet__btn--default\" type=\"submit\" id=\"npFetchGo\" value=\"fetch\">Fetch</button></div></form>';\n"
        "        document.body.appendChild(fetchSheet);\n"
        "        fetchSheet.querySelector('#npFetchCancel').addEventListener('click', function () { fetchSheet.close(); });\n"
        "        fetchSheet.querySelector('form').addEventListener('submit', function (e) {\n"
        "          e.preventDefault();\n"
        "          var pick = fetchSheet.querySelector('input[name=\"npBasis\"]:checked'), go = fetchSheet.querySelector('#npFetchGo'), st = fetchSheet.querySelector('#npFetchState');\n"
        "          if (!pick) { st.textContent = 'Say why you may have this file first.'; return; }\n"
        "          if (!window.NP_TOOLS) { st.textContent = 'Fetching needs the local helper.'; return; }\n"
        "          var target = fetchSheet._song; go.disabled = true; st.textContent = 'Fetching…';\n"
        "          window.NP_TOOLS.fetch(target.url, pick.value).then(function (r) {\n"
        "            go.disabled = false;\n"
        "            if (!r.added) { st.textContent = r.reason || 'Nothing was saved.'; return; }\n"
        "            fetchSheet.close();\n"
        "            /* the link row gives way to the real file */\n"
        "            var lib = window.LIBRARY || [];\n"
        "            for (var k = lib.length - 1; k >= 0; k--) if (lib[k].id === target.id) lib.splice(k, 1);\n"
        "            document.dispatchEvent(new CustomEvent('library:refresh', { detail: { count: lib.length } }));\n"
        "            var got = lib.filter(function (s) { return s.id === r.trackId; })[0];\n"
        "            window.say('Fetched — it is in your library');\n"
        "            if (got) document.dispatchEvent(new CustomEvent('library:play', { detail: { song: got } }));\n"
        "          });\n"
        "        });\n"
        "      }\n"
        "      fetchSheet._song = sg;\n"
        "      fetchSheet.querySelector('#npFetchMsg').textContent = '“' + sg.title + '”' + (sg.artist ? ' by ' + sg.artist : '') + ' — fetched by the helper on this PC from ' + sg.url.replace(/^https?:\\/\\//, '').split('/')[0] + ', then played from this device.';\n"
        "      fetchSheet.querySelector('#npFetchState').textContent = '';\n"
        "      [].forEach.call(fetchSheet.querySelectorAll('input[name=\"npBasis\"]'), function (x) { x.checked = false; });\n"
        "      window.NP_TOOLS.detect().then(function (h) {\n"
        "        fetchSheet.querySelector('#npFetchState').textContent = h ? 'Using ' + h.label + '.' : 'No helper is answering on this PC, so Fetch will say so.';\n"
        "      });\n"
        "      fetchSheet.showModal();\n"
        "    }\n\n"
        "    /* switching modes by hand clears that mode's chosen track, which is how\n       a group session gets back to the live edge */")
replace("</style>\n",
        ".np-fetch__bases { border: 0; margin: 8px 0 0; padding: 0; display: grid; gap: 6px; }\n"
        ".np-fetch__basis { display: block; font-size: 12px; line-height: 1.4; }\n"
        "/* This repo's touch rule (UX-TOUCH-001): on a coarse pointer no visible text is under 12px.\n"
        "   The shell's own touch layer stepped most text up; these six it had left at 10–11px. Gated on\n"
        "   the pointer, so the desktop keeps the design as it was drawn. */\n"
        "@media (pointer: coarse) {\n"
        "  .tb__btn, .lib-scope__label, .lib-sortbtn, .mini__time, .ios-row__sub, .ios-foot, .prefs__back { font-size: 12px; }\n"
        "  /* ... and nothing tapped is under 44px (UX-TOUCH-002). The avatar and the bar already take taps\n"
        "     from an invisible overlay; it was sized for 30px and grows to 44. The rest grow themselves. */\n"
        "  .statusbar__avatar::after { inset: -12px; }\n"
        "  /* compact controls in rows and pills: a centred 44px overlay takes the tap, the drawing is unchanged */\n"
        "  .tb__btn, .lib-sortbtn, .lib-scope__badge, .mini__btn, .prefs__back { position: relative; }\n"
        "  .tb__btn::after, .lib-sortbtn::after, .lib-scope__badge::after, .mini__btn::after, .prefs__back::after {\n"
        "    content: ''; position: absolute; left: 50%; top: 50%; width: 44px; height: 44px;\n"
        "    min-width: 100%; transform: translate(-50%, -50%);\n"
        "  }\n"
        "  .volume__track { position: relative; }\n"
        "  .volume__track::after { content: ''; position: absolute; inset: -19px 0; }\n"
        "  .lib-find__input { min-height: 44px; }\n"
        "  .player__track::after { inset: -16px 0; }\n"
        "  .segmented__item { min-width: 44px; }\n"
        "  .segmented__item { position: relative; }\n"
        "  .segmented__item::after { content: ''; position: absolute; top: -11px; bottom: -11px; left: 0; right: 0; }\n"
        "  .transport__key { min-height: 44px; }\n"
        "  .search__input { min-height: 44px; }\n"
        "  /* The jewel case's glow bleeds past its stage by design; on a narrow screen it ran past the page's\n"
        "     edge. Clipped to the player (clip, not hidden: no scroll container, sticky parts unaffected). */\n"
        "  .player { overflow-x: clip; }\n"
        "}\n"
        "</style>\n")

# ---- 13. the product's name ------------------------------------------------------------------------------
# The product is Airwave (packages/contracts/src/branding.ts), as the frontend was drawn; "Now Playing"
# is the name of its home page, not of the app. Only the user agent differs from the drawing: it is a
# machine identifier that hubs and logs already know, so it keeps the value it has always had.
replace("AirwaveNowPlaying/1.0", "NowPlaying/1.0")

# ---- 14. streaming from a PC (AWSP, docs/AWSP.md §6) -----------------------------------------------------
# Sources ▸ Connections gains a third card: paste the PC's ticket, type its six-digit code, Pair. The
# PC's library joins the list as rows with `remote: true`; they play through the engine like rows from
# this device (the bridge points the element at the service worker's /awsp/track/<id>), and while one
# plays a small indicator beside the transport says how it is carried: direct, relay-carried, bridge.
replace('          <p class="prefs__hint" style="margin:0 0 10px">Two things this player can talk to.',
        '          <p class="prefs__hint" style="margin:0 0 10px">Three things this player can talk to.')
replace('          <h3 class="conn__sub" id="connPassedH">What’s passed</h3>',
        '          <section class="conn__card" aria-labelledby="connPcH">\n'
        '            <h3 class="conn__h" id="connPcH"><span class="conn__dot" id="connPcDot" data-state="off" aria-hidden="true"></span>Stream from a PC</h3>\n'
        '            <p class="conn__what">Plays the music on a PC running the companion app, from anywhere: lossless, end-to-end encrypted, carried by the PC’s relay. On the PC, Settings ▸ Remote shows its ticket and a six-digit code.</p>\n'
        '            <div class="prefs__row">\n'
        '              <label for="pcTicket">Ticket</label>\n'
        '              <input class="prefs__field" type="text" id="pcTicket" placeholder="endpoint…" spellcheck="false" autocomplete="off">\n'
        '            </div>\n'
        '            <div class="prefs__row">\n'
        '              <label for="pcCode">Pairing code</label>\n'
        '              <div class="conn__acts">\n'
        '                <input class="prefs__field" type="text" id="pcCode" inputmode="numeric" maxlength="6" placeholder="6 digits" spellcheck="false" autocomplete="one-time-code" style="flex:1 1 120px;width:auto">\n'
        '                <button class="prefs__btn" type="button" id="pcPair">Pair</button>\n'
        '                <button class="prefs__btn" type="button" id="pcForget" hidden>Forget</button>\n'
        '              </div>\n'
        '            </div>\n'
        '            <p class="prefs__hint" id="pcMsg" role="status">Not paired.</p>\n'
        '            <dl class="conn__facts" id="pcFacts" hidden></dl>\n'
        '          </section>\n\n'
        '          <h3 class="conn__sub" id="connPassedH">What’s passed</h3>')
# the indicator, in the stamps row right above the transport keys
replace('        <span class="player__live" id="live" role="status" hidden>\n'
        '          <span class="player__live-dot" aria-hidden="true"></span>LIVE\n'
        '        </span>\n',
        '        <span class="player__live" id="live" role="status" hidden>\n'
        '          <span class="player__live-dot" aria-hidden="true"></span>LIVE\n'
        '        </span>\n'
        '        <span class="player__conn" id="npConn" role="status" aria-label="How this track reaches you" hidden></span>\n')
replace("</style>\n",
        "/* How a track from the paired PC is carried (docs/AWSP.md §5): a quiet word between the stamps. */\n"
        ".player__conn { flex: none; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; line-height: 1; color: var(--player-time); opacity: 0.8; }\n"
        "</style>\n")
# a row from the PC plays through the engine, like a row from this device
replace("      if (sg.local && window.NP_PLAYER) {", "      if ((sg.local || sg.remote) && window.NP_PLAYER) {")
replace("      chosen[target] = { id: sg.id, title: sg.title, artist: sg.artist, album: sg.album, duration: sg.duration, local: !!sg.local };",
        "      chosen[target] = { id: sg.id, title: sg.title, artist: sg.artist, album: sg.album, duration: sg.duration, local: !!sg.local, remote: !!sg.remote };")
replace("    function engineDriven() { return !!(window.NP_PLAYER && chosen[mode] && chosen[mode].local); }",
        "    function engineDriven() { return !!(window.NP_PLAYER && chosen[mode] && (chosen[mode].local || chosen[mode].remote)); }")
replace("      if (c.local) { window.say('This song is already on this device'); return; }",
        "      if (c.local) { window.say('This song is already on this device'); return; }\n"
        "      if (c.remote) { window.say('This song streams from your PC'); return; }")
# the card's wiring, beside Sources > Music's
replace("    paintRoots();\n  })();\n  };\n</script>",
        "    paintRoots();\n  })();\n\n"
        "  /* Sources > Connections > Stream from a PC, through the bridge (window.NP_AWSP). */\n"
        "  (function () {\n"
        "    var ticketIn = document.getElementById('pcTicket'), codeIn = document.getElementById('pcCode');\n"
        "    var pairBtn = document.getElementById('pcPair'), forgetBtn = document.getElementById('pcForget');\n"
        "    var msg = document.getElementById('pcMsg'), dot = document.getElementById('connPcDot'), facts = document.getElementById('pcFacts');\n"
        "    var TYPE = { relay: 'relay-carried — end-to-end encrypted, through the PC’s relay', direct: 'direct', bridge: 'bridge' };\n"
        "    function fill(rows) {\n"
        "      facts.innerHTML = '';\n"
        "      rows.forEach(function (r) { var dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = r[0]; dd.textContent = r[1]; facts.appendChild(dt); facts.appendChild(dd); });\n"
        "      facts.hidden = !rows.length;\n"
        "    }\n"
        "    function paint() {\n"
        "      var a = window.NP_AWSP; if (!a) return;\n"
        "      a.status().then(function (s) {\n"
        "        var name = s.serverName || 'your PC';\n"
        "        forgetBtn.hidden = !s.paired;\n"
        "        dot.setAttribute('data-state', s.status === 'connected' ? 'ok' : s.status === 'refused' ? 'bad' : s.paired ? 'warn' : 'off');\n"
        "        if (!s.paired) { fill([]); if (!pairBtn.disabled) msg.textContent = 'Not paired.'; return; }\n"
        "        msg.textContent = s.status === 'connected' ? 'Paired with ' + name + '.'\n"
        "          : s.status === 'refused' ? (s.lastError || 'The PC no longer accepts this player. Pair again.')\n"
        "          : s.status === 'reconnecting' || s.status === 'connecting' ? 'Paired with ' + name + '. Reaching it…'\n"
        "          : 'Paired with ' + name + '. Not connected.';\n"
        "        fill([['PC', name], ['Connection', s.connectionType ? (TYPE[s.connectionType] || s.connectionType) : 'not connected'], ['Tracks', String(s.tracks)],\n"
        "              ['This player', s.endpointId ? s.endpointId.slice(0, 16) + '…' : '—']]);\n"
        "      });\n"
        "    }\n"
        "    pairBtn.addEventListener('click', function () {\n"
        "      var a = window.NP_AWSP;\n"
        "      if (!a) { msg.textContent = 'Streaming from a PC needs the served player; this copy cannot do it.'; return; }\n"
        "      pairBtn.disabled = true; msg.textContent = 'Pairing…'; dot.setAttribute('data-state', 'off');\n"
        "      a.pair(ticketIn.value, codeIn.value).then(function (r) {\n"
        "        pairBtn.disabled = false;\n"
        "        if (!r.ok) { msg.textContent = r.reason; dot.setAttribute('data-state', 'bad'); return; }\n"
        "        codeIn.value = ''; window.say('Paired with ' + (r.serverName || 'your PC')); paint();\n"
        "      });\n"
        "    });\n"
        "    forgetBtn.addEventListener('click', function () {\n"
        "      if (!confirm('Forget this PC? Its tracks leave the list; pairing again needs a new code.')) return;\n"
        "      window.NP_AWSP.forget().then(paint);\n"
        "    });\n"
        "    (window.NP_AWSP_READY || Promise.resolve(null)).then(function (a) {\n"
        "      if (!a) { pairBtn.disabled = true; msg.textContent = 'Streaming from a PC needs the served player; this copy cannot do it.'; return; }\n"
        "      a.on('status', paint); a.on('connection', paint); a.on('library', paint);\n"
        "      paint();\n"
        "    });\n"
        "  })();\n"
        "  };\n</script>")

# ---- groups: Make Invite Link only when this player may invite -------------------------------------------
# Every invite route on the hub is gated on the group:admin scope (packages/contracts, routes.ts), and the
# Devices tab's default pairing does not grant it, while creating a group needs only group:member. Without
# this, a player that owns a group it made is shown a button that can only fail, and the 403 it gets is
# blamed on its role rather than on the permission it was paired without. Found by tests/journey step 06.
replace("    function canInvite(g) { return g.myRole === 'owner' || g.myRole === 'admin'; }",
        "    function hasScope(s) { return !!(hubAcct && hubAcct.scopes && hubAcct.scopes.indexOf(s) >= 0); }\n"
        "    function canInvite(g) { return (g.myRole === 'owner' || g.myRole === 'admin') && hasScope('group:admin'); }")
replace("r.status === 403 ? 'Only the group’s owner or an admin can invite.'",
        "r.status === 403 ? (hasScope('group:admin') ? 'Only the group’s owner or an admin can invite.' : "
        "'This player was paired without the “Manage groups” permission. Pair it again with that ticked, or invite from the container.')")

# ---- search: the hub leg — enriched results when paired (sub-project 2, NP-FIND-001) ----------------
# The paired hub's /search answers from its enrichment cache: real artist with features, album,
# genre and tempo. Unpaired (or keyless), nothing changes: the companion/iTunes chain below is the
# whole story, which is the keyless-first rule this product runs on.

replace("    function getJSON(url, allowJsonp, ms) {\n"
        "      var ctl = window.AbortController ? new AbortController() : null;\n"
        "      var t = ctl ? setTimeout(function () { ctl.abort(); }, ms || 12000) : 0;\n"
        "      return fetch(url, { signal: ctl ? ctl.signal : undefined })",
        "    function getJSON(url, allowJsonp, ms, headers) {\n"
        "      var ctl = window.AbortController ? new AbortController() : null;\n"
        "      var t = ctl ? setTimeout(function () { ctl.abort(); }, ms || 12000) : 0;\n"
        "      return fetch(url, { signal: ctl ? ctl.signal : undefined, headers: headers || undefined })")

replace("        bpmTried: false,",
        "        bpmTried: false,\n"
        "        feat: [], genre: null, conf: null,")

replace("    var DEADLINE = 8000;",
        "    /* ---- the hub leg: enriched results when paired (NP-FIND-001) ----\n"
        "       The paired credential lives in kv; this module reads it directly because the shell's\n"
        "       hub closure is elsewhere. Same Bearer scheme as hubRaw. Without a credential nothing\n"
        "       here runs and the keyless chain below is untouched. */\n"
        "    function hubAcctFor() {\n"
        "      if (!window.kv || !window.kv.get) return Promise.resolve(null);\n"
        "      return window.kv.get('player:hub').then(function (v) {\n"
        "        return v && v.base && v.credentialId && v.secret ? v : null;\n"
        "      }, function () { return null; });\n"
        "    }\n"
        "    var HUB_PLATFORM_NAMES ={ youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify', bandcamp: 'Bandcamp' };\n"
        "    /* Hub metadata comes from provider adapters; only the web's own schemes may travel\n"
        "       from it into an href, an audio src or window.open. */\n"
        "    function webUrl(u) {\n"
        "      if (typeof u !== 'string' || !u) return null;\n"
        "      try { var p = new URL(u).protocol; return p === 'https:' || p === 'http:' ? u : null; } catch (e) { return null; }\n"
        "    }\n"
        "    function fromHub(d) {\n"
        "      var rows = (d && d.results) || [], out = [];\n"
        "      for (var i = 0; i < rows.length && out.length < 25; i++) {\n"
        "        var x = rows[i] || {};\n"
        "        if (x.kind !== 'track' || typeof x.title !== 'string') continue;\n"
        "        var conf = x.identity && typeof x.identity.matchConfidence === 'number' ? x.identity.matchConfidence : null;\n"
        "        /* Below 0.5 the hub itself refused to guess; this listing shows the platform's own words. */\n"
        "        var sure = conf === null || conf >= 0.5;\n"
        "        var r = track(x.title, x.artistName || '', sure ? (x.albumName || '') : '', webUrl(x.artworkUrl),\n"
        "                      webUrl(x.previewUrl), webUrl(x.canonicalUrl), HUB_PLATFORM_NAMES[x.provider] || null,\n"
        "                      x.durationMs > 0 ? x.durationMs / 1000 : 0, x.bpm);\n"
        "        r.feat = sure && x.featuredArtists && x.featuredArtists.length ? x.featuredArtists.slice(0, 3) : [];\n"
        "        r.genre = sure && x.genres && x.genres[0] ? String(x.genres[0]) : null;\n"
        "        r.conf = conf;\n"
        "        out.push(r);\n"
        "      }\n"
        "      return out;\n"
        "    }\n"
        "    function hubAuth(acct) { return { Authorization: 'Bearer ' + acct.credentialId + '.' + acct.secret }; }\n"
        "    function hubSearch(q) {\n"
        "      return hubAcctFor().then(function (acct) {\n"
        "        if (!acct) throw new Error('not paired');\n"
        "        return getJSON(acct.base + '/api/v1/search?scope=songs&q=' + encodeURIComponent(q), false, 5000, hubAuth(acct)).then(fromHub);\n"
        "      });\n"
        "    }\n"
        "    /* iTunes lends its 30-second clips to hub rows that arrived without one: matched by name\n"
        "       and by length to three seconds, never by hope. */\n"
        "    function fillPreviewsFromITunes(q, rows) {\n"
        "      var wanting = rows.filter(function (r) { return !r.prev; });\n"
        "      if (!wanting.length) return;\n"
        "      itunesSearch(q).then(function (list) {\n"
        "        var changed = false;\n"
        "        wanting.forEach(function (r) {\n"
        "          for (var i = 0; i < list.length; i++) {\n"
        "            var m = list[i];\n"
        "            if (!m.prev) continue;\n"
        "            if ((m.t || '').toLowerCase() !== (r.t || '').toLowerCase()) continue;\n"
        "            if ((m.a || '').toLowerCase() !== (r.a || '').toLowerCase()) continue;\n"
        "            if (r.d && m.d && Math.abs(r.d - m.d) > 3) continue;\n"
        "            r.prev = m.prev; changed = true; break;\n"
        "          }\n"
        "        });\n"
        "        if (changed && state === 'list') render();\n"
        "      }, function () { /* no clips to lend is not an error */ });\n"
        "    }\n"
        "    var DEADLINE = 8000;")

replace("      var chain = [companionSearch, itunesSearch];",
        "      /* hubSearch leads unconditionally: it reads the credential itself and rejects at once\n"
        "         when unpaired, so the decision is never one search out of date. */\n"
        "      var chain = [hubSearch, itunesSearch];")

# ---- search: no hard-coded local companion (docs/DEVIATIONS.md) ----------------------------------------------
# The frontend asked http://127.0.0.1:8642 for searches and pasted links. Nothing in this suite serves
# that port (the companion's helper is found and paired on 17342+), so the lookup reached whatever
# else happened to listen there — on the owner's PC, an unrelated agent gateway — and told it every
# query. DEVIATIONS.md already records this assumption as removed; now it is.
replace("    var COMPANION = 'http://127.0.0.1:8642';",
        "    var COMPANION = null;   // no hard-coded local companion: see docs/DEVIATIONS.md")
replace("    function companionSearch(q) {\n",
        "    function companionSearch(q) {\n"
        "      if (!COMPANION) return Promise.reject(new Error('no local companion search'));\n")
# (the pasted-link resolver's companion step is removed at the end, after the hub step is put in front of it)

replace("        return chain[i](q).then(function (rows) {\n"
        "          if (rows && rows.length) return rows;",
        "        return chain[i](q).then(function (rows) {\n"
        "          if (rows && rows.length) {\n"
        "            if (chain[i] === hubSearch) fillPreviewsFromITunes(q, rows);\n"
        "            return rows;\n"
        "          }")

replace("      var tries = [\n"
        "        function () {\n"
        "          return getJSON(COMPANION + '/resolve?q=' + enc, false, 20000).then(function (d) {",
        "      var tries = [\n"
        "        /* Paired first: the hub's resolve carries the enrichment cache — album, features,\n"
        "           genre, tempo — which no oEmbed can. Unpaired, this try fails at once. */\n"
        "        function () {\n"
        "          return hubAcctFor().then(function (acct) {\n"
        "            if (!acct) throw new Error('not paired');\n"
        "            /* The hub reads Spotify through spotDL, which takes 20-50 s; everything else answers in seconds. */\n"
        "            return getJSON(acct.base + '/api/v1/providers/resolve?url=' + enc, false, r.u.indexOf('open.spotify.com/') >= 0 ? 90000 : 20000, hubAuth(acct)).then(function (d) {\n"
        "              var rr = fromHub({ results: [d] })[0];\n"
        "              if (!rr) throw new Error('empty');\n"
        "              if (!r.bpm && rr.bpm) r.bpm = rr.bpm;\n"
        "              r.feat = rr.feat; r.genre = rr.genre; r.conf = rr.conf;\n"
        "              if (rr.prev) r.prev = rr.prev;\n"
        "              if (rr.al) r.al = rr.al;\n"
        "              return { t: rr.t, a: rr.a, art: rr.art, d: rr.d };\n"
        "            });\n"
        "          });\n"
        "        },\n"
        "        function () {\n"
        "          return getJSON(COMPANION + '/resolve?q=' + enc, false, 20000).then(function (d) {")

replace("      var sub = r.p ? (r.a ? esc(r.a) + ' \\u2014 ' + r.p : r.p)\n"
        "                    : (r.a ? esc(r.a) + (r.al ? ' \\u2014 ' + esc(r.al) : '') : (r.al ? esc(r.al) : ''));",
        "      /* Features and album lead when enrichment knows them; the platform stays as the tail\n"
        "         when there is no album to name. */\n"
        "      var who = r.a ? esc(r.a) + (r.feat && r.feat.length ? ' feat. ' + esc(r.feat.join(', ')) : '') : '';\n"
        "      var tail = r.al ? esc(r.al) : (r.p || '');\n"
        "      var sub = who ? (tail ? who + ' \\u2014 ' + tail : who) : tail;")

replace("          '<span class=\"srch__bpm\">' + (r.bpm ? r.bpm + ' bpm' : '') + '</span>' +",
        "          '<span class=\"srch__bpm\">' + (r.bpm ? r.bpm + ' bpm' : '') + '</span>' +\n"
        "          (r.genre ? '<span class=\"srch__genre\">' + esc(r.genre) + '</span>' : '') +")

replace("  .srch__pf {",
        "  /* The genre chip: the platform badge's own materials, worn as a word. */\n"
        "  .srch__genre {\n"
        "    flex: none;\n"
        "    padding: 1px 6px;\n"
        "    border-radius: 3px;\n"
        "    background: var(--srch-pf);\n"
        "    color: var(--srch-pf-ink);\n"
        "    font-size: 10.5px;\n"
        "    letter-spacing: 0.02em;\n"
        "    font-variant-caps: small-caps;\n"
        "  }\n"
        "  @media (max-width: 480px) { .srch__genre { display: none; } }\n"
        "\n"
        "  .srch__pf {")

# ---- search: the audition runs the whole clip, and steps aside for nothing dishonest (NP-FIND-001) --
# Thirty seconds is what the platforms serve; fifteen was the mockup's guess. The main track pauses
# for the audition and returns after it; a row with no clip says why instead of dressing as a button.

replace("    var CLIP = 15;                 // seconds of preview",
        "    var CLIP = 30;                 // seconds of preview \\u2014 the whole clip a platform serves\n"
        "    window.NP_SRCH_CLIP = CLIP;    /* read by tests; one constant drives label, ring and cutoff */")

replace("      if (!r.prev) return '<span class=\"srch__art\" aria-hidden=\"true\">' + inner + '</span>';",
        "      if (!r.prev) {\n"
        "        /* Unavailable is shown and explained (NP-PRIN-002): the tile stays, and says why. */\n"
        "        var whyNot = 'No preview \\u2014 ' + (r.p ? 'opens on ' + r.p : 'nothing to play here');\n"
        "        return '<span class=\"srch__art\" title=\"' + esc(whyNot) + '\" aria-label=\"' + esc(whyNot) + '\">' + inner + '</span>';\n"
        "      }")

replace("        ' aria-label=\"Preview ' + esc(r.t) + ', 15 seconds\">' + inner +",
        "        ' aria-label=\"Preview ' + esc(r.t) + ', ' + CLIP + ' seconds\">' + inner +")

replace("    var audio = null, playing = null, raf = 0;",
        "    var audio = null, playing = null, raf = 0, resumeMain = false;")

replace("      var same = playing === r;\n"
        "      stopPreview();\n"
        "      if (same) return;",
        "      var same = playing === r;\n"
        "      /* Switching clips: the main track is already stepped aside — keep it aside rather than\n"
        "         let stopPreview resume it under the new audition. (Its engine reports 'playing' only\n"
        "         once the element truly starts, so re-checking right after a resume would miss it.)\n"
        "         A same-row click is a stop, and that one does resume. */\n"
        "      var keepAside = !same && resumeMain;\n"
        "      if (keepAside) resumeMain = false;\n"
        "      stopPreview();\n"
        "      if (same) return;\n"
        "      /* One sound at a time: the main track steps aside for the audition and returns after. */\n"
        "      if (keepAside) {\n"
        "        resumeMain = true;\n"
        "      } else if (window.NP_PLAYER && window.NP_PLAYER.playing && window.NP_PLAYER.playing()) {\n"
        "        try { window.NP_PLAYER.pause(); resumeMain = true; } catch (e) { resumeMain = false; }\n"
        "      }")

replace("      playing = null;\n"
        "    }",
        "      playing = null;\n"
        "      if (resumeMain) {\n"
        "        resumeMain = false;\n"
        "        try { window.NP_PLAYER.resume(); } catch (e) { /* the engine may have been torn down */ }\n"
        "      }\n"
        "    }")

# ---- search: hold-to-hear — five seconds of rest on a row with a clip (NP-FIND-001) ----------------
# The ring fills clockwise in the library's selection blue while the hold runs, so the person sees
# it coming and can move away; the countdown that follows runs down in white. Touch never arms
# (a finger rests on things it reads), reduced motion never arms, and any key, scroll or departure
# cancels. The click is always there first.

replace("  /* dasharray is the full circumference; the offset is driven from JS as a\n"
        "     fraction of the 15 seconds elapsed */",
        "  /* Arming: the ring fills clockwise in the selection blue over the hold; leaving empties it\n"
        "     in a fifth of a second. Distinct colours, so filling and counting down cannot be confused. */\n"
        "  .srch__art.is-arming .srch__scrim { opacity: 1; }\n"
        "  .srch__art.is-arming .srch__ring--on {\n"
        "    display: block;\n"
        "    stroke: var(--lib-accent);\n"
        "    transition: stroke-dashoffset var(--arm-ms, 5000ms) linear;\n"
        "  }\n"
        "  .srch__art:not(.is-arming):not(.is-preview) .srch__ring--on { transition: stroke-dashoffset 0.2s ease; }\n"
        "\n"
        "  /* dasharray is the full circumference; the offset is driven from JS as a\n"
        "     fraction of the clip's seconds elapsed */")

replace("    /* ---- preview ---- */\n",
        "    /* ---- hold-to-hear: five seconds of rest arms a row with a clip (NP-FIND-001) ---- */\n"
        "    var ARM_DEFAULT_MS = 5000;\n"
        "    window.NP_SRCH_ARM_MS = ARM_DEFAULT_MS;\n"
        "    var armTimer = 0, armedEl = null;\n"
        "    function canArm() {\n"
        "      try {\n"
        "        return matchMedia('(hover: hover) and (pointer: fine)').matches &&\n"
        "               !matchMedia('(prefers-reduced-motion: reduce)').matches;\n"
        "      } catch (e) { return false; }\n"
        "    }\n"
        "    function disarm() {\n"
        "      if (armTimer) { clearTimeout(armTimer); armTimer = 0; }\n"
        "      if (armedEl) { armedEl.classList.remove('is-arming'); armedEl.style.removeProperty('--p'); armedEl.style.removeProperty('--arm-ms'); armedEl = null; }\n"
        "    }\n"
        "    body.addEventListener('pointerenter', function (e) {\n"
        "      if (!canArm()) return;\n"
        "      var rowEl = e.target && e.target.closest ? e.target.closest('.srch__row') : null;\n"
        "      if (!rowEl) return;\n"
        "      var i = +rowEl.dataset.i, r = visible()[i];\n"
        "      var el = rowEl.querySelector('button.srch__art');\n"
        "      if (!r || !r.prev || !el || playing === r) return;\n"
        "      /* pointerenter fires again at every child boundary inside the row; an armed row\n"
        "         keeps its hold instead of starting the five seconds over */\n"
        "      if (armedEl === el) return;\n"
        "      disarm();\n"
        "      armedEl = el;\n"
        "      el.style.setProperty('--arm-ms', (window.NP_SRCH_ARM_MS || ARM_DEFAULT_MS) + 'ms');\n"
        "      el.classList.add('is-arming');\n"
        "      /* two frames: the class lands with the ring empty, then the transition carries it full */\n"
        "      requestAnimationFrame(function () { requestAnimationFrame(function () { if (armedEl === el) el.style.setProperty('--p', '1'); }); });\n"
        "      armTimer = setTimeout(function () {\n"
        "        var target = armedEl;\n"
        "        disarm();\n"
        "        if (target) {\n"
        "          var live = body.querySelector('.srch__row[data-i=\"' + i + '\"] button.srch__art');\n"
        "          if (live) preview(i, live);\n"
        "        }\n"
        "      }, window.NP_SRCH_ARM_MS || ARM_DEFAULT_MS);\n"
        "    }, true);\n"
        "    body.addEventListener('pointerleave', function (e) {\n"
        "      if (!armedEl || !e.target || !e.target.closest) return;\n"
        "      var rowEl = e.target.closest('.srch__row');\n"
        "      if (!rowEl || !rowEl.contains(armedEl)) return;\n"
        "      /* still inside the armed row (a child boundary): the hold goes on */\n"
        "      if (e.relatedTarget && rowEl.contains(e.relatedTarget)) return;\n"
        "      disarm();\n"
        "    }, true);\n"
        "    body.addEventListener('scroll', disarm, true);\n"
        "    document.addEventListener('keydown', disarm, true);\n"
        "\n"
        "    /* ---- preview ---- */\n")

replace("    function stopPreview() {\n"
        "      if (raf) { cancelAnimationFrame(raf); raf = 0; }",
        "    function stopPreview() {\n"
        "      disarm();\n"
        "      if (raf) { cancelAnimationFrame(raf); raf = 0; }")

# ---- search -> library: a tempo that arrives after the add still reaches the row -------------------
# The bridge already carries bpm at add time; this closes the other half: a song added while its
# tempo was still being looked up is filled in where it now lives, instead of wearing an em dash
# forever. Same one-event pattern as library:add.

replace("          r.bpmTried = true;\n"
        "          if (m.bpm) r.bpm = m.bpm;\n"
        "          if (m.d && !r.d) r.d = m.d;",
        "          r.bpmTried = true;\n"
        "          if (m.bpm) r.bpm = m.bpm;\n"
        "          if (m.d && !r.d) r.d = m.d;\n"
        "          if (m.bpm && r.added) {\n"
        "            /* The row already moved into the library; hand the late answer over the same wall. */\n"
        "            document.dispatchEvent(new CustomEvent('library:bpm', { detail: { title: r.t, artist: r.a, bpm: m.bpm } }));\n"
        "          }")

replace("      var row = tbody.querySelector('tr[data-id=\"' + have.id + '\"]');\n"
        "      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });\n"
        "    });",
        "      var row = tbody.querySelector('tr[data-id=\"' + have.id + '\"]');\n"
        "      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });\n"
        "    });\n"
        "\n"
        "    /* A tempo that was still being looked up when the song was added: fill it in, once. */\n"
        "    document.addEventListener('library:bpm', function (e) {\n"
        "      var d = e.detail || {};\n"
        "      for (var i = 0; i < LIB.length; i++) {\n"
        "        var sg = LIB[i];\n"
        "        if (sg.bpm) continue;\n"
        "        if (sg.title.toLowerCase() !== String(d.title || '').toLowerCase()) continue;\n"
        "        if ((sg.artist || '').toLowerCase() !== String(d.artist || '').toLowerCase()) continue;\n"
        "        sg.bpm = d.bpm || null;\n"
        "        render();\n"
        "        break;\n"
        "      }\n"
        "    });")

# ---- radio: the song on the air, from the stream itself (NP-RADIO-001) ------------------------------------------
# A browser never sees a stream's ICY metadata, so the only titles the page could show were the few
# stations that publish a feed. The hub (paired) and the companion both read ICY for the page now;
# the tuned station asks them when it has no feed. Only the tuned station: the list keeps to feeds,
# because a title per row would mean a stream connection per row.

replace("""    /* What is actually on the air. A stream carries its title in ICY
       headers, which a browser is never shown, so the only honest sources are
       the ones a station publishes itself over HTTP with CORS open. SomaFM
       does; most do not, and inventing a track name would be worse than
       admitting there isn't one. When there is no track, the programme format
       the directory carries takes the line, which is at least true. */""",
        """    /* What is actually on the air. A stream carries its title in ICY
       metadata, which a browser is never shown. Two honest sources remain: a
       feed the station publishes over HTTP with CORS open (SomaFM, Triton,
       radio.co), and the stream's own metadata read for us by the container
       (when paired) or the companion app (NP-RADIO-001). Inventing a track
       name would be worse than admitting there isn't one: when neither
       answers, the programme format the directory carries takes the line. */""")

replace("    window.radioMetaSupported = function (url) { return !!feedFor(url); };",
        r"""    /* The stream's own title, asked of whoever can read it: the container
       first when this player is paired with one, the companion app after.
       Neither is a feed the page could call itself, so neither is offered
       to the station list (radioMetaSupported stays feed-only). */
    function icyAsk(url) {
      var q = '?url=' + encodeURIComponent(url);
      var ok = function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); };
      var acct = window.kv && window.kv.get ? window.kv.get('player:hub') : Promise.resolve(null);
      return acct.then(function (a) {
        if (!a || !a.base || !a.credentialId || !a.secret) throw new Error('not paired');
        return fetch(a.base + '/api/v1/radio/now-playing' + q, { headers: { Authorization: 'Bearer ' + a.credentialId + '.' + a.secret }, cache: 'no-store' }).then(ok);
      }).catch(function () {
        if (!window.COMPANION) return null;
        return fetch(String(window.COMPANION).replace(/\/$/, '') + '/helper/v1/radio/now-playing' + q, { cache: 'no-store' }).then(ok);
      });
    }

    function icyMeta(url) {
      var key = 'icy:' + url, now = Date.now(), c = metaCache[key];
      if (c && c.pending) return c.pending;
      if (c && now - c.at < 20000) return Promise.resolve(c.val);
      var pr = icyAsk(url).then(function (d) {
        var t = d && d.title ? { title: String(d.title), artist: d.artist ? String(d.artist) : '' } : null;
        metaCache[key] = { at: Date.now(), val: t };
        return t;
      }, function () {
        metaCache[key] = { at: Date.now(), val: null };
        return null;
      });
      metaCache[key] = { at: now, val: c ? c.val : null, pending: pr };
      return pr;
    }

    window.radioMetaSupported = function (url) { return !!feedFor(url); };""")

# Only the tuned station reads the stream (radioMeta's second argument); the list asks feeds alone,
# so forty rows never become forty stream connections.
replace("    window.radioMeta = function (url) {\n"
        "      var hit = feedFor(url);\n"
        "      if (!hit) return Promise.resolve(null);",
        "    window.radioMeta = function (url, tuned) {\n"
        "      var hit = feedFor(url);\n"
        "      if (!hit) return tuned ? icyMeta(url) : Promise.resolve(null);")
replace("      window.radioMeta(url).then(function (t) {\n"
        "        if (!station || station.id !== mine || !t) return;  // tuned away meanwhile",
        "      window.radioMeta(url, true).then(function (t) {\n"
        "        if (!station || station.id !== mine || !t) return;  // tuned away meanwhile")

# A feed that is down or empty is not the last word either: the stream itself may still say.
replace("          metaCache[url] = { at: Date.now(), val: null };\n"
        "          return null;\n"
        "        });\n"
        "      metaCache[url] = { at: now, val: c ? c.val : null, pending: pr };",
        "          metaCache[url] = { at: Date.now(), val: null };\n"
        "          return null;\n"
        "        })\n"
        "        .then(function (t) { return t || (tuned ? icyMeta(url) : null); });\n"
        "      metaCache[url] = { at: now, val: c ? c.val : null, pending: pr };")

replace("      delete metaCache[url];                              // the point is freshness",
        "      delete metaCache[url];                              // the point is freshness\n"
        "      delete metaCache['icy:' + url];")

# ---- menus: more than one submenu per menu ---------------------------------------------------------------------
# The station menu now carries two (its own lists, and the playlists for the song on the air). The
# keyboard followed only the first parent and only the first submenu flipped at the edge.

replace("      var parent = ctx.querySelector('.ctx__item--parent');",
        "      /* Several submenus can share a menu: the parent is the one with focus,\n"
        "         or the open one that holds it. */\n"
        "      var ae = document.activeElement;\n"
        "      var parent = ae && ae.classList && ae.classList.contains('ctx__item--parent') ? ae : (ae && ae.closest ? ae.closest('.ctx__item--parent') : null);")

replace("      var sub = ctx.querySelector('.ctx__sub');\n"
        "      if (sub) sub.classList.toggle('is-flip', r.right + 210 > innerWidth);",
        "      Array.prototype.forEach.call(ctx.querySelectorAll('.ctx__sub'), function (sub) {\n"
        "        sub.classList.toggle('is-flip', r.right + 210 > innerWidth);\n"
        "      });")

# ---- radio: keep the song you just heard (NP-RADIO-002) --------------------------------------------------------
# Right-click (or long-press) a station whose song is known: add that song to Up Next, to a group's
# queue on the container, or to one of your playlists. The song becomes a library entry the way a
# search result does — found through the same search chain for its album and link — and, unlike a
# search result, it is kept across reloads, because a playlist that forgets its songs is a lie.

replace("    var state = { starred: {}, saved: {}, playlists: [], queue: [], edits: {}, history: [],\n"
        "                  stations: {}, videos: {}, lists: {}, plays: [], sessions: [], recShown: [], acts: [] };",
        "    var state = { starred: {}, saved: {}, playlists: [], queue: [], edits: {}, history: [],\n"
        "                  stations: {}, videos: {}, lists: {}, plays: [], sessions: [], recShown: [], acts: [], kept: [] };")

replace("        /* A renamed artist has to survive a reload, or the command is a lie. */\n"
        "        applyEdits();",
        "        /* Songs kept from the radio are library entries of this player's own. */\n"
        "        state.kept = (Array.isArray(saved.kept) ? saved.kept : []).filter(function (s) { return s && s.id && s.title; });\n"
        "        state.kept.forEach(function (s) { if (!song(s.id)) LIB.push(s); });\n"
        "        /* A renamed artist has to survive a reload, or the command is a lie. */\n"
        "        applyEdits();")

replace("    function buildItemMenu(sub) {",
        r"""    /* The song a station is playing, when it is a song: the iHeart feed
       carries a station description instead, which is not something to keep. */
    function onAirSong(st) {
      var t = st && trackByStation[st.id];
      return t && t.title && !t.about ? t : null;
    }

    function onAirMenu(sub) {
      if (sub.view !== 'radio') return '';
      var t = onAirSong(sub.entry);
      if (!t) return '';
      var label = (t.artist ? t.artist + ' — ' : '') + t.title;
      var lists = state.playlists.length
        ? state.playlists.map(function (pl) {
            return '<button class="ctx__item" type="button" role="menuitem" data-act="ls-air-pl" data-pl="' + esc(pl.id) + '">' + esc(pl.name) + '</button>';
          }).join('')
        : '<button class="ctx__item" type="button" role="menuitem" disabled>No playlists yet</button>';
      var hub = window.NP_HUB;
      var groups = hub ? hub.groups() : null;
      var groupItem;
      if (!hub || groups === null) {
        if (hub) hub.refreshGroups();
        groupItem = '<button class="ctx__item" type="button" role="menuitem" disabled title="' +
          esc(hub && hub.paired() ? 'Checking your groups on the container…' : 'Pair with the container to share a queue.') + '">Add Song to Group Queue</button>';
      } else if (!groups.length) {
        groupItem = '<button class="ctx__item" type="button" role="menuitem" disabled title="You are not in a group on the container yet.">Add Song to Group Queue</button>';
      } else if (groups.length === 1) {
        groupItem = '<button class="ctx__item" type="button" role="menuitem" data-act="ls-air-group" data-g="' + esc(groups[0].id) + '">Add Song to “' + esc(groups[0].name) + '” Queue</button>';
      } else {
        groupItem = '<div class="ctx__item ctx__item--parent" role="menuitem" tabindex="0" aria-haspopup="menu" aria-expanded="false" data-act="parent">' +
          'Add Song to Group Queue<span class="ctx__chev" aria-hidden="true"></span>' +
          '<div class="ctx__sub" role="menu" aria-label="Groups">' +
          groups.map(function (g) {
            return '<button class="ctx__item" type="button" role="menuitem" data-act="ls-air-group" data-g="' + esc(g.id) + '">' + esc(g.name) + '</button>';
          }).join('') + '</div></div>';
      }
      return '<div class="ctx__sep" role="separator"></div>' +
        '<div class="ctx__head">On air: ' + esc(label) + '</div>' +
        '<button class="ctx__item" type="button" role="menuitem" data-act="ls-air-next">Add Song to Up Next</button>' +
        groupItem +
        '<div class="ctx__item ctx__item--parent" role="menuitem" tabindex="0" aria-haspopup="menu" aria-expanded="false" data-act="parent">' +
          'Add Song to Playlist<span class="ctx__chev" aria-hidden="true"></span>' +
          '<div class="ctx__sub" role="menu" aria-label="Song playlists">' + lists +
            '<div class="ctx__sep" role="separator"></div>' +
            '<button class="ctx__item" type="button" role="menuitem" data-act="ls-air-new">New Playlist…</button>' +
          '</div>' +
        '</div>';
    }

    /* The song as a library entry: the one already there, or a new one the
       search chain fills in (album, length, link) when it finds the same
       song by the same artist. Nothing is guessed from a different artist. */
    function airSong(t) {
      function same(s) {
        return s.title.toLowerCase() === t.title.toLowerCase() &&
          String(s.artist || '').toLowerCase() === String(t.artist || '').toLowerCase();
      }
      for (var i = 0; i < LIB.length; i++) if (same(LIB[i])) return Promise.resolve(LIB[i]);
      var look = window.NP_FIND
        ? window.NP_FIND((t.artist ? t.artist + ' ' : '') + t.title).then(function (rows) {
            for (var k = 0; k < (rows || []).length; k++) {
              var r = rows[k];
              if (r && String(r.t || '').toLowerCase() === t.title.toLowerCase() &&
                  (!t.artist || String(r.a || '').toLowerCase().indexOf(t.artist.toLowerCase()) === 0)) return r;
            }
            return null;
          }, function () { return null; })
        : Promise.resolve(null);
      return look.then(function (m) {
        for (var j = 0; j < LIB.length; j++) if (same(LIB[j])) return LIB[j];   // added meanwhile
        var sg = {
          id: 'song-air-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          kind: 'music',
          title: String(t.title).slice(0, 120),
          artist: String(t.artist || '').slice(0, 80),
          album: m && m.al ? String(m.al).slice(0, 80) : '',
          duration: m && m.d ? Math.max(0, Math.round(m.d)) : 0,
          bpm: m && m.bpm ? m.bpm : null,
          platform: m && m.p ? m.p : 'Radio',     // the badge says where it came from
          url: m && m.u ? m.u : null,
        };
        LIB.push(sg);
        state.kept.push(sg);
        render();
        return sg;
      });
    }

    function runAirAction(act, el, sub) {
      var t = onAirSong(sub.entry);
      if (!t) { say('The station has moved on — nothing to add'); return; }
      if (act === 'ls-air-group') {
        var hub = window.NP_HUB;
        if (!hub) return;
        say('Asking the container for “' + t.title + '”…');
        hub.request(el.dataset.g, (t.artist ? t.artist + ' - ' : '') + t.title).then(function (r) {
          if (r && r.queued) say('Queued “' + (r.title || t.title) + '”' + (r.position ? ' — number ' + r.position + ' in the group queue' : ''));
          else say((r && r.reason) || 'The container could not queue that song');
        });
        return;
      }
      airSong(t).then(function (sg) {
        if (act === 'ls-air-next') {
          if (state.queue.indexOf(sg.id) < 0) state.queue.push(sg.id);
          save();
          say('Up Next: “' + sg.title + '”');
          return;
        }
        if (act === 'ls-air-pl') {
          var pl = state.playlists.filter(function (p) { return p.id === el.dataset.pl; })[0];
          if (!pl) return;
          if (pl.songs.indexOf(sg.id) < 0) { pl.songs.push(sg.id); logAct('playlistAdd', sg.id); }
          save();
          say('Added to “' + pl.name + '”');
          return;
        }
        if (act === 'ls-air-new') {
          askName().then(function (name) {
            if (!name) { save(); return; }
            state.playlists.push({ id: 'pl-' + Date.now().toString(36), name: name, songs: [sg.id] });
            logAct('playlistAdd', sg.id);
            save();
            say('Added to “' + name + '”');
          });
        }
      });
    }

    function buildItemMenu(sub) {""")

replace("        head + keep +\n",
        "        head + keep + onAirMenu(sub) +\n")

replace("      if (act === 'ls-open')   { sub.run(); return; }",
        "      if (act.indexOf('ls-air-') === 0) { runAirAction(act, el, sub); return; }\n"
        "      if (act === 'ls-open')   { sub.run(); return; }")

# Touch has no right-click: a long press on a station opens the same menu (NP-MENU-002's gesture).
replace("    if (desktop) {\n"
        "      radio.addEventListener('contextmenu', function (e) {\n"
        "        var row = e.target.closest('.rlist tbody tr[data-i]');\n"
        "        if (!row) return;\n"
        "        e.preventDefault();\n"
        "        var lvl = radioLevel();",
        "    function stationMenu(row, e) {\n"
        "      {\n"
        "        var lvl = radioLevel();")

replace("        }, kb ? rr.left + 40 : e.clientX, kb ? rr.bottom - 4 : e.clientY);\n"
        "      });\n"
        "    }\n"
        "\n"
        "    radio.addEventListener('click', function (e) {",
        r"""        }, kb ? rr.left + 40 : e.clientX, kb ? rr.bottom - 4 : e.clientY);
      }
    }
    if (desktop) {
      radio.addEventListener('contextmenu', function (e) {
        var row = e.target.closest('.rlist tbody tr[data-i]');
        if (!row) return;
        e.preventDefault();
        stationMenu(row, e);
      });
    } else {
      var stPress = 0, stAt = null, stQuietUntil = 0;
      var stCancel = function () { clearTimeout(stPress); stPress = 0; };
      radio.addEventListener('pointerdown', function (e) {
        var row = e.target.closest('.rlist tbody tr[data-i]');
        if (!row) return;
        stAt = { x: e.clientX, y: e.clientY };
        stCancel();
        stPress = setTimeout(function () {
          stPress = 0;
          stQuietUntil = Date.now() + 700;       // the lift that ends the press is not a tap
          stationMenu(row, { button: -1, clientX: stAt.x, clientY: stAt.y });
        }, 500);
      });
      /* a press that turns into a scroll is a scroll, not a long press */
      radio.addEventListener('pointermove', function (e) {
        if (stPress && stAt && (Math.abs(e.clientX - stAt.x) > 10 || Math.abs(e.clientY - stAt.y) > 10)) stCancel();
      });
      radio.addEventListener('pointerup', stCancel);
      radio.addEventListener('pointercancel', stCancel);
      radio.addEventListener('contextmenu', function (e) { if (e.target.closest('.rlist tbody tr[data-i]')) e.preventDefault(); });
      radio.addEventListener('click', function (e) {
        if (Date.now() < stQuietUntil) { e.stopPropagation(); e.preventDefault(); }
      }, true);
    }

    radio.addEventListener('click', function (e) {""")

# The container's side of it: which groups this player is in, and "queue this song by name".
replace("    function canInvite(g) { return (g.myRole === 'owner' || g.myRole === 'admin') && hasScope('group:admin'); }",
        r"""    /* Added to the bridge's NP_HUB (which carries status()), never put in its place. */
    window.NP_HUB = Object.assign(window.NP_HUB || {}, {
      paired: function () { return !!hubAcct; },
      groups: function () { return hubAcct ? groups : null; },
      refreshGroups: function () {
        if (!hubAcct) return Promise.resolve(null);
        return hubCall('GET', '/groups').then(function (r) {
          if (r.ok && r.json && Array.isArray(r.json.items)) groups = r.json.items.filter(function (g) { return g.status !== 'archived'; });
          return groups;
        }, function () { return groups; });
      },
      request: function (groupId, query) {
        if (!hubAcct) return Promise.resolve({ queued: false, reason: 'Pair with the container first.' });
        var key = 'air-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        return hubCall('POST', '/groups/' + encodeURIComponent(groupId) + '/requests', { query: query, idempotencyKey: key }).then(function (r) {
          if (r.ok && r.json) return r.json;
          return { queued: false, reason: r.status === 403 ? 'You are no longer in that group, or this player may not add to it.' : r.status === 401 ? 'The container no longer accepts this player.' : r.status === 429 ? 'Too many requests at once. Wait a moment.' : 'No answer from the container.' };
        }, function () { return { queued: false, reason: 'No answer from the container.' }; });
      },
    });
    /* A tuned station is the moment someone may want to keep a song. */
    document.addEventListener('radio:station', function () { if (hubAcct && groups === null) window.NP_HUB.refreshGroups(); });
    function canInvite(g) { return (g.myRole === 'owner' || g.myRole === 'admin') && hasScope('group:admin'); }""")

# The search chain, for the radio menu: the same hub-first, keyless-after lookup a typed search uses.
replace("    /* ---- pasted links ---- */",
        "    window.NP_FIND = function (q) { return search(q); };\n\n"
        "    /* ---- pasted links ---- */")
# ---- Connections: a downloader being set up is not "missing" (UX-SETUP-001) ----------------------------------
# The companion and the helper set yt-dlp, spotDL and FFmpeg up by themselves now, and health carries
# each tool's `setup` state. A tool on its way reads "setting up" in the muted colour; only one that
# failed or cannot be set up on that machine counts toward "N downloader(s) missing".
replace("        span.className = t.present ? 'conn__good' : 'conn__warn';\n"
        "        span.textContent = (i ? ' · ' : '') + t.id + (t.present ? ' ' + (t.version || '✓') : ' missing');\n"
        "        if (!t.present) { missing++; if (t.installHint) span.title = t.installHint; }",
        "        var setup = (t.setup && t.setup.state) || '';\n"
        "        var coming = !t.present && setup === 'installing';\n"
        "        span.className = t.present ? 'conn__good' : coming ? 'muted' : 'conn__warn';\n"
        "        span.textContent = (i ? ' · ' : '') + t.id + (t.present ? ' ' + (t.version || '✓')\n"
        "          : coming ? ' setting up' + (typeof t.setup.progress === 'number' ? ' ' + Math.round(t.setup.progress * 100) + '%' : '')\n"
        "          : ' missing');\n"
        "        if (coming) span.title = 'The companion is downloading and verifying ' + t.id + '.';\n"
        "        else if (!t.present) { missing++; span.title = (t.setup && t.setup.reason) || t.installHint || ''; }")

# ---- kv.set returns its write ---------------------------------------------------------------------------------
# It started the database write and returned nothing, so `await kv.set(...)` waited for nothing. A reload
# straight after could beat the write — Hermes's pass-3 diagnostic caught the preview suite doing exactly
# that ("paired": false). Most keys are rescued by the bridge's localStorage journal; the hub pairing
# deliberately is not (its secret stays out of localStorage). The promise still never rejects, so the
# callers that ignore it are unchanged.
replace("          if (art) { var p = art.set(key, json); if (p && p.catch) p.catch(function () {}); }\n"
        "          else if (ls) ls.setItem(key, json);\n"
        "        } catch (e) { /* quota or sandbox — memory copy still holds */ }\n"
        "      },",
        "          if (art) { var p = art.set(key, json); if (p && p.catch) return p.catch(function () {}); }\n"
        "          else if (ls) ls.setItem(key, json);\n"
        "        } catch (e) { /* quota or sandbox — memory copy still holds */ }\n"
        "        return Promise.resolve();\n"
        "      },")

# The pasted-link resolver's local-companion step goes too (docs/DEVIATIONS.md; see the search section).
replace("        function () {\n"
        "          return getJSON(COMPANION + '/resolve?q=' + enc, false, 20000).then(function (d) {\n"
        "            var e = d && d.results && d.results[0];\n"
        "            if (!e || !e.t) throw new Error('empty');\n"
        "            return { t: e.t, a: e.a, art: e.art, d: e.d };\n"
        "          });\n"
        "        },\n",
        "")
replace("       browser; the companion beats both when it's running */",
        "       browser; a paired container, when there is one, beats both */")

# ---- Live TV: the companion's channels and guide (NP-TV-001) --------------------------------------------------
# The companion keeps the M3U playlists and XMLTV guides pasted into its Live TV tab and serves them on
# /helper/v1/tv/channels and /helper/v1/tv/guide. A player that can see a companion takes its channel
# list from there — no playlist to load by hand, and no CORS wall, because the companion did the reading.
# A channel with a guide entry says what is on and what follows; one without still says "Live".
replace("      if (!ch.run) return ch.url ? 'Live' : '\\u2014';\n",
        "      if (ch.guide) {\n"
        "        var later = at > Date.now();\n"
        "        var prog = later ? ch.guide.next : ch.guide.now;\n"
        "        return prog && prog.title ? prog.title : (later ? '\\u2014' : 'Live');\n"
        "      }\n"
        "      if (!ch.run) return ch.url ? 'Live' : '\\u2014';\n")
replace("        return { id: c.id || 'm3u-' + i, num: c.num || String(i + 1), name: c.name,\n"
        "                 genre: c.genre || '', url: c.url };\n"
        "      });\n"
        "      mediaStack = [];\n"
        "      mediaSel = 0;\n"
        "      if (mediaView === 'live-tv' && !media.hidden) mediaRender();\n"
        "    }\n",
        "        return { id: c.id || 'm3u-' + i, num: c.num || String(i + 1), name: c.name,\n"
        "                 genre: c.genre || '', url: c.url, guide: c.guide || null };\n"
        "      });\n"
        "      mediaStack = [];\n"
        "      mediaSel = 0;\n"
        "      if (mediaView === 'live-tv' && !media.hidden) mediaRender();\n"
        "    }\n"
        "\n"
        "    /* Live TV, from the companion when one is in reach on this machine, otherwise from the paired\n"
        "       hub, which keeps the copy a companion shares with it (GET /api/v1/live-tv). The list is\n"
        "       replaced only when the channels themselves changed, so a guide refresh never throws you\n"
        "       out of where you were. */\n"
        "    var companionTvSig = '';\n"
        "    function tvFromCompanion() {\n"
        "      if (!window.COMPANION) return Promise.resolve(null);\n"
        "      var base = String(window.COMPANION).replace(/\\/$/, '');\n"
        "      var get = function (path) {\n"
        "        return fetch(base + path, { cache: 'no-store' }).then(function (r) {\n"
        "          if (!r.ok) throw new Error(String(r.status));\n"
        "          return r.json();\n"
        "        });\n"
        "      };\n"
        "      return get('/helper/v1/tv/channels').then(function (c) {\n"
        "        var list = c && Array.isArray(c.channels) ? c.channels : [];\n"
        "        if (!list.length) return null;\n"
        "        return get('/helper/v1/tv/guide').catch(function () { return { guide: [] }; }).then(function (g) {\n"
        "          return { channels: list, guide: g && Array.isArray(g.guide) ? g.guide : [] };\n"
        "        });\n"
        "      }).catch(function () { return null; });\n"
        "    }\n"
        "    function tvFromHub() {\n"
        "      var acct = window.kv && window.kv.get ? window.kv.get('player:hub') : Promise.resolve(null);\n"
        "      return acct.then(function (a) {\n"
        "        if (!a || !a.base || !a.credentialId || !a.secret) return null;\n"
        "        return fetch(a.base + '/api/v1/live-tv', { headers: { Authorization: 'Bearer ' + a.credentialId + '.' + a.secret }, cache: 'no-store' })\n"
        "          .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })\n"
        "          .then(function (d) {\n"
        "            var list = d && Array.isArray(d.channels) ? d.channels : [];\n"
        "            return list.length ? { channels: list, guide: Array.isArray(d.guide) ? d.guide : [] } : null;\n"
        "          });\n"
        "      }).catch(function () { return null; });\n"
        "    }\n"
        "    function companionTv() {\n"
        "      return tvFromCompanion().then(function (got) { return got || tvFromHub(); }).then(function (got) {\n"
        "        if (!got) return 0;\n"
        "        var list = got.channels;\n"
        "        return Promise.resolve(got).then(function (g) {\n"
        "          var by = {};\n"
        "          g.guide.forEach(function (e) { by[String(e.tvgId).toLowerCase()] = e; });\n"
        "          var mapped = list.map(function (ch) {\n"
        "            return { id: ch.id, num: String(ch.number), name: ch.name, genre: ch.group || '', url: ch.url,\n"
        "                     guide: (ch.tvgId && by[String(ch.tvgId).toLowerCase()]) || null };\n"
        "          });\n"
        "          var sig = mapped.map(function (ch) { return ch.id + '\\u0001' + ch.url; }).join('\\u0002');\n"
        "          if (sig !== companionTvSig) {\n"
        "            companionTvSig = sig;\n"
        "            useChannels(mapped);\n"
        "          } else {\n"
        "            CHANNELS.forEach(function (ch, i) { ch.guide = mapped[i].guide; });\n"
        "            if (mediaView === 'live-tv' && !media.hidden) mediaRender();\n"
        "          }\n"
        "          return mapped.length;\n"
        "        });\n"
        "      }).catch(function () { return 0; });\n"
        "    }\n"
        "    window.companionTv = companionTv;\n"
        "    /* A player that has only a hub still asks once at start; pairing later asks again. */\n"
        "    setTimeout(companionTv, 1500);\n"
        "    setInterval(companionTv, 5 * 60 * 1000);\n")
replace("      conn.app = { base: base, health: j };\n"
        "      window.COMPANION = base;\n",
        "      conn.app = { base: base, health: j };\n"
        "      window.COMPANION = base;\n"
        "      if (window.companionTv) window.companionTv();\n")
replace("      if (cfg.companion) window.COMPANION = cfg.companion;\n",
        "      if (cfg.companion) window.COMPANION = cfg.companion;\n"
        "      if (window.companionTv) window.companionTv();\n")
replace("              'The companion app can fetch it instead.';\n",
        "              'Add it in the companion app\\u2019s Live TV tab instead: the companion reads it and the channels appear here.';\n")

# Pairing with a hub is a moment Live TV may have become available: ask straight away (NP-TV-001).
replace("              hubSave(); paintHubPair(); paintProfileTab(); loadMe();",
        "              hubSave().then(function () { if (window.companionTv) window.companionTv(); }); paintHubPair(); paintProfileTab(); loadMe();")

# A guide entry from the companion or the hub knows when the programme ends: Until says so (NP-TV-001).
replace("              (it.channel.run ? esc(clockOf(lvl.at + SLOT)) : '') + '</td>' +",
        "              (it.channel.guide && it.channel.guide.now && it.channel.guide.now.stop\n"
        "                ? esc(clockOf(Date.parse(it.channel.guide.now.stop)))\n"
        "                : it.channel.run ? esc(clockOf(lvl.at + SLOT)) : '') + '</td>' +")

# ---- pasted links through the companion (NP-FIND-002) -------------------------------------------------------------
# A companion on this PC reads a pasted link with its own tools (GET /helper/v1/resolve: yt-dlp, or spotDL for
# Spotify) and knows what oEmbed cannot — duration, the whole date, album, features, art — keylessly. It is asked
# beside the chain, not in it: the paired hub still answers first, oEmbed still fills the row in a second, and the
# companion's answer lands over oEmbed's when it comes (a source never overwrites a better one; it only fills gaps).
# A playlist, set or album becomes its songs, each a row with its own address (so each can be added and fetched),
# under a count that names the list and says when the cap left some out. A set entry the site lists by address
# alone is looked up when its page of rows is on screen. The date joins the details line the row already has.
replace(r"    var HOSTS = /^(www\.)?(youtube\.com|music\.youtube\.com|youtu\.be|soundcloud\.com|on\.soundcloud\.com|bandcamp\.com|[a-z0-9-]+\.bandcamp\.com)$/i;",
        r"    var HOSTS = /^(www\.)?(youtube\.com|music\.youtube\.com|youtu\.be|soundcloud\.com|on\.soundcloud\.com|bandcamp\.com|[a-z0-9-]+\.bandcamp\.com|open\.spotify\.com)$/i;")
replace("      if (/bandcamp/i.test(host)) return 'Bandcamp';\n      return null;",
        "      if (/bandcamp/i.test(host)) return 'Bandcamp';\n      if (/spotify/i.test(host)) return 'Spotify';\n      return null;")
replace("        t = segs[1] ? humanize(segs[1]) : 'SoundCloud track';\n      } else {",
        "        t = segs[1] ? humanize(segs[1]) : 'SoundCloud track';\n"
        "      } else if (p === 'Spotify') {\n"
        "        t = segs[0] === 'album' ? 'Spotify album' : segs[0] === 'playlist' ? 'Spotify playlist' : 'Spotify track';\n"
        "      } else {")
replace("        msg('Only YouTube, SoundCloud and Bandcamp links work here.');",
        "        msg('Only YouTube, SoundCloud, Bandcamp and Spotify links work here.');")
replace("    var results = [], page = 0, hot = -1, state = 'idle', lastQ = '', seq = 0;",
        "    var results = [], page = 0, hot = -1, state = 'idle', lastQ = '', seq = 0;\n"
        "    var listInfo = null;   // the pasted playlist the rows came from, for the count line")
replace("       browser; a paired container, when there is one, beats both */\n"
        "    function resolveLink(r) {\n"
        "      var enc = encodeURIComponent(r.u);\n"
        "      var tries = [\n",
        "       browser; a paired container, when there is one, beats both, and the\n"
        "       companion on this PC, when there is one, reads the link with its own\n"
        "       tools beside them (NP-FIND-002) */\n"
        "    function resolveLink(r) {\n"
        "      var enc = encodeURIComponent(r.u);\n"
        "      var mine = seq;\n"
        "      r.rank = 0;\n"
        "      /* rank: hub 3, companion 2, oEmbed and the rest 1. A lower answer that arrives late\n"
        "         only fills what the better one left empty. */\n"
        "      function put(rank, m) {\n"
        "        if (mine !== seq || !m) return;\n"
        "        if (rank < r.rank) {\n"
        "          if (!r.d && m.d > 0) r.d = Math.round(m.d);\n"
        "          if (!r.art && typeof m.art === 'string' && m.art) r.art = m.art;\n"
        "          if (state === 'list' && results.indexOf(r) >= 0) render();\n"
        "          return;\n"
        "        }\n"
        "        r.rank = rank;\n"
        "        applyMeta(r, m.t, m.a, m.art, m.d);\n"
        "      }\n"
        "      fromCompanion(r, enc, mine, put);\n"
        "      var tries = [\n")
replace("      var mine = seq;\n"
        "      (function step(i) {\n"
        "        if (i >= tries.length || mine !== seq) return;\n"
        "        tries[i]().then(function (m) {\n"
        "          if (mine !== seq) return;\n"
        "          applyMeta(r, m.t, m.a, m.art, m.d);\n"
        "        }, function () { step(i + 1); });\n"
        "      })(0);\n"
        "    }\n",
        "      /* The hub is asked alongside the rest, not before it: a slow answer (a Spotify link) must not\n"
        "         hold back what oEmbed can say at once, and when it lands it outranks it. */\n"
        "      tries[0]().then(function (m) { put(3, m); }, function () { /* not paired, or it could not read the link */ });\n"
        "      (function step(i) {\n"
        "        if (i >= tries.length || mine !== seq) return;\n"
        "        tries[i]().then(function (m) { put(i === 0 ? 3 : 1, m); }, function () { step(i + 1); });\n"
        "      })(1);\n"
        "    }\n"
        "\n"
        "    /* The companion's answer (HelperResolved). A song fills the row; a playlist, set or album\n"
        "       replaces it with its songs. Nothing here throws: no companion is the ordinary case. */\n"
        "    function companionBase() { return window.COMPANION ? String(window.COMPANION).replace(/\\/$/, '') : null; }\n"
        "    function fromCompanion(r, enc, mine, put) {\n"
        "      var base = companionBase();\n"
        "      if (!base) return;\n"
        "      getJSON(base + '/helper/v1/resolve?url=' + enc, false, 160000).then(function (d) {\n"
        "        if (mine !== seq || !d) return;\n"
        "        var c = d.kind === 'collection' ? d.collection : null;\n"
        "        if (c && Array.isArray(c.entries) && c.entries.length) { listCollection(r, c); return; }\n"
        "        var x = d.track;\n"
        "        if (!x || typeof x.title !== 'string' || !x.title) return;\n"
        "        fillFrom(r, x, r.rank <= 2);\n"
        "        put(2, { t: x.title, a: x.artist, art: webUrl(x.artworkUrl), d: x.durationSec });\n"
        "      }).catch(function () { /* no companion, or it could not read the link: the chain stands */ });\n"
        "    }\n"
        "    /* What only the companion knows. `lead` is false when the hub already answered: then it\n"
        "       only fills what the hub left empty. */\n"
        "    function fillFrom(r, x, lead) {\n"
        "      if (typeof x.date === 'string' && x.date) r.date = x.date.slice(0, 10);\n"
        "      if (typeof x.album === 'string' && x.album && (lead || !r.al)) r.al = x.album.slice(0, 80);\n"
        "      if (Array.isArray(x.featured) && x.featured.length && (lead || !r.feat.length)) r.feat = x.featured.slice(0, 3).map(String);\n"
        "      if (typeof x.genre === 'string' && x.genre && (lead || !r.genre)) r.genre = x.genre;\n"
        "    }\n"
        "    function rowFromResolved(x, platform) {\n"
        "      /* a set's entry may arrive as an address alone: its path stands in until it is looked up */\n"
        "      var guess = !x.title && x.url ? parseLink(x.url) : null;\n"
        "      var row = track(x.title || (guess && guess.t) || 'Untitled', x.artist || (guess && guess.a) || '', '',\n"
        "                      webUrl(x.artworkUrl), null, webUrl(x.url), platform, x.durationSec || 0);\n"
        "      fillFrom(row, x, true);\n"
        "      row.pending = !x.title;\n"
        "      return row;\n"
        "    }\n"
        "    function listCollection(r, c) {\n"
        "      results = c.entries.map(function (x) { return rowFromResolved(x || {}, r.p); });\n"
        "      listInfo = { title: String(c.title || 'Playlist'), total: c.total, cap: c.cap, capped: !!c.capped };\n"
        "      page = 0; hot = -1; state = 'list';\n"
        "      render();\n"
        "    }\n"
        "    /* An entry listed by address alone, looked up once when its page is on screen. */\n"
        "    function resolveEntry(r) {\n"
        "      var base = companionBase(), mine = seq;\n"
        "      if (!base || !r.u) return;\n"
        "      getJSON(base + '/helper/v1/resolve?url=' + encodeURIComponent(r.u), false, 60000).then(function (d) {\n"
        "        var x = d && d.track;\n"
        "        if (mine !== seq || !x || typeof x.title !== 'string' || !x.title) return;\n"
        "        r.pending = false;\n"
        "        fillFrom(r, x, true);\n"
        "        applyMeta(r, x.title, x.artist, webUrl(x.artworkUrl), x.durationSec);\n"
        "      }).catch(function () { r.pending = false; });\n"
        "    }\n")
replace("      visible().forEach(function (r) {\n        if (r.bpm || r.bpmTried) return;",
        "      visible().forEach(function (r) {\n"
        "        /* named by its address alone so far: no tempo to look up for a guessed name */\n"
        "        if (r.pending) { if (!r.pendingAsked) { r.pendingAsked = true; resolveEntry(r); } return; }\n"
        "        if (r.bpm || r.bpmTried) return;")
replace("      var tail = r.al ? esc(r.al) : (r.p || '');",
        "      var tail = (r.al ? esc(r.al) : (r.p || '')) + (r.date ? (r.al || r.p ? ' \\u00b7 ' : '') + esc(r.date) : '');")
replace("        count.innerHTML = '<b>Results:</b> ' + n + (n === 1 ? ' song' : ' songs');",
        "        var songs = n + (n === 1 ? ' song' : ' songs');\n"
        "        count.innerHTML = listInfo\n"
        "          ? '<b>' + esc(listInfo.title.length > 48 ? listInfo.title.slice(0, 47) + '\\u2026' : listInfo.title) + ':</b> ' + songs +\n"
        "            (listInfo.capped ? ' (the first ' + listInfo.cap + (listInfo.total ? ' of ' + listInfo.total : '') + ')' : '')\n"
        "          : '<b>Results:</b> ' + songs;")
replace("      lastQ = q;\n      page = 0;\n      hot = -1;\n",
        "      lastQ = q;\n      listInfo = null;\n      page = 0;\n      hot = -1;\n")
replace("          duration: r.d, bpm: r.bpm,\n",
        "          duration: r.d, bpm: r.bpm, date: r.date || null,\n")
replace("          bpm: d.bpm || null,\n          platform: d.platform,\n          url: d.url,\n",
        "          bpm: d.bpm || null,\n          date: typeof d.date === 'string' ? d.date.slice(0, 10) : null,\n          platform: d.platform,\n          url: d.url,\n")
replace("(sg.artist ? ' by ' + sg.artist : '') + ' — fetched by the helper on this PC from '",
        "(sg.artist ? ' by ' + sg.artist : '') + (sg.date ? ' (' + sg.date + ')' : '') + ' — fetched by the helper on this PC from '")


# ---- the disc: whether and how it spins and turns (NP-PREF-014) -------------------------------------------
# Settings ▸ Player gains "The disc": Spin (while playing / with the song's tempo / don't) and its speed;
# Turn (all the way round / with the tempo / hold one way / stay where I leave it), its speed, and which
# way it faces when held. Saved with the other preferences in cfg.disc; the 3D stage reads it from the
# prefs events it already follows. Tempo means the song's BPM: at 120 BPM the disc moves at the speed set,
# faster songs faster; a song with no known tempo moves at the steady speed. Reduce animation still wins.
replace("        <fieldset class=\"prefs__group\">\n"
        "          <legend class=\"prefs__legend\">Listening</legend>",
        "        <fieldset class=\"prefs__group\" id=\"discPrefs\">\n"
        "          <legend class=\"prefs__legend\">The disc</legend>\n"
        "          <div class=\"disc-preview\">\n"
        "            <div class=\"disc-preview__stage\" id=\"discPreview\" role=\"img\" aria-label=\"A preview of the disc, moving the way these settings say\"></div>\n"
        "            <p class=\"prefs__hint disc-preview__note\" id=\"discPreviewNote\" aria-live=\"polite\"></p>\n"
        "          </div>\n"
        "          <div class=\"prefs__row\">\n"
        "            <label for=\"cfgDiscSpin\">Spin</label>\n"
        "            <select class=\"prefs__select\" id=\"cfgDiscSpin\">\n"
        "              <option value=\"steady\">Spin while a song plays</option>\n"
        "              <option value=\"tempo\">Spin with the song’s tempo</option>\n"
        "              <option value=\"off\">Don’t spin</option>\n"
        "            </select>\n"
        "          </div>\n"
        "          <div class=\"prefs__row\" id=\"cfgDiscSpinSpeedRow\">\n"
        "            <label for=\"cfgDiscSpinSpeed\">Spin speed</label>\n"
        "            <div class=\"weight vol__row\">\n"
        "              <input type=\"range\" id=\"cfgDiscSpinSpeed\" min=\"0.25\" max=\"3\" step=\"0.25\" aria-describedby=\"cfgDiscSpinSpeedVal\">\n"
        "              <span class=\"weight__val\" id=\"cfgDiscSpinSpeedVal\"></span>\n"
        "            </div>\n"
        "          </div>\n"
        "          <div class=\"prefs__row\">\n"
        "            <label for=\"cfgDiscTurn\">Turn</label>\n"
        "            <select class=\"prefs__select\" id=\"cfgDiscTurn\">\n"
        "              <option value=\"steady\">Turn all the way round</option>\n"
        "              <option value=\"tempo\">Turn with the song’s tempo</option>\n"
        "              <option value=\"lock\">Hold it at its angle</option>\n"
        "              <option value=\"off\">Stay where I leave it</option>\n"
        "            </select>\n"
        "          </div>\n"
        "          <div class=\"prefs__row\" id=\"cfgDiscTurnSpeedRow\">\n"
        "            <label for=\"cfgDiscTurnSpeed\">Turn speed</label>\n"
        "            <div class=\"weight vol__row\">\n"
        "              <input type=\"range\" id=\"cfgDiscTurnSpeed\" min=\"0.25\" max=\"3\" step=\"0.25\" aria-describedby=\"cfgDiscTurnSpeedVal\">\n"
        "              <span class=\"weight__val\" id=\"cfgDiscTurnSpeedVal\"></span>\n"
        "            </div>\n"
        "          </div>\n"
        "          <div class=\"prefs__row\" id=\"cfgDiscFacingRow\">\n"
        "            <label for=\"cfgDiscFacing\">Angle</label>\n"
        "            <select class=\"prefs__select\" id=\"cfgDiscFacing\">\n"
        "              <option value=\"front\">The label, face on</option>\n"
        "              <option value=\"angle\">The label, at an angle</option>\n"
        "              <option value=\"edge\">The edge</option>\n"
        "              <option value=\"back\">The playing side</option>\n"
        "              <option value=\"custom\">My own angle</option>\n"
        "            </select>\n"
        "          </div>\n"
        "          <div class=\"prefs__row\">\n"
        "            <label for=\"cfgDiscYaw\">Exact angle</label>\n"
        "            <div class=\"weight vol__row\">\n"
        "              <input type=\"range\" id=\"cfgDiscYaw\" min=\"0\" max=\"355\" step=\"5\" aria-describedby=\"cfgDiscYawVal\">\n"
        "              <span class=\"weight__val\" id=\"cfgDiscYawVal\"></span>\n"
        "            </div>\n"
        "          </div>\n"
        "          <div class=\"prefs__row\">\n"
        "            <label for=\"cfgDiscPitch\">Tilt</label>\n"
        "            <div class=\"weight vol__row\">\n"
        "              <input type=\"range\" id=\"cfgDiscPitch\" min=\"-30\" max=\"80\" step=\"5\" aria-describedby=\"cfgDiscPitchVal\">\n"
        "              <span class=\"weight__val\" id=\"cfgDiscPitchVal\"></span>\n"
        "            </div>\n"
        "          </div>\n"
        "          <div class=\"prefs__row\">\n"
        "            <span class=\"prefs__label\">Position</span>\n"
        "            <button class=\"prefs__btn\" type=\"button\" id=\"cfgDiscReset\">Reset Position</button>\n"
        "          </div>\n"
        "          <p class=\"prefs__hint\">The angle is where the disc starts, and where it stays when it is held; tilt is how far it leans back, and Reset Position puts it back there after you have dragged it. Tempo follows the song’s BPM: at 120 BPM the disc moves at the speed set, faster songs faster; a song with no known tempo, and the radio, use the steady speed. Turn also covers the closed case while nothing plays. Reduce animation, above, still slows the spin and stops the turning.</p>\n"
        "        </fieldset>\n"
        "\n"
        "        <fieldset class=\"prefs__group\">\n"
        "          <legend class=\"prefs__legend\">Listening</legend>")

replace("theme: 'auto', motion: false, stage: true,",
        "theme: 'auto', motion: false, stage: true,\n"
        "      disc: { spin: 'steady', spinSpeed: 1, turn: 'steady', turnSpeed: 1, facing: 'front', yaw: 0, pitch: 40 },")

replace("      ['motion', 'stage'].forEach(function (k) {\n"
        "        if (typeof saved[k] === 'boolean') cfg[k] = saved[k];\n"
        "      });\n",
        "      ['motion', 'stage'].forEach(function (k) {\n"
        "        if (typeof saved[k] === 'boolean') cfg[k] = saved[k];\n"
        "      });\n"
        "      if (saved.disc && typeof saved.disc === 'object') {\n"
        "        var sd = saved.disc;\n"
        "        if (/^(steady|tempo|off)$/.test(sd.spin)) cfg.disc.spin = sd.spin;\n"
        "        if (/^(steady|tempo|lock|off)$/.test(sd.turn)) cfg.disc.turn = sd.turn;\n"
        "        if (/^(front|angle|edge|back|custom)$/.test(sd.facing)) cfg.disc.facing = sd.facing;\n"
        "        if (typeof sd.yaw === 'number' && sd.yaw >= 0 && sd.yaw < 360) cfg.disc.yaw = sd.yaw;\n"
        "        if (typeof sd.pitch === 'number' && sd.pitch >= -30 && sd.pitch <= 80) cfg.disc.pitch = sd.pitch;\n"
        "        ['spinSpeed', 'turnSpeed'].forEach(function (k) {\n"
        "          if (typeof sd[k] === 'number' && sd[k] >= 0.25 && sd[k] <= 3) cfg.disc[k] = sd[k];\n"
        "        });\n"
        "      }\n")

replace("      document.getElementById('cfgStage').checked = cfg.stage;\n",
        "      document.getElementById('cfgStage').checked = cfg.stage;\n"
        "      discFill();\n")

replace("    document.getElementById('cfgStage').addEventListener('change', function () {\n"
        "      cfg.stage = this.checked; cfgSave(); applyPlayer(); setStatus('Saved.');\n"
        "    });\n",
        "    document.getElementById('cfgStage').addEventListener('change', function () {\n"
        "      cfg.stage = this.checked; cfgSave(); applyPlayer(); setStatus('Saved.');\n"
        "    });\n"
        "\n"
        "    /* The disc (NP-PREF-014). Each control saves at once, like the rest of this pane; a speed\n"
        "       shows on the stage while it is being dragged and is saved when it is let go. */\n"
        "    function discSpeedText(v) { return (Math.round(v * 100) / 100) + '×'; }\n"
        "    function discFill() {\n"
        "      var d = cfg.disc;\n"
        "      document.getElementById('cfgDiscSpin').value = d.spin;\n"
        "      document.getElementById('cfgDiscTurn').value = d.turn;\n"
        "      document.getElementById('cfgDiscFacing').value = d.facing;\n"
        "      document.getElementById('cfgDiscSpinSpeed').value = String(d.spinSpeed);\n"
        "      document.getElementById('cfgDiscTurnSpeed').value = String(d.turnSpeed);\n"
        "      document.getElementById('cfgDiscSpinSpeedVal').textContent = discSpeedText(d.spinSpeed);\n"
        "      document.getElementById('cfgDiscTurnSpeedVal').textContent = discSpeedText(d.turnSpeed);\n"
        "      document.getElementById('cfgDiscSpinSpeedRow').hidden = d.spin === 'off';\n"
        "      document.getElementById('cfgDiscTurnSpeedRow').hidden = d.turn === 'off' || d.turn === 'lock';\n"
        "      document.getElementById('cfgDiscYaw').value = String(d.yaw);\n"
        "      document.getElementById('cfgDiscPitch').value = String(d.pitch);\n"
        "      document.getElementById('cfgDiscYawVal').textContent = d.yaw + '°';\n"
        "      document.getElementById('cfgDiscPitchVal').textContent = d.pitch + '°';\n"
        "    }\n"
        "    var DISC_PRESET_YAW = { front: 0, angle: 45, edge: 90, back: 180 };\n"
        "    function discPresetOf(yaw) {\n"
        "      for (var k in DISC_PRESET_YAW) if (DISC_PRESET_YAW[k] === yaw) return k;\n"
        "      return 'custom';\n"
        "    }\n"
        "    /* Tells the stage to put the disc at the chosen angle and tilt now, dropping any dragged pose. */\n"
        "    function discPlace() { document.dispatchEvent(new CustomEvent('disc:place')); }\n"
        "    document.getElementById('cfgDiscFacing').addEventListener('change', function () {\n"
        "      if (this.value !== 'custom') cfg.disc.yaw = DISC_PRESET_YAW[this.value];\n"
        "      cfg.disc.facing = this.value; cfgSave(); discFill(); applyPlayer(); discPlace(); setStatus('Saved.');\n"
        "    });\n"
        "    [['cfgDiscYaw', 'yaw'], ['cfgDiscPitch', 'pitch']].forEach(function (p) {\n"
        "      var el = document.getElementById(p[0]);\n"
        "      el.addEventListener('input', function () {\n"
        "        cfg.disc[p[1]] = +this.value;\n"
        "        if (p[1] === 'yaw') cfg.disc.facing = discPresetOf(cfg.disc.yaw);\n"
        "        discFill(); applyPlayer(); discPlace();\n"
        "      });\n"
        "      el.addEventListener('change', function () { cfgSave(); setStatus('Saved.'); });\n"
        "    });\n"
        "    document.getElementById('cfgDiscReset').addEventListener('click', function () {\n"
        "      discPlace(); setStatus('The disc is back at its angle and tilt.');\n"
        "    });\n"
        "    [['cfgDiscSpin', 'spin'], ['cfgDiscTurn', 'turn']].forEach(function (p) {\n"
        "      document.getElementById(p[0]).addEventListener('change', function () {\n"
        "        cfg.disc[p[1]] = this.value; cfgSave(); discFill(); applyPlayer(); setStatus('Saved.');\n"
        "      });\n"
        "    });\n"
        "    [['cfgDiscSpinSpeed', 'spinSpeed'], ['cfgDiscTurnSpeed', 'turnSpeed']].forEach(function (p) {\n"
        "      var el = document.getElementById(p[0]);\n"
        "      el.addEventListener('input', function () {\n"
        "        cfg.disc[p[1]] = +this.value;\n"
        "        document.getElementById(p[0] + 'Val').textContent = discSpeedText(+this.value);\n"
        "        applyPlayer();\n"
        "      });\n"
        "      el.addEventListener('change', function () { cfgSave(); setStatus('Saved.'); });\n"
        "    });\n")

# ---- the stage follows cfg.disc, and the song's tempo -------------------------------------------------------
replace("function applyStagePrefs(c) {\n"
        "  reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches || !!c.motion;\n"
        "  stageOn = c.stage !== false;\n"
        "}\n",
        "function applyStagePrefs(c) {\n"
        "  reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches || !!c.motion;\n"
        "  stageOn = c.stage !== false;\n"
        "  discPrefs = Object.assign({}, DISC_DEFAULTS, c.disc || {});\n"
        "}\n"
        "\n"
        "/* How the disc moves (NP-PREF-014): the listener's choice, from Settings ▸ Player ▸ The disc. */\n"
        "const DISC_DEFAULTS = { spin: 'steady', spinSpeed: 1, turn: 'steady', turnSpeed: 1, facing: 'front', yaw: 0, pitch: 40 };\n"
        "let discPrefs = Object.assign({}, DISC_DEFAULTS);\n"
        "/* The playing song's tempo, when it is known. The radio has none. */\n"
        "let songBpm = null, songKey = '';\n"
        "const keyOf = (t, a) => String(t || '').toLowerCase() + '\\u0001' + String(a || '').toLowerCase();\n"
        "document.addEventListener('library:play', e => {\n"
        "  const s = e.detail && e.detail.song;\n"
        "  songKey = s ? keyOf(s.title, s.artist) : '';\n"
        "  songBpm = s && s.bpm > 0 ? +s.bpm : null;\n"
        "});\n"
        "document.addEventListener('library:bpm', e => {\n"
        "  const d = e.detail || {};\n"
        "  if (songKey && keyOf(d.title, d.artist) === songKey && d.bpm > 0) songBpm = +d.bpm;\n"
        "});\n"
        "document.addEventListener('radio:station', () => { songBpm = null; songKey = ''; });\n"
        "/* After the defaults above exist: the stage can start after the preferences were announced. */\n"
        "if (window.NP_PREFS) applyStagePrefs(window.NP_PREFS);\n")

replace("const DISC_SPIN = reduceMotion ? 1.0 : 8.0;   // about its own axis\n",
        "const DISC_SPIN = reduceMotion ? 1.0 : 8.0;   // about its own axis\n"
        "const DISC_SPIN_BASE = 8.0;                   // rad/s at 1×, before Reduce animation\n"
        "const DISC_TURN_BASE = 0.42;                  // rad/s at 1×: about one turn in fifteen seconds\n"
        "/* The listener's angle (yaw) and tilt (pitch), in degrees in the preferences. */\n"
        "const yawRad = () => ((discPrefs.yaw || 0) * Math.PI) / 180;\n"
        "const pitchRad = () => (-(typeof discPrefs.pitch === 'number' ? discPrefs.pitch : 40) * Math.PI) / 180;\n"
        "/* At 120 BPM the chosen speed; faster songs faster, within reason. */\n"
        "const tempoScale = () => (songBpm ? Math.min(2.5, Math.max(0.4, songBpm / 120)) : 1);\n"
        "function discSpinRate() {\n"
        "  if (discPrefs.spin === 'off') return 0;\n"
        "  const rate = DISC_SPIN_BASE * discPrefs.spinSpeed * (discPrefs.spin === 'tempo' ? tempoScale() : 1);\n"
        "  return reduceMotion ? Math.min(rate, 1.0) : rate;\n"
        "}\n"
        "function discTurnRate() {\n"
        "  if (reduceMotion || discPrefs.turn === 'off' || discPrefs.turn === 'lock') return 0;\n"
        "  /* With the tempo: one full turn every 32 beats — eight bars of 4/4. */\n"
        "  if (discPrefs.turn === 'tempo' && songBpm) return TWO_PI * (songBpm / 60) / 32 * discPrefs.turnSpeed;\n"
        "  return DISC_TURN_BASE * discPrefs.turnSpeed;\n"
        "}\n"
        "/* The closed case turns while nothing plays only when the disc is allowed to turn. */\n"
        "function caseTurnScale() {\n"
        "  if (discPrefs.turn === 'off' || discPrefs.turn === 'lock') return 0;\n"
        "  return discPrefs.turnSpeed * (discPrefs.turn === 'tempo' ? tempoScale() : 1);\n"
        "}\n")

replace("  } else if (!dragging && !reduceMotion) {\n"
        "    baseRY += SPIN * dt;\n",
        "  } else if (!dragging && !reduceMotion) {\n"
        "    baseRY += SPIN * caseTurnScale() * dt;\n")

replace("  if (playing && !holdingDisc) turn += DISC_TURN * dt;\n",
        "  if (playing && !holdingDisc) {\n"
        "    if (discPrefs.turn === 'lock') {\n"
        "      // settle on the nearest copy of the chosen facing, never the long way round\n"
        "      const want = yawRad();\n"
        "      const target = want + Math.round((turn - want) / TWO_PI) * TWO_PI;\n"
        "      turn += (target - turn) * (1 - Math.pow(0.02, dt));\n"
        "    } else {\n"
        "      turn += discTurnRate() * dt;\n"
        "    }\n"
        "  }\n")

replace("  const spinTarget = playing ? DISC_SPIN : 0;\n",
        "  const spinTarget = playing ? discSpinRate() : 0;\n")

# What the stage is doing, for the e2e suite and for anyone checking a setting took: read-only.
replace("renderer.setAnimationLoop(tick);\n",
        "renderer.setAnimationLoop(tick);\n"
        "window.NP_DISC = Object.freeze({\n"
        "  motion: () => ({ spin: discSpinRate(), turn: discTurnRate(), angle: turn, tilt: discTilt, pitch: pitchRad(), out: lastDiscT, spinning: spinSpeed, bpm: songBpm, prefs: Object.assign({}, discPrefs), preview: discPreviewState() }),\n"
        "});\n")


# The 3D stage loads three.js asynchronously, so it can start after the preferences were announced and
# miss them: Reduce animation, "Show the 3D case" and now the disc's motion were ignored on a reload.
# The preferences in force are kept where the stage reads them as it starts.
replace("      document.dispatchEvent(new CustomEvent('prefs:change', { detail: { cfg: cfg } }));\n",
        "      window.NP_PREFS = cfg;   // read by the 3D stage when it starts later than this\n"
        "      document.dispatchEvent(new CustomEvent('prefs:change', { detail: { cfg: cfg } }));\n")


# The disc's speed sliders keep their value beside them, at a width a slider can be read at.
replace("  .vol__row .weight__val { min-width: 34px; text-align: right; }\n",
        "  .vol__row .weight__val { min-width: 34px; text-align: right; }\n"
        "  #discPrefs .vol__row { flex-wrap: nowrap; max-width: 320px; }\n"
        "  #discPrefs .vol__row input[type=\"range\"] { flex: 1 1 auto; min-width: 0; }\n")


# The disc's tilt is the listener's (NP-PREF-014); 40° back is the angle it always had.
replace("    DISC_TILT + discTilt + Math.sin(idleT * 1.7) * 0.05 * wob,\n",
        "    pitchRad() + discTilt + Math.sin(idleT * 1.7) * 0.05 * wob,\n")

# Reset Position, and a new angle or tilt chosen in Settings: the disc goes there now and the dragged pose is dropped.
replace("poseStore.load().then(pose => {\n",
        "document.addEventListener('disc:place', () => {\n"
        "  turn = yawRad();\n"
        "  discTilt = 0;\n"
        "  savePose(true);\n"
        "});\n"
        "\n"
        "poseStore.load().then(pose => {\n")

# A live preview in Settings ▸ Player ▸ The disc: a copy of the real disc, lit the way the stage lights it, moving
# the way the settings say, as if a song were playing. Its own small renderer, running only while it is on screen.
replace("window.NP_DISC = Object.freeze({\n",
        "let discPreviewState = () => ({ running: false, frames: 0 });\n"
        "(function discPreview() {\n"
        "  const host = document.getElementById('discPreview');\n"
        "  const note = document.getElementById('discPreviewNote');\n"
        "  if (!host) return;\n"
        "  let r = null, sc = null, cam = null, pivot = null, spinner = null, raf = 0, last = 0, frames = 0;\n"
        "  let running = false, pTurn = 0, pSpin = 0, pSpeed = 0;\n"
        "  function build() {\n"
        "    r = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: false });\n"
        "    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));\n"
        "    r.outputColorSpace = THREE.SRGBColorSpace;\n"
        "    r.toneMapping = THREE.ACESFilmicToneMapping;\n"
        "    r.domElement.style.width = '100%';\n"
        "    r.domElement.style.height = '100%';\n"
        "    host.appendChild(r.domElement);\n"
        "    sc = new THREE.Scene();\n"
        "    const pm = new THREE.PMREMGenerator(r);\n"
        "    sc.environment = pm.fromScene(new RoomEnvironment(), 0.03).texture;\n"
        "    sc.environmentIntensity = 0.85;\n"
        "    pm.dispose();\n"
        "    sc.add(box1.clone(), box2.clone(), back.clone(), rim.clone(), fill.clone());\n"
        "    pivot = new THREE.Group();\n"
        "    spinner = disc.clone(true);\n"
        "    spinner.rotation.set(0, 0, 0);\n"
        "    pivot.add(spinner);\n"
        "    sc.add(pivot);\n"
        "    cam = new THREE.PerspectiveCamera(28, 1, 0.1, 40);\n"
        "    cam.position.set(0, 0, (DISC_R * 1.22) / Math.tan(THREE.MathUtils.degToRad(14)));\n"
        "    pTurn = yawRad();\n"
        "  }\n"
        "  function size() {\n"
        "    const px = Math.max(1, Math.round(host.clientWidth));\n"
        "    r.setSize(px, px, false);\n"
        "  }\n"
        "  function say() {\n"
        "    if (!note) return;\n"
        "    const tempo = discPrefs.spin === 'tempo' || discPrefs.turn === 'tempo';\n"
        "    note.textContent = !tempo ? 'As it moves while a song plays.'\n"
        "      : songBpm ? 'As it moves with this song, at ' + Math.round(songBpm) + ' BPM.'\n"
        "      : 'As it moves with a song at 120 BPM.';\n"
        "  }\n"
        "  function loop(t) {\n"
        "    if (!running) return;\n"
        "    raf = requestAnimationFrame(loop);\n"
        "    const dt = Math.min((t - (last || t)) / 1000, 0.05);\n"
        "    last = t;\n"
        "    pSpeed += (discSpinRate() - pSpeed) * (1 - Math.pow(0.15, dt));\n"
        "    pSpin += pSpeed * dt;\n"
        "    spinner.rotation.z = pSpin;\n"
        "    if (discPrefs.turn === 'lock' || discPrefs.turn === 'off') {\n"
        "      const want = yawRad();\n"
        "      const target = want + Math.round((pTurn - want) / TWO_PI) * TWO_PI;\n"
        "      pTurn += (target - pTurn) * (1 - Math.pow(0.02, dt));\n"
        "    } else {\n"
        "      pTurn += discTurnRate() * dt;\n"
        "    }\n"
        "    pivot.rotation.set(pitchRad(), pTurn, 0);   // XYZ: tilt, then turn — the stage's own order\n"
        "    r.render(sc, cam);\n"
        "    frames += 1;\n"
        "  }\n"
        "  function start() {\n"
        "    if (running) return;\n"
        "    if (!r) build();\n"
        "    size();\n"
        "    say();\n"
        "    running = true;\n"
        "    last = 0;\n"
        "    raf = requestAnimationFrame(loop);\n"
        "  }\n"
        "  function stop() {\n"
        "    running = false;\n"
        "    cancelAnimationFrame(raf);\n"
        "  }\n"
        "  new IntersectionObserver(es => (es.some(e => e.isIntersecting) ? start() : stop())).observe(host);\n"
        "  document.addEventListener('disc:place', () => { pTurn = yawRad(); });\n"
        "  document.addEventListener('prefs:change', say);\n"
        "  document.addEventListener('library:play', () => setTimeout(say, 0));\n"
        "  window.addEventListener('resize', () => { if (r && running) size(); });\n"
        "  discPreviewState = () => ({ running, frames, turn: pTurn, spin: pSpeed });\n"
        "})();\n"
        "window.NP_DISC = Object.freeze({\n")

replace("  #discPrefs .vol__row { flex-wrap: nowrap; max-width: 320px; }\n",
        "  #discPrefs .vol__row { flex-wrap: nowrap; max-width: 320px; }\n"
        "  .disc-preview { display: flex; flex-direction: column; align-items: center; gap: 4px; margin: 0 0 8px; }\n"
        "  .disc-preview__stage { width: 200px; height: 200px; max-width: 60vw; max-height: 60vw; }\n"
        "  .disc-preview__note { margin: 0; text-align: center; }\n"
        "  #discPrefs #cfgDiscReset { width: auto; flex: none; justify-self: start; }\n")

# ---- spacing: the additions sit on the design's own rhythm -------------------------------------------------
# Measured against the design's preference rows (148px labels, a 10px gap, 8px between rows):
#  - a slider row (.weight.vol__row: the design's own Default volume and the disc's four) kept the
#    .weight list's 11px bottom margin. The design writes `.vol__row { margin: 0 }`, but `.weight`
#    comes later in the sheet and wins, so the row grew to 26px and its label sat 5px below the slider;
#  - the PC card's status line ("Not paired.") stood at the card's edge, while the two cards above put
#    theirs in the controls column (148px label + 10px gap). On a phone the columns are one, as there.
replace("</style>\n",
        "  .prefs__row > .weight.vol__row { margin-bottom: 0; }\n"
        "  @media (min-width: 720px) { .conn__card > #pcMsg { margin-left: 158px; } }\n"
        "</style>\n")

# ---- sanity: none of the words that would mean sample data survive ----------------------------------------------
for bad in ("S.src = 'demo'", "? 'browser' : 'demo'", 'Cassette Bloom', 'Fennel Grove', 'AW.buildDemo', 'Demo year', "'demo-'", 'DEMO_HISTORY', 'api.anthropic.com', 'anthropic-version', 'cdn.jsdelivr.net/npm/three@', 'Airwave One', 'The Glass Coast'):
    assert bad not in text, f'left behind: {bad}'

DST.write_text(text, encoding='utf-8')
print(f'{DST.relative_to(ROOT)}: {edits} edits, {len(text.splitlines())} lines, {len(text.encode("utf-8")) // 1024} KB')
