package com.example.streetsweep.domain

/** What started a recording session. Automatic sources can also stop it; manual sessions only stop manually. */
enum class TriggerSource(val label: String) {
    MANUAL("Manual"),
    BLUETOOTH("Bluetooth"),
    ANDROID_AUTO("Android Auto"),
    IN_VEHICLE("In vehicle");

    val isAutomatic: Boolean get() = this != MANUAL

    companion object {
        fun fromName(name: String?): TriggerSource =
            entries.firstOrNull { it.name == name } ?: MANUAL
    }
}

enum class TrackingMode { MANUAL, AUTOMATIC }
