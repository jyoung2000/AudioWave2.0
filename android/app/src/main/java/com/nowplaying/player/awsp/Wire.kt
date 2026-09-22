package com.nowplaying.player.awsp

import org.json.JSONObject
import java.io.ByteArrayOutputStream

/*
 * The AWSP v1 wire format (docs/AWSP.md §3), matching windows-companion/awsp-server/src/protocol.rs
 * byte for byte. Pure JVM: no android.* here, so it is unit-tested without a device.
 */

const val ALPN = "awsp/1"
const val PROTOCOL_VERSION = 1

/** Largest control or request frame (§3.1). */
const val MAX_FRAME = 256 * 1024

/** Read unit of an audio stream; the server writes in 64 KiB chunks (§3.2). */
const val CHUNK = 64 * 1024

/** Application error codes (§3.2 "Error codes"). */
object Codes {
  const val NORMAL = 0x0L
  const val UNKNOWN_DEVICE = 0x1L
  const val PROTOCOL = 0x2L
  const val NOT_FOUND = 0x10L
  const val RANGE = 0x11L
  const val TIER = 0x12L
  const val BAD_REQUEST = 0x13L
  const val FRAME_TOO_LARGE = 0x20L

  fun name(code: Long): String = when (code) {
    NORMAL -> "normal"
    UNKNOWN_DEVICE -> "unknown-device"
    PROTOCOL -> "protocol"
    NOT_FOUND -> "not-found"
    RANGE -> "range"
    TIER -> "tier"
    BAD_REQUEST -> "bad-request"
    FRAME_TOO_LARGE -> "frame-too-large"
    else -> "0x" + code.toString(16)
  }
}

/** A control-stream frame: `{id, type, seq, payload}`, plus `re` on replies. */
data class Frame(
  val type: String,
  val payload: JSONObject = JSONObject(),
  val id: Long = 0,
  val seq: Long = 0,
  val re: Long? = null,
) {
  fun toJson(): JSONObject = JSONObject().apply {
    put("id", id)
    put("type", type)
    put("seq", seq)
    put("payload", payload)
    if (re != null) put("re", re)
  }

  companion object {
    fun fromJson(o: JSONObject): Frame = Frame(
      type = o.getString("type"),
      payload = o.optJSONObject("payload") ?: JSONObject(),
      id = o.optLong("id", 0),
      seq = o.optLong("seq", 0),
      re = if (o.has("re") && !o.isNull("re")) o.getLong("re") else null,
    )
  }
}

class FrameTooLargeException(val size: Long) : Exception("frame too large ($size bytes)")

class FrameFormatException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** `u32` big-endian length, then the UTF-8 JSON body. */
fun encodeJsonFrame(json: JSONObject): ByteArray {
  val body = json.toString().toByteArray(Charsets.UTF_8)
  if (body.size > MAX_FRAME) throw FrameTooLargeException(body.size.toLong())
  val out = ByteArray(4 + body.size)
  writeU32(out, 0, body.size.toLong())
  System.arraycopy(body, 0, out, 4, body.size)
  return out
}

fun encodeFrame(frame: Frame): ByteArray = encodeJsonFrame(frame.toJson())

/**
 * Incremental decoder for length-prefixed frames. Feed it whatever the stream returned; it yields
 * every complete frame and keeps the remainder. A declared length over [MAX_FRAME] throws at once,
 * before any of that body is buffered (the server closes with `frame-too-large`, 0x20).
 */
class FrameDecoder {
  private val pending = ByteArrayOutputStream()

  fun feed(bytes: ByteArray, off: Int = 0, len: Int = bytes.size - off): List<JSONObject> {
    pending.write(bytes, off, len)
    val buf = pending.toByteArray()
    val out = ArrayList<JSONObject>()
    var pos = 0
    while (buf.size - pos >= 4) {
      val size = readU32(buf, pos)
      if (size > MAX_FRAME) throw FrameTooLargeException(size)
      if (buf.size - pos - 4 < size) break
      val text = String(buf, pos + 4, size.toInt(), Charsets.UTF_8)
      try {
        out += JSONObject(text)
      } catch (e: Exception) {
        throw FrameFormatException("frame is not a JSON object", e)
      }
      pos += 4 + size.toInt()
    }
    pending.reset()
    pending.write(buf, pos, buf.size - pos)
    return out
  }

  /** Bytes held that are not yet a whole frame; non-zero at end of stream means truncation. */
  val buffered: Int get() = pending.size()
}

enum class Tier(val wire: String, val byte: Int, val label: String) {
  LOSSLESS("lossless", 0, "Lossless"),
  HIGH("high", 1, "High (Opus 256 kb/s)"),
  SAVER("saver", 2, "Saver (Opus 128 kb/s)");

  companion object {
    fun fromByte(b: Int): Tier? = entries.firstOrNull { it.byte == b }
    fun fromWire(s: String?): Tier? = entries.firstOrNull { it.wire == s }
  }
}

enum class Codec(val byte: Int, val mime: String?) {
  OTHER(0, null),
  FLAC(1, "audio/flac"),
  ALAC(2, "audio/mp4"),
  MP3(3, "audio/mpeg"),
  OPUS(4, "audio/ogg"),
  WAV(5, "audio/wav"),
  AAC(6, "audio/mp4");

  companion object {
    fun fromByte(b: Int): Codec = entries.firstOrNull { it.byte == b } ?: OTHER
  }
}

/** The request frame of an audio stream (§3.2). `byteEnd` inclusive; null = to the end. */
data class AudioRequest(val trackId: String, val byteStart: Long, val byteEnd: Long?, val tier: Tier) {
  fun toJson(): JSONObject = JSONObject().apply {
    put("track_id", trackId)
    put("byte_start", byteStart)
    put("byte_end", byteEnd ?: JSONObject.NULL)
    put("tier", tier.wire)
  }

  fun encode(): ByteArray = encodeJsonFrame(toJson())
}

const val AUDIO_HEADER_LEN = 16

/**
 * The 16-byte header that starts every audio stream: `track_id_hash` (8), `total_len` (6, BE),
 * `codec` (1), `tier` (1). An unknown tier byte is kept raw in [tierByte] so it can be reported.
 */
data class AudioHeader(val trackIdHash: ByteArray, val totalLength: Long, val codec: Codec, val codecByte: Int, val tierByte: Int) {
  val tier: Tier? get() = Tier.fromByte(tierByte)

  fun matches(trackId: String): Boolean = trackIdHash.contentEquals(trackIdHash(trackId))

  override fun equals(other: Any?): Boolean =
    other is AudioHeader && trackIdHash.contentEquals(other.trackIdHash) && totalLength == other.totalLength &&
      codecByte == other.codecByte && tierByte == other.tierByte

  override fun hashCode(): Int = (trackIdHash.contentHashCode() * 31 + totalLength.hashCode()) * 31 + codecByte * 7 + tierByte

  companion object {
    fun parse(h: ByteArray): AudioHeader {
      require(h.size >= AUDIO_HEADER_LEN) { "audio header is $AUDIO_HEADER_LEN bytes, got ${h.size}" }
      var len = 0L
      for (i in 8 until 14) len = (len shl 8) or (h[i].toLong() and 0xff)
      val codecByte = h[14].toInt() and 0xff
      return AudioHeader(h.copyOfRange(0, 8), len, Codec.fromByte(codecByte), codecByte, h[15].toInt() and 0xff)
    }

    /** The server's `audio_header`, for tests and symmetry. */
    fun encode(trackId: String, totalLength: Long, codecByte: Int, tierByte: Int): ByteArray {
      require(totalLength in 0..0xFFFF_FFFF_FFFFL) { "total_len must fit 6 bytes" }
      val h = ByteArray(AUDIO_HEADER_LEN)
      System.arraycopy(trackIdHash(trackId), 0, h, 0, 8)
      for (i in 0 until 6) h[8 + i] = (totalLength ushr (8 * (5 - i))).toByte()
      h[14] = codecByte.toByte()
      h[15] = tierByte.toByte()
      return h
    }
  }
}

/** First 8 bytes of BLAKE3(track_id). */
fun trackIdHash(trackId: String): ByteArray = Blake3.hash(trackId.toByteArray(Charsets.UTF_8)).copyOfRange(0, 8)

/**
 * An HTTP-Range style request resolved against a file length, exactly as the server's
 * `resolve_range`: inclusive `(start, end)`, or null for a `range` (0x11) reset.
 */
fun resolveRange(totalLength: Long, start: Long, end: Long?): LongRange? {
  if (totalLength <= 0 || start >= totalLength || start < 0) return null
  val e = minOf(end ?: (totalLength - 1), totalLength - 1)
  if (e < start) return null
  return start..e
}

private fun writeU32(b: ByteArray, at: Int, v: Long) {
  b[at] = (v ushr 24).toByte()
  b[at + 1] = (v ushr 16).toByte()
  b[at + 2] = (v ushr 8).toByte()
  b[at + 3] = v.toByte()
}

private fun readU32(b: ByteArray, at: Int): Long =
  ((b[at].toLong() and 0xff) shl 24) or ((b[at + 1].toLong() and 0xff) shl 16) or
    ((b[at + 2].toLong() and 0xff) shl 8) or (b[at + 3].toLong() and 0xff)
