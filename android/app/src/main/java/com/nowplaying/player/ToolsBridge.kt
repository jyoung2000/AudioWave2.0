package com.nowplaying.player

import android.content.Context
import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * What the page is allowed to ask for.
 *
 * Android's bridge carries strings, synchronously, and nothing else — so every method here takes and
 * returns JSON text, and none of them may wait on work. `startFetch` starts a job and returns it;
 * progress arrives by polling, exactly as it does from the desktop helper over HTTP. The shapes on
 * either side are the ones in `packages/contracts`, which is what lets the player treat this and a
 * helper as the same thing.
 *
 * This object is reachable from any page loaded in the WebView, which is why [MainActivity] refuses
 * to load any page but its own. That refusal is the boundary; this class assumes it and checks
 * everything else anyway.
 *
 * The gate that matters is the rights basis, and it is per fetch rather than once. A one-time "I
 * have the rights" box is a worse gate than a choice made each time, because everyone ticks the
 * former once and then never thinks about it again.
 */
class ToolsBridge(
  context: Context,
  /**
   * Whether the page currently in the WebView is the app's own. Checked on every call, as a second
   * wall behind the navigation boundary: if anything foreign ever becomes the top-level page, the
   * bridge answers it with a refusal rather than a tool.
   */
  private val isTrusted: () -> Boolean,
  /** Told when a fetch has started, so the activity can ask for the notification permission then. */
  private val onFetchStarted: () -> Unit = {},
) {

  // The application, not the activity: jobs and the service outlive any one activity instance.
  private val context: Context = context.applicationContext

  private val allowedBases = setOf("user-owned", "creator-download", "purchased-export", "public-domain", "licensed")

  @JavascriptInterface
  fun protocol(): Int = if (isTrusted()) Tools.PROTOCOL else -1

  @JavascriptInterface
  fun health(): String {
    if (!isTrusted()) return forbidden()
    return Tools.healthJson(context)
  }

  @JavascriptInterface
  fun startFetch(request: String): String {
    if (!isTrusted()) return forbidden()
    val body = runCatching { JSONObject(request) }.getOrNull() ?: return error("validation", "That request is not JSON.")

    val authorization = body.optJSONObject("authorization")
    val basis = authorization?.optString("basis").orEmpty()
    if (!authorization.let { it != null && it.optBoolean("acknowledged", false) } || basis !in allowedBases) {
      return error("validation", "Nothing is fetched without saying what entitles you to it.")
    }

    val url = body.optString("url")
    if (url.isEmpty()) return error("validation", "That request names no address.")
    Tools.urlRefusal(url)?.let { return error("url", it) }

    // spotDL is not here and the player already knows; saying so again beats a silent substitution.
    val asked = body.optString("tool", "auto")
    if (asked == "spotdl" || (asked == "auto" && url.contains("spotify.com"))) {
      return error("tool-missing", "spotDL is not available on Android. A helper on a computer can run it, and Settings → Platforms explains how.")
    }
    if (!Tools.isReady()) return error("tool-missing", "The tools are still setting themselves up. Try again in a moment.")

    val format = body.optString("format", "original").ifEmpty { "original" }
    val job = Jobs.create(context, url, "yt-dlp", format)
    runCatching { onFetchStarted() }
    return Jobs.toJson(job)
  }

  @JavascriptInterface
  fun jobState(id: String): String {
    if (!isTrusted()) return forbidden()
    val job = Jobs.get(id) ?: return error("not-found", "No such job.")
    return Jobs.toJson(job)
  }

  @JavascriptInterface
  fun forget(id: String): String =
    if (!isTrusted()) forbidden()
    else if (Jobs.forget(id)) JSONObject().put("ok", true).toString() else error("not-found", "No such job.")

  @JavascriptInterface
  fun install(tool: String): String =
    if (!isTrusted()) forbidden()
    else JSONObject()
      .put("tool", tool)
      .put("installed", false)
      .put("version", JSONObject.NULL)
      .put(
        "reason",
        if (tool == "yt-dlp") "yt-dlp comes with this app; there is nothing to install." else "This app carries only yt-dlp.",
      )
      .toString()

  /**
   * A URL rather than the bytes.
   *
   * Forty megabytes base64'd through a synchronous string return would freeze the interface asking
   * for it, so the file is served by the same asset loader that serves the player and fetched the
   * way anything else is fetched.
   */
  @JavascriptInterface
  fun fileUrl(jobId: String, fileId: String): String =
    if (isTrusted() && Jobs.fileFor(jobId, fileId) != null) "https://${MainActivity.ASSET_DOMAIN}/jobfiles/$jobId/$fileId" else ""

  private fun forbidden(): String = error("forbidden", "Only the player this app ships may use its tools.")

  private fun error(code: String, message: String): String =
    JSONObject().put("error", code).put("message", message).toString()
}
