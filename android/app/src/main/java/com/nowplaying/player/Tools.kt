package com.nowplaying.player

import android.content.Context
import android.net.Uri
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The tools, and what this app is willing to say about them.
 *
 * Two rules carried over from the desktop helper, because they are the ones that matter and they do
 * not become less true for being on a phone:
 *
 *   **Nothing is claimed that has not been observed.** `health` reports what it actually knows right
 *   now — including, on a first run, that the tool is still unpacking itself and cannot be used yet.
 *   The player builds its interface from that, so a button never appears before the thing behind it.
 *
 *   **The page cannot name an argument.** It names a URL, a tool and a format. Every flag is written
 *   in [Jobs], `--ignore-config` among them.
 *
 * Setting up costs several seconds on a first run: the library unpacks a Python runtime out of the
 * APK. That happens on a background thread and `health` is honest in the meantime rather than
 * blocking, because a synchronous bridge call that waited would freeze the interface asking it.
 */
object Tools {

  /** Bumped in lockstep with HELPER_PROTOCOL in packages/contracts. */
  const val PROTOCOL = 1

  /**
   * The hosts a fetch may name. Deliberately the same list as the helper's `HELPER_DEFAULT_HOSTS`:
   * two implementations of one promise should not quietly differ about what it covers.
   */
  val allowedHosts = listOf(
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "soundcloud.com",
    "api.soundcloud.com",
    "on.soundcloud.com",
    "open.spotify.com",
    "bandcamp.com",
    "archive.org",
  )

  private val starting = AtomicBoolean(false)
  private val setup = Executors.newSingleThreadExecutor()

  @Volatile private var ready = false
  @Volatile private var failure: String? = null
  @Volatile private var version: String? = null

  /** Kick off first-run setup. Safe to call more than once; only the first does anything. */
  fun start(context: Context) {
    if (!starting.compareAndSet(false, true)) return
    val app = context.applicationContext
    setup.execute {
      try {
        YoutubeDL.getInstance().init(app)
        FFmpeg.getInstance().init(app)
        version = YoutubeDL.getInstance().version(app)
        ready = true
      } catch (error: Throwable) {
        // Reported rather than thrown: a phone that cannot unpack the tool should still be a music
        // player, and the panel in Settings should say what went wrong instead of the app dying.
        failure = error.message ?: error.javaClass.simpleName
      }
    }
  }

  fun isReady(): Boolean = ready

  /**
   * What the player asks for first, and the only thing it will believe.
   *
   * spotDL is reported absent, always, with the reason. It is a Python application with no Android
   * packaging, and its Spotify half needs an API key this app does not have — so the honest answer
   * is a named absence rather than a button that would fail.
   */
  fun healthJson(context: Context): String {
    val tools = JSONArray()
    tools.put(
      JSONObject()
        .put("id", "yt-dlp")
        .put("present", ready)
        .put("version", version ?: JSONObject.NULL)
        .put("origin", if (ready) "installed" else "missing")
        .put(
          "installHint",
          when {
            ready -> JSONObject.NULL
            failure != null -> "This app could not set up yt-dlp: $failure"
            else -> "Setting up on first run — it unpacks itself the first time the app opens, which takes a few seconds."
          },
        )
        .put("installable", false),
    )
    tools.put(
      JSONObject()
        .put("id", "spotdl")
        .put("present", false)
        .put("version", JSONObject.NULL)
        .put("origin", "missing")
        .put(
          "installHint",
          "Not available on Android. spotDL is a Python application with no Android build, and the Spotify half of it needs an API key this app does not have. A helper on a computer can run it.",
        )
        .put("installable", false),
    )
    tools.put(
      JSONObject()
        .put("id", "ffmpeg")
        .put("present", ready)
        .put("version", if (ready) "bundled with this app" else JSONObject.NULL)
        .put("origin", if (ready) "installed" else "missing")
        .put("installHint", if (ready) JSONObject.NULL else "Arrives with yt-dlp when setup finishes.")
        .put("installable", false),
    )

    val formats = JSONArray()
    // FFmpeg travels with the tool, so conversion is available exactly when the tool is.
    for (format in if (ready) listOf("original", "mp3", "aac", "opus", "flac") else listOf("original")) formats.put(format)

    val hosts = JSONArray()
    for (host in allowedHosts) hosts.put(host)

    return JSONObject()
      .put("helper", "now-playing-local-helper")
      .put("protocol", PROTOCOL)
      .put("version", appVersion(context))
      .put("servesApp", true)
      .put("tools", tools)
      .put("allowedHosts", hosts)
      .put("formats", formats)
      .put("startedAt", Jobs.startedAt)
      .toString()
  }

  private fun appVersion(context: Context): String =
    runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0" }.getOrDefault("0")

  /**
   * Whether a fetch may name this address.
   *
   * https only, on the allowlist, and never something that resolves inside a network — the same
   * three checks the helper makes, for the same reasons.
   */
  fun urlRefusal(raw: String): String? {
    val uri = runCatching { Uri.parse(raw) }.getOrNull() ?: return "That is not a web address."
    if (!uri.scheme.equals("https", ignoreCase = true)) return "Only https addresses are fetched."
    val host = uri.host?.lowercase() ?: return "That address names no host."
    if (uri.userInfo != null) return "An address carrying credentials is refused."
    if (isLocal(host)) return "Addresses on this device or this network are refused."
    val allowed = allowedHosts.any { host == it || host.endsWith(".$it") }
    return if (allowed) null else "Host $host is not on the allowlist."
  }

  private fun isLocal(host: String): Boolean =
    host == "localhost" ||
      host.endsWith(".local") ||
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      host == "0.0.0.0" ||
      host == "[::1]" ||
      Regex("^172\\.(1[6-9]|2\\d|3[01])\\.").containsMatchIn(host)
}
