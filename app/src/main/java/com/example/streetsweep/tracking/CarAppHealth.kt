package com.example.streetsweep.tracking

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager

/**
 * Why the car screen might not be showing up.
 *
 * A sideloaded car app is easy to lose: Android Auto only lists apps it was told to
 * trust, and that permission is in a developer menu that its own updates reset. When the
 * app vanishes from the car launcher there is no way to tell from the car whether the
 * app is broken or merely unlisted, so it reports what it can see from here.
 */
data class CarAppHealth(
    /** The car service this app declares, as the system resolves it. */
    val serviceDeclared: Boolean,
    val serviceEnabled: Boolean,
    val androidAutoInstalled: Boolean,
    val androidAutoVersion: String?,
) {
    val looksRight: Boolean get() = serviceDeclared && serviceEnabled && androidAutoInstalled

    companion object {
        const val ANDROID_AUTO = "com.google.android.projection.gearhead"

        fun read(context: Context): CarAppHealth {
            val pm = context.packageManager
            val services = pm.queryIntentServices(
                Intent("androidx.car.app.CarAppService").setPackage(context.packageName),
                0,
            )
            val component = ComponentName(context, "com.example.streetsweep.car.StreetSweepCarAppService")
            val enabled = when (pm.getComponentEnabledSetting(component)) {
                PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER,
                PackageManager.COMPONENT_ENABLED_STATE_DISABLED_UNTIL_USED,
                -> false
                else -> true
            }
            val auto = runCatching { pm.getPackageInfo(ANDROID_AUTO, 0) }.getOrNull()
            return CarAppHealth(
                serviceDeclared = services.isNotEmpty(),
                serviceEnabled = enabled,
                androidAutoInstalled = auto != null,
                androidAutoVersion = auto?.versionName,
            )
        }

        /** Opens Android Auto itself, where the developer menu and app list live. */
        fun openAndroidAuto(context: Context): Boolean {
            val intent = context.packageManager.getLaunchIntentForPackage(ANDROID_AUTO) ?: return false
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            return runCatching { context.startActivity(intent); true }.getOrDefault(false)
        }
    }
}
