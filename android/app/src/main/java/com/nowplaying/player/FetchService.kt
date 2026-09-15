package com.nowplaying.player

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder

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

    fun start(context: Context) {
      runCatching {
        val intent = Intent(context, FetchService::class.java)
        context.startForegroundService(intent)
      }
    }

    fun stop(context: Context) {
      runCatching { context.stopService(Intent(context, FetchService::class.java)) }
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    runCatching { startForeground(NOTIFICATION_ID, notification()) }
    // Not sticky: a restarted service with no job to protect is a notification about nothing.
    return START_NOT_STICKY
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
