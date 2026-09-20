package com.nowplaying.player

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * Keeps a fetch alive when somebody switches away from the app.
 *
 * Android is entitled to stop background work, and losing ten minutes of downloading because a
 * message arrived would be a poor way to find that out. A foreground service is the sanctioned way
 * to say "this is work the person asked for and is waiting on", and the notification it requires is
 * a feature rather than a tax: it is where the work is visible from outside the app.
 *
 * Nothing here is allowed to break a fetch. If the service cannot start — an unusual OEM, a denied
 * notification permission — the job runs anyway and simply loses its protection.
 */
class FetchService : Service() {

  companion object {
    private const val CHANNEL = "fetches"
    private const val NOTIFICATION_ID = 1

    /*
     * Stopping is routed through the service rather than done with stopService().
     *
     * A service started with startForegroundService() that is stopped before it has called
     * startForeground() takes the whole app down ("did not then call Service.startForeground()").
     * A job that fails in its first second would do exactly that. So stop() only records that the
     * work is over; the service acts on it once it is safely in the foreground.
     */
    private val lock = Any()
    private var wanted = false
    private var running: FetchService? = null

    fun start(context: Context) {
      synchronized(lock) { wanted = true }
      runCatching {
        val intent = Intent(context, FetchService::class.java)
        context.startForegroundService(intent)
      }
    }

    fun stop(@Suppress("UNUSED_PARAMETER") context: Context) {
      synchronized(lock) {
        wanted = false
        running?.stopSelf()
      }
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val promoted = runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        startForeground(NOTIFICATION_ID, notification())
      }
    }
    synchronized(lock) {
      if (promoted.isFailure) {
        // Refused (the daily dataSync allowance on Android 15 is spent, or an OEM said no). The job
        // runs on without protection, as promised above; a service that is not in the foreground
        // has no business staying up.
        Log.w("FetchService", "Could not enter the foreground", promoted.exceptionOrNull())
        running = null
        stopSelf()
      } else if (!wanted) {
        // The work finished before the service got here. By start id, so a newer start still wins.
        running = null
        stopSelf(startId)
      } else {
        running = this
      }
    }
    // Not sticky: a restarted service with no job to protect is a notification about nothing.
    return START_NOT_STICKY
  }

  /**
   * Android 15 limits dataSync services to six hours a day and calls this when time is up. The
   * service must stop within seconds or the app is killed, and the work it was protecting would die
   * with it, so the jobs are ended with a reason the player can show.
   */
  override fun onTimeout(startId: Int, fgsType: Int) {
    Jobs.stopAll("Android stopped the download: this app has used its background download time for today. Try again later.")
    synchronized(lock) {
      wanted = false
      running = null
    }
    stopSelf()
  }

  override fun onDestroy() {
    synchronized(lock) { if (running === this) running = null }
    super.onDestroy()
  }

  private fun notification(): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL) == null) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, getString(R.string.channel_fetches), NotificationManager.IMPORTANCE_LOW).apply {
          description = getString(R.string.channel_fetches_description)
          setShowBadge(false)
        },
      )
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
    return builder
      .setContentTitle(getString(R.string.fetching_title))
      .setContentText(getString(R.string.fetching_text))
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setOngoing(true)
      .build()
  }
}
