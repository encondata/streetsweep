package com.example.streetsweep.tracking.auto

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import com.example.streetsweep.tracking.Permissions
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/**
 * Bonded (paired) Bluetooth devices and which of them are connected right now.
 * Connection state is read through the public HFP and A2DP profile proxies, which is
 * what car head units expose. All calls need BLUETOOTH_CONNECT on Android 12+.
 */
object BluetoothDevices {
    data class Info(val name: String, val address: String, val connected: Boolean)

    private fun adapter(context: Context): BluetoothAdapter? =
        context.getSystemService(BluetoothManager::class.java)?.adapter

    @SuppressLint("MissingPermission")
    suspend fun bonded(context: Context): List<Info> {
        if (!Permissions.hasBluetoothConnect(context)) return emptyList()
        val adapter = adapter(context) ?: return emptyList()
        val connected = connectedAddresses(context)
        return try {
            adapter.bondedDevices.orEmpty()
        } catch (e: SecurityException) {
            emptySet()
        }.map { d ->
            Info(
                name = d.name?.takeIf { it.isNotBlank() } ?: d.address,
                address = d.address,
                connected = d.address.uppercase() in connected,
            )
        }.sortedWith(compareByDescending<Info> { it.connected }.thenBy { it.name.lowercase() })
    }

    suspend fun connectedAddresses(context: Context): Set<String> {
        if (!Permissions.hasBluetoothConnect(context)) return emptySet()
        val adapter = adapter(context) ?: return emptySet()
        if (!adapter.isEnabled) return emptySet()
        val devices = connectedFor(context, adapter, BluetoothProfile.HEADSET) +
            connectedFor(context, adapter, BluetoothProfile.A2DP)
        return devices.map { it.address.uppercase() }.toSet()
    }

    suspend fun isConnected(context: Context, address: String): Boolean =
        address.uppercase() in connectedAddresses(context)

    @SuppressLint("MissingPermission")
    private suspend fun connectedFor(context: Context, adapter: BluetoothAdapter, profile: Int): List<BluetoothDevice> =
        withTimeoutOrNull(3_000) {
            suspendCancellableCoroutine { cont ->
                val listener = object : BluetoothProfile.ServiceListener {
                    override fun onServiceConnected(p: Int, proxy: BluetoothProfile) {
                        val devices = try {
                            proxy.connectedDevices
                        } catch (e: SecurityException) {
                            emptyList()
                        }
                        adapter.closeProfileProxy(p, proxy)
                        if (cont.isActive) cont.resume(devices)
                    }

                    override fun onServiceDisconnected(p: Int) = Unit
                }
                val ok = adapter.getProfileProxy(context.applicationContext, listener, profile)
                if (!ok && cont.isActive) cont.resume(emptyList())
            }
        } ?: emptyList()
}
