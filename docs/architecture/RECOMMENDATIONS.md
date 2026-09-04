# Recommendations and discovery

Deterministic, inspectable, CPU-only. Implemented in `packages/recommendations` (shared) and the hub's discovery services. Raw history stays on the originating device by default.

## Pipeline
```text
listening events ─▶ taste profile (track/artist/album/genre/tag/era/popularity/discovery/platform
                     + contextual profiles: playlist, genre, mood, activity, session)
                 ─▶ seeds ("search for likely-good music, not everything")
                 ─▶ candidate generation (10 sources) ── hub: discovery service → shared cache → platform adapters via the rate-limit manager
                 ─▶ ranking (weighted, configurable) ─▶ diversity pass ─▶ recommendations with "Why this?"
                 ─▶ feedback (Like / Not for me / Less from this artist / Already know it) ─▶ profile update ─▶ …
```

## Learning
- Action weights (configurable): immediate skip −5, early skip −3, partial +0.5, >50 % +2, completed +3, replay +4, like +6, playlist add +7, favorite +10, dislike −6.
- Skip intelligence: one skip lowers only that track; artist/genre affinity moves only after ≥ 8 distinct skipped tracks (artist) / 12 (genre) within 60 days.
- Time decay: exponential, half-life 45 days, applied lazily.
- Contexts: every playlist/genre/mood/activity/session keeps its own affinities, so an artist can be +0.70 overall and +0.94 in "Late Night".

## Ranking
`score = 0.30·taste + 0.20·artist + 0.15·genreTag + 0.10·context + 0.10·collaborative + 0.05·novelty + 0.05·freshness + 0.05·platform − repeat − skip − overexposure` (weights in `DEFAULT_RECOMMENDATION_CONFIG`; editable by the admin). Modes: For You, Playlist Discovery, Genre Discovery, Similar to This, Deep Discovery (novelty ×3, popularity inverted), New Releases (freshness ×3), More Like My Recent Listening (14-day window).

## Diversity
Max 2 per artist, max 40 % from one genre, tier mix 40 % strong / 30 % related / 20 % emerging / 10 % experimental, user-adjustable exploration share.

## Hub-side discovery (multi-user)
- Canonical records: `canonical_tracks`, `canonical_artists`, `track_platforms` (one recording, many platform ids; MusicBrainz id → ISRC → normalized title/artist/duration matching), `artist_relations`.
- Admin configures each platform's application credentials once (`provider_app_configs`, encrypted). Users connect their own accounts (`platform_connections`, per-user encrypted tokens, PKCE); tokens never reach clients.
- `discovery_cache` (query, provider, results, TTL, hit counts) is shared across users; personalisation happens locally on cached candidates.
- `discovery_jobs` run in the background (profile refresh, discover seeds, library sync, token refresh, new releases) with P0–P4 priorities; `user_platform_sync` keeps cursors/snapshots/etags for incremental imports.
- `RateLimitManager`: per-platform queue, concurrency, token bucket, `Retry-After`, backoff, budgets; when constrained P0/P1 continue, P2 slows, P3 queues, P4 stops.

## Privacy
Group comparisons use opt-in aggregates (weights only, minimum cohort 3, minimum sample 20); "music they like that is new to me" comes from aggregate differences, never from another person's timeline. Every recommendation carries its reasons and feedback controls.

## Evaluation
`pnpm --filter @now-playing/recommendations evaluate` writes `packages/recommendations/evaluation/report.json` with catalogue coverage, diversity index, repeated-artist rate, fixture acceptance rate and a determinism check; tests assert thresholds. These are fixture measurements, not claims about real-world quality.
