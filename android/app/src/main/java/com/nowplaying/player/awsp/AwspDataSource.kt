package com.nowplaying.player.awsp

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSourceException
import androidx.media3.datasource.DataSpec
import java.io.IOException

/**
 * ExoPlayer's view of an AWSP track: `awsp://track/<id>?tier=<tier>`.
 *
 * [open] points the track's [TrackBuffer] at the requested position — which is what turns a seek
 * (or the FLAC extractor's binary search) into a new range request when that byte is not held —
 * and waits for the audio header to learn the length. [read] blocks on the buffer until bytes
 * arrive. It runs on ExoPlayer's loader thread, which is allowed to block and which ExoPlayer
 * interrupts to cancel; the buffer turns that into an [java.io.InterruptedIOException].
 */
@OptIn(UnstableApi::class)
class AwspDataSource(private val streamer: Streamer) : BaseDataSource(/* isNetwork = */ true) {

  class Factory(private val streamer: Streamer) : DataSource.Factory {
    override fun createDataSource(): DataSource = AwspDataSource(streamer)
  }

  private var uri: Uri? = null
  private var buffer: TrackBuffer? = null
  private var position = 0L
  private var remaining = 0L
  private var opened = false

  override fun open(dataSpec: DataSpec): Long {
    uri = dataSpec.uri
    val (trackId, tier) = parse(dataSpec.uri)
    transferInitializing(dataSpec)
    val buf = streamer.buffer(trackId, tier)
    buffer = buf
    buf.readPosition = dataSpec.position
    val header = try {
      buf.awaitHeader(OPEN_TIMEOUT_MS)
    } catch (e: IOException) {
      throw DataSourceException(e, PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED)
    }
    if (dataSpec.position > header.totalLength) {
      throw DataSourceException(PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE)
    }
    position = dataSpec.position
    val toEnd = header.totalLength - position
    remaining = if (dataSpec.length != C.LENGTH_UNSET.toLong()) minOf(dataSpec.length, toEnd) else toEnd
    opened = true
    transferStarted(dataSpec)
    return remaining
  }

  override fun read(target: ByteArray, offset: Int, length: Int): Int {
    if (length == 0) return 0
    if (remaining == 0L) return C.RESULT_END_OF_INPUT
    val buf = buffer ?: throw IOException("not open")
    val n = try {
      buf.read(position, target, offset, minOf(length.toLong(), remaining).toInt(), READ_TIMEOUT_MS)
    } catch (e: TierUnavailableException) {
      throw e
    } catch (e: IOException) {
      if (e is java.io.InterruptedIOException) throw e
      throw DataSourceException(e, PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED)
    }
    if (n < 0) return C.RESULT_END_OF_INPUT
    position += n
    remaining -= n
    buf.readPosition = position
    bytesTransferred(n)
    return n
  }

  override fun getUri(): Uri? = uri

  override fun close() {
    buffer = null
    uri = null
    if (opened) {
      opened = false
      transferEnded()
    }
  }

  companion object {
    const val SCHEME = "awsp"
    private const val OPEN_TIMEOUT_MS = 45_000L
    private const val READ_TIMEOUT_MS = 60_000L

    fun uri(trackId: String, tier: Tier): Uri =
      Uri.Builder().scheme(SCHEME).authority("track").appendPath(trackId).appendQueryParameter("tier", tier.wire).build()

    fun parse(uri: Uri): Pair<String, Tier> {
      if (uri.scheme != SCHEME) throw IOException("not an awsp URI: $uri")
      val id = uri.lastPathSegment ?: throw IOException("no track id in $uri")
      return id to (Tier.fromWire(uri.getQueryParameter("tier")) ?: Tier.LOSSLESS)
    }
  }
}
