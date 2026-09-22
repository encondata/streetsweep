package com.example.streetsweep.ui.common

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

object Format {
    private val dateTime: DateTimeFormatter = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
    private val time: DateTimeFormatter = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)

    fun dateTime(epochMillis: Long): String =
        dateTime.format(Instant.ofEpochMilli(epochMillis).atZone(ZoneId.systemDefault()))

    fun time(epochMillis: Long): String =
        time.format(Instant.ofEpochMilli(epochMillis).atZone(ZoneId.systemDefault()))

    fun duration(millis: Long): String {
        val totalMinutes = (millis / 60_000).coerceAtLeast(0)
        val hours = totalMinutes / 60
        val minutes = totalMinutes % 60
        return if (hours > 0) "${hours}h ${minutes}m" else "${minutes}m"
    }
}
