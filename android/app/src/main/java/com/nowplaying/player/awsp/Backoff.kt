package com.nowplaying.player.awsp

import kotlin.random.Random

/**
 * Reconnect delays (§3.1): exponential from 250 ms, capped at 30 s, with full jitter — each delay
 * is uniform in `[0, min(cap, base · 2^attempt)]`. Full jitter keeps a room full of phones that
 * lost the same Wi-Fi from all knocking at the same instant.
 */
class Backoff(
  val baseMs: Long = 250,
  val capMs: Long = 30_000,
  private val random: Random = Random.Default,
) {
  /** The ceiling for [attempt] (0-based): 250, 500, 1000, … 30 000. */
  fun ceilingMs(attempt: Int): Long {
    // Past 2^30 the cap has long been reached; stopping there keeps the shift from overflowing.
    val shift = attempt.coerceIn(0, 30)
    return minOf(capMs, baseMs shl shift)
  }

  fun delayMs(attempt: Int): Long = random.nextLong(0, ceilingMs(attempt) + 1)
}
