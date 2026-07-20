package io.markerusa.feedback

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import java.util.Locale
import java.util.TimeZone

/** Collects the Android equivalent of web's `collectDeviceContext`. */
internal object DeviceInfo {

    fun collect(context: Context, sdkVersion: String, route: String?): DeviceContext {
        val metrics = context.resources.displayMetrics

        var appVersion: String? = null
        var appBuild: String? = null
        try {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            appVersion = info.versionName
            appBuild = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                info.longVersionCode.toString()
            } else {
                @Suppress("DEPRECATION")
                info.versionCode.toString()
            }
        } catch (e: PackageManager.NameNotFoundException) {
            // Cannot happen for our own package, but the API forces the catch.
        }

        return DeviceContext(
            platform = Platform.ANDROID,
            sdkVersion = sdkVersion,
            osName = "Android",
            osVersion = Build.VERSION.RELEASE,
            deviceModel = "${Build.MANUFACTURER} ${Build.MODEL}".trim(),
            locale = Locale.getDefault().toLanguageTag(),
            timezone = TimeZone.getDefault().id,
            screenWidth = metrics.widthPixels,
            screenHeight = metrics.heightPixels,
            pixelRatio = metrics.density,
            route = route,
            appVersion = appVersion,
            appBuild = appBuild,
            // Deliberately omitted: reading it requires ACCESS_NETWORK_STATE, and an
            // SDK that forces a new permission onto the host app's manifest is an
            // SDK that gets removed. Better a null field than a permission prompt.
            networkType = null
        )
    }
}
