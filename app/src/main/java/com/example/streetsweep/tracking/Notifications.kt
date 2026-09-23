package com.example.streetsweep.tracking

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.example.streetsweep.MainActivity
import com.example.streetsweep.R
import com.example.streetsweep.domain.Geo
import com.example.streetsweep.domain.TriggerSource
import java.text.DateFormat
import java.util.Date

object Notifications {
    const val CHANNEL_TRACKING = "tracking"
    const val CHANNEL_ALERTS = "alerts"
    const val ID_TRACKING = 1
    const val ID_START_PROMPT = 2
    const val ID_WORKER = 3
    const val ID_DOWNLOAD = 4
    const val ID_SUMMARY = 5

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_TRACKING,
                context.getString(R.string.notification_channel_tracking),
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "Shown while a drive is being recorded" },
        )
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ALERTS,
                context.getString(R.string.notification_channel_alerts),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { description = "Prompts to start recording and permission problems" },
        )
    }

    private fun openAppIntent(context: Context): PendingIntent = PendingIntent.getActivity(
        context,
        0,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    fun tracking(context: Context, status: TrackingStatus.Recording?): Notification {
        val title: String
        val text: String
        if (status == null) {
            title = "Starting drive recording…"
            text = "Waiting for GPS"
        } else {
            val started = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(status.startedAt))
            title = if (status.isPaused) {
                "Paused · ${Geo.formatDistance(status.distanceMeters)}"
            } else {
                "Recording drive · ${Geo.formatDistance(status.distanceMeters)}"
            }
            text = buildString {
                if (status.isPaused) append("Not recording. ")
                append("${status.pointCount} points since $started")
                if (status.trigger.isAutomatic) append(" · via ${status.trigger.label}")
                status.stopScheduledAt?.let { at ->
                    val secs = ((at - System.currentTimeMillis()) / 1000).coerceAtLeast(0)
                    append(" · car disconnected, stopping in ${secs}s")
                }
            }
        }
        val stopIntent = PendingIntent.getService(
            context,
            1,
            Intent(context, TrackingService::class.java).setAction(TrackingService.ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val paused = (status as? TrackingStatus.Recording)?.isPaused == true
        val holdIntent = PendingIntent.getService(
            context,
            2,
            Intent(context, TrackingService::class.java)
                .setAction(if (paused) TrackingService.ACTION_RESUME else TrackingService.ACTION_PAUSE),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(context, CHANNEL_TRACKING)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openAppIntent(context))
            .addAction(0, if (paused) "Resume" else "Pause", holdIntent)
            .addAction(0, "Stop", stopIntent)
            .build()
    }

    /**
     * Shown when a trigger fired but Android would not let the app start a foreground
     * service from the background (e.g. wired Android Auto detected from the USB power
     * event). Tapping the action is a user interaction, which is always allowed to start it.
     */
    @SuppressLint("MissingPermission")
    fun showStartPrompt(context: Context, trigger: TriggerSource) {
        if (!Permissions.hasNotifications(context)) return
        val startIntent = PendingIntent.getForegroundService(
            context,
            2,
            TrackingService.startIntent(context, trigger),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ALERTS)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("${trigger.label} connected")
            .setContentText("Tap to start recording this drive")
            .setAutoCancel(true)
            .setContentIntent(startIntent)
            .addAction(0, "Start recording", startIntent)
            .build()
        NotificationManagerCompat.from(context).notify(ID_START_PROMPT, notification)
    }

    fun cancelStartPrompt(context: Context) = NotificationManagerCompat.from(context).cancel(ID_START_PROMPT)

    /** Posted when a drive ends: what it added, and where that leaves the area. */
    @SuppressLint("MissingPermission")
    fun showDriveSummary(context: Context, title: String, body: String) {
        if (!Permissions.hasNotifications(context)) return
        val notification = NotificationCompat.Builder(context, CHANNEL_ALERTS)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(context))
            .build()
        NotificationManagerCompat.from(context).notify(ID_SUMMARY, notification)
    }

    @SuppressLint("MissingPermission")
    fun showAlert(context: Context, title: String, text: String) {
        if (!Permissions.hasNotifications(context)) return
        val notification = NotificationCompat.Builder(context, CHANNEL_ALERTS)
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(context))
            .build()
        NotificationManagerCompat.from(context).notify(ID_START_PROMPT, notification)
    }

    fun download(context: Context, areaName: String, done: Int, total: Int): Notification =
        NotificationCompat.Builder(context, CHANNEL_TRACKING)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Downloading streets for $areaName")
            .setContentText(if (total > 0) "$done of $total map cells" else "Starting…")
            .setProgress(total, done, total == 0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openAppIntent(context))
            .build()

    fun worker(context: Context): Notification =
        NotificationCompat.Builder(context, CHANNEL_TRACKING)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Checking for Android Auto…")
            .setOngoing(true)
            .build()
}
