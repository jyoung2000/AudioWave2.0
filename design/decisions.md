# Design decisions, exceptions and open questions

Each entry has a stable ID that `design/token-map.json`, `design/coverage.json` and the styleguide
refer to. **Adopted** means the current behaviour is the standard. **Unresolved** means the code
and the documented intent disagree and someone has to choose; until then the check records the
difference instead of failing on it, and nothing may be added to the same exception silently.

Longer histories live in [docs/DEVIATIONS.md](../docs/DEVIATIONS.md) and
[docs/AQUA_CONFORMANCE.md](../docs/AQUA_CONFORMANCE.md).

| ID      | Status     | Decision |
| ------- | ---------- | -------- |
| DEC-001 | Adopted    | Lucida Grande is not shipped (not redistributable). The window skin names it first and falls back through a tuned chain. |
| DEC-002 | Adopted    | `--aqua-font` inserts the bundled `"Aqua Fallback"` face after Lucida Grande; `tokens.json` `font.family` does not list it. The CSS is authoritative. |
| DEC-003 | Adopted    | The window skin (hub admin, Windows companion) has no dark palette, because Snow Leopard had none. The page skin (player) and the styleguide follow the system colour scheme. |
| DEC-005 | Unresolved | Discord `noResults` renders `No results for “{{reason}}”`, but the command service passes the search text as `title` and `No results` as `reason`, so the bot says “No results for “No results”.” Proposed fix: the template uses `{{title}}`. Changing a default template changes what existing servers see. |
| DEC-006 | Adopted    | Cover Flow is not implemented; the 3D jewel-case stage stands in for it. |
| DEC-007 | Adopted    | The player replaces the inset LCD display with the hero, which states the same information at reading size. |
| DEC-008 | Unresolved | The public share page (`docker-container/src/api/routes/shares.ts`) is standalone HTML under a strict CSP with its own inline stylesheet. It uses a 12px pill button and weight 600, which the system otherwise forbids. Proposed: restyle it with the page-skin values (4px push button, weights 400/700). |
| DEC-009 | Adopted    | The mockups render each product's real components with fixture data; they are not the product view files executed verbatim. Runtime coverage says which surfaces were seen in the running product and which only in a mockup. |
| DEC-010 | Adopted    | Android notifications, the document picker and the save dialog are system UI. The guide documents their copy (`strings.xml`) and when they appear, not their appearance. |
| DEC-011 | Proposed   | `tokens.json` is mirrored into the stylesheets by hand; `pnpm styleguide:check` compares the two through `design/token-map.json`. Proposed: generate the custom properties from `tokens.json` so the map becomes unnecessary. |
| DEC-012 | Unresolved | The Android shell only reaches hubs over https (mixed content is never allowed and the manifest forbids cleartext), but the player's pairing form still accepts an `http://` address, so the refusal happens at connection time. Proposed: say so in the pairing form on Android. |
| DEC-013 | Adopted    | The Windows companion is Electron-only; its renderer cannot run in a browser without the preload bridge, so its runtime evidence comes from its DOM tests and the mockups. |
| DEC-014 | Adopted    | The equalizer window (`.eqw`) has an intrinsic width: `max-width: 600px`, which holds its rails about 36 px apart the way the iTunes window does. It had been stretching to whatever container held it — 958 px in the styleguide — and read as a strip rather than a window. |
| DEC-015 | Adopted    | The note in every app icon is placed by centring the path's measured box (x 4.4–19.8, y 3–21.7 of its 24-unit grid) on the icon's optical target: the tile centre for the player and maskable icons, the folder mouth (240, 308) for the companion, the 32-square for the tray. The player icon had shipped 27 px left of centre; `tests/unit/icon-glyphs.test.ts` now pins all four placements. |
| DEC-016 | Adopted    | Play sits on the progress rail's centre line at every width, with previous and next on its line either side. `KeyTransport` measures its row: the volume line stays beside the keys only while it fits on both sides (otherwise it goes beneath, centred), and the keys wrap only when they do not fit on one line, with previous, play and next alone on the first line. The player's eleven keys never leave room for the volume beside them inside the 820 px hero, so the player shows it beneath at every width. Covered by `tests/dom/page-chrome.test.tsx`. |
