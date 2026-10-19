# Requests

What the listener actually asked for, in their words, and whether it is delivered.

A request is only checked off when its behaviour is implemented and verified by something that
would fail if the behaviour broke. A written test is not delivery. A plan is not delivery. If a
request is being left for later, it stays unchecked and is said out loud as outstanding.

Checked by `python scripts/open-loops.py`, which exits non-zero while anything here is unchecked.

## Open

- [ ] "ensure music data for the algorithm can get fetched from each platform also ensure discovery
  works and can pull from each platform. no feature should be broken" — genre/tag reach is ~8-10%
  on live rows; roughly half of YouTube rows are DJ mixes and shorts that no store carries. Needs
  the listener's decision on acceptable reach.
- [ ] "Ensure song, album, feature and discography data is the same across all 3 apps and pull data
  from all platforms" — parity measured on three artists (102/5, 93/4, 199/9); per-platform
  verification for Tidal, Qobuz and Amazon Music still unproven.
- [ ] "Ensure the hubs downloaders and fetch for music and playlist work on the expected platforms,
  with parity to the windows companion" — host gaps remain for `m.youtube.com` and
  `api.soundcloud.com`; no paired `resolve`; a real media download has never been run end to end.
- [ ] SoundCloud states junk genres (`Ajouter « Deep House »`, tags like `Meh`). They are
  platform-stated so the genre rule admits them. Filtering was offered; awaiting a decision.
- [ ] Song-dash-artist reversal: `"Headlines (Clean) - Drake"` parses as `artist='Headlines'`.
  Pre-existing bug in the spaced-dash rule, unfixed.

## Delivered

- [x] "everytime the radio updates or the user clicks the radio update icon the icon should animate"
  — pass-driven spin, `b10621a`.
- [x] "can the user adjust the radio refresh time in settings?" then "yes, add it" — presets in
  Settings > Sources > Radio, `929fb92`.
- [x] "give the option for the user to set a custom time" — "A time I choose", 10-3600s, clamped,
  `d479736`.
- [x] "on the radio can we see how long the current song or program has been playing before we
  started playing" — broadcast position from iHeart `startTime`/`trackDuration`, Triton
  `cue_time_start`/`cue_time_duration`, SomaFM start-only; progress bar where a length is
  published, elapsed alone where it is not.
- [x] "The container and companion app should be available as soon as the music player is finished
  reloading if they are available" — `npBootConnections()` paints both backends at boot; the paired
  Companion is a first-class backend alongside the legacy helper.
