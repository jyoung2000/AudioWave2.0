#!/usr/bin/env python3
"""
Open loops: what was asked for or declared, and is not finished yet.

Exists because a test was written for the radio elapsed-time feature, confirmed to fail, and then
reported as "cleanly queued" while the implementation was never written. A plan described as
progress is the failure this catches. Run it before claiming anything is done and before ending a
turn with work outstanding:

    python scripts/open-loops.py            # report; exit 1 if anything is open
    python scripts/open-loops.py --base HEAD~5

It reports three kinds of open loop:

  REQUEST    an unchecked item in .hermes/requests.md (the ledger of what the user asked for)
  RED        a spec/test file changed with no implementation file changed beside it
  DEFERRED   a skipped, todo or fixme test

None of these are style complaints: each one is work that was named and not delivered.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / '.hermes' / 'requests.md'

TEST_PAT = re.compile(r'(^|/)(tests?|__tests__|spec)/|\.(spec|test)\.[cm]?[jt]sx?$|_test\.(py|go|rs)$')
SRC_SKIP = re.compile(
    r'(^|/)(node_modules|dist|dist-local|release|target|\.git|coverage|test-results|playwright-report)(/|$)'
    r'|\.(md|lock|png|jpg|jpeg|svg|ico|woff2?|map)$'
    r'|(^|/)(package(-lock)?\.json|pnpm-lock\.yaml|Cargo\.lock)$'
)
DEFER_PAT = re.compile(r'\b(?:it|test|describe)\.(?:skip|todo|fixme)\b|\bxit\(|\bxdescribe\(')


def git(*args: str) -> str:
    try:
        return subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return ''


def changed_files(base: str | None) -> list[str]:
    """Working tree plus, when a base is given, everything since it."""
    names = set()
    for line in git('status', '--porcelain').splitlines():
        if len(line) > 3:
            names.add(line[3:].strip().strip('"'))
    if base:
        for name in git('diff', '--name-only', f'{base}..HEAD').splitlines():
            if name.strip():
                names.add(name.strip())
    return sorted(n for n in names if n and not SRC_SKIP.search(n))


def ledger_open() -> list[str]:
    if not LEDGER.exists():
        return []
    out = []
    for i, raw in enumerate(LEDGER.read_text(encoding='utf-8', errors='replace').splitlines(), 1):
        line = raw.strip()
        if line.startswith('- [ ]'):
            out.append(f'{LEDGER.relative_to(ROOT).as_posix()}:{i}: {line[5:].strip()}')
    return out


def deferred_tests(files: list[str]) -> list[str]:
    out = []
    for name in files:
        if not TEST_PAT.search(name):
            continue
        path = ROOT / name
        if not path.is_file():
            continue
        for i, line in enumerate(path.read_text(encoding='utf-8', errors='replace').splitlines(), 1):
            if DEFER_PAT.search(line):
                out.append(f'{name}:{i}: {line.strip()[:110]}')
    return out


def tests_without_implementation(files: list[str]) -> list[str]:
    """A spec changed on its own is a declaration of intent with nothing behind it yet."""
    tests = [f for f in files if TEST_PAT.search(f)]
    impl = [f for f in files if not TEST_PAT.search(f)]
    if tests and not impl:
        return tests
    return []


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default=None, help='also consider commits since this ref')
    ap.add_argument('--quiet', action='store_true', help='print nothing when there is nothing open')
    args = ap.parse_args()

    files = changed_files(args.base)
    groups = [
        ('REQUEST  (asked for, not finished)', ledger_open()),
        ('RED      (spec changed, no implementation beside it)', tests_without_implementation(files)),
        ('DEFERRED (skipped / todo / fixme test)', deferred_tests(files)),
    ]
    total = sum(len(v) for _, v in groups)
    if not total:
        if not args.quiet:
            print('No open loops: nothing asked for is unfinished, no spec is waiting on code.')
        return 0

    print(f'{total} open loop(s) — work that was named and is not delivered:\n')
    for label, items in groups:
        if not items:
            continue
        print(f'  {label}')
        for item in items:
            print(f'    - {item}')
        print()
    print('Finish these, or say plainly which are still outstanding. Do not report them as done.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
