package com.nowplaying.player.awsp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AbrTest {
  /** A 24/96 FLAC runs at roughly 3000 kb/s = 375 000 B/s; 1.2× that is 450 000 B/s. */
  private val source = 375_000.0

  /** Feed [seconds] of 1 s samples delivering [bps] bytes/s while fetching [activeFraction] of the time. */
  private fun Abr.feed(fromMs: Long, seconds: Int, bps: Double, activeFraction: Double = 1.0): Long {
    var t = fromMs
    repeat(seconds) {
      t += 1000
      val active = (1000 * activeFraction).toLong()
      onDelivered(t, (bps * active / 1000).toLong(), active)
    }
    return t
  }

  @Test
  fun noDecisionBeforeAFullWindow() {
    val abr = Abr()
    val t = abr.feed(0, 9, bps = 10_000.0)
    assertEquals(Abr.Change.NONE, abr.evaluate(t, source))
    assertEquals(Tier.LOSSLESS, abr.tier)
  }

  @Test
  fun sustainedSlowLinkDropsToHigh() {
    val abr = Abr()
    val t = abr.feed(0, 10, bps = 400_000.0) // above 1× but under 1.2× the source rate
    assertEquals(Abr.Change.DOWN, abr.evaluate(t, source))
    assertEquals(Tier.HIGH, abr.tier)
    assertEquals(400_000.0, abr.lastThroughputBps!!, 1.0)
  }

  @Test
  fun enoughHeadroomStaysLossless() {
    val abr = Abr()
    val t = abr.feed(0, 10, bps = 460_000.0)
    assertEquals(Abr.Change.NONE, abr.evaluate(t, source))
    assertEquals(Tier.LOSSLESS, abr.tier)
  }

  @Test
  fun idleTimeWhileTheBufferIsFullIsNotASlowLink() {
    // A fast link that only fetches 20% of the time (the buffer sits at its target): throughput is
    // measured over active time, so this is 5 MB/s, not 1 MB/s averaged over idling.
    val abr = Abr()
    val t = abr.feed(0, 10, bps = 5_000_000.0, activeFraction = 0.2)
    assertEquals(Abr.Change.NONE, abr.evaluate(t, source))
    assertEquals(Tier.LOSSLESS, abr.tier)
  }

  @Test
  fun tooLittleActiveTimeIsNoEvidence() {
    val abr = Abr()
    val t = abr.feed(0, 10, bps = 1_000.0, activeFraction = 0.1) // 1 s active in the window
    assertEquals(Abr.Change.NONE, abr.evaluate(t, source))
    assertNull(abr.lastThroughputBps)
  }

  @Test
  fun returnsToLosslessAfterSixtySecondsOfHeadroom() {
    val abr = Abr()
    var t = abr.feed(0, 10, bps = 300_000.0)
    assertEquals(Abr.Change.DOWN, abr.evaluate(t, source))
    // Headroom starts; evaluate every second.
    var up = -1L
    val start = t
    repeat(70) {
      t = abr.feed(t, 1, bps = 1_000_000.0)
      if (abr.evaluate(t, source) == Abr.Change.UP && up < 0) up = t
    }
    assertEquals(Tier.LOSSLESS, abr.tier)
    // The 10 s window first averages above 1.2× three seconds in ((7·300k + 3·1M)/10 s = 510 kB/s
    // ≥ 450 kB/s); from there it takes 60 s of headroom to switch back.
    assertEquals(start + 3_000 + 60_000, up)
  }

  @Test
  fun aDipResetsTheHeadroomClock() {
    val abr = Abr()
    var t = abr.feed(0, 10, bps = 300_000.0)
    abr.evaluate(t, source)
    repeat(50) {
      t = abr.feed(t, 1, bps = 1_000_000.0)
      abr.evaluate(t, source)
    }
    // Ten slow seconds: the window drops under 1.2× and the clock restarts.
    repeat(10) {
      t = abr.feed(t, 1, bps = 100_000.0)
      abr.evaluate(t, source)
    }
    assertEquals(Tier.HIGH, abr.tier)
    repeat(30) {
      t = abr.feed(t, 1, bps = 1_000_000.0)
      assertEquals(Abr.Change.NONE, abr.evaluate(t, source))
    }
    assertEquals(Tier.HIGH, abr.tier)
  }
}
