package com.nowplaying.player.awsp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RangeSetTest {

  @Test
  fun mergesOverlappingAndTouchingRanges() {
    val r = RangeSet()
    r.add(0, 10)
    r.add(10, 20) // touching
    r.add(30, 40)
    r.add(35, 50) // overlapping
    assertEquals(listOf(0L until 20L, 30L until 50L), r.intervals())
    r.add(15, 32) // bridges the gap
    assertEquals(listOf(0L until 50L), r.intervals())
    assertEquals(50L, r.heldBytes)
    r.add(5, 5) // empty
    assertEquals(1, r.size)
  }

  @Test
  fun outOfOrderChunksLandInOrder() {
    val r = RangeSet()
    r.add(200, 300)
    r.add(0, 100)
    r.add(100, 200)
    assertEquals(listOf(0L until 300L), r.intervals())
  }

  @Test
  fun contiguousEndFromAPosition() {
    val r = RangeSet()
    r.add(0, 1000)
    r.add(5000, 6000)
    assertEquals(1000L, r.contiguousEnd(0))
    assertEquals(1000L, r.contiguousEnd(999))
    assertEquals(1000L, r.contiguousEnd(1000)) // first byte not held
    assertEquals(3000L, r.contiguousEnd(3000)) // in the hole
    assertEquals(6000L, r.contiguousEnd(5000))
    assertTrue(r.contains(5999))
    assertFalse(r.contains(6000))
  }

  // ---- resume-from-last-contiguous-byte (§3.1, §4) ------------------------------------------------

  @Test
  fun resumeAfterAConnectionDropsMidStream() {
    // 64 KiB chunks arrived for [0, 327 680) before the connection went; playback is at 100 000.
    val held = RangeSet()
    var pos = 0L
    repeat(5) {
      held.add(pos, pos + CHUNK)
      pos += CHUNK
    }
    assertEquals(327_680L, resumeOffset(held, readPosition = 100_000, totalLength = 10_000_000))
    // And it is a valid request for the server: inside the file.
    assertEquals(327_680L..9_999_999L, resolveRange(10_000_000, 327_680, null))
  }

  @Test
  fun resumeAfterASeekIntoAHoleStartsAtTheSeek() {
    val held = RangeSet()
    held.add(0, 400_000)
    assertEquals(2_000_000L, resumeOffset(held, readPosition = 2_000_000, totalLength = 10_000_000))
  }

  @Test
  fun resumeAfterASeekIntoALaterHeldRangeSkipsWhatIsHeld() {
    val held = RangeSet()
    held.add(0, 400_000)
    held.add(2_000_000, 2_500_000) // an earlier seek fetched this
    assertEquals(2_500_000L, resumeOffset(held, readPosition = 2_100_000, totalLength = 10_000_000))
    // Seeking back to the start resumes after the first run, not at 0.
    assertEquals(400_000L, resumeOffset(held, readPosition = 0, totalLength = 10_000_000))
  }

  @Test
  fun nothingToResumeWhenHeldToTheEnd() {
    val held = RangeSet()
    held.add(0, 1000)
    assertNull(resumeOffset(held, readPosition = 10, totalLength = 1000))
    // Without a known length there is always somewhere to ask from.
    assertEquals(1000L, resumeOffset(held, readPosition = 10, totalLength = null))
  }

  @Test
  fun resumeWithNothingHeldIsTheReadPosition() {
    assertEquals(0L, resumeOffset(RangeSet(), 0, null))
    assertEquals(777L, resumeOffset(RangeSet(), 777, 1000))
  }
}
