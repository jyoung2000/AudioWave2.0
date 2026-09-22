package com.nowplaying.player.awsp

/**
 * Adaptive bitrate for the native client (§4): over a 10 s window compare what the link delivers
 * with what playback consumes; below 1.2 × the source bitrate, ask for `high` (Opus 256 kb/s) and
 * tell the UI; go back to `lossless` after 60 s of headroom.
 *
 * "Delivered" is measured as throughput *while the fetch loop was pulling*: the loop deliberately
 * idles whenever the buffer is above its 20 s target, and counting that idle time would read as a
 * slow link and downgrade a perfectly good one. A decision needs a full window of history and at
 * least [minActiveMs] of active fetching in it; otherwise there is no evidence and nothing changes.
 *
 * Pure: time comes in as arguments, so the rules are unit-tested with a fake clock.
 */
class Abr(
  val windowMs: Long = 10_000,
  val factor: Double = 1.2,
  val recoverAfterMs: Long = 60_000,
  val minActiveMs: Long = 2_000,
) {
  enum class Change { NONE, DOWN, UP }

  private class Sample(val atMs: Long, val bytes: Long, val activeMs: Long)

  private val samples = ArrayDeque<Sample>()
  private var firstSampleMs: Long? = null
  private var headroomSinceMs: Long? = null

  var tier: Tier = Tier.LOSSLESS
    private set

  /** The last window's throughput in bytes/s, or null when there was too little active time. */
  var lastThroughputBps: Double? = null
    private set

  /** Record [bytes] delivered by the fetch loop during [activeMs] of pulling, ending at [nowMs]. */
  fun onDelivered(nowMs: Long, bytes: Long, activeMs: Long) {
    if (firstSampleMs == null) firstSampleMs = nowMs - activeMs
    samples.addLast(Sample(nowMs, bytes, activeMs))
    prune(nowMs)
  }

  /**
   * Re-evaluate at [nowMs] against the source (lossless) rate of the current track in bytes/s.
   * Returns the tier change it made, if any.
   */
  fun evaluate(nowMs: Long, sourceBytesPerSec: Double): Change {
    prune(nowMs)
    val first = firstSampleMs ?: return Change.NONE
    if (nowMs - first < windowMs || sourceBytesPerSec <= 0) return Change.NONE
    val active = samples.sumOf { it.activeMs }
    if (active < minActiveMs) {
      lastThroughputBps = null
      return Change.NONE
    }
    val throughput = samples.sumOf { it.bytes } * 1000.0 / active
    lastThroughputBps = throughput
    val enough = throughput >= factor * sourceBytesPerSec
    return when (tier) {
      Tier.LOSSLESS -> if (!enough) {
        tier = Tier.HIGH
        headroomSinceMs = null
        Change.DOWN
      } else {
        Change.NONE
      }
      else -> {
        if (!enough) {
          headroomSinceMs = null
          Change.NONE
        } else {
          val since = headroomSinceMs ?: nowMs.also { headroomSinceMs = it }
          if (nowMs - since >= recoverAfterMs) {
            tier = Tier.LOSSLESS
            headroomSinceMs = null
            Change.UP
          } else {
            Change.NONE
          }
        }
      }
    }
  }

  fun reset() {
    samples.clear()
    firstSampleMs = null
    headroomSinceMs = null
    lastThroughputBps = null
    tier = Tier.LOSSLESS
  }

  private fun prune(nowMs: Long) {
    // Samples in (now − window, now]: exactly the last 10 s.
    while (samples.isNotEmpty() && nowMs - samples.first().atMs >= windowMs) samples.removeFirst()
  }
}
