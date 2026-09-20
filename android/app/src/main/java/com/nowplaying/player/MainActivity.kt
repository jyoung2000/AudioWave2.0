package com.nowplaying.player

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.webkit.MimeTypeMap
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.webkit.ServiceWorkerClientCompat
import androidx.webkit.ServiceWorkerControllerCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.FileInputStream

/**
 * The player, in a window this app owns.
 *
 * The one decision everything else rests on: the page is served over **https**, from
 * `appassets.androidplatform.net`, by [WebViewAssetLoader] — not from `file://`. A `file://` page is
 * not a secure context, and without one there is no service worker, no IndexedDB, no origin-private
 * file system and no Web Audio worklet. Every substantial thing the player does would be gone. This
 * costs one class and buys the whole application. The player must be built with
 * `NP_BASE_PATH=/assets/app/` so its URLs point where this serves them.
 *
 * The second decision is the boundary. [ToolsBridge] is reachable from any page loaded in this
 * WebView, so this WebView loads exactly one page and hands every other link to the real browser,
 * and the bridge itself refuses to answer if the top-level page is ever anything else. That is what
 * makes the bridge safe to expose at all.
 *
 * A known limitation, stated here rather than discovered: **audio does not reliably continue when
 * the app is in the background.** Back no longer closes the window (it moves the app to the
 * background, so the page keeps its state and its audio for as long as Android allows), but in a
 * WebView inside this app Android may still suspend it. Fixing that properly needs a playback
 * foreground service driven by the page, which is not in this version.
 */
class MainActivity : AppCompatActivity() {

  companion object {
    const val ASSET_DOMAIN = "appassets.androidplatform.net"
    private const val ASSET_ORIGIN = "https://$ASSET_DOMAIN"
    private const val START_URL = "$ASSET_ORIGIN/assets/app/index.html"

    /** More renderer deaths than this inside the window means reloading is not going to help. */
    private const val MAX_RENDERER_RESTARTS = 3
    private const val RENDERER_RESTART_WINDOW_MS = 60_000L

    fun isAppUrl(url: Uri?): Boolean =
      url != null && url.scheme.equals("https", ignoreCase = true) && url.host.equals(ASSET_DOMAIN, ignoreCase = true)
  }

  private lateinit var container: FrameLayout
  private lateinit var loader: WebViewAssetLoader
  private lateinit var web: WebView

  /**
   * Whether the top-level page is the app's own. Starts true because the only page this activity
   * ever loads is [START_URL]; it is withdrawn the moment a main-frame navigation anywhere else is
   * seen, and read from the bridge thread, hence volatile.
   */
  @Volatile private var trustedPage = true

  private val rendererDeaths = ArrayDeque<Long>()
  private var askedForNotifications = false

  private val downloads = BlobDownloads(this)

  private var pendingChooser: ValueCallback<Array<Uri>>? = null
  private val chooseFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
    val callback = pendingChooser
    pendingChooser = null
    callback?.onReceiveValue(if (result.resultCode == Activity.RESULT_OK) urisFrom(result.data) else null)
  }

  // Nothing to do with the answer: a refusal only means the progress notification is not shown.
  private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    // Whatever a previous process left half-fetched is litter, not a resumable job. Jobs only sweeps
    // on the first call per process, so reopening the window mid-download does not delete it.
    Jobs.sweep(this)
    // Unpacking the tool takes seconds on a first run, so it starts now and reports honestly in the
    // meantime; nothing here waits on it. If an earlier attempt failed, this tries again.
    Tools.start(this)

    val assets = WebViewAssetLoader.Builder()
      .setDomain(ASSET_DOMAIN)
      .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(applicationContext))
      .addPathHandler("/jobfiles/", JobFilesHandler())
      .build()
    loader = assets

    // The player registers a service worker. Its requests (the precache, the script itself) do not
    // pass through a WebViewClient, so without this they would go to the network for a host that
    // does not exist and the offline shell would never install.
    if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_SHOULD_INTERCEPT_REQUEST)
    ) {
      ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(
        object : ServiceWorkerClientCompat() {
          override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse? =
            assets.shouldInterceptRequest(request.url)
        },
      )
    }

    if ((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true)

    container = FrameLayout(this)
    setContentView(container)
    web = buildWebView()
    container.addView(web)
    web.loadUrl(START_URL)

    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          // Finishing would destroy the WebView and stop the music; going to the background keeps
          // both, the way a music app is expected to behave.
          if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
        }
      },
    )
  }

  /** Everything about a WebView lives here, so a renderer crash can be answered with a fresh one. */
  @SuppressLint("SetJavaScriptEnabled", "RequiresFeature")
  private fun buildWebView(): WebView {
    val view = WebView(this)

    view.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      databaseEnabled = true
      // The player starts audio from a tap, which counts; this only stops the WebView demanding a
      // second gesture it has already had.
      mediaPlaybackRequiresUserGesture = false
      // Nothing is loaded from the filesystem — everything comes through the loader above. Files the
      // person picks reach the page through the chooser, which does not need either of these.
      allowFileAccess = false
      allowContentAccess = false
      // An https page never loads http. This also means a hub on the local network must be reached
      // over https; the manifest forbids cleartext for the same reason.
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      setSupportMultipleWindows(false)
      javaScriptCanOpenWindowsAutomatically = false
    }

    view.webViewClient = object : WebViewClientCompat() {
      override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
        loader.shouldInterceptRequest(request.url)

      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url
        if (isAppUrl(url)) return false
        // Anything else is somebody else's page and belongs in a browser, where it cannot see the
        // bridge. This is the boundary ToolsBridge relies on. A frame inside the page does not get
        // to open a browser on its own say-so; it is simply not loaded.
        if (request.isForMainFrame) openOutside(url)
        return true
      }

      override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        trustedPage = isAppUrl(url?.let(Uri::parse))
        super.onPageStarted(view, url, favicon)
      }

      override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
        trustedPage = isAppUrl(url?.let(Uri::parse))
        super.doUpdateVisitedHistory(view, url, isReload)
      }

      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean =
        recoverFromRendererDeath(view)
    }

    view.webChromeClient = object : WebChromeClient() {
      override fun onShowFileChooser(
        webView: WebView,
        filePathCallback: ValueCallback<Array<Uri>>,
        fileChooserParams: WebChromeClient.FileChooserParams,
      ): Boolean {
        pendingChooser?.onReceiveValue(null)
        pendingChooser = filePathCallback
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
          .addCategory(Intent.CATEGORY_OPENABLE)
          .setType("*/*")
        val types = mimeTypesFor(fileChooserParams.acceptTypes)
        if (types.size == 1) intent.type = types[0] else if (types.size > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, types)
        if (fileChooserParams.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
          intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        try {
          chooseFiles.launch(intent)
        } catch (missing: ActivityNotFoundException) {
          // No document picker at all: cancel, which is what the page expects when nothing is chosen.
          pendingChooser = null
          filePathCallback.onReceiveValue(null)
        }
        return true
      }
    }

    // http(s) downloads go to the browser; blob: downloads are caught in the page (BlobDownloads)
    // and never reach here, and there is nothing useful to do with one that does.
    view.setDownloadListener { url, _, _, _, _ ->
      val uri = Uri.parse(url)
      if ((uri.scheme == "https" || uri.scheme == "http") && !isAppUrl(uri)) openOutside(uri)
    }

    view.addJavascriptInterface(
      ToolsBridge(
        this,
        isTrusted = { trustedPage },
        onFetchStarted = { runOnUiThread { requestNotificationsIfNeeded() } },
      ),
      "NowPlayingTools",
    )

    // Restricted to the app's own origin by the WebView itself, unlike the interface above.
    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
      WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
    ) {
      WebViewCompat.addWebMessageListener(view, BlobDownloads.JS_NAME, setOf(ASSET_ORIGIN)) { _, message, sourceOrigin, isMainFrame, _ ->
        val data = message.data
        if (isMainFrame && data != null && sourceOrigin.toString().trimEnd('/') == ASSET_ORIGIN) downloads.onMessage(data)
      }
      WebViewCompat.addDocumentStartJavaScript(view, BlobDownloads.SCRIPT, setOf(ASSET_ORIGIN))
    }

    return view
  }

  /**
   * A renderer that crashed or was killed for memory takes the WebView with it; returning false
   * would take the app too. Replace the WebView and reload, unless it keeps happening.
   */
  private fun recoverFromRendererDeath(dead: WebView): Boolean {
    container.removeView(dead)
    dead.destroy()
    if (dead !== web || isFinishing || isDestroyed) return true

    val now = SystemClock.elapsedRealtime()
    rendererDeaths.addLast(now)
    while (rendererDeaths.isNotEmpty() && now - rendererDeaths.first() > RENDERER_RESTART_WINDOW_MS) rendererDeaths.removeFirst()
    if (rendererDeaths.size > MAX_RENDERER_RESTARTS) {
      finish()
      return true
    }

    trustedPage = true
    web = buildWebView()
    container.addView(web)
    web.loadUrl(START_URL)
    return true
  }

  /** Asked once per window, the first time a fetch starts, and never in the way of the fetch. */
  private fun requestNotificationsIfNeeded() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    if (askedForNotifications || isFinishing || isDestroyed) return
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
    askedForNotifications = true
    runCatching { askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS) }
  }

  private fun urisFrom(data: Intent?): Array<Uri>? {
    if (data == null) return null
    val clip = data.clipData
    if (clip != null && clip.itemCount > 0) return Array(clip.itemCount) { clip.getItemAt(it).uri }
    return data.data?.let { arrayOf(it) }
  }

  /**
   * `accept` as the document picker understands it. Extensions are mapped to MIME types; if any
   * cannot be, the filter is dropped rather than hiding files the page would have accepted.
   */
  private fun mimeTypesFor(accept: Array<String>?): Array<String> {
    val tokens = accept.orEmpty().flatMap { it.split(',') }.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
    if (tokens.isEmpty()) return emptyArray()
    val types = LinkedHashSet<String>()
    for (token in tokens) {
      val type = if (token.startsWith(".")) MimeTypeMap.getSingleton().getMimeTypeFromExtension(token.substring(1)) else token.takeIf { '/' in it }
      if (type == null) return emptyArray()
      types.add(type)
    }
    return types.toTypedArray()
  }

  private fun openOutside(url: Uri) {
    // Only ordinary web and mail links leave the app; any other scheme is dropped rather than handed
    // to whichever app claims it.
    val scheme = url.scheme?.lowercase()
    if (scheme != "https" && scheme != "http" && scheme != "mailto") return
    try {
      startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (missing: ActivityNotFoundException) {
      // No browser installed. Doing nothing is the correct amount of drama.
    }
  }

  override fun onDestroy() {
    pendingChooser?.onReceiveValue(null)
    pendingChooser = null
    if (::web.isInitialized) {
      container.removeView(web)
      web.destroy()
    }
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
