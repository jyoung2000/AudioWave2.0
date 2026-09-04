# Deviations

Where this implementation departs from the Aqua specification, from the supplied HTML reference, or
from the behaviour a listener might reasonably expect — and why. Each entry says what was done
instead, so a reviewer can disagree with the reasoning rather than guess at it.

The active profile is declared in [docs/IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md):

```text
AQUA_PROFILE=snow-leopard-itunes-9
```

Every MUST item in §17 and §18 of the specification is treated as a release gate, each mapped to the
test that would fail in [AQUA_CONFORMANCE.md](AQUA_CONFORMANCE.md). The deviations below are all from
SHOULD items or from the reference implementation, except the three noted as unmet MUSTs.

## Corrected after review

### The push buttons were the wrong decade

Shipped, and wrong: the buttons were 10.2-era Aqua — a full pill, a glass lozenge filling the top
half, a hard gloss step across the middle, and a saturated blue gel for the default action. The
declared profile is `snow-leopard-itunes-9`, and by 10.6 all of that was gone.

**Fixed:** a rounded rect with a 4 px radius, one quiet vertical gradient, a hairline grey rim that
darkens along the bottom, and a single pixel of white on the top edge. The default action is a
*tinted* button — the same face with the hue turned up and dark ink — rather than a lozenge of
blue. The pop-up menu and the checkbox followed the same correction. The pulse on the default
button stays, because §6.5 asks for it; it is the halo that breathes, not the face.

This was a profile-coherence failure (§17.6) that the conformance test could not catch, because it
checks the tokens and the material rules rather than whether a recipe belongs to the right year.

### Picked files were indexed and then refused

Shipped, and wrong: `resolveFile` refused every file added through "Choose files" on sight, because
the stored reference is marked `ephemeral` — true of a file that cannot be *reopened after a
reload*, but not of one whose `File` object the page still holds. The index was built, the row
appeared in the list with its tags and its artwork, and pressing it produced a warning instead of
music. On a phone, and in the standalone file, the folder picker does not exist, so that button was
the only way in and it led nowhere.

**Fixed:** the picked `File` objects are kept for the life of the page and consulted before the
refusal. Nothing is persisted and `ephemeral` still means what it said: after a reload the files are
genuinely gone, the message is unchanged, and the offline column still reports these tracks as not
available offline. Two tests now hold the line — one that a picked file plays in the session that
picked it, one that the explanation returns once the page that held it is gone.

The test that existed asserted the broken behaviour, which is why nothing caught it.

### The download the hub was already serving

Not wrong so much as never finished: `ReleaseService` on the hub, and the route beside it, carry a
comment saying "the PWA shows a *Get the Windows companion* link, and that link must not be a lie".
The route was written, the admin page could configure it, and the player never called it — so the
one product the suite ships as a downloadable binary had no download anywhere in the app.

**Fixed:** Settings asks the hub and renders what comes back. The panel cannot become a dead button:
no hub says to pair one, a hub with nothing configured says an administrator has to set a release,
and a real release shows the version, size, SHA-256 and whether it was code-signed.

### The second song killed the equalizer

Shipped, and wrong: `attachMediaElement` called `createMediaElementSource` on every load. Web Audio
binds an element to its source node permanently — the second call for the same element throws
`InvalidStateError`, and disconnecting the node does not undo the binding. One element plays every
track here, so track two threw and took the DSP chain with it.

**Fixed:** the node is created once per element and reused for every track that element goes on to
play. The mock context already modelled the real rule and threw correctly; no test had ever attached
the same element twice, so nothing exercised it. One now does.

## From the Aqua specification

### The player is a page, not a window

§17.1 asks for one framed desktop-style window with a persistent source list, and the hub's admin
GUI is exactly that. The player is not: it is a sticky status bar over a hero and a list, following
the arrangement in `docs/reference/now-playing-header.html`. The reasoning is in
[UI_REDESIGN.md](UI_REDESIGN.md); briefly, a window frame around a browser viewport is a picture of
a window rather than a window, and a 196 px source list is a fifth of a laptop screen and simply
unavailable on a phone.

**Instead:** the same landmarks and the same keyboard model in a different shape. The source list
became a horizontal strip that is still a `navigation` landmark named "Sections" holding `option`s,
with the same roving tabindex, arrow keys, Home/End and type-ahead — a person who learned the app by
keyboard did not have to learn it again. Every material rule (1 px rims, light from above, neutral
chrome, selective blue, visible focus, reduced motion) still applies and is still tested; see the
"2010 page surfaces" section of [AQUA_CONFORMANCE.md](AQUA_CONFORMANCE.md).

### The equalizer window has no frame

The supplied equalizer screenshot is a window: a title bar with three traffic lights over the On
checkbox, the preset menu and the faders. Everything inside the frame is reproduced. The frame is
not, because the player is a page rather than a window and the three lights would be three buttons
that do nothing — and a control that cannot act is the one thing this app does not draw.

**Instead:** the panel carries the same 1 px rim and the same brushed face, and the section it sits
in is titled where the window's title bar would have been.

### The offline key reports; it does not download

The reference's download key is a toggle with nothing behind it — press it and an arrow becomes a
check. Here the key keeps its place and its morph, and states whether the track can actually play
with the network off: a file in a connected folder already can, a file from the one-shot picker
cannot survive a reload, and a hub stream needs the hub.

**Instead:** the state is computed per track and the reason is on the control. Caching hub streams
into IndexedDB would make it a real download, and is not built — so it is not claimed.

### The player's LCD display became the hero

§17.4 lists a central inset information display as a SHOULD, and the hub GUI keeps one. On a page
with no toolbar there is nothing for an inset panel to be inset *into*, and the same information —
title, artist, album, where it is playing from, position — reads better at hero size than engraved
into a 62 px strip.

**Instead:** the hero states all of it in plain type, and the honest signal-chain detail the LCD
never had room for lives one click away under **Now playing**.

### A dark colour scheme, for the page only

The specification observes that Snow Leopard permitted a "context-specific dark surface" for
immersive media (QuickTime X), and warns against making all media interfaces dark. The
`snow-leopard-itunes-9` window profile stays light, and the hub's admin GUI declares
`color-scheme: light`.

The player does not, because the reference ships a complete dark palette for every one of its
surfaces and a music player is a thing people open at night. It follows the viewer's system setting
rather than being dark by default, so it is a context-specific surface rather than a dark interface.

**Instead:** one token layer with a `prefers-color-scheme` override, in `now-playing.css` only. The
constellation view remains a dark canvas in either scheme — the spec's own recommendation for
immersive content.

### Lucida Grande is not shipped

§17.3 requires "Lucida Grande or a compact, tuned fallback". Lucida Grande is not redistributable and
is absent from Windows, Linux and Android. Bundling it would be a licensing violation; loading it
from a font CDN would break the no-external-requests rule that the tests enforce.

**Instead:** a compact system stack tuned to match its metrics, with the tracking and 13 px/12 px
sizes the spec specifies. On macOS the first entry resolves to the system font; elsewhere the
fallbacks were chosen for x-height and width rather than for style.

### Cover Flow is not implemented

iTunes 9's third view mode is not present. It is a SHOULD-adjacent component, it is expensive to do
well, and its value is largely nostalgic: it shows fewer albums per screen than the grid and is
harder to navigate by keyboard.

**Instead:** the artwork grid, and the constellation view for a spatial overview of a whole library.

### The 3D view has a full 2D equivalent, not a fallback

The specification does not require this; it is a deliberate addition. Three-dimensional views of
libraries usually hide the data they present. The constellation's table is the same information with
the same keyboard model and the same selection, and the 3D layer can be turned off permanently.

## From the supplied HTML reference

The reference's _visual behaviour_ is reused throughout — the sticky header, the search pill and
results popover, the scrubber, the transport with its latched states, the striped sortable table with
a marquee on the playing row, and the motion character including the parked marquee. What was not
carried over:

| In the reference | Why it is not here |
| --- | --- |
| A direct browser call to `api.anthropic.com` | It requires an API key in the page. No secret may live in a client bundle, so there is nowhere safe to put one. Removed entirely. |
| JSONP fallbacks to `itunes.apple.com` and Deezer | Script-injection JSONP is arbitrary code execution by design. Search goes through the hub, which is a server that can hold credentials. |
| A `noembed.com` relay | Same reason, plus it sends what a listener is looking at to a third party. |
| `http://127.0.0.1:8642` companion assumption | The companion is paired explicitly and reached at an address the person chose. A hard-coded loopback port is a hidden dependency and a hijacking target. |
| A CDN import map for `three` | Everything is bundled. The player must work offline, and a CDN is a third party that sees every visit. |
| Demo tracks in `window.LIBRARY` | Replaced by real indexed data. A demo mode exists behind `VITE_DEMO_MODE=true` and is labelled as one on screen. |
| iOS-style blurred context menus and sheets, 12–14 px radii | Replaced with Aqua menus and sheets: opaque, 5–8 px radii, one shadow — the spec's material rules. |

## Honest capability, where it costs a feature

### A stream is never presented as a download

Where a provider permits playback but not downloading, no download control appears — not a disabled
one, not one that fails. The capability matrix in
[docs/PROVIDER_CAPABILITIES.md](PROVIDER_CAPABILITIES.md) drives what is rendered, and
[docs/DOWNLOADS_AND_LEGAL.md](DOWNLOADS_AND_LEGAL.md) explains each case.

### Retuning says what it does to the recording

Shifting a recording's pitch is not the same as the musicians having played at that tuning, and this
software does not imply otherwise. The panel states the shift in cents, the ratio, and that the
duration is preserved by a granular pitch shifter. When the AudioWorklet is unavailable and the
fallback changes playback rate, the tempo changes too — and the panel says so instead of continuing
to claim "preserve tempo".

### Solfeggio presets are filters, described as filters

They are offered because people want them. Each is a narrow peaking filter at the frequency it names
— parametric rather than graphic, because none of the ten graphic bands sits on 528 Hz and rounding
to 500 Hz would be a different filter wearing the right label. The panel states that they emphasise
what the recording already contains, do not synthesise a tone, do not retune the music, and that no
physical or medical effect is claimed. A test keeps that language out of the descriptions.

### An unsigned Windows build says it is unsigned

Code signing needs a certificate that costs money and is tied to a legal identity, so builds from
source and from CI without a secret are unsigned. `latest.json` records `signed: false`, and the
About screen describes the SmartScreen dialog a person will see and what it means — rather than
coaching them past a warning that is, for an unsigned build, correct.

### The hub will not open a port for you

No UPnP, no NAT hole punching, no relay service. Several products in this category do one of these,
and it is the fastest way to make remote access "just work". It also punches a hole in someone's
network on their behalf, often without their understanding it. [docs/REMOTE_ACCESS.md](REMOTE_ACCESS.md)
is a table of what works from where, including the rows that say "No".

### Android Auto gets a car mode, not an app tile

A web app cannot appear as a native tile on the Android Auto or CarPlay home screen; that requires a
native app built against the car app libraries and shipped through an app store. The player does what
a web app can: Media Session metadata and artwork on the lock screen and in the car's media view,
play/pause/next/previous from the steering wheel and headset, and seeking from the car display where
the browser supports it — all of it working once playback starts on the phone, exactly as any other
Bluetooth audio source does.

The settings screen lists each capability with a yes or no and a reason, computed by asking the
browser rather than assumed, and gives the three steps to use it in a car.
[docs/PWA_AND_CAR.md](PWA_AND_CAR.md) has the detail. There is no separate large-target driving view;
the interface is used through the phone, and adding one is the obvious next step if it turns out to
be wanted.

## Deliberate omissions

| Not built | Why |
| --- | --- |
| Fingerprint-based track matching (AcoustID/Chromaprint) | The identity model has a field for it, and the matching logic accepts one. Computing fingerprints needs a native library in the browser and the companion; content hash, ISRC and MusicBrainz ids cover the cases that matter. |
| A mobile companion | The PWA covers phones. A native app would exist mainly for the Android Auto tile, which is a large amount of work for one feature. |
| Multi-user accounts on the hub | One administrator, and paired devices with scopes. Adding real multi-tenancy would change the authorization model everywhere and was not asked for. |
| Server-side transcoding on the fly | FFmpeg converts a file the owner already has. Transcoding a provider's stream in flight is a different thing legally and was not built. |
