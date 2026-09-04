# @now-playing/recommendations

A deterministic, inspectable recommender. No model, no GPU, no network — it is arithmetic over a
taste profile you can read, and it runs identically in the player (offline, on your own history)
and on the hub (for people who opted into hub-side personalisation).

## The pipeline

A request goes through five stages: seeds are drawn from the profile's strongest artists, genres,
tags, tracks and eras; candidates are gathered from up to ten sources; every candidate is scored
against eight weighted components minus three penalties; a diversity pass enforces the artist cap,
the genre share cap and the familiarity mix; and the survivors become `Recommendation` records
carrying the reasons that produced them.

```ts
const result = recommend({
  userId, profile, catalogue, mode: 'for-you', limit: 30, seed: 1,
  context: { recentlyPlayedIds, recentlyRecommended, ownedTrackIds },
});
result.recommendations[0].reasons; // "Because you finished 4 songs by Fennel Grove this month"
result.diagnostics;                // candidate counts per source, tier fill, cold start, shortfall
```

## Learning from behaviour

Every listening event is classified and applied with a weight, then decayed exponentially with a
45-day half-life so last year's phase fades without being erased.

| Action | Weight | | Action | Weight |
| --- | ---: | --- | --- | ---: |
| Immediate skip (< 10 % or < 10 s) | −5 | | Completed | +3 |
| Early skip (< 30 %) | −3 | | Replayed | +4 |
| Partial (30–50 %) | +0.5 | | Liked | +6 |
| Majority (> 50 %) | +2 | | Added to a playlist | +7 |
| Disliked | −6 | | Favourited | +10 |

Ranking weights sum to one: taste match 0.30, artist affinity 0.20, genre affinity 0.15,
collaborative 0.10, recency 0.10, popularity fit 0.05, mood/context 0.05, discovery bonus 0.05.
Penalties then subtract for repeats (heard in the last 7 days), previous skips, and overexposure
(recommended repeatedly without being played).

**Skip intelligence** is the part most recommenders get wrong. One skip lowers that track and
nothing else — people skip a song they love because it does not fit the moment. An artist's
affinity only drops after three *different* tracks by them are skipped within 30 days, and a genre
needs the same pattern across distinct tracks. The counters that drive this are in the profile and
visible through `profileView()`.

## Modes

`for-you` draws on every source. `playlist` extends a playlist without repeating it. `genre`
returns one genre only. `similar` is anchored on a seed track and never returns it. `deep` excludes
tracks you own and artists you already know, so it is measured on novelty rather than hit rate.
`new-releases` restricts to recent years and skips what you have. `recent` follows what you have
been playing lately. Each mode's permitted sources are declared in `sourcesForMode`, so a mode
cannot quietly draw from somewhere it should not.

## Sharing without exposing anything

`profileToAggregate` is the only thing that ever leaves a device for group features. It emits
weighted buckets — artists, genres, albums, decades, an hour histogram — and never track ids,
titles or timestamps. Buckets with fewer than three observations are dropped; a profile with fewer
than five qualifying artists produces `null` and a reason instead of a thin, identifying aggregate.
The computed timestamp is rounded to the week. `aggregateLeaksTrackIds` is the assertion the
privacy tests use.

## Measured, not asserted

```
pnpm --filter @now-playing/recommendations evaluate
```

Splits each synthetic user's history 70/30 in time, trains on the earlier part and scores against
what they actually went on to enjoy. The committed `evaluation/report.json` is the current run —
12 synthetic listeners, 240 canonical tracks, k = 20:

| Mode | hit@20 | NDCG@20 | Artist diversity | Coverage | Novelty | Skip precision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| for-you | 100 % | 0.513 | 0.906 | 21.7 % | 53.3 % | 93.3 % |
| deep | 0 % | 0.000 | 0.905 | 33.8 % | 100 % | 100 % |
| recent | 0 % | 0.000 | 0.874 | 9.6 % | 50.0 % | 98.2 % |

The zeroes are the design working. A held-out set drawn from someone's own history can only be hit
by modes allowed to return music they already know; discovery modes deliberately exclude it, so
they are judged on novelty, diversity and skip precision instead. The report says this itself, in
`notes`, rather than leaving a reader to guess.

These are synthetic fixtures, not real listeners. The numbers verify that the pipeline behaves as
designed and catch regressions; they are not a claim about real-world quality.

## Tests

```
npx vitest run --project unit packages/recommendations
```

48 tests covering the action weights, skip intelligence, decay, idempotent event application,
serialization round-trips, cold start, every mode's exclusions, the artist and genre caps, the
penalties, aggregate privacy and the evaluation harness itself.
