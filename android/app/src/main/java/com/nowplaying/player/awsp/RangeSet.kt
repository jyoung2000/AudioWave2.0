package com.nowplaying.player.awsp

/**
 * The byte ranges of one file the client holds, as sorted, disjoint, non-adjacent half-open
 * intervals `[start, end)`. It answers the question reconnection and seeking both ask: from a read
 * position, where does the contiguous run of held bytes end — which is where the next range request
 * starts (§3.1 "re-issues its audio fetch from the last contiguous byte it holds").
 *
 * Not thread-safe; [TrackBuffer] guards it.
 */
class RangeSet {
  private val starts = ArrayList<Long>()
  private val ends = ArrayList<Long>()

  val isEmpty: Boolean get() = starts.isEmpty()
  val size: Int get() = starts.size

  /** Total bytes held. */
  val heldBytes: Long get() = starts.indices.sumOf { ends[it] - starts[it] }

  fun add(start: Long, endExclusive: Long) {
    if (endExclusive <= start) return
    var s = start
    var e = endExclusive
    // First interval whose end reaches s (touching counts: [0,10) + [10,20) = [0,20)).
    var i = 0
    while (i < starts.size && ends[i] < s) i++
    var j = i
    while (j < starts.size && starts[j] <= e) {
      s = minOf(s, starts[j])
      e = maxOf(e, ends[j])
      j++
    }
    for (k in j - 1 downTo i) {
      starts.removeAt(k)
      ends.removeAt(k)
    }
    starts.add(i, s)
    ends.add(i, e)
  }

  fun contains(pos: Long): Boolean = indexOf(pos) >= 0

  /**
   * The end (exclusive) of the held run containing [pos]; [pos] itself if that byte is not held.
   * `contiguousEnd(p) - p` is how many bytes can be read from `p` without waiting.
   */
  fun contiguousEnd(pos: Long): Long {
    val i = indexOf(pos)
    return if (i >= 0) ends[i] else pos
  }

  fun intervals(): List<LongRange> = starts.indices.map { starts[it] until ends[it] }

  fun clear() {
    starts.clear()
    ends.clear()
  }

  private fun indexOf(pos: Long): Int {
    var lo = 0
    var hi = starts.size - 1
    while (lo <= hi) {
      val mid = (lo + hi) ushr 1
      when {
        pos < starts[mid] -> hi = mid - 1
        pos >= ends[mid] -> lo = mid + 1
        else -> return mid
      }
    }
    return -1
  }
}

/**
 * Where a (re)issued range request starts: the first byte at or after [readPosition] the client
 * does not hold, or null if everything from there to the end of the file is held (nothing to
 * fetch). This is the resume rule after a lost connection, a network change and a seek alike.
 */
fun resumeOffset(held: RangeSet, readPosition: Long, totalLength: Long?): Long? {
  val from = held.contiguousEnd(readPosition)
  if (totalLength != null && from >= totalLength) return null
  return from
}
