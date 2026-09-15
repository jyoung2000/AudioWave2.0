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
class ToolsBridge(private val context: Context) {

  private val allowedBases = setOf("user-owned", "creator-download", "purchased-export", "public-domain", "licensed")

  @JavascriptInterface
  fun protocol(): Int = Tools.PROTOCOL

  @JavascriptInterface
  fun health(): String = Tools.healthJson(context)

  @JavascriptInterface
  fun startFetch(request: String): String {
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
    return Jobs.toJson(Jobs.create(context, url, "yt-dlp", format))
  }

  @JavascriptInterface
  fun jobState(id: String): String {
    val job = Jobs.get(id) ?: return error("not-found", "No such job.")
    return Jobs.toJson(job)
  }

  @JavascriptInterface
  fun forget(id: String): String =
    if (Jobs.forget(id)) JSONObject().put("ok", true).toString() else error("not-found", "No such job.")

  @JavascriptInterface
  fun install(tool: String): String =
    JSONObject()
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
    if (Jobs.fileFor(jobId, fileId) != null) "https://${MainActivity.ASSET_DOMAIN}/jobfiles/$jobId/$fileId" else ""

  private fun error(code: String, message: String): String =
    JSONObject().put("error", code).put("message", message).toString()
}
