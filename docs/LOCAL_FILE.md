# The single-file player

One HTML file you open by double-clicking. No server, no install, no terminal.

**It is committed at the root of this repository as [`now-playing.html`](../now-playing.html)** —
about 2.4 MB, with nothing beside it. Download it, or copy it out of a checkout, and open it in a
browser. There is nothing to build and nothing to run first; a file whose whole point is needing no
tooling should not need a toolchain to obtain.

Copy it wherever you like — a USB stick, a Documents folder, a network share — and open it in a
browser. It is the same application as the served player, built from the same source and covered
by the same tests, assembled so that a browser opening it from `file://` never has to fetch
anything.

### Rebuilding it

Only needed if you change the player's source:

```sh
pnpm build:local     # rebuilds and updates the committed now-playing.html
```

It is a build output that happens to be checked in, like `packages/contracts/generated` and the icon
files. The build is deterministic — the same source produces a byte-identical file — so the
committed copy changes when the app changes and at no other time, and `pnpm verify` fails if the two
have drifted apart. Committing a 2.4 MB artifact is a real cost in repository size; it is worth it
here because the artifact *is* the deliverable.

## Why it has to be one file

A page opened from the filesystem has the opaque origin `null`, and Chromium refuses **any**
subresource fetch from it — including a sibling `.js` sitting in the same folder:

```
Access to script at 'file:///…/assets/index.js' from origin 'null' has been blocked by CORS policy:
Cross origin requests are only supported for protocol schemes: chrome, chrome-extension,
chrome-untrusted, data, http, https, isolated-app.
```

So "no CDN" is not enough; there can be no second file at all. The build inlines the JavaScript as
one classic script, inlines the CSS, turns every asset into a `data:` URI, and folds the code-split
chunks back in — a dynamic import of a chunk *file* would be one of those forbidden fetches. The
served build keeps its code splitting; only this one pays the size, and it pays it on a disk where
size costs nothing.

The build fails rather than shipping a half-working file: it scans the finished markup for anything
still referenced by a relative path and refuses to emit if it finds one.

## What was measured

Every line below was checked in Chromium at a real `file://` origin, not reasoned about. The two
surprises are both good ones.

| | From `file://` | |
|---|---|---|
| Playing your own audio files | **Works** | `<audio>` with blob URLs, and `createMediaElementSource` for the graph |
| IndexedDB — library index, playlists, presets, history | **Works** | Opens and writes; your library survives closing the browser |
| `localStorage` | **Works** | |
| The equaliser and the whole Web Audio graph | **Works** | |
| **The retune AudioWorklet** | **Works** | Only because the compiled worklet travels inside the bundle and is loaded from a `data:` URL. A worklet module is fetched with CORS, so a file next to the HTML would fail — but `data:` is on the allowed-scheme list above |
| `showDirectoryPicker` — choosing a folder and keeping it | **Works** | `file://` is a secure context (`isSecureContext === true`), so the File System Access API is available |
| `crypto.subtle`, Media Session | **Works** | Same reason |
| Workers from blob URLs | **Works** | |
| Dynamic `import()` of `data:` and `blob:` URLs | **Works** | Not needed here, but it is why the worklet approach works |
| **Service worker** | **No** | `Failed to register a ServiceWorker: The URL protocol of the current origin ('null') is not supported.` Nothing to solve: the file is already on your disk |
| **Installing as an app** | **No** | There is no origin to install. Make a shortcut to the file instead |
| Fetching a sibling file | **No** | The reason this is one file |
| **WebSocket** | **No** | Which is why group listening is not available |
| `fetch` to a hub | **Only with permissive CORS** | An `http://` request from a `null` origin needs `Access-Control-Allow-Origin: *` on the hub, and then it still cannot send credentials — `credentials: 'include'` fails against a wildcard origin. The hub does not do this by default, and should not |

The app reports all of this on its own Settings screen under **Running from a file**, computed at
runtime from the actual origin. Serve the identical file over http and the panel disappears — a test
asserts exactly that, by starting a server and loading the same bytes.

## What you give up, plainly

- **Group listening**, because it needs a WebSocket.
- **Searching providers through a hub**, unless you deliberately configure that hub to accept a null
  origin. The served player is the supported way to use a hub.
- **Installing it**, and with it the app-window frame and the launcher icon.

Everything else — your library, playback, the equaliser, retuning, playlists, listening metrics, the
constellation — works exactly as it does when served.

## Why the served build still exists

If you want a hub, a phone, an installed app icon, or a lock-screen player in the car, use
`pnpm build` and serve it. The single file is for the case where all of that is beside the point:
your music, your machine, no infrastructure.

Both come from one source tree and one set of tests. The differences are in what the *browser*
permits, not in what the code tries to do.

## Testing it

```sh
pnpm test:local     # opens the committed now-playing.html at file:// in a real browser
```

The suite opens the *committed* file, because that is the one people download. `pnpm verify` checks
separately that it matches what the source produces, so testing the committed copy can never mean
testing something stale.

The suite has its own Playwright config with **no `webServer`** — that separation is the point.
Over http every one of these tests would pass while the file was still broken. Three bugs proved it:

1. The bundle was spliced into React's own source, because `String.replace` expands `$&` in a
   replacement string and minified React contains `"$&/"`. The `<script>` closed early and the page
   fell back to fetching a chunk it could not reach.
2. The build's own guard against leftover file references stripped the `src` attribute it was
   looking for, so it reported success while the page was still broken.
3. A classic script inlined into `<head>` ran before `#root` existed.

None of the three is visible in a served build. All three are visible in the first second of opening
the file, which is why `pnpm verify` builds it and opens it.
