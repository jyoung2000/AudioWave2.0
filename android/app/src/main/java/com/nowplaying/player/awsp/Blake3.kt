package com.nowplaying.player.awsp

/**
 * BLAKE3 (unkeyed hash, 32-byte output), a direct port of the specification's reference
 * implementation. AWSP needs it for one thing: the audio header's `track_id_hash` is the first 8
 * bytes of BLAKE3(track_id) (§3.2), which lets the client check a stream is the track it asked for.
 * Checked against the `blake3` crate the server uses in Blake3Test.
 */
object Blake3 {
  private const val BLOCK_LEN = 64
  private const val CHUNK_LEN = 1024
  private const val CHUNK_START = 1
  private const val CHUNK_END = 2
  private const val PARENT = 4
  private const val ROOT = 8

  private val IV = intArrayOf(
    0x6A09E667, 0xBB67AE85.toInt(), 0x3C6EF372, 0xA54FF53A.toInt(),
    0x510E527F, 0x9B05688C.toInt(), 0x1F83D9AB, 0x5BE0CD19,
  )
  private val PERM = intArrayOf(2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8)

  private fun g(s: IntArray, a: Int, b: Int, c: Int, d: Int, x: Int, y: Int) {
    s[a] = s[a] + s[b] + x
    s[d] = Integer.rotateRight(s[d] xor s[a], 16)
    s[c] = s[c] + s[d]
    s[b] = Integer.rotateRight(s[b] xor s[c], 12)
    s[a] = s[a] + s[b] + y
    s[d] = Integer.rotateRight(s[d] xor s[a], 8)
    s[c] = s[c] + s[d]
    s[b] = Integer.rotateRight(s[b] xor s[c], 7)
  }

  private fun round(s: IntArray, m: IntArray) {
    g(s, 0, 4, 8, 12, m[0], m[1])
    g(s, 1, 5, 9, 13, m[2], m[3])
    g(s, 2, 6, 10, 14, m[4], m[5])
    g(s, 3, 7, 11, 15, m[6], m[7])
    g(s, 0, 5, 10, 15, m[8], m[9])
    g(s, 1, 6, 11, 12, m[10], m[11])
    g(s, 2, 7, 8, 13, m[12], m[13])
    g(s, 3, 4, 9, 14, m[14], m[15])
  }

  private fun compress(cv: IntArray, block: IntArray, counter: Long, blockLen: Int, flags: Int): IntArray {
    val s = IntArray(16)
    System.arraycopy(cv, 0, s, 0, 8)
    System.arraycopy(IV, 0, s, 8, 4)
    s[12] = counter.toInt()
    s[13] = (counter ushr 32).toInt()
    s[14] = blockLen
    s[15] = flags
    var m = block.copyOf()
    for (r in 0 until 7) {
      round(s, m)
      if (r < 6) m = IntArray(16) { m[PERM[it]] }
    }
    for (i in 0 until 8) {
      s[i] = s[i] xor s[i + 8]
      s[i + 8] = s[i + 8] xor cv[i]
    }
    return s
  }

  private fun words(bytes: ByteArray, off: Int, len: Int): IntArray {
    val block = ByteArray(BLOCK_LEN)
    System.arraycopy(bytes, off, block, 0, len)
    return IntArray(16) { i ->
      (block[4 * i].toInt() and 0xff) or ((block[4 * i + 1].toInt() and 0xff) shl 8) or
        ((block[4 * i + 2].toInt() and 0xff) shl 16) or ((block[4 * i + 3].toInt() and 0xff) shl 24)
    }
  }

  /** A deferred compression: what the reference calls `Output`. */
  private class Output(val cv: IntArray, val block: IntArray, val counter: Long, val blockLen: Int, val flags: Int) {
    fun chainingValue(): IntArray = compress(cv, block, counter, blockLen, flags).copyOf(8)
    fun root(): IntArray = compress(cv, block, 0, blockLen, flags or ROOT)
  }

  /** The output of one chunk (up to 1024 bytes of `input` from `off`). */
  private fun chunkOutput(input: ByteArray, off: Int, len: Int, counter: Long): Output {
    var cv = IV.copyOf()
    var pos = 0
    var blocks = 0
    // Every block but the last is compressed now; the last is left for the caller (it may be root).
    while (len - pos > BLOCK_LEN) {
      val flags = if (blocks == 0) CHUNK_START else 0
      cv = compress(cv, words(input, off + pos, BLOCK_LEN), counter, BLOCK_LEN, flags).copyOf(8)
      pos += BLOCK_LEN
      blocks++
    }
    val lastLen = len - pos
    val flags = (if (blocks == 0) CHUNK_START else 0) or CHUNK_END
    return Output(cv, words(input, off + pos, lastLen), counter, lastLen, flags)
  }

  private fun parentOutput(left: IntArray, right: IntArray): Output {
    val block = IntArray(16)
    System.arraycopy(left, 0, block, 0, 8)
    System.arraycopy(right, 0, block, 8, 8)
    return Output(IV, block, 0, BLOCK_LEN, PARENT)
  }

  fun hash(input: ByteArray): ByteArray {
    val stack = ArrayList<IntArray>()
    var chunk = 0L
    var off = 0
    // All full chunks except the last are merged into the stack as the reference hasher does.
    while (input.size - off > CHUNK_LEN) {
      var cv = chunkOutput(input, off, CHUNK_LEN, chunk).chainingValue()
      chunk++
      var total = chunk
      while (total and 1L == 0L) {
        cv = parentOutput(stack.removeAt(stack.size - 1), cv).chainingValue()
        total = total shr 1
      }
      stack += cv
      off += CHUNK_LEN
    }
    var out = chunkOutput(input, off, input.size - off, chunk)
    for (i in stack.indices.reversed()) out = parentOutput(stack[i], out.chainingValue())
    val words = out.root()
    return ByteArray(32) { i -> (words[i / 4] ushr (8 * (i % 4))).toByte() }
  }
}
