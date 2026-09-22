package com.nowplaying.player.awsp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.file.Files
import java.util.Collections
import kotlin.random.Random

/**
 * The fetch loop against a fake server that speaks the audio-stream half of §3.2 (header, then
 * the range in 64 KiB chunks) and can drop a stream part-way. Real coroutines, real files, no device.
 */
class StreamerTest {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private val dir = Files.createTempDirectory("awsp-test").toFile()
  private val data = Random(3).nextBytes(1_000_000)

  private class FakeServer(val data: ByteArray, val trackId: String) : AudioOpener {
    val requests: MutableList<AudioRequest> = Collections.synchronizedList(ArrayList())
    val cancelled: MutableList<Long> = Collections.synchronizedList(ArrayList())

    /** Drop the first stream after this many bytes (a lost connection), or never. */
    @Volatile var dropFirstAfter: Long = -1
    @Volatile var chunkDelayMs: Long = 0

    override suspend fun openAudio(request: AudioRequest): AudioStream {
      requests += request
      val range = resolveRange(data.size.toLong(), request.byteStart, request.byteEnd) ?: throw StreamResetException(Codes.RANGE)
      val first = requests.size == 1
      val header = AudioHeader.parse(AudioHeader.encode(trackId, data.size.toLong(), Codec.FLAC.byte, request.tier.byte))
      return object : AudioStream {
        override val header = header
        override val start = request.byteStart
        var pos = range.first
        var sent = 0L

        override suspend fun read(max: Int): ByteArray? {
          if (pos > range.last) return null
          if (first && dropFirstAfter >= 0 && sent >= dropFirstAfter) throw IOException("connection lost")
          if (chunkDelayMs > 0) delay(chunkDelayMs)
          val n = minOf(max.toLong(), CHUNK.toLong(), range.last - pos + 1).toInt()
          val out = data.copyOfRange(pos.toInt(), pos.toInt() + n)
          pos += n
          sent += n
          return out
        }

        override suspend fun cancel() {
          cancelled += pos
        }
      }
    }
  }

  @After
  fun tearDown() {
    scope.cancel()
    dir.deleteRecursively()
  }

  /** Read the whole track the way the DataSource does: sequentially, blocking on the buffer. */
  private fun readAll(buf: TrackBuffer, from: Long = 0): ByteArray {
    val out = ByteArrayOutputStream()
    val chunk = ByteArray(16 * 1024)
    var pos = from
    while (true) {
      val n = buf.read(pos, chunk, 0, chunk.size, 10_000)
      if (n < 0) break
      out.write(chunk, 0, n)
      pos += n
      buf.readPosition = pos
    }
    return out.toByteArray()
  }

  @Test
  fun aDroppedStreamResumesFromTheLastContiguousByte() {
    val server = FakeServer(data, "t1").apply { dropFirstAfter = 4L * CHUNK }
    val streamer = Streamer(scope, dir, server)
    // 1 MB over 10 s: always under the 20 s target, so the loop never pauses.
    streamer.setCurrent("t1", Tier.LOSSLESS, 10_000, keepNext = null)
    val bytes = readAll(streamer.buffer("t1", Tier.LOSSLESS))

    assertArrayEquals("byte-identical after the drop", data, bytes)
    assertEquals(2, server.requests.size)
    assertEquals(0L, server.requests[0].byteStart)
    assertEquals(4L * CHUNK, server.requests[1].byteStart)
    assertEquals(null, server.requests[1].byteEnd)
    streamer.close()
  }

  @Test
  fun aSeekIntoAHoleIsANewRangeRequestThere() {
    val server = FakeServer(data, "t1").apply { chunkDelayMs = 30 }
    val streamer = Streamer(scope, dir, server)
    streamer.setCurrent("t1", Tier.LOSSLESS, 10_000, keepNext = null)
    val buf = streamer.buffer("t1", Tier.LOSSLESS)
    // Let a little arrive, then seek far ahead, as ExoPlayer's open(position) does.
    buf.read(0, ByteArray(1), 0, 1, 5_000)
    buf.readPosition = 800_000
    val tail = readAll(buf, from = 800_000)

    assertArrayEquals(data.copyOfRange(800_000, data.size), tail)
    assertTrue("the first stream was stopped", server.cancelled.isNotEmpty())
    assertEquals(800_000L, server.requests.last().byteStart)
    streamer.close()
  }

  @Test
  fun prefetchStopsAtThirtySecondsWorth() {
    val server = FakeServer(data, "t2")
    val streamer = Streamer(scope, dir, server)
    // 1 MB over 100 s: 30 s is 300 000 bytes.
    assertTrue(streamer.prefetch("t2", Tier.LOSSLESS, 100_000))
    assertTrue("a second prefetch of the same track is a no-op", !streamer.prefetch("t2", Tier.LOSSLESS, 100_000))
    val buf = streamer.buffer("t2", Tier.LOSSLESS)
    val deadline = System.currentTimeMillis() + 5_000
    while (buf.heldBytes() < 300_000 && System.currentTimeMillis() < deadline) Thread.sleep(10)
    Thread.sleep(100)
    assertEquals(listOf(0L until 300_000L), buf.intervals())
    assertEquals(1, server.requests.size)
    assertTrue("the stream was stopped once enough had arrived", server.cancelled.isNotEmpty())
    val head = ByteArray(300_000)
    var pos = 0
    while (pos < head.size) pos += buf.read(pos.toLong(), head, pos, head.size - pos, 1_000)
    assertArrayEquals(data.copyOf(300_000), head)
    streamer.close()
  }

  @Test
  fun aNotFoundResetFailsTheReader() {
    val opener = AudioOpener { throw StreamResetException(Codes.NOT_FOUND) }
    val streamer = Streamer(scope, dir, opener)
    streamer.setCurrent("gone", Tier.LOSSLESS, 10_000, keepNext = null)
    try {
      streamer.buffer("gone", Tier.LOSSLESS).awaitHeader(5_000)
      throw AssertionError("expected not-found")
    } catch (e: IOException) {
      assertEquals("the PC no longer has this track", e.message)
    }
    streamer.close()
  }
}
