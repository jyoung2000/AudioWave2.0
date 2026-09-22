package com.nowplaying.player.awsp

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.io.IOException
import java.io.InterruptedIOException
import kotlin.concurrent.thread

class TrackBufferTest {
  private val file: File = File.createTempFile("awsp", ".part")
  private val buf = TrackBuffer("t1", Tier.LOSSLESS, file)

  @After fun tearDown() = buf.close()

  private fun header(len: Long, codec: Int = 1, tier: Int = 0) = AudioHeader.parse(AudioHeader.encode("t1", len, codec, tier))

  @Test
  fun readsWhatWasWrittenAtItsOffset() {
    buf.setHeader(header(100))
    buf.write(10, ByteArray(20) { (it + 10).toByte() })
    val out = ByteArray(50)
    assertEquals(20, buf.read(10, out, 0, 50, 1000)) // only what is contiguous
    assertEquals(10.toByte(), out[0])
    assertEquals(29.toByte(), out[19])
    assertEquals(30L, buf.contiguousEnd(10))
    assertEquals(30L, buf.resumeFrom(15))
  }

  @Test
  fun endOfFileIsMinusOne() {
    buf.setHeader(header(4))
    buf.write(0, byteArrayOf(1, 2, 3, 4))
    assertEquals(-1, buf.read(4, ByteArray(8), 0, 8, 1000))
    assertTrue(buf.completeFrom(0))
    assertNull(buf.resumeFrom(0))
  }

  @Test
  fun aBlockedReaderWakesWhenItsByteArrives() {
    buf.setHeader(header(1000))
    val out = ByteArray(8)
    var got = -2
    val reader = thread { got = buf.read(500, out, 0, 8, 5_000) }
    // Wait until the reader is really blocked, and visible as starved at 500.
    val deadline = System.currentTimeMillis() + 2_000
    while (buf.starvedAt != 500L && System.currentTimeMillis() < deadline) Thread.sleep(5)
    assertEquals(500L, buf.starvedAt)
    buf.write(0, ByteArray(500)) // not it
    buf.write(500, byteArrayOf(9, 8, 7))
    reader.join(2_000)
    assertEquals(3, got)
    assertArrayEquals(byteArrayOf(9, 8, 7), out.copyOf(3))
    assertEquals(-1L, buf.starvedAt)
  }

  @Test
  fun anInterruptedReaderGetsInterruptedIo() {
    buf.setHeader(header(1000))
    var error: Throwable? = null
    val reader = thread {
      try {
        buf.read(0, ByteArray(8), 0, 8, 10_000)
      } catch (e: Throwable) {
        error = e
      }
    }
    Thread.sleep(100)
    reader.interrupt()
    reader.join(2_000)
    assertTrue(error is InterruptedIOException)
    // And the buffer still works for everyone else (a FileChannel would have been closed).
    buf.write(0, byteArrayOf(1))
    assertEquals(1, buf.read(0, ByteArray(1), 0, 1, 100))
  }

  @Test
  fun aDifferentFileDropsTheHeldBytes() {
    buf.setHeader(header(100))
    buf.write(0, ByteArray(50))
    assertEquals(50L, buf.heldBytes())
    buf.setHeader(header(100)) // the same file again: kept
    assertEquals(50L, buf.heldBytes())
    buf.setHeader(header(120)) // the source changed on the PC
    assertEquals(0L, buf.heldBytes())
    buf.write(0, ByteArray(10))
    buf.setHeader(header(120, codec = 4, tier = 1)) // now served as Opus (a tier cap)
    assertEquals(0L, buf.heldBytes())
  }

  @Test
  fun failuresReachReadersAndTheNextHeaderClearsThem() {
    buf.fail(IOException("the PC no longer has this track"))
    try {
      buf.awaitHeader(100)
      fail("expected the failure")
    } catch (e: IOException) {
      assertEquals("the PC no longer has this track", e.message)
    }
    buf.setHeader(header(10))
    assertEquals(10L, buf.awaitHeader(100).totalLength)
  }

  @Test
  fun timesOutWithoutBytes() {
    buf.setHeader(header(10))
    try {
      buf.read(0, ByteArray(1), 0, 1, 50)
      fail("expected a timeout")
    } catch (e: IOException) {
      assertFalse(e is InterruptedIOException)
    }
  }

  @Test
  fun closeDeletesTheFile() {
    buf.write(0, byteArrayOf(1))
    assertTrue(file.exists())
    buf.close()
    assertFalse(file.exists())
  }
}
