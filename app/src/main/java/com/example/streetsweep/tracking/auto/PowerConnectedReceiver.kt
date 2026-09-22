package com.example.streetsweep.tracking.auto

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.example.streetsweep.appContainer
import com.example.streetsweep.domain.TrackingMode
import com.example.streetsweep.domain.TriggerSource
import com.example.streetsweep.tracking.Notifications
import com.example.streetsweep.tracking.TrackingService
import com.example.streetsweep.tracking.TrackingStateHolder
import kotlinx.coroutines.runBlocking

/**
 * Wired Android Auto starts with the phone being plugged in. ACTION_POWER_CONNECTED is
 * exempt from the implicit-broadcast limits, so use it as a wake-up to look for projection.
 * This event does not permit a background foreground-service start on Android 12+, so if
 * the direct start is refused the user gets a one-tap "Start recording" notification.
 */
class PowerConnectedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_POWER_CONNECTED) return
        val settings = runBlocking { context.appContainer.settings.current() }
        if (settings.mode != TrackingMode.AUTOMATIC || !settings.androidAutoTriggerEnabled) return
        if (TrackingStateHolder.isRecording) return

        if (CarConnectionState.isConnected(context)) {
            if (!TrackingService.start(context, TriggerSource.ANDROID_AUTO)) {
                Notifications.showStartPrompt(context, TriggerSource.ANDROID_AUTO)
            }
        } else {
            CarConnectionCheckWorker.schedule(context)
        }
    }
}
