package com.nowplaying.player.awsp

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Vectors produced with the `blake3` crate 1.8.7 — the one the server links — so the client's
 * `track_id_hash` check agrees with what the server writes into the audio header.
 */
class Blake3Test {
  private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

  private val big = ByteArray(5000) { (it % 251).toByte() }

  @Test fun empty() = assertEquals("af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262", hex(Blake3.hash(ByteArray(0))))

  @Test fun shortId() = assertEquals("dcbe3f9d9712a1f796e36f8f9f8fd116d3bfadd4a2f193366c3363788ba0b10c", hex(Blake3.hash("t1".toByteArray())))

  @Test fun uuidId() = assertEquals(
    "0f0ce84b5da1689d60f3295a2a7da2fc94314b762b08406a7d00469727409651",
    hex(Blake3.hash("3f2b8c1e-7a4d-4e21-9b6f-0c8d2e5a1f34".toByteArray())),
  )

  @Test fun exactlyOneChunk() = assertEquals("42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7", hex(Blake3.hash(big.copyOf(1024))))

  @Test fun oneChunkAndOneByte() = assertEquals("d00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444", hex(Blake3.hash(big.copyOf(1025))))

  @Test fun severalChunks() = assertEquals("ee78d92070de3df1c57c37002abf0a6b1a6589acdeef4d8ffac7cf3d9e8f2836", hex(Blake3.hash(big)))

  @Test fun trackIdHashIsTheFirstEightBytes() = assertEquals("dcbe3f9d9712a1f7", hex(trackIdHash("t1")))
}
