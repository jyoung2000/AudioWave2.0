"""
Merge airwave-np's design records into this repo's (master prompt, Phase 3 ground rule 4).

NP-* rules join design/ux-rules.json in this repo's shape: groups become {id, title} objects under
an `np-` prefix (this repo already has a `principles` group), owners become the shell and the
script that generates it, and each test evidence entry points at the ported suite under
music-player/tests/e2e/np/ with the name of the test there that carries the same assertion. That
name is matched, not invented: the ported test whose title shares the most words with the
original's, and only when the ported file exists. NPD-* rows are appended to design/decisions.md,
with a note where a fact they record has since changed here.

Idempotent: rules and rows already present by ID are left alone.
Usage:  python music-player/scripts/merge-np-design.py [path-to-airwave-np]
"""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NP = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r'C:\Users\jalon\projects\airwave-np')
SPECS = ROOT / 'music-player' / 'tests' / 'e2e' / 'np'
OWNERS = ['music-player/index.html', 'music-player/scripts/make-shell.py']

STOP = {'the', 'a', 'an', 'and', 'of', 'to', 'in', 'on', 'is', 'it', 'its', 'at', 'for', 'by', 'with', 'as', 'or', 'not', 'no'}


def words(text: str) -> set[str]:
    return {w for w in re.findall(r'[a-z0-9]+', text.lower()) if w not in STOP}


def titles(spec: Path) -> list[str]:
    """Test titles as literal substrings of the file (the check greps for them)."""
    out = []
    for m in re.finditer(r"\btest\(\s*(['\"`])(.*?)\1", spec.read_text(encoding='utf-8'), re.S):
        title = m.group(2)
        if m.group(1) == '`' and '${' in title:
            # a templated title: the longest fixed fragment is what the file literally contains
            title = max(re.split(r'\$\{[^}]*\}', title), key=len).strip()
        if len(title) >= 12:
            out.append(title)
    return out


def best_title(name: str, spec: Path) -> str | None:
    candidates = titles(spec)
    if not candidates:
        return None
    want = words(name)
    scored = sorted(candidates, key=lambda t: len(want & words(t)), reverse=True)
    return scored[0] if want & words(scored[0]) else candidates[0]


# ---------------------------------------------------------------- rules
rules_path = ROOT / 'design' / 'ux-rules.json'
rules = json.loads(rules_path.read_text(encoding='utf-8'))
np_rules = json.loads((NP / 'design' / 'ux-rules.json').read_text(encoding='utf-8'))

have_groups = {g['id'] for g in rules['groups']}
for gid, label in np_rules['groups'].items():
    if f'np-{gid}' not in have_groups:
        rules['groups'].append({'id': f'np-{gid}', 'title': f'Player shell — {label}'})

have_rules = {r['id'] for r in rules['rules']}
added = unmapped = 0
for r in np_rules['rules']:
    if r['id'] in have_rules:
        continue
    evidence = []
    for e in r.get('evidence', []):
        if e.get('type') == 'test' and e.get('path', '').startswith('tests/'):
            spec = SPECS / (Path(e['path']).stem + '.spec.ts')
            if spec.exists():
                t = best_title(e.get('name', ''), spec)
                if t:
                    evidence.append({'type': 'test', 'path': spec.relative_to(ROOT).as_posix(), 'name': t})
                    continue
        # no ported test carries it: say so rather than point at nothing
    if not evidence:
        evidence.append({'type': 'reviewer', 'note': 'Carried from airwave-np; its test did not survive the port as a separate assertion. Checked in review against the shell.'})
        unmapped += 1
    rules['rules'].append({
        'id': r['id'],
        'group': f"np-{r['group']}",
        'title': r['title'],
        'contract': r['contract'],
        'example': r.get('example', ''),
        'authority': r.get('authority', 'adopted'),
        'owners': OWNERS,
        'evidence': evidence,
    })
    added += 1
rules_path.write_text(json.dumps(rules, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

# ------------------------------------------------------------ decisions
NOTES = {
    'NPD-023': 'In this repo the generated demo year is gone (DEC-019): Statistics shows this player\'s recorded history, and an empty history is an empty year.',
    'NPD-024': 'In this repo the companion runs real backups (Step B, DEC-018) and the player measures with the same code; Back Up Now in the player says nothing was sent.',
    'NPD-025': 'In this repo the profile routes exist (Phase 1A) and the shell calls them.',
    'NPD-028': 'In this repo both routes exist (Phase 1C): GET /helper/v1/backup/estimate and GET /api/v1/backup/space.',
    'NPD-031': 'In this repo the invite routes exist (Phase 1B): list, withdraw, preview, /me/invites, accept, decline.',
}
dec_path = ROOT / 'design' / 'decisions.md'
dec = dec_path.read_text(encoding='utf-8').rstrip('\n')
present = set(re.findall(r'^\|\s*(NPD-\d{3})\s*\|', dec, re.M))
rows = []
for line in (NP / 'design' / 'decisions.md').read_text(encoding='utf-8').splitlines():
    m = re.match(r'^\|\s*(NPD-\d{3})\s*\|\s*(\w+)\s*\|\s*(.*)\|\s*$', line)
    if not m or m.group(1) in present:
        continue
    ident, status, text = m.group(1), m.group(2), m.group(3).strip()
    text = text.replace('`now-playing.html`', '`design/frontends/origin/airwave-now-playing.html` (served here as `music-player/index.html`)')
    if ident in NOTES:
        text += ' ' + NOTES[ident]
    rows.append(f'| {ident} | {status:<10} | {text} |')
if rows:
    dec_path.write_text(dec + '\n' + '\n'.join(rows) + '\n', encoding='utf-8')

print(f'rules: {added} added ({unmapped} with reviewer evidence only); decisions: {len(rows)} rows added')
