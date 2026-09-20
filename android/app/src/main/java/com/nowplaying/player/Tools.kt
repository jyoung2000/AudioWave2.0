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
   * The hosts a fetch may name.
   *
   * Generated from the helper's `HELPER_DEFAULT_HOSTS` rather than typed out again. It used to be a
   * second copy under a comment promising the two would not differ, which is not something a
   * comment can promise; `pnpm generate` now leaves a diff when only one side is edited.
   */
  val allowedHosts: List<String> = AllowedHosts.hosts

  private val starting = AtomicBoolean(false)
  private val setup = Executors.newSingleThreadExecutor()

  @Volatile private var ready = false
  @Volatile private var failure: String? = null
  @Volatile private var version: String? = null

  /**
   * Kick off first-run setup. Safe to call more than once: while an attempt is running or after one
   * succeeded, a call does nothing; after one failed, the next call tries again.
   */
  fun start(context: Context) {
    if (ready || !starting.compareAndSet(false, true)) return
    val app = context.applicationContext
    setup.execute {
      try {
        YoutubeDL.getInstance().init(app)
        FFmpeg.getInstance().init(app)
        version = YoutubeDL.getInstance().version(app)
        failure = null
        ready = true
      } catch (error: Throwable) {
        // Reported rather than thrown: a phone that cannot unpack the tool should still be a music
        // player, and the panel in Settings should say what went wrong instead of the app dying.
        failure = error.message ?: error.javaClass.simpleName
        // Released only on failure, so the next start() (the next launch of the activity) retries.
        starting.set(false)
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

  /**
   * Whether this host points somewhere inside a network rather than out at the internet.
   *
   * Ported from `isPrivateAddress` in `packages/domain/src/security.ts`, which is the version that
   * has been thought about. The prefix matching this replaces looked thorough and was not: it
   * missed CGNAT (100.64/10), link-local — including the 169.254.169.254 cloud metadata address —
   * IPv6 unique-local (fc00::/7), and every obfuscated form of a loopback address such as `127.1`
   * or `2130706433`, each of which a prefix check waves straight through.
   */
  internal fun isLocal(host: String): Boolean {
    val h = host.removePrefix("[").removeSuffix("]").lowercase().removeSuffix(".")
    if (h == "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h == "metadata.google.internal") return true
    if (Regex("^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$").matches(h)) {
      val v4 = parseIpv4(h) ?: return true
      return isPrivateIpv4(v4)
    }
    if (h.contains(":")) {
      val v6 = parseIpv6(h) ?: return true // an address we cannot read is not one we will trust
      return isPrivateIpv6(v6)
    }
    // Decimal, hex, octal and short-form IPv4 (127.1, 0x7f.1, 2130706433) all reach loopback.
    if (Regex("^(0x[0-9a-f]+|\\d+)(\\.(0x[0-9a-f]+|\\d+)){0,3}$").matches(h)) return true
    return false
  }

  private fun parseIpv4(h: String): IntArray? {
    val parts = h.split(".")
    if (parts.size != 4) return null
    val bytes = IntArray(4)
    for (i in 0 until 4) {
      val n = parts[i].toIntOrNull() ?: return null
      if (n < 0 || n > 255) return null
      bytes[i] = n
    }
    return bytes
  }

  private fun isPrivateIpv4(b: IntArray): Boolean {
    val a = b[0]
    val second = b[1]
    val third = b[2]
    if (a == 0 || a == 10 || a == 127) return true
    if (a == 100 && second in 64..127) return true // CGNAT
    if (a == 169 && second == 254) return true // link-local, incl. the 169.254.169.254 metadata address
    if (a == 172 && second in 16..31) return true
    if (a == 192 && second == 168) return true
    if (a == 192 && second == 0 && third == 0) return true // IETF protocol assignments
    if (a == 198 && (second == 18 || second == 19)) return true // benchmarking
    if (a >= 224) return true // multicast, reserved, broadcast
    return false
  }

  /** Sixteen bytes, or null when the literal cannot be read. Handles `::` and a trailing IPv4. */
  private fun parseIpv6(raw: String): IntArray? {
    var text = raw.substringBefore('%') // a zone id says nothing about reachability
    val bytes = IntArray(16)
    // A trailing dotted quad (::ffff:1.2.3.4) is rewritten to two hex groups first.
    val lastColon = text.lastIndexOf(':')
    if (lastColon >= 0 && text.substring(lastColon + 1).contains('.')) {
      val v4 = parseIpv4(text.substring(lastColon + 1)) ?: return null
      text = text.substring(0, lastColon + 1) + "%04x:%04x".format(v4[0] * 256 + v4[1], v4[2] * 256 + v4[3])
    }
    val halves = text.split("::")
    if (halves.size > 2) return null
    val head = if (halves[0].isEmpty()) emptyList() else halves[0].split(":")
    val tail = if (halves.size == 1 || halves[1].isEmpty()) emptyList() else halves[1].split(":")
    if (halves.size == 1 && head.size != 8) return null
    if (head.size + tail.size > 8) return null
    fun write(groups: List<String>, at: Int): Boolean {
      groups.forEachIndexed { i, group ->
        if (group.isEmpty() || group.length > 4) return false
        val value = group.toIntOrNull(16) ?: return false
        bytes[(at + i) * 2] = value shr 8
        bytes[(at + i) * 2 + 1] = value and 0xff
      }
      return true
    }
    if (!write(head, 0)) return null
    if (!write(tail, 8 - tail.size)) return null
    return bytes
  }

  private fun isPrivateIpv6(b: IntArray): Boolean {
    fun zeros(from: Int, to: Int): Boolean = (from until to).all { b[it] == 0 }
    // IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible ::a.b.c.d (incl. :: and ::1), SIIT ::ffff:0:a.b.c.d
    if (zeros(0, 10) && b[10] == 0xff && b[11] == 0xff) return isPrivateIpv4(b.copyOfRange(12, 16))
    if (zeros(0, 12)) return true
    if (zeros(0, 8) && b[8] == 0xff && b[9] == 0xff && b[10] == 0 && b[11] == 0) return isPrivateIpv4(b.copyOfRange(12, 16))
    // NAT64 64:ff9b::/96 and local-use 64:ff9b:1::/48 can reach arbitrary IPv4 targets.
    if (b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b) return true
    // 6to4 2002::/16 embeds an IPv4 address.
    if (b[0] == 0x20 && b[1] == 0x02) return isPrivateIpv4(b.copyOfRange(2, 6))
    // Teredo 2001::/32 embeds an obfuscated address; documentation 2001:db8::/32.
    if (b[0] == 0x20 && b[1] == 0x01 && ((b[2] == 0 && b[3] == 0) || (b[2] == 0x0d && b[3] == 0xb8))) return true
    // Only global unicast 2000::/3 is public; ULA fc00::/7, link/site-local and multicast are not.
    return (b[0] and 0xe0) != 0x20
  }
}
