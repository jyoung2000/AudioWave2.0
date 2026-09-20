package com.nowplaying.player

import android.content.Context
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Running the tool, and turning what it leaves behind into files the player can take.
 *
 * The command line is built here and nowhere else. The page names a URL, a tool and a format; every
 * flag below is written in this file. `--ignore-config` is first for the same reason it is first in
 * the desktop helper: a configuration file left in the app's own directory would otherwise be read
 * and obeyed, and one of the flags it could add is `--exec`.
 *
 * One job at a time. These are network-bound, two at once is not twice as fast, and a queue of one
 * keeps the progress somebody is watching truthful.
 */
object Jobs {

  val startedAt: String = Instant.now().toString()

  private val jobs = ConcurrentHashMap<String, Job>()
  private val queue = Executors.newSingleThreadExecutor()

  private val audioExtensions = setOf("mp3", "m4a", "aac", "flac", "opus", "ogg", "oga", "wav", "webm", "alac", "mka")

  private val contentTypes = mapOf(
    "mp3" to "audio/mpeg",
    "m4a" to "audio/mp4",
    "aac" to "audio/aac",
    "flac" to "audio/flac",
    "opus" to "audio/ogg",
    "ogg" to "audio/ogg",
    "oga" to "audio/ogg",
    "wav" to "audio/wav",
    "webm" to "audio/webm",
    "alac" to "audio/mp4",
    "mka" to "audio/x-matroska",
  )

  class Job(val id: String, val url: String, val tool: String, val format: String, val dir: File) {
    @Volatile var state: String = "queued"
    @Volatile var stage: String = "preflight"
    @Volatile var percent: Double? = null
    @Volatile var message: String? = null
    @Volatile var error: String? = null
    @Volatile var finishedAt: String? = null
    val startedAt: String = Instant.now().toString()
    // Written by the worker, read by the bridge thread while it serialises; copy-on-write makes every
    // read a consistent snapshot instead of a ConcurrentModificationException.
    val files = CopyOnWriteArrayList<Triple<String, File, String>>() // id, file, contentType
    // Set by forget(). A queued job checks it before starting; a running one is also killed.
    @Volatile var cancelled: Boolean = false
  }

  /** Starts a job and returns it straight away; progress arrives by polling, as it does over HTTP. */
  fun create(context: Context, url: String, tool: String, format: String): Job {
    val id = UUID.randomUUID().toString()
    val dir = File(File(context.filesDir, "jobs"), id)
    dir.mkdirs()
    val job = Job(id, url, tool, format, dir)
    jobs[id] = job

    FetchService.start(context)
    queue.execute {
      try {
        run(job)
      } catch (error: Throwable) {
        // A cancelled job's process is killed from under it; that is not a failure worth reporting.
        if (!job.cancelled) fail(job, error.message ?: error.javaClass.simpleName)
      } finally {
        // forget() may have run while this was working and deleted the directory before the tool
        // wrote more into it; whatever landed afterwards goes too.
        if (job.cancelled) {
          // run() may have marked it running just after it was cancelled; a job left "running"
          // would keep the service up forever.
          if (job.state == "queued" || job.state == "running") job.state = if (job.error != null) "failed" else "cancelled"
          runCatching { job.dir.deleteRecursively() }
        }
        if (jobs.values.none { it.state == "queued" || it.state == "running" }) FetchService.stop(context)
      }
    }
    return job
  }

  private fun run(job: Job) {
    // Forgotten while it waited in the queue: never start it.
    if (job.cancelled) return
    if (!Tools.isReady()) return fail(job, "The tools are still setting themselves up. Try again in a moment.")
    job.state = "running"
    job.stage = "fetching"
    if (job.cancelled) return

    val request = YoutubeDLRequest(job.url)
    request.addOption("--ignore-config")
    request.addOption("--no-colors")
    request.addOption("--newline")
    request.addOption("--no-mtime")
    request.addOption("--no-cache-dir")
    // A link can point at a whole album; a cap stops one paste from becoming a thousand files.
    request.addOption("--playlist-end", "200")
    request.addOption("--paths", job.dir.absolutePath)
    request.addOption("--output", "%(title).180B.%(ext)s")
    request.addOption("--extract-audio")
    request.addOption("--embed-metadata")
    if (job.format != "original") request.addOption("--audio-format", job.format)

    val response = YoutubeDL.getInstance().execute(request, job.id) { progress, _, line ->
      if (progress >= 0f) job.percent = progress.toDouble().coerceIn(0.0, 100.0)
      val text = line.trim()
      if (text.isNotEmpty()) {
        job.message = text.take(400)
        if (text.startsWith("[ExtractAudio]") || text.startsWith("[Merger]") || text.startsWith("[Metadata]")) job.stage = "converting"
      }
    }

    if (job.cancelled) return
    if (response.exitCode != 0) return fail(job, lastMeaningfulLine(response.err) ?: "yt-dlp exited with code ${response.exitCode}.")

    job.stage = "finalizing"
    collect(job)
    if (job.files.isEmpty()) return fail(job, "yt-dlp finished without producing an audio file.")
    job.state = "done"
    job.stage = "done"
    job.percent = 100.0
    job.finishedAt = Instant.now().toString()
  }

  private fun collect(job: Job) {
    // Built and sorted privately, then published in one step, so a reader never sees a half-list.
    val found = job.dir.walkTopDown().maxDepth(4)
      .filter { it.isFile && it.extension.lowercase() in audioExtensions }
      .map { file -> Triple(UUID.randomUUID().toString(), file, contentTypes[file.extension.lowercase()] ?: "application/octet-stream") }
      .sortedBy { it.second.name }
      .toList()
    job.files.addAll(found)
  }

  private fun fail(job: Job, reason: String) {
    job.state = "failed"
    job.stage = "done"
    job.error = reason.take(600)
    job.finishedAt = Instant.now().toString()
  }

  fun get(id: String): Job? = jobs[id]

  fun fileFor(jobId: String, fileId: String): Pair<File, String>? {
    val job = jobs[jobId] ?: return null
    val entry = job.files.firstOrNull { it.first == fileId } ?: return null
    return entry.second to entry.third
  }

  /** Stops it if it is running, and takes its working directory with it either way. */
  fun forget(id: String): Boolean {
    val job = jobs.remove(id) ?: return false
    val active = job.state == "queued" || job.state == "running"
    // Flag first: a queued job sees it before it starts, a running one after its process dies.
    job.cancelled = true
    if (active) {
      // Harmless when there is no process yet; necessary when one started between the two lines.
      runCatching { YoutubeDL.getInstance().destroyProcessById(id) }
      job.state = "cancelled"
    }
    runCatching { job.dir.deleteRecursively() }
    return true
  }

  /**
   * Ends every queued or running job with a reason the page can show. Used when Android withdraws
   * the foreground service's time: carrying on without it would be work the system is about to kill.
   */
  fun stopAll(reason: String) {
    for (job in jobs.values) {
      if (job.state != "queued" && job.state != "running") continue
      job.cancelled = true
      runCatching { YoutubeDL.getInstance().destroyProcessById(job.id) }
      fail(job, reason)
    }
  }

  private val swept = AtomicBoolean(false)

  /**
   * Anything left behind by a previous *process* is litter; it is cleared once, at a cold start.
   *
   * Only once per process: the activity can be finished and recreated while this object, the
   * foreground service and a running job all live on, and sweeping then would delete a download
   * from under the tool that is writing it.
   */
  fun sweep(context: Context) {
    if (!swept.compareAndSet(false, true)) return
    runCatching { File(context.filesDir, "jobs").deleteRecursively() }
  }

  fun toJson(job: Job): String {
    val files = JSONArray()
    for ((id, file, contentType) in job.files) {
      files.put(
        JSONObject()
          .put("id", id)
          // Rebuilt rather than trusted: it came from a page title on somebody else's site.
          .put("name", safeName(file.name))
          .put("sizeBytes", file.length())
          .put("contentType", contentType),
      )
    }
    return JSONObject()
      .put("id", job.id)
      .put("state", job.state)
      .put("url", job.url)
      .put("tool", job.tool)
      .put("format", job.format)
      .put("stage", job.stage)
      .put("percent", job.percent ?: JSONObject.NULL)
      .put("message", job.message ?: JSONObject.NULL)
      .put("files", files)
      .put("error", job.error ?: JSONObject.NULL)
      .put("startedAt", job.startedAt)
      .put("finishedAt", job.finishedAt ?: JSONObject.NULL)
      .toString()
  }

  fun safeName(name: String): String {
    val cleaned = name.replace(Regex("[\\u0000-\\u001f<>:\"/\\\\|?*]"), "-").trim().trim('.')
    return if (cleaned.isEmpty()) "track" else cleaned.take(180)
  }

  /** Tools put the useful part of a failure last, after a stack of warnings nobody needs. */
  fun lastMeaningfulLine(stderr: String): String? =
    stderr.split("\n")
      .map { it.trim() }
      .filter { it.isNotEmpty() && !it.startsWith("WARNING:", ignoreCase = true) }
      .lastOrNull()
      ?.removePrefix("ERROR:")
      ?.trim()
      ?.take(600)
}
