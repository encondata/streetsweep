package com.example.streetsweep.tracking.auto

import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.IntentCompat
import com.example.streetsweep.appContainer
import com.example.streetsweep.domain.TrackingMode
import com.example.streetsweep.domain.TriggerSource
import com.example.streetsweep.tracking.Notifications
import com.example.streetsweep.tracking.TrackingService
import kotlinx.coroutines.runBlocking

/**
 * Automatic mode, Bluetooth trigger.
 *
 * ACL_CONNECTED / ACL_DISCONNECTED are exempt from the implicit-broadcast limits, so a
 * manifest receiver gets them even when the app is not running. Receiving a broadcast that
 * needs BLUETOOTH_CONNECT is also one of the cases in which Android lets an app start a
 * foreground service from the background, which is what makes hands-free auto-start work.
 */
class BluetoothTriggerReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != BluetoothDevice.ACTION_ACL_CONNECTED && action != BluetoothDevice.ACTION_ACL_DISCONNECTED) return
        val device = IntentCompat.getParcelableExtra(intent, BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
        val address = device?.address ?: return

        val settings = runBlocking { context.appContainer.settings.current() }
        if (settings.mode != TrackingMode.AUTOMATIC) return
        val isTriggerDevice = settings.bluetoothTriggerAddress.equals(address, ignoreCase = true)
        Log.d(TAG, "$action from $address (trigger device: $isTriggerDevice)")

        when (action) {
            BluetoothDevice.ACTION_ACL_CONNECTED -> when {
                isTriggerDevice -> {
                    if (!TrackingService.start(context, TriggerSource.BLUETOOTH)) {
                        Notifications.showStartPrompt(context, TriggerSource.BLUETOOTH)
                    }
                }
                settings.androidAutoTriggerEnabled -> {
                    // Wireless Android Auto pairs over Bluetooth first; projection follows shortly.
                    if (CarConnectionState.isConnected(context)) {
                        if (!TrackingService.start(context, TriggerSource.ANDROID_AUTO)) {
                            Notifications.showStartPrompt(context, TriggerSource.ANDROID_AUTO)
                        }
                    } else {
                        CarConnectionCheckWorker.schedule(context)
                    }
                }
            }
            BluetoothDevice.ACTION_ACL_DISCONNECTED -> if (isTriggerDevice) {
                TrackingService.notifyTriggerDisconnected(context, TriggerSource.BLUETOOTH)
            }
        }
    }

    private companion object {
        const val TAG = "BluetoothTrigger"
    }
}
