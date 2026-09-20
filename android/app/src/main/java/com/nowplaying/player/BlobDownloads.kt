package com.nowplaying.player

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Saving what the player hands the browser as a download.
 *
 * The player saves exports the way the web does: a `blob:` URL on an `<a download>`, clicked. A
 * WebView does nothing with that — its DownloadListener receives a URL that only means something
 * inside the page, and the page has often revoked it by then. So a small script, injected only
 * into the app's own origin, catches those clicks, reads the blob in the page, and posts it here in
 * base64 chunks over a web message listener (which, unlike a JavaScript interface, is restricted to
 * that origin by the WebView itself). The bytes are spooled to the cache directory and then
 * written wherever the person chooses in the system's "save as" dialog.
 *
 * Constructed as a property of the activity so the result launcher is registered in time.
 */
class BlobDownloads(private val activity: ComponentActivity) {

  companion object {
    const val JS_NAME = "NowPlayingDownloads"

    /** Anything bigger than this is refused rather than spooled; exports are far smaller. */
    private const val MAX_BYTES = 1L shl 30
    private const val MAX_OPEN = 4
    private val ID = Regex("^[A-Za-z0-9]{1,40}$")
    private val MIME = Regex("^[A-Za-z0-9][A-Za-z0-9.+_-]*/[A-Za-z0-9][A-Za-z0-9.+_-]*$")
    private val cleared = AtomicBoolean(false)

    /**
     * Runs at document start in the app's own frames. Hooks `<a download href="blob:…">` both for
     * real clicks and for `anchor.click()` on a detached element, and holds off `revokeObjectURL`
     * for a URL until it has been read, since the player revokes some of them straight after clicking.
     */
    val SCRIPT = """
      (function () {
        if (window.__nowPlayingDownloads) return;
        window.__nowPlayingDownloads = true;
        var port = window.$JS_NAME;
        if (!port || typeof port.postMessage !== 'function') return;
        var CHUNK = 384 * 1024;
        var reading = new Map();
        var seq = 0;
        var revoke = URL.revokeObjectURL.bind(URL);
        URL.revokeObjectURL = function (url) {
          if (reading.has(url)) { reading.set(url, true); return; }
          revoke(url);
        };
        function isBlobDownload(a) {
          return !!a && a.hasAttribute && a.hasAttribute('download') && /^blob:/i.test(a.href || '');
        }
        function readPart(part) {
          return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { var s = String(reader.result); resolve(s.slice(s.indexOf(',') + 1)); };
            reader.onerror = function () { reject(reader.error); };
            reader.readAsDataURL(part);
          });
        }
        function save(a) {
          var href = a.href;
          var name = (a.getAttribute('download') || 'download').replace(/[\r\n]/g, ' ');
          var id = 'd' + Date.now().toString(36) + (seq++).toString(36);
          reading.set(href, false);
          fetch(href).then(function (r) { return r.blob(); }).then(function (blob) {
            port.postMessage('b' + id + '\n' + (blob.type || 'application/octet-stream') + '\n' + name);
            var offset = 0;
            function next() {
              if (offset >= blob.size) { port.postMessage('e' + id); return null; }
              var part = blob.slice(offset, offset + CHUNK);
              offset += CHUNK;
              return readPart(part).then(function (data) { port.postMessage('c' + id + '\n' + data); return next(); });
            }
            return next();
          }).catch(function () {
            port.postMessage('x' + id);
          }).then(function () {
            var revokeLater = reading.get(href);
            reading.delete(href);
            if (revokeLater) revoke(href);
          });
        }
        var click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          if (isBlobDownload(this)) { save(this); return; }
          return click.apply(this, arguments);
        };
        window.addEventListener('click', function (event) {
          if (event.defaultPrevented) return;
          var target = event.target;
          var a = target && target.closest ? target.closest('a') : null;
          if (!isBlobDownload(a)) return;
          event.preventDefault();
          save(a);
        }, false);
      })();
    """.trimIndent()
  }

  private class Incoming(val file: File, val name: String, val mime: String, val out: OutputStream) {
    var bytes = 0L
  }

  private class Finished(val file: File, val name: String, val mime: String)

  private val main = Handler(Looper.getMainLooper())
  private val io = Executors.newSingleThreadExecutor()

  // Touched only on the io thread.
  private val incoming = HashMap<String, Incoming>()

  // Touched only on the main thread.
  private val waiting = ArrayDeque<Finished>()
  private var saving: Finished? = null

  private val createDocument = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
    val done = saving ?: return@registerForActivityResult
    saving = null
    val target = if (result.resultCode == Activity.RESULT_OK) result.data?.data else null
    if (target == null) {
      io.execute { done.file.delete() }
    } else {
      val app = activity.applicationContext
      io.execute {
        val ok = runCatching {
          app.contentResolver.openOutputStream(target)?.use { out -> done.file.inputStream().use { it.copyTo(out) } }
            ?: error("No stream")
        }.isSuccess
        done.file.delete()
        main.post {
          val text = if (ok) app.getString(R.string.download_saved, done.name) else app.getString(R.string.download_failed, done.name)
          Toast.makeText(app, text, Toast.LENGTH_SHORT).show()
        }
      }
    }
    launchNext()
  }

  private fun spool(): File {
    val dir = File(activity.cacheDir, "downloads")
    // Half-written spools from a previous process are litter.
    if (cleared.compareAndSet(false, true)) runCatching { dir.deleteRecursively() }
    dir.mkdirs()
    return dir
  }

  /** Called on the main thread by the web message listener, only for the app's own main frame. */
  fun onMessage(message: String) {
    if (message.isEmpty()) return
    val kind = message[0]
    val rest = message.substring(1)
    val newline = rest.indexOf('\n')
    val id = if (newline < 0) rest else rest.substring(0, newline)
    if (!ID.matches(id)) return
    val payload = if (newline < 0) "" else rest.substring(newline + 1)
    when (kind) {
      'b' -> {
        val parts = payload.split('\n', limit = 2)
        val mime = parts.getOrNull(0)?.takeIf { MIME.matches(it) } ?: "application/octet-stream"
        val name = Jobs.safeName(parts.getOrNull(1).orEmpty())
        io.execute { begin(id, name, mime) }
      }
      'c' -> io.execute { chunk(id, payload) }
      'e' -> io.execute { end(id) }
      'x' -> io.execute { abort(id) }
    }
  }

  private fun begin(id: String, name: String, mime: String) {
    if (incoming.containsKey(id) || incoming.size >= MAX_OPEN) return
    runCatching {
      val file = File(spool(), "$id.part")
      incoming[id] = Incoming(file, name, mime, FileOutputStream(file).buffered())
    }
  }

  private fun chunk(id: String, data: String) {
    val entry = incoming[id] ?: return
    val ok = runCatching {
      val bytes = Base64.decode(data, Base64.DEFAULT)
      entry.bytes += bytes.size
      check(entry.bytes <= MAX_BYTES) { "Too large" }
      entry.out.write(bytes)
    }.isSuccess
    if (!ok) abort(id)
  }

  private fun end(id: String) {
    val entry = incoming.remove(id) ?: return
    if (runCatching { entry.out.close() }.isFailure) {
      entry.file.delete()
      return
    }
    val done = Finished(entry.file, entry.name, entry.mime)
    main.post {
      waiting.addLast(done)
      if (saving == null) launchNext()
    }
  }

  private fun abort(id: String) {
    val entry = incoming.remove(id) ?: return
    runCatching { entry.out.close() }
    entry.file.delete()
  }

  private fun launchNext() {
    if (saving != null) return
    val next = waiting.removeFirstOrNull() ?: return
    if (activity.isFinishing || activity.isDestroyed) {
      io.execute { next.file.delete() }
      return
    }
    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
      .addCategory(Intent.CATEGORY_OPENABLE)
      .setType(next.mime)
      .putExtra(Intent.EXTRA_TITLE, next.name)
    saving = next
    try {
      createDocument.launch(intent)
    } catch (missing: ActivityNotFoundException) {
      saving = null
      io.execute { next.file.delete() }
      Toast.makeText(activity, activity.getString(R.string.download_failed, next.name), Toast.LENGTH_SHORT).show()
      launchNext()
    }
  }
}
