package com.nowplaying.player.awsp

/**
 * The buffering rules of §4, as decisions with no I/O in them.
 *
 * - The fetch loop runs until the buffer holds [targetMs] (20 s) ahead of playback, then pauses,
 *   and resumes only once it has fallen below [lowWaterMs] (5 s). The gap between the two is
 *   hysteresis: without it the loop would flap on and off around one threshold.
 * - When the current track has less than [prefetchWhenRemainingMs] (45 s) left, the first
 *   [prefetchMs] (30 s) of the next queued track is fetched.
 *
 * Time is converted to bytes with the file's average rate (`total_len / duration`), which is exact
 * for CBR and close enough for FLAC/VBR at these granularities.
 */
class BufferPolicy(
  val targetMs: Long = 20_000,
  val lowWaterMs: Long = 5_000,
  val prefetchWhenRemainingMs: Long = 45_000,
  val prefetchMs: Long = 30_000,
) {
  init {
    require(lowWaterMs < targetMs) { "low-water must be below the target" }
  }

  /**
   * Whether the fetch loop should be pulling bytes now.
   *
   * @param fetching whether it currently is (the hysteresis state)
   * @param aheadMs buffered time ahead of the playback position
   * @param complete whether every byte to the end of the file is held
   * @param readerStarved whether the player is blocked on a byte that is not held; that always
   *   fetches, whatever the estimate says, because the estimate is only an estimate.
   */
  fun shouldFetch(fetching: Boolean, aheadMs: Long, complete: Boolean, readerStarved: Boolean = false): Boolean = when {
    complete -> false
    readerStarved -> true
    fetching -> aheadMs < targetMs
    else -> aheadMs < lowWaterMs
  }

  fun shouldPrefetch(remainingMs: Long, hasNext: Boolean, nextAlreadyPrefetched: Boolean): Boolean =
    hasNext && !nextAlreadyPrefetched && remainingMs in 0 until prefetchWhenRemainingMs

  /** How many leading bytes of a file make [prefetchMs] of audio (at least one byte, at most all). */
  fun prefetchBytes(totalLength: Long, durationMs: Long?): Long {
    if (totalLength <= 0) return 0
    if (durationMs == null || durationMs <= 0) return minOf(totalLength, FALLBACK_PREFETCH_BYTES)
    val bytes = ceilDiv(totalLength * prefetchMs, durationMs)
    return bytes.coerceIn(1, totalLength)
  }

  companion object {
    /** 30 s of CD-rate PCM, for a file whose duration the index does not know. */
    const val FALLBACK_PREFETCH_BYTES = 30L * 176_400
  }
}

/** Milliseconds of audio in [bytes] of a file of [totalLength] bytes lasting [durationMs]. */
fun bytesToMs(bytes: Long, totalLength: Long, durationMs: Long): Long =
  if (totalLength <= 0 || durationMs <= 0) 0 else (bytes.toDouble() * durationMs / totalLength).toLong()

/** Byte offset of [ms] into a file of [totalLength] bytes lasting [durationMs]. */
fun msToBytes(ms: Long, totalLength: Long, durationMs: Long): Long =
  if (totalLength <= 0 || durationMs <= 0) 0 else (ms.toDouble() * totalLength / durationMs).toLong().coerceIn(0, totalLength)

private fun ceilDiv(a: Long, b: Long): Long = (a + b - 1) / b
