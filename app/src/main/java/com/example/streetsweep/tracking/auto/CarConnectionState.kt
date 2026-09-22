package com.example.streetsweep.tracking.auto

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.car.app.connection.CarConnection

/**
 * Synchronous read of the Android Auto / Automotive connection state, for use from
 * broadcast receivers and workers where observing [CarConnection.getType] is impractical.
 * Reads the same content provider the Car App Library's LiveData observes.
 */
object CarConnectionState {
    private const val TAG = "CarConnectionState"
    private const val AUTHORITY = "androidx.car.app.connection"
    private const val COLUMN = "CarConnectionState"
    private val uri: Uri = Uri.Builder().scheme("content").authority(AUTHORITY).build()

    /** One of [CarConnection.CONNECTION_TYPE_NOT_CONNECTED], _NATIVE or _PROJECTION. */
    fun current(context: Context): Int = try {
        context.contentResolver.query(uri, arrayOf(COLUMN), null, null, null)?.use { cursor ->
            if (cursor.moveToNext()) cursor.getInt(cursor.getColumnIndexOrThrow(COLUMN))
            else CarConnection.CONNECTION_TYPE_NOT_CONNECTED
        } ?: CarConnection.CONNECTION_TYPE_NOT_CONNECTED
    } catch (e: Exception) {
        Log.d(TAG, "Car connection provider unavailable: ${e.message}")
        CarConnection.CONNECTION_TYPE_NOT_CONNECTED
    }

    fun isConnected(context: Context): Boolean = isConnectedType(current(context))

    fun isConnectedType(type: Int?): Boolean =
        type != null && type != CarConnection.CONNECTION_TYPE_NOT_CONNECTED
}
