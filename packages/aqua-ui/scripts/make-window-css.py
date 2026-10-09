"""
Build the Airwave window stylesheets from the two window designs.

design/frontends/origin/airwave-companion.html and airwave-hub.html are where the companion's and
the hub's window kit came from, exactly as airwave-now-playing.html is for the player (see
music-player/scripts/make-shell.py). They are frozen (DEC-038): a change to the kit is an asserted
entry in EDITS below. Their <style> blocks are one kit drawn twice: the companion's
is the base, the hub's adds tiles, tables, capability chips and the first-run gate. This script
copies them out verbatim, so the products cannot drift from the designs by hand:

  packages/aqua-ui/src/styles/airwave-window.css   the companion's sheet, whole
  packages/aqua-ui/src/styles/airwave-hub.css      every hub rule the base does not already carry

Run:  python packages/aqua-ui/scripts/make-window-css.py     (pnpm build:window-css)
"""
from __future__ import annotations
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FRONTENDS = ROOT / 'design' / 'frontends' / 'origin'
OUT = ROOT / 'packages' / 'aqua-ui' / 'src' / 'styles'


def style_of(name: str) -> str:
    html = (FRONTENDS / name).read_text(encoding='utf-8')
    found = re.findall(r'<style>(.*?)</style>', html, re.S)
    assert len(found) == 1, f'{name}: expected one <style>, found {len(found)}'
    return found[0].strip('\n') + '\n'


def chunks(css: str) -> list[str]:
    """Top-level rules (and at-rules), each with the comment that introduces it."""
    out, depth, start, i, n = [], 0, 0, 0, len(css)
    while i < n:
        if css.startswith('/*', i):
            i = css.index('*/', i) + 2
            continue
        ch = css[i]
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                out.append(css[start:i + 1])
                start = i + 1
        i += 1
    assert depth == 0, 'unbalanced braces'
    tail = css[start:].strip()
    assert not tail or tail.startswith('/*'), f'unparsed tail: {tail[:60]!r}'
    return out


def norm(rule: str) -> str:
    return re.sub(r'\s+', ' ', re.sub(r'/\*.*?\*/', '', rule, flags=re.S)).strip()


companion = style_of('airwave-companion.html')
hub = style_of('airwave-hub.html')
base = {norm(r) for r in chunks(companion)}
extra = [r for r in chunks(hub) if norm(r) not in base]
assert len(extra) > 20, 'the hub design should add tiles, tables and the gate'

# The designs are frozen history (design/decisions.md DEC-038): a change to the window kit is made
# here, as an edit to what was copied out, asserted against the exact text it replaces so a drift
# is a loud failure, the way music-player/scripts/make-shell.py records the player's.
# Each entry is (output file, old text, new text).
EDITS: list[tuple[str, str, str]] = [
    # The search's row menu and type control (UX-SEARCH-009, UX-SEARCH-012; owner, 2026-10-07): the
    # designs draw neither, and both windows need the same two, so they join the kit here — a 10.6
    # contextual menu (white, the selection's blue under the pointer or the keys, a tick column, a
    # submenu arrow, 44px commands on a touch screen) and a segmented control of push-button halves.
    ('airwave-window.css', '/* the "this is a mockup" plate under the window */', '''/* ============================================================ menus
   A contextual menu, as 10.6 drew one: a white sheet with a soft shadow,
   commands 20px tall with a tick column, the selection's blue on the
   command under the pointer or the keys, a separator, and a submenu that
   hangs beside its command. Opened from a row's "…" or a right-click. */
.menu {
  position: fixed;
  z-index: 40;
  min-width: 200px;
  max-width: min(320px, calc(100vw - 16px));
  padding: 4px 0;
  margin: 0;
  list-style: none;
  background: rgba(255,255,255,.97);
  border: 1px solid rgba(0,0,0,.28);
  border-radius: 5px;
  box-shadow: 0 8px 22px rgba(0,0,0,.32), 0 1px 3px rgba(0,0,0,.2);
  font-size: 12px;
  color: var(--ink);
}
.menu--sub { position: absolute; top: -5px; left: 100%; }
.menu--sub.is-flip { left: auto; right: 100%; }
.menu__row { position: relative; }
.menu__item {
  appearance: none; border: 0; background: none; font: inherit; color: inherit;
  display: flex; flex-wrap: wrap; align-items: center; column-gap: 6px;
  width: 100%; min-height: 20px; padding: 1px 18px 1px 20px;
  text-align: left; white-space: nowrap; cursor: default; position: relative;
}
.menu__item[aria-checked="true"]::before { content: "\\2713"; position: absolute; left: 6px; font-size: 11px; }
.menu__item .menu__arrow { margin-left: auto; padding-left: 14px; font-size: 9px; }
.menu__item:focus { outline: none; }
.menu__item:not([aria-disabled="true"]):hover, .menu__item:not([aria-disabled="true"]):focus, .menu__item[aria-expanded="true"] {
  background: linear-gradient(var(--sel-top), var(--sel-mid) 45%, var(--sel-bot));
  color: var(--sel-ink);
}
.menu__item[aria-disabled="true"] { color: var(--ink-3); }
.menu__note { flex-basis: 100%; font-size: 11px; white-space: normal; }
.menu__sep { height: 1px; margin: 5px 0; background: var(--row-divider); }
@media (pointer: coarse) { .menu__item { min-height: 44px; } }

/* A segmented control of push-button halves: one choice of a few, held
   down while it is the one shown (a tab list to a screen reader). */
.seg { display: inline-flex; flex-wrap: wrap; border-radius: 11px; box-shadow: 0 1px 0 rgba(255,255,255,.6); }
.seg__btn {
  appearance: none; font: inherit; color: var(--aq-ink);
  height: 22px; padding: 0 12px; margin: 0;
  border: 1px solid var(--btn-edge); border-left-width: 0;
  background: linear-gradient(var(--btn-top), var(--btn-mid) 55%, var(--btn-bot));
  cursor: default; white-space: nowrap;
}
.seg__btn:first-child { border-left-width: 1px; border-radius: 11px 0 0 11px; padding-left: 14px; }
.seg__btn:last-child { border-radius: 0 11px 11px 0; padding-right: 14px; }
.seg__btn[aria-selected="true"] { background: linear-gradient(var(--chrome-lower), var(--chrome-upper)); box-shadow: inset 0 1px 3px rgba(0,0,0,.35); font-weight: 700; }
.seg__btn:focus-visible { outline: none; box-shadow: 0 0 0 1px var(--aq-ring), 0 0 2px 3px var(--aq-halo); position: relative; z-index: 1; }
@media (pointer: coarse) { .seg__btn { height: 44px; } }

/* the "this is a mockup" plate under the window */'''),
]


def edited(name: str, css: str) -> str:
    for target, old, new in EDITS:
        if target != name:
            continue
        n = css.count(old)
        assert n == 1, f'{name}: expected one occurrence, found {n}: {old[:80]!r}'
        css = css.replace(old, new)
    return css


HEAD = ('/* GENERATED by packages/aqua-ui/scripts/make-window-css.py from design/frontends/origin/{src}.\n'
        '   Do not edit: the design is frozen (DEC-038); record a change in EDITS there and run `pnpm build:window-css`. */\n')
(OUT / 'airwave-window.css').write_text(HEAD.format(src='airwave-companion.html') + edited('airwave-window.css', companion), encoding='utf-8', newline='\n')
(OUT / 'airwave-hub.css').write_text(HEAD.format(src='airwave-hub.html') + edited('airwave-hub.css', ''.join(extra).lstrip('\n') + '\n'), encoding='utf-8', newline='\n')
sys.stdout.write(f'airwave-window.css: {len(chunks(companion))} rules; airwave-hub.css: {len(extra)} rules\n')
