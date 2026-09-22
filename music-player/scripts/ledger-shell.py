"""
Put the player shell's surfaces into design/coverage.json (Step C of the part-2 prompt).

The React player's entries stay in the ledger, because the styleguide still renders those views as
specimens, but they are no longer what is served: they are marked so (authority `proposed`, entry
prefixed) and DEC-019 says why. The shell's surfaces are added, discovered from the `ShellSurface`
union in music-player/src/shell/bridge.ts. Idempotent.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
p = ROOT / 'design' / 'coverage.json'
c = json.loads(p.read_text(encoding='utf-8'))

SHELL = ['music-player/index.html', 'music-player/scripts/make-shell.py', 'music-player/src/shell/bridge.ts']
NP = 'music-player/tests/e2e/np/'

if not any(d.get('file') == 'music-player/src/shell/bridge.ts' for d in c['discovery']):
    c['discovery'].append({'product': 'player', 'kind': 'view-union', 'file': 'music-player/src/shell/bridge.ts', 'type': 'ShellSurface', 'prefix': 'player-shell-'})

for s in c['surfaces']:
    if s['id'].startswith('player-') and not s['id'].startswith('player-shell-') and s.get('product') == 'player':
        if not s['entry'].startswith('(React specimen'):
            s['entry'] = '(React specimen, not served — DEC-019) ' + s['entry']
        s['authority'] = 'proposed'

def surface(sid, title, entry, states, rules, extra=()):
    return {'id': f'player-shell-{sid}', 'kind': 'screen', 'product': 'player', 'platform': 'web', 'title': title, 'entry': entry,
            'sourcePaths': SHELL + list(extra), 'components': ['shell markup (design/frontends/airwave-now-playing.html)'],
            'states': states, 'rules': rules, 'guideAnchor': 'screens', 'authority': 'adopted'}

NEW = [
    surface('library', 'Library', 'the list under the player; Music view', ['empty (nothing indexed)', 'rows from this device', 'link rows from search', 'sorted', 'narrowed by scope chip', 'filtered by the bar'], ['NP-LIST-001', 'UX-KEY-001', 'UX-STATE-001']),
    surface('now-playing', 'Now Playing', 'the jewel case and transport at the top of the page', ['nothing playing', 'a track from this device playing (the bar follows the element)', 'paused', 'a link row chosen (does not pretend to play)', 'a station (LIVE)', 'a channel (video bar, LIVE)'], ['NP-TRANS-001', 'UX-KEY-002']),
    surface('search-popover', 'Search popover', 'the header search field', ['empty', 'results from companion / iTunes', 'pasted link resolved', 'people on the hub'], ['NP-PRIN-002']),
    surface('row-menu', 'Row menu', 'right-click or long-press a row', ['one row', 'several rows (marquee)'], ['NP-MENU-001']),
    surface('new-playlist-sheet', 'New playlist sheet', 'row menu ▸ Add to Playlist ▸ New Playlist…', ['empty name refused', 'created'], ['NP-MENU-002']),
    surface('fetch-sheet', 'Fetch sheet', 'transport ▸ Download, on a link row', ['no basis chosen (refused, said why)', 'helper found / not found', 'fetching', 'refused by the helper (its reason)', 'fetched and playing'], ['UX-SAFE-001', 'UX-FEED-001'], ['music-player/src/lib/tools-core.ts']),
    surface('mini-player', 'Mini player', 'the header while Settings is open', ['hidden', 'shown for music and radio'], ['NP-CHROME-001']),
    surface('radio', 'Radio', 'toolbar ▸ Radio', ['directory unreachable (offline shelf)', 'a station playing', 'station list'], ['NP-LIVE-001']),
    surface('live-tv', 'Live TV', 'toolbar ▸ Live TV', ['no playlist loaded (empty guide)', 'channels from a loaded M3U', 'a channel playing (LIVE)'], ['NP-LIVE-002']),
    surface('tv', 'TV', 'toolbar ▸ TV', ['no catalogue (nothing invented)'], ['NP-PRIN-001']),
    surface('movies', 'Movies', 'toolbar ▸ Movies', ['no catalogue (nothing invented)'], ['NP-PRIN-001']),
    surface('settings-statistics', 'Settings ▸ Statistics', 'profile button ▸ Statistics, or #settings/stats', ['nothing recorded yet', "this player's history", 'imported file', '3D views unavailable (tables still carry the numbers)'], ['NP-DATA-001']),
    surface('settings-recommendations', 'Settings ▸ Recommendations', '#settings/rec', ['defaults', 'edited', 'saved algorithm', 'reverted'], ['NP-PREF-001']),
    surface('settings-sources', 'Settings ▸ Sources', '#settings/src', ['music on this device (folders/files)', 'companion found / missing downloaders', 'hub tested / paired', 'backup measured (nothing sent)', 'backup will not fit (reason)'], ['NP-PREF-002', 'UX-FEED-001']),
    surface('settings-player', 'Settings ▸ Player', '#settings/player', ['appearance', 'listening', 'defaults'], ['NP-PREF-003']),
    surface('settings-equalizer', 'Settings ▸ Equalizer', '#settings/eq', ['preset', 'custom', 'default volume'], ['NP-PREF-004']),
    surface('settings-profile', 'Settings ▸ Profile', '#settings/profile (shown when paired)', ['name available / taken', 'picture', 'shared playlists', 'groups', 'invites received / sent', 'declined'], ['NP-PREF-005', 'UX-SAFE-001']),
    surface('profile-viewer', 'Profile viewer', 'search ▸ a person, or a group member', ['their name, picture and shared playlists', 'a playlist opened'], ['NP-PREF-005']),
    surface('invite-page', 'Invite page', 'a #invite/<code> link', ['previewed (group, sender, role, expiry)', 'unknown or used code', 'joined', 'declined'], ['NP-PREF-005']),
]
have = {s['id'] for s in c['surfaces']}
c['surfaces'].extend(s for s in NEW if s['id'] not in have)
for f in c['flows']:
    f['surfaces'] = [{'player-library': 'player-shell-library', 'player-settings': 'player-shell-settings-sources', 'player-shell': 'player-shell-now-playing',
                      'player-queue': 'player-shell-now-playing', 'player-sheet-fetch': 'player-shell-fetch-sheet'}.get(x, x) for x in f['surfaces']]
p.write_text(json.dumps(c, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
print('surfaces now', len(c['surfaces']))
