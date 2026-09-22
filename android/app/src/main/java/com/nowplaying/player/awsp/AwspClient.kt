package com.nowplaying.player.awsp

import computer.iroh.Connection
import computer.iroh.Endpoint
import computer.iroh.EndpointTicket
import computer.iroh.IrohException
import computer.iroh.PathSnapshot
import computer.iroh.RecvStream
import computer.iroh.SendStream
import computer.iroh.BiStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/** An audio stream reset by the server with an AWSP code (§3.2: 0x10–0x13). */
class StreamResetException(val code: Long) : IOException("audio stream reset: ${Codes.name(code)}")

/** The server refused this device or this protocol; reconnecting would not help. */
class RejectedException(val code: String, message: String) : IOException(message)

/** One audio fetch: the header, then the bytes of the range. */
interface AudioStream {
  val header: AudioHeader
  val start: Long

  /** The next bytes (at most [max]), or null at the end of the range. */
  suspend fun read(max: Int): ByteArray?

  /** STOP_SENDING — a seek, or enough prefetched. */
  suspend fun cancel()
}

fun interface AudioOpener {
  suspend fun openAudio(request: AudioRequest): AudioStream
}

/** The server's shared player state (§3.1 `state`). */
data class ServerState(
  val seq: Long,
  val playing: Boolean,
  val trackId: String?,
  val positionMs: Long,
  val queue: List<String>,
  val volume: Double,
) {
  fun nextTrackId(): String? {
    val i = queue.indexOf(trackId ?: return null)
    return if (i >= 0 && i + 1 < queue.size) queue[i + 1] else null
  }

  companion object {
    fun from(f: Frame): ServerState {
      val p = f.payload
      val q = p.optJSONArray("queue") ?: JSONArray()
      return ServerState(
        seq = f.seq,
        playing = p.optBoolean("playing"),
        trackId = if (p.isNull("track_id")) null else p.optString("track_id"),
        positionMs = p.optLong("position_ms"),
        queue = (0 until q.length()).map { q.getString(it) },
        volume = p.optDouble("volume", 1.0),
      )
    }
  }
}

/**
 * The AWSP client for one paired PC (docs/AWSP.md §2–§3), on iroh's Kotlin bindings.
 *
 * One QUIC connection carries one control stream (opened at once, length-prefixed JSON) and one
 * bidi stream per audio fetch. A supervisor loop keeps the connection up: on loss it reconnects
 * with full-jitter backoff (250 ms → 30 s), says `hello` with the last `resume_token`, and the
 * audio side resumes from the last contiguous byte it holds. Three missed pongs (ping every 5 s) is
 * a lost connection. A refusal (`unknown-device`, a wrong pairing code, a protocol mismatch) stops
 * the loop: it would never succeed.
 */
class AwspClient(
  private val scope: CoroutineScope,
  private val endpoint: suspend () -> Endpoint,
  val ticket: String,
  private val deviceName: String,
  private val backoff: Backoff = Backoff(),
  /** INFO-level log sink; the app passes android.util.Log (tag AWSP), tests pass println. */
  private val log: (String) -> Unit = {},
) : AudioOpener {

  sealed interface Status {
    data object Idle : Status
    data class Connecting(val attempt: Int) : Status
    data class Connected(val serverName: String, val connection: String, val rttMs: Long, val resumed: Boolean) : Status
    data class Rejected(val code: String, val message: String) : Status
  }

  private class Live(val conn: Connection, val control: SendStream) {
    val writeLock = Mutex()
    val nextId = AtomicLong(0)
    val pending = ConcurrentHashMap<Long, CompletableDeferred<Frame>>()
    val missedPongs = AtomicInteger(0)
  }

  private val _status = MutableStateFlow<Status>(Status.Idle)
  val status: StateFlow<Status> = _status.asStateFlow()

  private val _state = MutableStateFlow<ServerState?>(null)
  val serverState: StateFlow<ServerState?> = _state.asStateFlow()

  private val _events = MutableSharedFlow<Frame>(extraBufferCapacity = 64)

  /** Unsolicited server frames other than `state`: `library_delta`, `error` without `re`. */
  val events: SharedFlow<Frame> = _events.asSharedFlow()

  /** `direct` or `relay` for the selected path, as the client sees it (§5). */
  private val _pathType = MutableStateFlow<String?>(null)
  val pathType: StateFlow<String?> = _pathType.asStateFlow()

  private val live = MutableStateFlow<Live?>(null)
  private val serverId: String by lazy { runCatching { EndpointTicket.fromString(ticket).endpointAddr().id().toString() }.getOrDefault("?") }

  @Volatile private var resumeToken: String? = null
  @Volatile private var pairCode: String? = null
  @Volatile private var pairResult: CompletableDeferred<String>? = null
  private var loop: Job? = null
  private val wake = Channel<Unit>(Channel.CONFLATED)

  val isRunning: Boolean get() = loop?.isActive == true

  /** Keep a connection up until [goIdle]. Idempotent. */
  @Synchronized
  fun start() {
    if (loop?.isActive == true) return
    loop = scope.launch { supervise() }
  }

  /**
   * Pair with the six-digit [code] (§2): connect, send `pair` as the first frame, and on `paired`
   * continue on the same control stream with `hello`. Returns the server's name.
   */
  suspend fun pair(code: String): String {
    val result = CompletableDeferred<String>()
    synchronized(this) {
      loop?.cancel()
      loop = null
      pairCode = code
      pairResult = result
    }
    start()
    return result.await()
  }

  /** Close the connection and stop reconnecting (the pause grace ran out). [start] resumes. */
  @Synchronized
  fun goIdle() {
    loop?.cancel()
    loop = null
    live.value?.conn?.let { runCatching { it.close(Codes.NORMAL, "idle".toByteArray()) } }
    live.value = null
    _status.value = Status.Idle
  }

  /** Drop the connection and reconnect at once, without the backoff (a network change). */
  fun reconnectNow(reason: String) {
    log("awsp reconnecting to $serverId: $reason")
    live.value?.conn?.let { runCatching { it.close(Codes.NORMAL, reason.toByteArray()) } }
    wake.trySend(Unit)
  }

  /**
   * After a network change: does the connection still answer? QUIC may have migrated to the new
   * path on its own; if a ping is not answered within [timeoutMs], reconnect silently.
   */
  suspend fun probe(timeoutMs: Long = 3_000) {
    if (live.value == null) {
      wake.trySend(Unit)
      return
    }
    val ok = withTimeoutOrNull(timeoutMs) { runCatching { request("ping", JSONObject()) }.isSuccess } ?: false
    if (!ok) reconnectNow("no pong after a network change")
  }

  /**
   * Send an intent (`play`, `pause`, `seek`, `set_queue`, …) in order; dropped with a log line if
   * not connected (the server is authoritative, and a stale intent replayed later would be wrong).
   */
  fun send(type: String, payload: JSONObject = JSONObject()) {
    outbox.trySend(Frame(type, payload))
  }

  private val outbox = Channel<Frame>(Channel.UNLIMITED).also { ch ->
    scope.launch {
      for (f in ch) {
        val l = live.value
        if (l == null) {
          log("awsp not connected; dropped ${f.type}")
          continue
        }
        runCatching { write(l, f) }.onFailure { log("awsp send ${f.type} failed: $it") }
      }
    }
  }

  /** Stop the outbox consumer; the client is finished with. */
  fun close() {
    goIdle()
    outbox.close()
  }

  /** Send once connected (waits up to [waitMs]); used when a play press wakes an idle client. */
  suspend fun sendWhenConnected(type: String, payload: JSONObject = JSONObject(), waitMs: Long = 30_000): Boolean {
    start()
    val l = withTimeoutOrNull(waitMs) { live.filterNotNull().first() } ?: return false
    return runCatching { write(l, Frame(type, payload)) }.isSuccess
  }

  /** A request with a reply (`browse`, `get_artwork`, `ping`); the reply or an `error` frame. */
  suspend fun request(type: String, payload: JSONObject, timeoutMs: Long = 15_000): Frame {
    val l = withTimeout(timeoutMs) { live.filterNotNull().first() }
    val reply = CompletableDeferred<Frame>()
    val id = write(l, Frame(type, payload), reply)
    return try {
      withTimeout(timeoutMs) { reply.await() }
    } finally {
      l.pending.remove(id)
    }
  }

  suspend fun browse(query: String?, page: Int, path: String? = null): JSONObject {
    val p = JSONObject().put("page", page)
    if (!query.isNullOrBlank()) p.put("query", query)
    if (path != null) p.put("path", path)
    val r = request("browse", p)
    if (r.type == "error") throw IOException(r.payload.optString("message", r.payload.optString("code")))
    return r.payload
  }

  suspend fun artwork(trackId: String, size: Int): ByteArray? {
    val r = request("get_artwork", JSONObject().put("track_id", trackId).put("size", size))
    if (r.type != "artwork" || r.payload.isNull("data")) return null
    return java.util.Base64.getMimeDecoder().decode(r.payload.getString("data"))
  }

  override suspend fun openAudio(request: AudioRequest): AudioStream {
    val l = live.value ?: withTimeout(30_000) { live.filterNotNull().first() }
    val bi: BiStream = try {
      l.conn.openBi()
    } catch (e: IrohException) {
      throw IOException("open audio stream: ${e.message()}")
    }
    val send = bi.send()
    val recv = bi.recv()
    try {
      send.writeAll(request.encode())
      send.finish()
      val h = AudioHeader.parse(recv.readExact(AUDIO_HEADER_LEN.toUInt()))
      return IrohAudioStream(h, request.byteStart, bi, recv)
    } catch (e: IrohException) {
      val code = withTimeoutOrNull(1_000) { runCatching { recv.receivedReset() }.getOrNull() }
      bi.close()
      if (code != null) throw StreamResetException(code.toLong())
      throw IOException("audio stream: ${e.message()}")
    }
  }

  private class IrohAudioStream(
    override val header: AudioHeader,
    override val start: Long,
    private val bi: BiStream,
    private val recv: RecvStream,
  ) : AudioStream {
    override suspend fun read(max: Int): ByteArray? = try {
      val b = recv.read(max.toUInt())
      if (b.isEmpty()) {
        bi.close()
        null
      } else {
        b
      }
    } catch (e: IrohException) {
      bi.close()
      throw IOException("audio stream: ${e.message()}")
    }

    override suspend fun cancel() {
      runCatching { recv.stop(Codes.NORMAL.toULong()) }
      bi.close()
    }
  }

  // ---- the connection ------------------------------------------------------------------------

  private suspend fun supervise() {
    var attempt = 0
    while (true) {
      _status.value = Status.Connecting(attempt)
      try {
        val ep = endpoint()
        val addr = EndpointTicket.fromString(ticket).endpointAddr()
        val conn = withTimeout(CONNECT_TIMEOUT_MS) { ep.connect(addr, ALPN.toByteArray()) }
        session(conn) { attempt = 0 }
      } catch (e: CancellationException) {
        throw e
      } catch (e: RejectedException) {
        log("awsp refused by $serverId: ${e.code} ${e.message}")
        _status.value = Status.Rejected(e.code, e.message ?: e.code)
        pairResult?.completeExceptionally(e)
        pairResult = null
        live.value = null
        return
      } catch (e: Exception) {
        log("awsp connection to $serverId lost: ${e.message ?: e}")
      }
      live.value = null
      _pathType.value = null
      val wait = backoff.delayMs(attempt++)
      _status.value = Status.Connecting(attempt)
      // A network change (or a play press) cuts the wait short.
      withTimeoutOrNull(wait) { wake.receive() }
    }
  }

  /** Run one connection until it ends; always ends by throwing (lost, closed or refused). */
  private suspend fun session(conn: Connection, onGreeted: () -> Unit): Nothing = coroutineScope {
    val bi = conn.openBi()
    val l = Live(conn, bi.send())
    val reader = async { readControl(l, bi.recv()) }
    try {
      val code = pairCode
      if (code != null) {
        val r = call(l, "pair", JSONObject().put("code", code).put("device_name", deviceName).put("client_kind", "android"))
        if (r.type != "paired") throw RejectedException(r.payload.optString("code", "pair-rejected"), r.payload.optString("message", "pairing failed"))
        pairCode = null
        pairResult?.complete(r.payload.optString("server_name", "PC"))
        pairResult = null
      }
      val hello = JSONObject()
        .put("device_name", deviceName)
        .put("client_kind", "android")
        .put("protocol_version", PROTOCOL_VERSION)
      resumeToken?.let { hello.put("resume_token", it) }
      val w = call(l, "hello", hello)
      if (w.type != "welcome") throw RejectedException(w.payload.optString("code", "refused"), w.payload.optString("message", "hello refused"))
      resumeToken = w.payload.optString("resume_token").ifEmpty { null }
      onGreeted()
      reportPath(conn.paths())
      val type = _pathType.value ?: w.payload.optString("connection", "relay")
      _status.value = Status.Connected(
        serverName = w.payload.optString("server_name", "PC"),
        connection = type,
        rttMs = conn.paths().firstOrNull { it.isSelected }?.rttMs?.toLong() ?: 0,
        resumed = w.payload.optBoolean("resumed"),
      )
      live.value = l
      // Path changes (§5). Polled, not `conn.watchPaths(callback)`: in iroh-ffi 1.1.0 that call spawns
      // onto Tokio from the calling thread and panics ("no reactor running") when that thread is a
      // JVM one, which every Kotlin caller's is. `paths()` is a plain snapshot and safe to call.
      launch {
        while (true) {
          delay(PATH_POLL_MS)
          reportPath(conn.paths())
        }
      }
      val pinger = async {
        while (true) {
          delay(PING_INTERVAL_MS)
          if (l.missedPongs.incrementAndGet() > MAX_MISSED_PONGS) throw IOException("three pongs missed")
          write(l, Frame("ping"))
        }
      }
      val closed = async { conn.closed() }
      // Whichever ends first ends the session: the control stream, the pinger, or the connection.
      val why = select {
        reader.onAwait { "control stream ended" }
        pinger.onAwait { "pinger ended" }
        closed.onAwait { it }
      }
      throw closeError(conn, why)
    } catch (e: Exception) {
      if (e is CancellationException) throw e
      val reason = conn.closeReason()
      throw if (reason != null && e !is RejectedException) closeError(conn, reason) else e
    } finally {
      live.value = null
      runCatching { conn.close(Codes.NORMAL, "bye".toByteArray()) }
      l.pending.values.forEach { it.completeExceptionally(IOException("connection closed")) }
      coroutineContext[Job]?.cancelChildren()
    }
  }

  /** Close reasons that mean "stop trying" become [RejectedException] (§1, §2: code 0x1, 0x2). */
  private fun closeError(conn: Connection, why: String): Exception {
    val reason = conn.closeReason() ?: why
    return when {
      "unknown-device" in reason || "revoked" in reason -> RejectedException("unknown-device", "this phone is not paired with the PC (or was revoked)")
      "protocol-version" in reason -> RejectedException("protocol-version", "the PC speaks a different AWSP version")
      else -> IOException(reason)
    }
  }

  private suspend fun readControl(l: Live, recv: RecvStream) {
    val decoder = FrameDecoder()
    while (true) {
      val bytes = try {
        recv.read(CHUNK.toUInt())
      } catch (e: IrohException) {
        throw IOException("control stream: ${e.message()}")
      }
      if (bytes.isEmpty()) {
        if (decoder.buffered > 0) throw IOException("control stream ended inside a frame")
        return
      }
      for (json in decoder.feed(bytes)) dispatch(l, Frame.fromJson(json))
    }
  }

  private fun dispatch(l: Live, f: Frame) {
    if (f.type == "pong") l.missedPongs.set(0)
    val re = f.re
    if (re != null) {
      val waiter = l.pending.remove(re)
      if (waiter != null) {
        waiter.complete(f)
        return
      }
    }
    when (f.type) {
      "state" -> _state.value = ServerState.from(f)
      "pong" -> Unit
      "welcome" -> resumeToken = f.payload.optString("resume_token").ifEmpty { resumeToken }
      else -> _events.tryEmit(f)
    }
  }

  private suspend fun call(l: Live, type: String, payload: JSONObject): Frame {
    val reply = CompletableDeferred<Frame>()
    val id = write(l, Frame(type, payload), reply)
    return try {
      withTimeout(REPLY_TIMEOUT_MS) { reply.await() }
    } finally {
      l.pending.remove(id)
    }
  }

  /** Assign the next message id and write the frame; register [reply] under that id first. */
  private suspend fun write(l: Live, f: Frame, reply: CompletableDeferred<Frame>? = null): Long = l.writeLock.withLock {
    val id = l.nextId.incrementAndGet()
    if (reply != null) l.pending[id] = reply
    try {
      l.control.writeAll(encodeFrame(f.copy(id = id, seq = 0)))
    } catch (e: IrohException) {
      l.pending.remove(id)
      throw IOException("control write: ${e.message()}")
    }
    id
  }

  private fun reportPath(paths: List<PathSnapshot>) {
    val p = paths.firstOrNull { it.isSelected } ?: paths.firstOrNull() ?: return
    val type = if (p.isRelay) "relay" else "direct"
    val rtt = p.rttMs.toLong()
    if (_pathType.value != type) {
      _pathType.value = type
      // §5: logged at INFO on establishment and on every path-type change.
      log("awsp connection $serverId type=$type rtt=$rtt")
      val s = _status.value
      if (s is Status.Connected) _status.value = s.copy(connection = type, rttMs = rtt)
    }
  }

  companion object {
    const val TAG = "AWSP"
    const val PING_INTERVAL_MS = 5_000L
    const val MAX_MISSED_PONGS = 3
    const val REPLY_TIMEOUT_MS = 15_000L
    const val CONNECT_TIMEOUT_MS = 30_000L
    const val PATH_POLL_MS = 2_000L
  }
}
