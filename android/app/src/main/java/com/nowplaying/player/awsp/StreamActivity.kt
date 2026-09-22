package com.nowplaying.player.awsp

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.InputFilter
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.nowplaying.player.R
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * "Stream from a PC": the native AWSP screen. Pair with the companion (its ticket — pasted, or
 * shared here from any QR scanner app — and the six-digit code from Settings ▸ Remote), browse the
 * PC's library, tap a track to play it. Playback itself lives in [AwspPlaybackService]; this binds
 * it through a [MediaController], so its buttons are the same transport the notification uses.
 *
 * Plain Views, like the rest of this app; the WebView player in MainActivity is untouched.
 */
class StreamActivity : AppCompatActivity() {

  private var controllerFuture: ListenableFuture<MediaController>? = null
  private var controller: MediaController? = null
  private var bindJob: Job? = null
  private var runtime: AwspRuntime? = null

  private lateinit var status: TextView
  private lateinit var notice: TextView
  private lateinit var dozeRow: LinearLayout
  private lateinit var pairPanel: LinearLayout
  private lateinit var ticketField: EditText
  private lateinit var codeField: EditText
  private lateinit var pairButton: Button
  private lateinit var pairResult: TextView
  private lateinit var libraryPanel: LinearLayout
  private lateinit var nowPlaying: TextView
  private lateinit var playPause: Button
  private lateinit var searchField: EditText
  private lateinit var more: Button

  private val items = ArrayList<TrackInfo>()
  private lateinit var adapter: ArrayAdapter<String>
  private var page = 0
  private var total = 0L
  private var query: String? = null
  private var loaded = false

  private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(buildViews())
    takeTicketFrom(intent)
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    takeTicketFrom(intent)
  }

  override fun onStart() {
    super.onStart()
    // Binding the session starts the service, which creates the runtime.
    val token = SessionToken(this, ComponentName(this, AwspPlaybackService::class.java))
    val future = MediaController.Builder(this, token).buildAsync()
    controllerFuture = future
    future.addListener({
      val c = runCatching { future.get() }.getOrNull() ?: return@addListener
      controller = c
      c.addListener(controllerListener)
      renderTransport()
    }, ContextCompat.getMainExecutor(this))
    bindJob = lifecycleScope.launch { bind(AwspRuntime.current.filterNotNull().first()) }
  }

  override fun onResume() {
    super.onResume()
    renderDozeHint()
  }

  override fun onStop() {
    bindJob?.cancel()
    controller?.removeListener(controllerListener)
    controller = null
    controllerFuture?.let { MediaController.releaseFuture(it) }
    controllerFuture = null
    super.onStop()
  }

  @kotlin.OptIn(ExperimentalCoroutinesApi::class)
  private suspend fun bind(rt: AwspRuntime) {
    runtime = rt
    lifecycleScope.launch {
      rt.notice.collect { n ->
        notice.text = n ?: ""
        notice.visibility = if (n == null) View.GONE else View.VISIBLE
      }
    }
    val statuses = rt.client.flatMapLatest { c -> c?.status ?: flowOf(null) }
    combine(rt.client, statuses, rt.serverName) { c, s, name -> Triple(c, s, name) }.collect { (c, s, name) ->
      pairPanel.visibility = if (c == null) View.VISIBLE else View.GONE
      libraryPanel.visibility = if (c == null) View.GONE else View.VISIBLE
      status.text = describe(s, name)
      if (c != null && s is AwspClient.Status.Connected && !loaded) {
        loaded = true
        loadPage(reset = true)
      }
    }
  }

  private fun describe(s: AwspClient.Status?, name: String?): String {
    val pc = name ?: "your PC"
    return when (s) {
      null -> "Not paired. Open Settings ▸ Remote on the PC for its ticket and a pairing code."
      AwspClient.Status.Idle -> "$pc · idle (press play to reconnect)"
      is AwspClient.Status.Connecting -> "$pc · connecting…"
      is AwspClient.Status.Connected -> {
        val type = if (s.connection == "direct") "● direct" else "● relay-carried"
        "${s.serverName} · $type · ${s.rttMs} ms"
      }
      is AwspClient.Status.Rejected -> when (s.code) {
        "unknown-device" -> "$pc does not know this phone any more (revoked?). Forget it and pair again."
        else -> "$pc refused: ${s.message}"
      }
    }
  }

  // ---- pairing ---------------------------------------------------------------------------------

  private fun pair() {
    val rt = runtime ?: return
    pairButton.isEnabled = false
    pairResult.text = "Pairing…"
    lifecycleScope.launch {
      try {
        val name = rt.pair(ticketField.text.toString(), codeField.text.toString())
        pairResult.text = "Paired with $name."
        codeField.setText("")
        loaded = false
      } catch (e: RejectedException) {
        pairResult.text = when (e.code) {
          "pair-rejected" -> "Wrong code. Five wrong codes void it; make a new one on the PC if needed."
          "pair-no-code" -> "The PC has no live pairing code. Make one in Settings ▸ Remote (they last ten minutes)."
          else -> e.message
        }
      } catch (e: Exception) {
        pairResult.text = e.message ?: e.toString()
      } finally {
        pairButton.isEnabled = true
      }
    }
  }

  private fun takeTicketFrom(intent: Intent?) {
    val text = intent?.takeIf { it.action == Intent.ACTION_SEND }?.getStringExtra(Intent.EXTRA_TEXT) ?: return
    // A scanner app shares the QR code's text; the ticket is its one "endpoint…" word.
    val ticket = text.split(Regex("\\s+")).firstOrNull { it.startsWith("endpoint") } ?: text.trim()
    ticketField.setText(ticket)
  }

  // ---- library -----------------------------------------------------------------------------------

  private fun loadPage(reset: Boolean) {
    val client = runtime?.client?.value ?: return
    if (reset) {
      page = 0
      items.clear()
      adapter.clear()
    }
    more.isEnabled = false
    lifecycleScope.launch {
      try {
        val p = client.browse(query, page)
        total = p.optLong("total")
        val arr = p.optJSONArray("items") ?: JSONArray()
        val got = (0 until arr.length()).mapNotNull { runCatching { TrackInfo.from(arr.getJSONObject(it)) }.getOrNull() }
        runtime?.remember(got)
        items += got
        adapter.addAll(got.map { t -> listOfNotNull(t.title, t.artist.ifEmpty { null }).joinToString(" — ") })
        page++
      } catch (e: Exception) {
        notice.text = "Could not load the library: ${e.message}"
        notice.visibility = View.VISIBLE
      } finally {
        more.isEnabled = items.size < total
        more.text = if (items.size < total) "More (${items.size} of $total)" else "$total tracks"
      }
    }
  }

  private fun playFrom(index: Int) {
    val client = runtime?.client?.value ?: return
    val ids = JSONArray(items.map { it.id })
    val trackId = items[index].id
    lifecycleScope.launch {
      // One coroutine, in order: the queue first, so `play` lands on an index inside it.
      val ok = client.sendWhenConnected("set_queue", JSONObject().put("track_ids", ids)) &&
        client.sendWhenConnected("play", JSONObject().put("track_id", trackId).put("offset_ms", 0))
      if (!ok) {
        notice.text = "Not connected to the PC."
        notice.visibility = View.VISIBLE
      }
    }
  }

  // ---- transport ---------------------------------------------------------------------------------

  private val controllerListener = object : Player.Listener {
    override fun onEvents(player: Player, events: Player.Events) = renderTransport()
  }

  private fun renderTransport() {
    val c = controller
    val m: MediaMetadata? = c?.mediaMetadata
    nowPlaying.text = if (c == null || c.mediaItemCount == 0) {
      "Nothing playing"
    } else {
      listOfNotNull(m?.title, m?.artist).joinToString(" — ")
    }
    playPause.text = if (c?.playWhenReady == true) "Pause" else "Play"
  }

  private fun renderDozeHint() {
    val pm = getSystemService(PowerManager::class.java)
    val seen = getSharedPreferences(AwspPlaybackService.PREFS, MODE_PRIVATE).getBoolean(AwspPlaybackService.PREF_DOZE_SEEN, false)
    dozeRow.visibility = if (seen && !pm.isIgnoringBatteryOptimizations(packageName)) View.VISIBLE else View.GONE
  }

  private fun askBatteryExemption() {
    try {
      startActivity(AwspPlaybackService.batteryExemptionIntent(this))
    } catch (e: ActivityNotFoundException) {
      startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    }
  }

  // ---- views -----------------------------------------------------------------------------------

  private fun buildViews(): View {
    val pad = dp(16)
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(pad, pad, pad, pad)
      fitsSystemWindows = true
    }
    root.addView(text(getString(R.string.awsp_title), 22f))
    status = text("", 14f)
    root.addView(status)
    notice = text("", 14f).apply {
      setTextColor(0xff8a5a00.toInt())
      visibility = View.GONE
    }
    root.addView(notice)

    dozeRow = row().apply {
      addView(text(getString(R.string.awsp_battery_text), 13f), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      addView(button("Allow") { askBatteryExemption() })
      visibility = View.GONE
    }
    root.addView(dozeRow)

    pairPanel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    ticketField = EditText(this).apply {
      hint = "Ticket (paste it, or share the QR text here)"
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
      minLines = 2
      maxLines = 4
    }
    codeField = EditText(this).apply {
      hint = "Six-digit pairing code"
      inputType = InputType.TYPE_CLASS_NUMBER
      filters = arrayOf(InputFilter.LengthFilter(6))
    }
    pairButton = button("Pair") { pair() }
    pairResult = text("", 14f)
    pairPanel.addView(ticketField)
    pairPanel.addView(codeField)
    pairPanel.addView(pairButton)
    pairPanel.addView(pairResult)
    root.addView(pairPanel)

    libraryPanel = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      visibility = View.GONE
    }
    nowPlaying = text("Nothing playing", 16f)
    libraryPanel.addView(nowPlaying)
    playPause = button("Play") {
      val c = controller ?: return@button
      if (c.playWhenReady) c.pause() else c.play()
    }
    libraryPanel.addView(
      row().apply {
        addView(button("Prev") { controller?.seekToPrevious() })
        addView(playPause)
        addView(button("Next") { controller?.seekToNext() })
      },
    )
    searchField = EditText(this).apply {
      hint = "Search the PC's library"
      inputType = InputType.TYPE_CLASS_TEXT
      imeOptions = EditorInfo.IME_ACTION_SEARCH
      setOnEditorActionListener { _, _, _ ->
        search()
        true
      }
    }
    libraryPanel.addView(
      row().apply {
        addView(searchField, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        addView(button("Search") { search() })
      },
    )
    adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, ArrayList())
    val list = ListView(this).apply {
      adapter = this@StreamActivity.adapter
      setOnItemClickListener { _, _, position, _ -> playFrom(position) }
    }
    libraryPanel.addView(list, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    more = button("More") { loadPage(reset = false) }
    libraryPanel.addView(
      row().apply {
        addView(more)
        addView(
          button("Forget this PC") {
            runtime?.forget()
            loaded = false
            items.clear()
            adapter.clear()
          },
        )
      },
    )
    root.addView(libraryPanel, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    return root
  }

  private fun search() {
    query = searchField.text.toString().trim().ifEmpty { null }
    loadPage(reset = true)
  }

  private fun text(s: String, sp: Float) = TextView(this).apply {
    text = s
    setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
    setPadding(0, dp(4), 0, dp(4))
  }

  private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
    text = label
    isAllCaps = false
    setOnClickListener { onClick() }
  }

  private fun row() = LinearLayout(this).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
  }

  private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
