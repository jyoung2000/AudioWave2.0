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

## From the Aqua specification

### No dark colour scheme

The specification observes that Snow Leopard permitted a "context-specific dark surface" for
immersive media (QuickTime X), and warns against making all media interfaces dark. The
`snow-leopard-itunes-9` profile is a light one; adding a dark variant would mean a second complete
token set, and it is not part of the profile that was selected. Every product declares
`color-scheme: light` and paints its own background explicitly.

**Instead:** the constellation view, which is the one genuinely immersive surface, uses a dark
canvas within an otherwise light window — the spec's own recommendation for content context.

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
