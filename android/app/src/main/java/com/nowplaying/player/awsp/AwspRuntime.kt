package com.nowplaying.player.awsp

import android.content.Context
import android.os.Build
import android.util.Log
import computer.iroh.Endpoint
import computer.iroh.EndpointBuilder
import computer.iroh.EndpointTicket
import computer.iroh.IrohAndroid
import computer.iroh.IrohException
import computer.iroh.SecretKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap

/** What the library index says about a track (the `Track` JSON of `library_page`). */
data class TrackInfo(
  val id: String,
  val title: String,
  val artist: String,
  val album: String?,
  val durationMs: Long?,
  val codec: String?,
  val bitrateKbps: Double?,
) {
  companion object {
    fun from(o: JSONObject): TrackInfo {
      val format = o.optJSONObject("format")
      return TrackInfo(
        id = o.getString("id"),
        title = o.optString("title", "Untitled"),
        artist = o.optString("artistName", ""),
        album = if (o.isNull("albumName")) null else o.optString("albumName"),
        durationMs = if (o.isNull("durationMs") || !o.has("durationMs")) null else o.optLong("durationMs"),
        codec = format?.optString("codec")?.ifEmpty { null },
        bitrateKbps = format?.optDouble("bitrateKbps")?.takeIf { !it.isNaN() && it > 0 },
      )
    }
  }
}

/**
 * Everything AWSP on this phone, owned by [AwspPlaybackService] for its lifetime: the identity, the
 * one iroh endpoint, the client for the paired PC and the [Streamer]. The activity reaches it
 * through [current] while the service is alive (it binds the service to make sure it is).
 */
class AwspRuntime(context: Context, val scope: CoroutineScope) {
  private val app = context.applicationContext
  private val identityStore = IdentityStore(app)
  private val endpointLock = Mutex()
  private var endpoint: Endpoint? = null
  private lateinit var identity: IdentityStore.Identity

  private val _client = MutableStateFlow<AwspClient?>(null)
  val client: StateFlow<AwspClient?> = _client.asStateFlow()

  private val _serverName = MutableStateFlow<String?>(null)
  val serverName: StateFlow<String?> = _serverName.asStateFlow()

  /** A notice for the UI: the ABR tier change, a codec fallback. */
  val notice = MutableStateFlow<String?>(null)

  /** Tracks seen in `library_page`/`library_delta`, for titles, durations and bitrates. */
  val tracks = ConcurrentHashMap<String, TrackInfo>()

  val deviceName: String = listOf(Build.MANUFACTURER, Build.MODEL).filter { it.isNotBlank() }.joinToString(" ").ifEmpty { "Android" }

  val streamer = Streamer(
    scope = scope,
    dir = File(app.cacheDir, "awsp"),
    opener = { req -> (_client.value ?: throw IOException("not paired")).openAudio(req) },
    log = { Log.i(AwspClient.TAG, it) },
  )

  fun start() {
    initNative(app)
    identity = identityStore.loadOrCreate { SecretKey.generate().toBytes() }
    identity.paired?.let { p ->
      _serverName.value = p.serverName
      _client.value = newClient(p.ticket).also { it.start() }
    }
    streamer.start()
  }

  /**
   * Pair with the PC named by [ticket] using its six-digit [code] (§2). On success the ticket is
   * stored with the identity (encrypted) and the new client stays connected.
   */
  suspend fun pair(ticket: String, code: String): String {
    val t = ticket.trim()
    try {
      EndpointTicket.fromString(t).close()
    } catch (e: IrohException) {
      throw IOException("That is not a valid ticket: ${e.message()}")
    }
    if (!Regex("^\\d{6}$").matches(code.trim())) throw IOException("The pairing code is six digits")
    _client.value?.close()
    val c = newClient(t)
    _client.value = c
    val name = try {
      c.pair(code.trim())
    } catch (e: Exception) {
      c.close()
      _client.value = null
      // Back to the PC paired before, if any.
      identity.paired?.let { p -> _client.value = newClient(p.ticket).also { it.start() } }
      throw e
    }
    identity = IdentityStore.Identity(identity.secretKey, IdentityStore.Paired(t, name))
    identityStore.save(identity)
    _serverName.value = name
    return name
  }

  /** Forget the paired PC (the PC keeps its allowlist entry until revoked there). */
  fun forget() {
    _client.value?.close()
    _client.value = null
    _serverName.value = null
    identity = IdentityStore.Identity(identity.secretKey, null)
    identityStore.save(identity)
  }

  fun remember(items: List<TrackInfo>) = items.forEach { tracks[it.id] = it }

  fun close() {
    _client.value?.close()
    streamer.close()
    scope.launch {
      withContext(NonCancellable) { endpointLock.withLock { runCatching { endpoint?.shutdown() } } }
    }
  }

  private fun newClient(ticket: String) =
    AwspClient(scope, ::boundEndpoint, ticket, deviceName, log = { Log.i(AwspClient.TAG, it) })

  /** The one iroh endpoint, bound on first use with this phone's secret key and n0's relays. */
  private suspend fun boundEndpoint(): Endpoint = endpointLock.withLock {
    endpoint?.takeIf { !it.isClosed() }?.let { return it }
    initNative(app)
    val key = identity.secretKey.copyOf()
    val builder = EndpointBuilder()
    try {
      builder.applyN0()
      builder.secretKey(key)
      builder.bind().also {
        endpoint = it
        Log.i(AwspClient.TAG, "awsp endpoint ${it.id()} bound")
      }
    } finally {
      key.fill(0)
      builder.close()
    }
  }

  companion object {
    val current = MutableStateFlow<AwspRuntime?>(null)

    @Volatile private var nativeReady = false

    /** iroh-android's JNI init: hands the Android context to the Rust side (DNS, network state). */
    @Synchronized
    fun initNative(context: Context) {
      if (nativeReady) return
      IrohAndroid.installAndroidContext(context.applicationContext)
      nativeReady = true
    }
  }
}
