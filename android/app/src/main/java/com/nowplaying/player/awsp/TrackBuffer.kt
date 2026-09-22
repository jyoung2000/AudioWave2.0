package com.nowplaying.player.awsp

import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.InterruptedIOException
import java.io.RandomAccessFile
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * The client-side bytes of one (track, tier): a sparse file in the app's cache plus the set of
 * ranges it holds. The fetch loop writes at offsets; the player's DataSource reads, blocking until
 * the byte it wants arrives. The whole file is never in memory — at most one 64 KiB chunk at a time.
 *
 * A `RandomAccessFile` rather than a `FileChannel` on purpose: ExoPlayer interrupts its loader
 * thread to cancel a load, and an interrupt during a channel read *closes the channel* for every
 * other reader and writer. Seek + read on the file under one lock does not have that failure mode.
 */
class TrackBuffer(val trackId: String, val requestedTier: Tier, private val file: File) : Closeable {
  private val lock = ReentrantLock()
  private val changed = lock.newCondition()
  private val raf = RandomAccessFile(file, "rw")
  private val held = RangeSet()
  private var failure: IOException? = null
  private var closed = false

  /** The header of the bytes held (the file actually served: its length, codec and tier). */
  var header: AudioHeader? = null
    private set

  /** Where the player last opened or read; the fetch loop's anchor. */
  @Volatile var readPosition: Long = 0

  /** The position a reader is blocked on, or -1. A blocked reader always gets bytes fetched for it. */
  @Volatile var starvedAt: Long = -1
    private set

  val totalLength: Long? get() = header?.totalLength

  /**
   * Adopt a stream's header. If it describes a different file than the bytes held (the source
   * changed on the PC, or the server's tier cap now serves another encode), the held bytes are
   * dropped: splicing two files is never right.
   */
  fun setHeader(h: AudioHeader) = lock.withLock {
    val old = header
    if (old != null && (old.totalLength != h.totalLength || old.codecByte != h.codecByte || old.tierByte != h.tierByte)) {
      held.clear()
      raf.setLength(0)
    }
    header = h
    failure = null
    changed.signalAll()
  }

  fun write(offset: Long, data: ByteArray, len: Int = data.size) = lock.withLock {
    if (closed || len <= 0) return
    raf.seek(offset)
    raf.write(data, 0, len)
    held.add(offset, offset + len)
    changed.signalAll()
  }

  fun contiguousEnd(pos: Long): Long = lock.withLock { held.contiguousEnd(pos) }

  /** Where a range request for this buffer should start now, or null when nothing is missing. */
  fun resumeFrom(pos: Long = readPosition): Long? = lock.withLock { resumeOffset(held, pos, header?.totalLength) }

  fun heldBytes(): Long = lock.withLock { held.heldBytes }

  fun intervals(): List<LongRange> = lock.withLock { held.intervals() }

  /** Make readers fail with [e] (a not-found track, an unusable tier); cleared by the next header. */
  fun fail(e: IOException) = lock.withLock {
    failure = e
    changed.signalAll()
  }

  /** Wait for the header; the DataSource needs the length before it can open. */
  fun awaitHeader(timeoutMs: Long): AudioHeader = lock.withLock {
    var nanos = TimeUnit.MILLISECONDS.toNanos(timeoutMs)
    while (true) {
      if (closed) throw IOException("buffer closed")
      failure?.let { throw it }
      header?.let { return it }
      if (nanos <= 0) throw IOException("no audio header from the PC within ${timeoutMs / 1000} s")
      try {
        nanos = changed.awaitNanos(nanos)
      } catch (e: InterruptedException) {
        Thread.currentThread().interrupt()
        throw InterruptedIOException("interrupted waiting for the audio header")
      }
    }
    @Suppress("UNREACHABLE_CODE") error("unreachable")
  }

  /**
   * Read up to [len] bytes at [pos] into [dst]. Blocks until at least one byte at [pos] is held.
   * Returns -1 at the end of the file, throws on failure, close, interrupt or [timeoutMs].
   */
  fun read(pos: Long, dst: ByteArray, off: Int, len: Int, timeoutMs: Long): Int = lock.withLock {
    var nanos = TimeUnit.MILLISECONDS.toNanos(timeoutMs)
    try {
      while (true) {
        if (closed) throw IOException("buffer closed")
        failure?.let { throw it }
        val total = header?.totalLength
        if (total != null && pos >= total) return -1
        val available = held.contiguousEnd(pos) - pos
        if (available > 0) {
          val n = minOf(len.toLong(), available).toInt()
          raf.seek(pos)
          raf.readFully(dst, off, n)
          return n
        }
        if (nanos <= 0) throw IOException("no audio bytes at $pos within ${timeoutMs / 1000} s")
        starvedAt = pos
        try {
          nanos = changed.awaitNanos(nanos)
        } catch (e: InterruptedException) {
          Thread.currentThread().interrupt()
          throw InterruptedIOException("interrupted waiting for audio bytes")
        }
      }
      @Suppress("UNREACHABLE_CODE") error("unreachable")
    } finally {
      starvedAt = -1
    }
  }

  /** Whether every byte from [pos] to the end is held. */
  fun completeFrom(pos: Long): Boolean = lock.withLock {
    val total = header?.totalLength ?: return false
    held.contiguousEnd(pos) >= total
  }

  override fun close() = lock.withLock {
    if (closed) return
    closed = true
    changed.signalAll()
    runCatching { raf.close() }
    file.delete()
    Unit
  }
}
