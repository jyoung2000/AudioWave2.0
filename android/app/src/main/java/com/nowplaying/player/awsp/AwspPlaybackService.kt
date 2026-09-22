package com.nowplaying.player.awsp

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import androidx.annotation.OptIn
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.nowplaying.player.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * The AWSP player (docs/AWSP.md §3–§5), a Media3 `MediaSessionService` running as a
 * `mediaPlayback` foreground service while it plays. It owns the [AwspRuntime] (endpoint, client,
 * buffers) and an ExoPlayer whose only data source is [AwspDataSource].
 *
 * The PC is authoritative for queue and state (§3.1): this renders its `state` — the current track,
 * playing or not — and turns local transport presses (notification, lock screen, headset, the
 * activity) into intents. The audio itself is fetched and played here.
 *
 * Power: a partial wakelock is held while playing and through a 10-minute grace after a pause;
 * when the grace runs out the wakelock is released and the connection is let go idle, and the next
 * play press (media button, notification, UI) reconnects. Doze is detected and answered with a
 * one-time prompt to exempt the app from battery optimisation. A network change probes the
 * connection and, if it did not migrate, reconnects silently and resumes the range from the last
 * contiguous byte.
 */
@OptIn(UnstableApi::class)
class AwspPlaybackService : MediaSessionService() {

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private val main = Handler(Looper.getMainLooper())

  private lateinit var runtime: AwspRuntime
  private lateinit var exo: ExoPlayer
  private lateinit var session: MediaSession

  private var wakeLock: PowerManager.WakeLock? = null
  private val graceExpired = Runnable {
    Log.i(AwspClient.TAG, "awsp paused for ${GRACE_MS / 60_000} min: releasing the wakelock, connection idle")
    releaseWakeLock()
    runtime.client.value?.goIdle()
  }

  // What the local player holds, which may briefly differ from the PC's state.
  private var currentTrackId: String? = null
  private var currentTier: Tier = Tier.LOSSLESS
  private var nextTrackId: String? = null
  private var prefetched: String? = null

  // Intent bookkeeping: a `state` older than our last intent must not undo it.
  private var lastSeq = 0L
  private var intentSeq = -1L
  private var intentAtMs = 0L

  private var wasReady = false
  private var rebuffering = false
  private var dropouts = 0
  private var connectionLabel: String? = null
  private var errorRetry: Job? = null

  override fun onCreate() {
    super.onCreate()
    runtime = AwspRuntime(this, scope)
    runtime.start()

    val loadControl = DefaultLoadControl.Builder()
      // ExoPlayer's own buffer stays under the 20 s the Streamer keeps ahead, so the network fetch
      // (not ExoPlayer) is what the §4 targets govern.
      .setBufferDurationsMs(10_000, 15_000, 1_000, 2_000)
      .build()
    exo = ExoPlayer.Builder(this)
      .setLoadControl(loadControl)
      .setMediaSourceFactory(DefaultMediaSourceFactory(AwspDataSource.Factory(runtime.streamer)))
      .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
      .setHandleAudioBecomingNoisy(true)
      .build()
    exo.addListener(playerListener)

    val open = PendingIntent.getActivity(
      this, 0, Intent(this, StreamActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    session = MediaSession.Builder(this, IntentPlayer(exo)).setSessionActivity(open).build()
    setMediaNotificationProvider(ConnectionNotificationProvider(this) { connectionLabel })

    watchClient()
    watchAbr()
    startTicker()
    registerNetworkCallback()
    registerDozeReceiver()
    AwspRuntime.current.value = runtime
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession = session

  override fun onTaskRemoved(rootIntent: Intent?) {
    if (!exo.playWhenReady || exo.mediaItemCount == 0) stopSelf()
  }

  override fun onDestroy() {
    AwspRuntime.current.value = null
    main.removeCallbacksAndMessages(null)
    runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback) }
    runCatching { unregisterReceiver(dozeReceiver) }
    releaseWakeLock()
    session.release()
    exo.release()
    runtime.close()
    scope.cancel()
    super.onDestroy()
  }

  // ---- the PC's state → the local player -----------------------------------------------------

  @kotlin.OptIn(ExperimentalCoroutinesApi::class)
  private fun watchClient() {
    scope.launch {
      runtime.client.flatMapLatest { it?.serverState ?: flowOf(null) }.filterNotNull().collect { s ->
        withContext(Dispatchers.Main) { applyServerState(s) }
      }
    }
    scope.launch {
      runtime.client.flatMapLatest { it?.status ?: flowOf(null) }
        .map { labelFor(it) }
        .distinctUntilChanged()
        .collect { label ->
          withContext(Dispatchers.Main) {
            connectionLabel = label
            triggerNotificationUpdate()
          }
        }
    }
    scope.launch {
      runtime.client.flatMapLatest { it?.events ?: flowOf() }.collect { f ->
        when (f.type) {
          "library_delta" -> {
            val items = f.payload.optJSONArray("items")
            if (items != null) runtime.remember((0 until items.length()).map { TrackInfo.from(items.getJSONObject(it)) })
          }
          "error" -> Log.w(AwspClient.TAG, "awsp error from the PC: ${f.payload}")
        }
      }
    }
  }

  private fun applyServerState(s: ServerState) {
    lastSeq = s.seq
    nextTrackId = s.nextTrackId()
    val trackId = s.trackId
    if (trackId == null) {
      if (currentTrackId != null) {
        exo.stop()
        exo.clearMediaItems()
        currentTrackId = null
      }
      return
    }
    if (trackId != currentTrackId) {
      load(trackId, s.positionMs, s.playing, runtime.streamer.abr.tier)
      return
    }
    val fresh = s.seq > intentSeq || System.currentTimeMillis() - intentAtMs > INTENT_GRACE_MS
    if (fresh && s.playing != exo.playWhenReady) exo.playWhenReady = s.playing
  }

  private fun load(trackId: String, positionMs: Long, play: Boolean, tier: Tier) {
    val info = runtime.tracks[trackId]
    currentTrackId = trackId
    currentTier = tier
    prefetched = null
    wasReady = false
    runtime.streamer.positionMs = positionMs
    runtime.streamer.sourceBytesPerSecHint = info?.bitrateKbps?.times(125.0) ?: 0.0
    runtime.streamer.setCurrent(trackId, tier, info?.durationMs, keepNext = nextTrackId)
    exo.setMediaItem(mediaItem(trackId, tier, info, null), positionMs)
    exo.prepare()
    exo.playWhenReady = play
    fetchArtwork(trackId, tier, info)
  }

  private fun mediaItem(trackId: String, tier: Tier, info: TrackInfo?, art: ByteArray?): MediaItem {
    val meta = MediaMetadata.Builder()
      .setTitle(info?.title ?: "Track from ${runtime.serverName.value ?: "your PC"}")
      .setArtist(info?.artist)
      .setAlbumTitle(info?.album)
      .setDurationMs(info?.durationMs)
    if (art != null) meta.setArtworkData(art, MediaMetadata.PICTURE_TYPE_FRONT_COVER)
    return MediaItem.Builder()
      .setMediaId("$trackId@${tier.wire}")
      .setUri(AwspDataSource.uri(trackId, tier))
      .setMediaMetadata(meta.build())
      .build()
  }

  private fun fetchArtwork(trackId: String, tier: Tier, info: TrackInfo?) {
    scope.launch {
      val art = runCatching { runtime.client.value?.artwork(trackId, 512) }.getOrNull() ?: return@launch
      withContext(Dispatchers.Main) {
        // A metadata-only replacement: same URI, so ExoPlayer keeps playing without re-preparing.
        if (currentTrackId == trackId && currentTier == tier && exo.mediaItemCount > 0) {
          exo.replaceMediaItem(0, mediaItem(trackId, tier, info, art))
        }
      }
    }
  }

  // ---- local presses → intents ---------------------------------------------------------------

  /** Transport controls from the session (notification, lock screen, headset, the activity). */
  private inner class IntentPlayer(player: ExoPlayer) : ForwardingPlayer(player) {
    private val extra = intArrayOf(
      Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
      Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
    )

    override fun getAvailableCommands(): Player.Commands = super.getAvailableCommands().buildUpon().addAll(*extra).build()

    override fun isCommandAvailable(command: Int): Boolean = command in extra || super.isCommandAvailable(command)

    override fun play() {
      intentPlay()
      super.play()
    }

    override fun pause() {
      intent("pause")
      super.pause()
    }

    override fun setPlayWhenReady(playWhenReady: Boolean) {
      if (playWhenReady) intentPlay() else intent("pause")
      super.setPlayWhenReady(playWhenReady)
    }

    override fun seekTo(positionMs: Long) {
      intent("seek", JSONObject().put("ms", positionMs.coerceAtLeast(0)))
      super.seekTo(positionMs)
    }

    override fun seekTo(mediaItemIndex: Int, positionMs: Long) {
      intent("seek", JSONObject().put("ms", positionMs.coerceAtLeast(0)))
      super.seekTo(mediaItemIndex, positionMs)
    }

    override fun seekToNext() = intent("next")
    override fun seekToNextMediaItem() = intent("next")
    override fun seekToPrevious() = intent("prev")
    override fun seekToPreviousMediaItem() = intent("prev")
  }

  private fun intent(type: String, payload: JSONObject = JSONObject()) {
    intentSeq = lastSeq
    intentAtMs = System.currentTimeMillis()
    runtime.client.value?.send(type, payload)
  }

  /** A play press also wakes an idle connection (after the pause grace) before sending `play`. */
  private fun intentPlay() {
    intentSeq = lastSeq
    intentAtMs = System.currentTimeMillis()
    main.removeCallbacks(graceExpired)
    acquireWakeLock()
    val c = runtime.client.value ?: return
    if (c.isRunning && c.status.value is AwspClient.Status.Connected) {
      c.send("play")
    } else {
      scope.launch { c.sendWhenConnected("play") }
    }
  }

  // ---- player events ---------------------------------------------------------------------------

  private val playerListener = object : Player.Listener {
    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
      main.removeCallbacks(graceExpired)
      if (playWhenReady) acquireWakeLock() else main.postDelayed(graceExpired, GRACE_MS)
    }

    override fun onPlaybackStateChanged(state: Int) {
      when (state) {
        Player.STATE_BUFFERING -> if (wasReady && exo.playWhenReady) {
          rebuffering = true
          dropouts++
        }
        Player.STATE_READY -> {
          wasReady = true
          if (rebuffering) {
            rebuffering = false
            // The PC's clock ran on while this stalled; re-anchor it to where the audio really is.
            if (exo.playWhenReady) runtime.client.value?.send("seek", JSONObject().put("ms", exo.currentPosition))
          }
        }
        else -> Unit
      }
    }

    override fun onPlayerError(error: PlaybackException) {
      val trackId = currentTrackId ?: return
      val pos = exo.currentPosition
      val tierFailure = generateSequence(error as Throwable) { it.cause }.any { it is TierUnavailableException }
      val decoderFailure = error.errorCode in setOf(
        PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
        PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
        PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED,
        PlaybackException.ERROR_CODE_DECODING_FAILED,
      )
      Log.w(AwspClient.TAG, "awsp playback error on $trackId (${currentTier.wire}): ${error.errorCodeName}", error)
      when {
        tierFailure && currentTier != Tier.LOSSLESS -> {
          runtime.notice.value = "The PC could not encode Opus for this track; playing the original."
          load(trackId, pos, true, Tier.LOSSLESS)
        }
        decoderFailure && currentTier == Tier.LOSSLESS -> {
          // E.g. ALAC, which Android's decoders do not cover: ask the PC for Opus instead.
          runtime.notice.value = "This phone cannot decode the original format; streaming Opus 256 kb/s."
          load(trackId, pos, true, Tier.HIGH)
        }
        else -> retryWhenConnected(pos)
      }
    }
  }

  /** Network-side failures: wait until the client is connected again, then prepare at [pos]. */
  private fun retryWhenConnected(pos: Long) {
    errorRetry?.cancel()
    errorRetry = scope.launch {
      val c = runtime.client.value ?: return@launch
      c.start()
      c.status.filterIsInstance<AwspClient.Status.Connected>().first()
      delay(500)
      withContext(Dispatchers.Main) {
        if (exo.playerError != null) {
          exo.seekTo(pos)
          exo.prepare()
        }
      }
    }
  }

  // ---- ABR, prefetch, report -----------------------------------------------------------------

  private fun watchAbr() {
    scope.launch {
      runtime.streamer.abrChanges.collect { (change, tier) ->
        withContext(Dispatchers.Main) {
          when (change) {
            Abr.Change.DOWN -> {
              runtime.notice.value = "Slow connection: streaming at ${tier.label} instead of lossless."
              // Tiers are different files, so the switch is a re-open at the same position — now if
              // playback is already starving, otherwise from the next track.
              val id = currentTrackId
              if (id != null && currentTier == Tier.LOSSLESS && exo.playbackState == Player.STATE_BUFFERING) {
                load(id, exo.currentPosition, exo.playWhenReady, tier)
              }
            }
            Abr.Change.UP -> runtime.notice.value = "Connection recovered: back to lossless from the next track."
            Abr.Change.NONE -> Unit
          }
        }
      }
    }
  }

  private fun startTicker() {
    var ticks = 0
    val tick = object : Runnable {
      override fun run() {
        ticks++
        val id = currentTrackId
        if (id != null) {
          val pos = exo.currentPosition
          runtime.streamer.positionMs = pos
          val duration = exo.duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: runtime.tracks[id]?.durationMs
          if (duration != null) {
            runtime.streamer.setDuration(id, currentTier, duration)
            val next = nextTrackId
            if (next != null && runtime.streamer.policy.shouldPrefetch(duration - pos, true, prefetched == next)) {
              prefetched = next
              val tier = runtime.streamer.abr.tier
              if (runtime.streamer.prefetch(next, tier, runtime.tracks[next]?.durationMs)) {
                runtime.client.value?.send("prefetch", JSONObject().put("track_id", next))
              }
            }
          }
          // §3.1: `report` every 10 s while playing.
          if (exo.isPlaying && ticks % (REPORT_MS / TICK_MS).toInt() == 0) {
            val kbps = runtime.streamer.abr.lastThroughputBps?.let { it * 8 / 1000 }
            runtime.client.value?.send(
              "report",
              JSONObject()
                .put("buffer_ms", runtime.streamer.bufferedAheadMs())
                .put("throughput_kbps", kbps ?: JSONObject.NULL)
                .put("dropouts", dropouts),
            )
          }
        }
        main.postDelayed(this, TICK_MS)
      }
    }
    main.post(tick)
  }

  // ---- power -----------------------------------------------------------------------------------

  @SuppressLint("WakelockTimeout")
  private fun acquireWakeLock() {
    val wl = wakeLock ?: getSystemService(PowerManager::class.java)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "NowPlaying:awsp").apply { setReferenceCounted(false) }
      .also { wakeLock = it }
    if (!wl.isHeld) {
      wl.acquire()
      Log.i(AwspClient.TAG, "awsp wakelock acquired")
    }
    runtime.client.value?.start()
  }

  private fun releaseWakeLock() {
    wakeLock?.takeIf { it.isHeld }?.let {
      it.release()
      Log.i(AwspClient.TAG, "awsp wakelock released")
    }
  }

  private val dozeReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = checkDoze()
  }

  private fun registerDozeReceiver() {
    ContextCompat.registerReceiver(
      this, dozeReceiver, IntentFilter(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED,
    )
    checkDoze()
  }

  /** Doze seen and the app not exempt: prompt once (a notification leading to the system dialog). */
  private fun checkDoze() {
    val pm = getSystemService(PowerManager::class.java)
    if (!pm.isDeviceIdleMode || pm.isIgnoringBatteryOptimizations(packageName)) return
    val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
    prefs.edit().putBoolean(PREF_DOZE_SEEN, true).apply()
    Log.i(AwspClient.TAG, "awsp device is in Doze and the app is not exempt from battery optimisation")
    if (prefs.getBoolean(PREF_DOZE_PROMPTED, false)) return
    prefs.edit().putBoolean(PREF_DOZE_PROMPTED, true).apply()
    postDozePrompt(this)
  }

  // ---- network -------------------------------------------------------------------------------

  private val networkCallback = object : ConnectivityManager.NetworkCallback() {
    private var last: Network? = null

    override fun onAvailable(network: Network) {
      val previous = last
      last = network
      if (previous != null && previous != network) {
        Log.i(AwspClient.TAG, "awsp default network changed; probing the connection")
        scope.launch { runtime.client.value?.probe() }
      }
    }
  }

  private fun registerNetworkCallback() {
    runCatching { getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(networkCallback) }
      .onFailure { Log.w(AwspClient.TAG, "awsp could not watch network changes: $it") }
  }

  private fun labelFor(s: AwspClient.Status?): String? = when (s) {
    is AwspClient.Status.Connected -> if (s.connection == "direct") "direct" else "relay-carried"
    is AwspClient.Status.Connecting -> "reconnecting"
    is AwspClient.Status.Rejected -> "not paired"
    AwspClient.Status.Idle, null -> null
  }

  /** The default notification, with the connection type appended to its subtitle (§5). */
  private class ConnectionNotificationProvider(context: Context, private val label: () -> String?) :
    DefaultMediaNotificationProvider(context) {
    override fun getNotificationContentText(metadata: MediaMetadata): CharSequence? {
      val base = super.getNotificationContentText(metadata)
      val l = label() ?: return base
      return if (base.isNullOrEmpty()) l else "$base · $l"
    }
  }

  companion object {
    const val GRACE_MS = 10 * 60_000L
    private const val TICK_MS = 500L
    private const val REPORT_MS = 10_000L
    private const val INTENT_GRACE_MS = 5_000L
    const val PREFS = "awsp"
    const val PREF_DOZE_SEEN = "doze_seen"
    const val PREF_DOZE_PROMPTED = "doze_prompted"
    private const val DOZE_CHANNEL = "awsp_battery"
    private const val DOZE_NOTIFICATION_ID = 4101

    /** The system's "allow this app to ignore battery optimisations?" dialog. */
    @SuppressLint("BatteryLife")
    fun batteryExemptionIntent(context: Context): Intent =
      Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))

    fun postDozePrompt(context: Context) {
      if (Build.VERSION.SDK_INT >= 33 &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
      ) {
        return
      }
      val nm = context.getSystemService(NotificationManager::class.java)
      nm.createNotificationChannel(
        NotificationChannel(DOZE_CHANNEL, context.getString(R.string.awsp_battery_channel), NotificationManager.IMPORTANCE_DEFAULT),
      )
      val pi = PendingIntent.getActivity(context, 1, batteryExemptionIntent(context), PendingIntent.FLAG_IMMUTABLE)
      val n = NotificationCompat.Builder(context, DOZE_CHANNEL)
        .setSmallIcon(R.drawable.ic_launcher_foreground)
        .setContentTitle(context.getString(R.string.awsp_battery_title))
        .setContentText(context.getString(R.string.awsp_battery_text))
        .setStyle(NotificationCompat.BigTextStyle().bigText(context.getString(R.string.awsp_battery_text)))
        .setContentIntent(pi)
        .setAutoCancel(true)
        .build()
      NotificationManagerCompat.from(context).notify(DOZE_NOTIFICATION_ID, n)
    }
  }
}
