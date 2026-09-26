"""
Build music-player/index.html (the shell) from design/frontends/airwave-now-playing.html.

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
SRC = ROOT / 'design' / 'frontends' / 'airwave-now-playing.html'
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
        '<title>Now Playing</title>\n'
        '<meta name="color-scheme" content="light">\n'
        '<meta name="theme-color" content="#dfe4ea">\n'
        '<meta name="description" content="An offline-first music player for the music already on your device.">\n'
        '<meta name="mobile-web-app-capable" content="yes">\n'
        '<meta name="apple-mobile-web-app-capable" content="yes">\n'
        '<meta name="apple-mobile-web-app-title" content="Now Playing">\n'
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
# The frontend was drawn as "Airwave"; the product is Now Playing (packages/contracts/src/branding.ts),
# as the hub and the companion windows already say. The lowercase `airwave-algorithm` file type stays:
# it is a format name files already carry.
replace("AirwaveNowPlaying/1.0", "NowPlaying/1.0")
n = text.count('Airwave')
text = text.replace('Airwave', 'Now Playing')
edits += 1
assert 'Airwave' not in text and n > 0

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
        "    var hubReady = false;\n"
        "    hubAcctFor().then(function (a) { hubReady = !!a; });\n"
        "    var HUB_PLATFORM_NAMES = { youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify', bandcamp: 'Bandcamp' };\n"
        "    function fromHub(d) {\n"
        "      var rows = (d && d.results) || [], out = [];\n"
        "      for (var i = 0; i < rows.length && out.length < 25; i++) {\n"
        "        var x = rows[i] || {};\n"
        "        if (x.kind !== 'track' || typeof x.title !== 'string') continue;\n"
        "        var conf = x.identity && typeof x.identity.matchConfidence === 'number' ? x.identity.matchConfidence : null;\n"
        "        /* Below 0.5 the hub itself refused to guess; this listing shows the platform's own words. */\n"
        "        var sure = conf === null || conf >= 0.5;\n"
        "        var r = track(x.title, x.artistName || '', sure ? (x.albumName || '') : '', x.artworkUrl || null,\n"
        "                      x.previewUrl || null, x.canonicalUrl || null, HUB_PLATFORM_NAMES[x.provider] || null,\n"
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
        "      hubAcctFor().then(function (a) { hubReady = !!a; });\n"
        "      var chain = hubReady ? [hubSearch, companionSearch, itunesSearch] : [companionSearch, itunesSearch];")

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
        "            return getJSON(acct.base + '/api/v1/providers/resolve?url=' + enc, false, 8000, hubAuth(acct)).then(function (d) {\n"
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

# ---- sanity: none of the words that would mean sample data survive ----------------------------------------------
for bad in ("S.src = 'demo'", "? 'browser' : 'demo'", 'Cassette Bloom', 'Fennel Grove', 'AW.buildDemo', 'Demo year', "'demo-'", 'DEMO_HISTORY', 'api.anthropic.com', 'anthropic-version', 'cdn.jsdelivr.net/npm/three@', 'Airwave One', 'The Glass Coast'):
    assert bad not in text, f'left behind: {bad}'

DST.write_text(text, encoding='utf-8')
print(f'{DST.relative_to(ROOT)}: {edits} edits, {len(text.splitlines())} lines, {len(text.encode("utf-8")) // 1024} KB')
