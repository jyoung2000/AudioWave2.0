package com.nowplaying.player.awsp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BufferPolicyTest {
  private val p = BufferPolicy()

  @Test
  fun defaultsAreTheSpecsNumbers() {
    assertEquals(20_000L, p.targetMs)
    assertEquals(5_000L, p.lowWaterMs)
    assertEquals(45_000L, p.prefetchWhenRemainingMs)
    assertEquals(30_000L, p.prefetchMs)
  }

  @Test
  fun fetchesUntilTheTargetThenPausesUntilLowWater() {
    // Walk the buffer up and down and record the loop's state at each step.
    var fetching = true
    val trace = ArrayList<Boolean>()
    for (ahead in listOf(0L, 10_000, 19_999, 20_000, 15_000, 8_000, 5_000, 4_999, 12_000, 20_001)) {
      fetching = p.shouldFetch(fetching, ahead, complete = false)
      trace += fetching
    }
    assertEquals(listOf(true, true, true, false, false, false, false, true, true, false), trace)
  }

  @Test
  fun neverFetchesWhenComplete() {
    assertFalse(p.shouldFetch(fetching = true, aheadMs = 0, complete = true))
    assertFalse(p.shouldFetch(fetching = false, aheadMs = 0, complete = true, readerStarved = true))
  }

  @Test
  fun aStarvedReaderAlwaysGetsBytes() {
    // The estimate says 30 s ahead, but the player is blocked on a byte that is not there.
    assertTrue(p.shouldFetch(fetching = false, aheadMs = 30_000, complete = false, readerStarved = true))
  }

  @Test
  fun prefetchStartsUnderFortyFiveSecondsLeftOnce() {
    assertFalse(p.shouldPrefetch(remainingMs = 45_000, hasNext = true, nextAlreadyPrefetched = false))
    assertTrue(p.shouldPrefetch(remainingMs = 44_999, hasNext = true, nextAlreadyPrefetched = false))
    assertTrue(p.shouldPrefetch(remainingMs = 0, hasNext = true, nextAlreadyPrefetched = false))
    assertFalse(p.shouldPrefetch(remainingMs = 10_000, hasNext = true, nextAlreadyPrefetched = true))
    assertFalse(p.shouldPrefetch(remainingMs = 10_000, hasNext = false, nextAlreadyPrefetched = false))
    assertFalse(p.shouldPrefetch(remainingMs = -1, hasNext = true, nextAlreadyPrefetched = false))
  }

  @Test
  fun prefetchIsTheFirstThirtySecondsOfBytes() {
    // A 4-minute, 40 MB file: 30 s is an eighth.
    assertEquals(5_000_000L, p.prefetchBytes(totalLength = 40_000_000, durationMs = 240_000))
    // A file shorter than 30 s is prefetched whole, never past its end.
    assertEquals(1_000_000L, p.prefetchBytes(totalLength = 1_000_000, durationMs = 20_000))
    // Unknown duration: 30 s of CD-rate PCM, capped at the file.
    assertEquals(BufferPolicy.FALLBACK_PREFETCH_BYTES, p.prefetchBytes(100_000_000, null))
    assertEquals(1234L, p.prefetchBytes(1234, null))
    assertEquals(0L, p.prefetchBytes(0, 1000))
  }

  @Test
  fun timeAndBytesConvertAtTheAverageRate() {
    assertEquals(20_000L, bytesToMs(bytes = 4_000_000, totalLength = 48_000_000, durationMs = 240_000))
    assertEquals(4_000_000L, msToBytes(ms = 20_000, totalLength = 48_000_000, durationMs = 240_000))
    assertEquals(48_000_000L, msToBytes(ms = 999_999, totalLength = 48_000_000, durationMs = 240_000)) // clamped
    assertEquals(0L, bytesToMs(100, 0, 1000))
  }

  @Test(expected = IllegalArgumentException::class)
  fun lowWaterMustBeBelowTheTarget() {
    BufferPolicy(targetMs = 5_000, lowWaterMs = 5_000)
  }
}
