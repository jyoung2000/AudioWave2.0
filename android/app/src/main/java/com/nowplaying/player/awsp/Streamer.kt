package com.nowplaying.player.awsp

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException

/** The PC could not produce the requested tier (reset 0x12); the player falls back to lossless. */
class TierUnavailableException(val tier: Tier) : IOException("the PC could not produce the ${tier.wire} tier")

/**
 * The fetch side of playback: one [TrackBuffer] per (track, tier), a fetch loop for the current
 * track that follows the §4 rules, a bounded prefetch of the next queued track, and the ABR clock.
 *
 * The current-track loop, in one sentence: request from the first byte at or after the player's
 * read position that is not held, pull chunks while the buffer is under 20 s ahead of playback,
 * *hold the stream open without reading* once it is over (QUIC flow control then stops the server
 * — backpressure end to end), resume below 5 s, and on a seek, a lost connection or a network
 * change, start a new range request from the last contiguous byte.
 *
 * No android.* here; the service feeds it the playback position.
 */
class Streamer(
  private val scope: CoroutineScope,
  private val dir: File,
  private val opener: AudioOpener,
  val policy: BufferPolicy = BufferPolicy(),
  val abr: Abr = Abr(),
  private val log: (String) -> Unit = {},
) {
  data class Key(val trackId: String, val tier: Tier)

  private class Entry(val key: Key, val buffer: TrackBuffer, @Volatile var durationMs: Long?) {
    var job: Job? = null
    var current = false
  }

  private val entries = HashMap<Key, Entry>()

  /** Playback position of the current track, set by the player thread. */
  @Volatile var positionMs: Long = 0

  /** Source (lossless) rate from the index (`format.bitrateKbps`), for ABR when not measurable. */
  @Volatile var sourceBytesPerSecHint: Double = 0.0

  @Volatile private var lastLosslessBps: Double = 0.0
  private var abrJob: Job? = null

  private val _abrChanges = MutableSharedFlow<Pair<Abr.Change, Tier>>(extraBufferCapacity = 8)
  val abrChanges: SharedFlow<Pair<Abr.Change, Tier>> = _abrChanges.asSharedFlow()

  init {
    dir.mkdirs()
    dir.listFiles()?.forEach { it.delete() }
  }

  fun start() {
    if (abrJob?.isActive == true) return
    abrJob = scope.launch {
      while (isActive) {
        delay(1_000)
        val change = abr.evaluate(now(), sourceBytesPerSec())
        if (change != Abr.Change.NONE) {
          log("awsp abr ${change.name.lowercase()} -> ${abr.tier.wire}")
          _abrChanges.tryEmit(change to abr.tier)
        }
      }
    }
  }

  /** The buffer the DataSource reads; created (as the current track) if the service has not yet. */
  fun buffer(trackId: String, tier: Tier): TrackBuffer = synchronized(entries) {
    val key = Key(trackId, tier)
    entries[key]?.buffer ?: setCurrentLocked(key, null).buffer
  }

  /** Make (track, tier) the current track; everything but it and a prefetched next is evicted. */
  fun setCurrent(trackId: String, tier: Tier, durationMs: Long?, keepNext: String?) = synchronized(entries) {
    val e = setCurrentLocked(Key(trackId, tier), durationMs)
    val evict = entries.values.filter { it !== e && it.key.trackId != keepNext }
    evict.forEach { drop(it) }
  }

  fun setDuration(trackId: String, tier: Tier, durationMs: Long) = synchronized(entries) {
    entries[Key(trackId, tier)]?.durationMs = durationMs
  }

  /** Fetch the first 30 s of [trackId] (§4), unless it is already held or being fetched. */
  fun prefetch(trackId: String, tier: Tier, durationMs: Long?) = synchronized(entries) {
    val key = Key(trackId, tier)
    if (entries.containsKey(key)) return@synchronized false
    val e = Entry(key, TrackBuffer(trackId, tier, fileFor(key)), durationMs)
    entries[key] = e
    e.job = scope.launch { runPrefetch(e) }
    true
  }

  /** Buffered time ahead of playback on the current track (for `report` and the UI). */
  fun bufferedAheadMs(): Long = synchronized(entries) { entries.values.firstOrNull { it.current } }?.let { aheadMs(it) } ?: 0

  fun close() = synchronized(entries) {
    abrJob?.cancel()
    entries.values.toList().forEach { drop(it) }
  }

  private fun setCurrentLocked(key: Key, durationMs: Long?): Entry {
    val existing = entries[key]
    if (existing != null && existing.current) {
      if (durationMs != null) existing.durationMs = durationMs
      return existing
    }
    entries.values.filter { it.current }.forEach { drop(it) }
    val e = existing ?: Entry(key, TrackBuffer(key.trackId, key.tier, fileFor(key)), durationMs).also { entries[key] = it }
    if (durationMs != null) e.durationMs = durationMs
    e.job?.cancel()
    e.current = true
    e.job = scope.launch { runCurrent(e) }
    return e
  }

  private fun drop(e: Entry) {
    e.job?.cancel()
    e.buffer.close()
    entries.remove(e.key)
  }

  private fun fileFor(key: Key): File =
    File(dir, trackIdHash(key.trackId).joinToString("") { "%02x".format(it) } + "-" + key.tier.wire + ".part")

  // ---- the loops --------------------------------------------------------------------------------

  private suspend fun runCurrent(e: Entry) {
    val buf = e.buffer
    var fetching = true
    while (currentCoroutineContext().isActive) {
      val from = buf.resumeFrom()
      if (from == null) {
        // Everything from the read position to the end is held; a seek back into a hole wakes this.
        delay(POLL_MS)
        continue
      }
      fetching = policy.shouldFetch(fetching, aheadMs(e), complete = false, readerStarved = buf.starvedAt >= 0)
      if (!fetching) {
        delay(POLL_MS)
        continue
      }
      val stream = try {
        opener.openAudio(AudioRequest(e.key.trackId, from, null, e.key.tier))
      } catch (x: CancellationException) {
        throw x
      } catch (x: StreamResetException) {
        if (onReset(e, from, x)) return
        delay(RETRY_MS)
        continue
      } catch (x: IOException) {
        // Not connected, or the connection dropped: the client reconnects; try again from here.
        delay(RETRY_MS)
        continue
      }
      var open = true
      try {
        if (!adopt(e, stream.header)) return
        var pos = from
        while (true) {
          // A seek elsewhere (or a merge with bytes already held): this stream is no longer useful.
          if (buf.resumeFrom() != pos) break
          if (!policy.shouldFetch(true, aheadMs(e), complete = false, readerStarved = buf.starvedAt >= 0)) {
            // Above the target: hold the stream without reading until below low-water.
            while (buf.resumeFrom() == pos && !policy.shouldFetch(false, aheadMs(e), false, buf.starvedAt >= 0)) delay(POLL_MS)
            continue
          }
          val t0 = now()
          val chunk = stream.read(CHUNK)
          if (chunk == null) {
            open = false
            break
          }
          buf.write(pos, chunk)
          pos += chunk.size
          abr.onDelivered(now(), chunk.size.toLong(), (now() - t0).coerceAtLeast(1))
        }
      } catch (x: CancellationException) {
        throw x
      } catch (x: IOException) {
        open = false
        log("awsp audio stream for ${e.key.trackId} lost at ${buf.resumeFrom()}: ${x.message}")
        delay(RETRY_MS)
      } finally {
        if (open) withContext(NonCancellable) { runCatching { stream.cancel() } }
      }
    }
  }

  private suspend fun runPrefetch(e: Entry) {
    val buf = e.buffer
    repeat(PREFETCH_ATTEMPTS) {
      val known = buf.totalLength?.let { policy.prefetchBytes(it, e.durationMs) }
      val from = buf.resumeFrom(0) ?: return
      if (known != null && from >= known) return
      val stream = try {
        opener.openAudio(AudioRequest(e.key.trackId, from, known?.minus(1), e.key.tier))
      } catch (x: CancellationException) {
        throw x
      } catch (x: StreamResetException) {
        if (onReset(e, from, x)) return
        delay(RETRY_MS)
        return@repeat
      } catch (x: IOException) {
        delay(RETRY_MS)
        return@repeat
      }
      var open = true
      try {
        if (!adopt(e, stream.header)) return
        val limit = policy.prefetchBytes(stream.header.totalLength, e.durationMs)
        var pos = from
        while (pos < limit) {
          val chunk = stream.read(CHUNK)
          if (chunk == null) {
            open = false
            break
          }
          val n = minOf(chunk.size.toLong(), limit - pos).toInt()
          buf.write(pos, chunk, n)
          pos += n
        }
        log("awsp prefetched ${e.key.trackId} [0, $pos)")
        return
      } catch (x: CancellationException) {
        throw x
      } catch (x: IOException) {
        open = false
        delay(RETRY_MS)
      } finally {
        if (open) withContext(NonCancellable) { runCatching { stream.cancel() } }
      }
    }
  }

  /** Check and adopt a stream's header. False (and the buffer failed) if it is not our track. */
  private fun adopt(e: Entry, h: AudioHeader): Boolean {
    if (!h.matches(e.key.trackId)) {
      e.buffer.fail(IOException("the PC answered with a different track"))
      return false
    }
    if (h.tierByte != e.key.tier.byte) log("awsp ${e.key.trackId}: asked ${e.key.tier.wire}, served ${h.tier?.wire ?: h.tierByte} (the PC's tier cap)")
    e.buffer.setHeader(h)
    val d = e.durationMs
    if (h.tier == Tier.LOSSLESS && d != null && d > 0) lastLosslessBps = h.totalLength * 1000.0 / d
    return true
  }

  /** Handle a reset; true when the loop should stop (the buffer has been failed). */
  private fun onReset(e: Entry, from: Long, x: StreamResetException): Boolean {
    log("awsp ${e.key.trackId} from $from: ${x.message}")
    val err = when (x.code) {
      Codes.RANGE -> {
        val total = e.buffer.totalLength
        if (total != null && from >= total) return false
        IOException("the PC refused the byte range")
      }
      Codes.NOT_FOUND -> IOException("the PC no longer has this track")
      Codes.TIER -> TierUnavailableException(e.key.tier)
      else -> x
    }
    e.buffer.fail(err)
    return true
  }

  private fun aheadMs(e: Entry): Long {
    val buf = e.buffer
    val total = buf.totalLength ?: return 0
    val duration = e.durationMs?.takeIf { it > 0 } ?: (total * 1000 / FALLBACK_BYTES_PER_SEC).coerceAtLeast(1)
    val play = msToBytes(positionMs, total, duration)
    val anchor = if (buf.contiguousEnd(play) > play) play else maxOf(play, buf.readPosition)
    return bytesToMs((buf.contiguousEnd(anchor) - play).coerceAtLeast(0), total, duration)
  }

  private fun sourceBytesPerSec(): Double {
    val current = synchronized(entries) { entries.values.firstOrNull { it.current } }
    if (current != null && current.key.tier == Tier.LOSSLESS) {
      val total = current.buffer.totalLength
      val d = current.durationMs
      if (total != null && d != null && d > 0 && current.buffer.header?.tier == Tier.LOSSLESS) return total * 1000.0 / d
    }
    return sourceBytesPerSecHint.takeIf { it > 0 } ?: lastLosslessBps.takeIf { it > 0 } ?: FALLBACK_BYTES_PER_SEC.toDouble()
  }

  private fun now(): Long = System.nanoTime() / 1_000_000

  companion object {
    const val POLL_MS = 200L
    const val RETRY_MS = 500L
    const val PREFETCH_ATTEMPTS = 3

    /** CD-rate PCM, the assumption when neither the index nor a header gives a rate. */
    const val FALLBACK_BYTES_PER_SEC = 176_400L
  }
}
