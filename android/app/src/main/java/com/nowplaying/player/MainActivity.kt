package com.nowplaying.player

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import java.io.FileInputStream

/**
 * The player, in a window this app owns.
 *
 * The one decision everything else rests on: the page is served over **https**, from
 * `appassets.androidplatform.net`, by [WebViewAssetLoader] — not from `file://`. A `file://` page is
 * not a secure context, and without one there is no service worker, no IndexedDB, no origin-private
 * file system and no Web Audio worklet. Every substantial thing the player does would be gone. This
 * costs one class and buys the whole application.
 *
 * The second decision is the boundary. [ToolsBridge] is reachable from any page loaded in this
 * WebView, so this WebView loads exactly one page and hands every other link to the real browser.
 * That is what makes the bridge safe to expose at all.
 *
 * A known limitation, stated here rather than discovered: **audio does not reliably continue when
 * the app is in the background.** In a browser the browser is the foreground app and Media Session
 * keeps it alive; in a WebView inside this app, Android may suspend it. Fixing that properly needs a
 * playback foreground service driven by the page, which is not in this version. If background
 * listening is what you want today, the browser is still better at it than this is.
 */
class MainActivity : AppCompatActivity() {

  companion object {
    const val ASSET_DOMAIN = "appassets.androidplatform.net"
    private const val START_URL = "https://$ASSET_DOMAIN/assets/app/index.html"
  }

  private lateinit var web: WebView

  @SuppressLint("SetJavaScriptEnabled")
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    // Whatever a previous run left half-fetched is litter, not a resumable job.
    Jobs.sweep(this)
    // Unpacking the tool takes seconds on a first run, so it starts now and reports honestly in the
    // meantime; nothing here waits on it.
    Tools.start(this)

    val loader = WebViewAssetLoader.Builder()
      .setDomain(ASSET_DOMAIN)
      .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
      .addPathHandler("/jobfiles/", JobFilesHandler())
      .build()

    web = WebView(this)
    setContentView(web)

    if ((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true)

    web.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      databaseEnabled = true
      // The player starts audio from a tap, which counts; this only stops the WebView demanding a
      // second gesture it has already had.
      mediaPlaybackRequiresUserGesture = false
      // Nothing is loaded from the filesystem — everything comes through the loader above.
      allowFileAccess = false
      allowContentAccess = false
    }

    web.webViewClient = object : WebViewClientCompat() {
      override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
        loader.shouldInterceptRequest(request.url)

      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url
        if (url.host == ASSET_DOMAIN) return false
        // Anything else is somebody else's page and belongs in a browser, where it cannot see the
        // bridge. This is the boundary ToolsBridge relies on.
        openOutside(url)
        return true
      }
    }

    web.addJavascriptInterface(ToolsBridge(this), "NowPlayingTools")
    web.loadUrl(START_URL)

    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          if (web.canGoBack()) web.goBack() else finish()
        }
      },
    )
  }

  private fun openOutside(url: Uri) {
    try {
      startActivity(Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: ActivityNotFoundException) {
      // No browser installed. Doing nothing is the correct amount of drama.
    }
  }

  override fun onDestroy() {
    web.destroy()
    super.onDestroy()
  }

  /** Serves a finished file to the page, on the page's own origin, so fetching it is unremarkable. */
  private class JobFilesHandler : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse? {
      val parts = path.split('/').filter { it.isNotEmpty() }
      if (parts.size != 2) return null
      val (file, contentType) = Jobs.fileFor(parts[0], parts[1]) ?: return null
      if (!file.isFile) return null
      return WebResourceResponse(contentType, null, FileInputStream(file))
    }
  }
}
