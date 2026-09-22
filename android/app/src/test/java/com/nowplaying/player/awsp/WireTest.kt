package com.nowplaying.player.awsp

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class WireTest {

  @Test
  fun frameRoundTripsThroughEncodeAndDecode() {
    val f = Frame("browse", JSONObject().put("query", "Nils Frahm").put("page", 2), id = 7, seq = 0)
    val decoded = FrameDecoder().feed(encodeFrame(f)).single()
    val back = Frame.fromJson(decoded)
    assertEquals("browse", back.type)
    assertEquals(7L, back.id)
    assertEquals(0L, back.seq)
    assertNull(back.re)
    assertEquals("Nils Frahm", back.payload.getString("query"))
    assertEquals(2, back.payload.getInt("page"))
  }

  @Test
  fun replyCarriesRe() {
    val f = Frame("pong", JSONObject(), id = 3, seq = 12, re = 41)
    val back = Frame.fromJson(FrameDecoder().feed(encodeFrame(f)).single())
    assertEquals(41L, back.re)
    assertEquals(12L, back.seq)
    // A frame without `re` must not serialise one (the server skips it when None).
    assertFalse(String(encodeFrame(Frame("ping")), 4, encodeFrame(Frame("ping")).size - 4, Charsets.UTF_8).contains("\"re\""))
  }

  @Test
  fun lengthPrefixIsBigEndianU32OfTheUtf8Body() {
    val bytes = encodeFrame(Frame("hello", JSONObject().put("device_name", "Pixel ü")))
    val len = ((bytes[0].toInt() and 0xff) shl 24) or ((bytes[1].toInt() and 0xff) shl 16) or
      ((bytes[2].toInt() and 0xff) shl 8) or (bytes[3].toInt() and 0xff)
    assertEquals(bytes.size - 4, len)
    assertTrue(String(bytes, 4, len, Charsets.UTF_8).contains("Pixel ü"))
  }

  @Test
  fun decoderHandlesSplitAndCoalescedFrames() {
    val a = encodeFrame(Frame("state", JSONObject().put("playing", true), id = 1, seq = 5))
    val b = encodeFrame(Frame("pong", JSONObject(), id = 2, re = 9))
    val all = a + b
    // Byte by byte: nothing until each frame completes.
    val d = FrameDecoder()
    val seen = ArrayList<JSONObject>()
    for (i in all.indices) seen += d.feed(all, i, 1)
    assertEquals(listOf("state", "pong"), seen.map { it.getString("type") })
    assertEquals(0, d.buffered)
    // Both in one read.
    assertEquals(2, FrameDecoder().feed(all).size)
    // A frame and a half: the half waits.
    val d2 = FrameDecoder()
    assertEquals(1, d2.feed(all, 0, a.size + 3).size)
    assertEquals(3, d2.buffered)
    assertEquals("pong", d2.feed(all, a.size + 3, b.size - 3).single().getString("type"))
  }

  @Test
  fun oversizeFramesAreRejectedOnBothSides() {
    // Reading: a declared length over 256 KiB is refused before the body arrives.
    val header = byteArrayOf(0x00, 0x04, 0x00, 0x01) // 262 145
    try {
      FrameDecoder().feed(header)
      fail("expected FrameTooLargeException")
    } catch (e: FrameTooLargeException) {
      assertEquals(MAX_FRAME + 1L, e.size)
    }
    // Exactly the limit is fine to declare.
    FrameDecoder().feed(byteArrayOf(0x00, 0x04, 0x00, 0x00))
    // Writing: refused too.
    try {
      encodeFrame(Frame("x", JSONObject().put("data", "a".repeat(MAX_FRAME))))
      fail("expected FrameTooLargeException")
    } catch (_: FrameTooLargeException) {
    }
  }

  @Test
  fun serverShapedFramesParse() {
    // What serde_json writes for a server reply (field order and all).
    val json = """{"id":4,"type":"welcome","seq":17,"payload":{"server_name":"Studio PC","resume_token":"${"ab".repeat(32)}","connection":"direct","resumed":false},"re":1}"""
    val body = json.toByteArray()
    val wire = byteArrayOf(0, 0, (body.size shr 8).toByte(), body.size.toByte()) + body
    val f = Frame.fromJson(FrameDecoder().feed(wire).single())
    assertEquals("welcome", f.type)
    assertEquals(1L, f.re)
    assertEquals(17L, f.seq)
    assertEquals(64, f.payload.getString("resume_token").length)

    val state = Frame.fromJson(
      JSONObject("""{"id":5,"type":"state","seq":18,"payload":{"playing":true,"track_id":"b","position_ms":1234,"queue":["a","b","c"],"volume":1.0}}"""),
    )
    val s = ServerState.from(state)
    assertEquals("b", s.trackId)
    assertEquals("c", s.nextTrackId())
    assertEquals(1234L, s.positionMs)
    assertTrue(s.playing)
    val idle = ServerState.from(Frame.fromJson(JSONObject("""{"type":"state","payload":{"playing":false,"track_id":null,"position_ms":0,"queue":[],"volume":1.0}}""")))
    assertNull(idle.trackId)
    assertNull(idle.nextTrackId())
  }

  @Test
  fun audioRequestMatchesTheServersShape() {
    val open = JSONObject(String(AudioRequest("t1", 0, null, Tier.LOSSLESS).encode().drop(4).toByteArray()))
    assertEquals("t1", open.getString("track_id"))
    assertEquals(0L, open.getLong("byte_start"))
    assertTrue(open.isNull("byte_end"))
    assertEquals("lossless", open.getString("tier"))
    val ranged = AudioRequest("t1", 100, 199, Tier.HIGH).toJson()
    assertEquals(199L, ranged.getLong("byte_end"))
    assertEquals("high", ranged.getString("tier"))
  }

  @Test
  fun audioHeaderParsesEveryField() {
    // The same fixture as the server's header_round_trip test.
    val h = AudioHeader.encode("t1", 0x0102_0304_0506L, codecByte = 1, tierByte = 1)
    assertEquals(AUDIO_HEADER_LEN, h.size)
    assertArrayEquals(byteArrayOf(0x01, 0x02, 0x03, 0x04, 0x05, 0x06), h.copyOfRange(8, 14))
    val p = AudioHeader.parse(h)
    assertEquals(0x0102_0304_0506L, p.totalLength)
    assertEquals(Codec.FLAC, p.codec)
    assertEquals(Tier.HIGH, p.tier)
    assertTrue(p.matches("t1"))
    assertFalse(p.matches("t2"))
    assertArrayEquals(trackIdHash("t1"), p.trackIdHash)
  }

  @Test
  fun audioHeaderCodecAndTierCodes() {
    val codecs = mapOf(0 to Codec.OTHER, 1 to Codec.FLAC, 2 to Codec.ALAC, 3 to Codec.MP3, 4 to Codec.OPUS, 5 to Codec.WAV, 6 to Codec.AAC)
    for ((byte, codec) in codecs) assertEquals(codec, AudioHeader.parse(AudioHeader.encode("x", 10, byte, 0)).codec)
    // An unknown codec byte is "other", but the raw byte is kept.
    val odd = AudioHeader.parse(AudioHeader.encode("x", 10, 0xEE, 0))
    assertEquals(Codec.OTHER, odd.codec)
    assertEquals(0xEE, odd.codecByte)
    val tiers = mapOf(0 to Tier.LOSSLESS, 1 to Tier.HIGH, 2 to Tier.SAVER)
    for ((byte, tier) in tiers) assertEquals(tier, AudioHeader.parse(AudioHeader.encode("x", 10, 1, byte)).tier)
    assertNull(AudioHeader.parse(AudioHeader.encode("x", 10, 1, 9)).tier)
  }

  @Test
  fun audioHeaderTotalLengthUsesAllSixBytes() {
    val max = 0xFFFF_FFFF_FFFFL
    assertEquals(max, AudioHeader.parse(AudioHeader.encode("x", max, 1, 0)).totalLength)
    assertEquals(0L, AudioHeader.parse(AudioHeader.encode("x", 0, 1, 0)).totalLength)
    // High bytes of the length must not bleed into the codec byte or be sign-extended.
    val p = AudioHeader.parse(AudioHeader.encode("x", 0x80_00_00_00_00_FFL, 3, 2))
    assertEquals(0x80_00_00_00_00_FFL, p.totalLength)
    assertEquals(Codec.MP3, p.codec)
    assertEquals(Tier.SAVER, p.tier)
  }

  @Test
  fun resolveRangeMatchesTheServer() {
    // The server's `ranges` test, case for case.
    assertEquals(0L..9L, resolveRange(10, 0, null))
    assertEquals(9L..9L, resolveRange(10, 9, 9))
    assertEquals(3L..9L, resolveRange(10, 3, 100))
    assertNull(resolveRange(10, 10, null))
    assertNull(resolveRange(10, 5, 4))
    assertNull(resolveRange(0, 0, null))
  }

  @Test
  fun codeNames() {
    assertEquals("unknown-device", Codes.name(Codes.UNKNOWN_DEVICE))
    assertEquals("not-found", Codes.name(0x10))
    assertEquals("range", Codes.name(0x11))
    assertEquals("tier", Codes.name(0x12))
    assertEquals("bad-request", Codes.name(0x13))
    assertEquals("frame-too-large", Codes.name(0x20))
    assertEquals("0x99", Codes.name(0x99))
    assertEquals(0, JSONArray().length())
  }
}
