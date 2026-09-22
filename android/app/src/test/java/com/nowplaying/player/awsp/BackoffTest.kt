package com.nowplaying.player.awsp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class BackoffTest {

  @Test
  fun ceilingsDoubleFrom250msAndCapAt30s() {
    val b = Backoff()
    assertEquals(
      listOf(250L, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000),
      (0 until 10).map { b.ceilingMs(it) },
    )
    assertEquals(30_000L, b.ceilingMs(1_000))
    assertEquals(30_000L, b.ceilingMs(Int.MAX_VALUE))
    assertEquals(250L, b.ceilingMs(-3))
  }

  @Test
  fun delaysAreFullJitterWithinTheCeiling() {
    val b = Backoff(random = Random(42))
    for (attempt in 0 until 40) {
      repeat(50) {
        val d = b.delayMs(attempt)
        assertTrue("attempt $attempt gave $d", d in 0..b.ceilingMs(attempt))
      }
    }
  }

  @Test
  fun jitterSpreadsAcrossTheWholeInterval() {
    // Full jitter, not "ceiling ± a bit": over many draws both ends of [0, 30 s] are used.
    val b = Backoff(random = Random(7))
    val draws = (0 until 2_000).map { b.delayMs(20) }
    assertTrue(draws.min() < 1_500)
    assertTrue(draws.max() > 28_500)
    assertTrue(draws.average() in 13_500.0..16_500.0)
  }

  @Test
  fun sameSeedSameSchedule() {
    val a = Backoff(random = Random(1)).let { b -> (0 until 8).map { b.delayMs(it) } }
    val c = Backoff(random = Random(1)).let { b -> (0 until 8).map { b.delayMs(it) } }
    assertEquals(a, c)
  }
}
