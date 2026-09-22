package com.example.streetsweep.domain

/** How fast an area is being finished, from the last few weeks of progress. */
object Pace {
    const val WEEK_MS = 604_800_000L
    const val DEFAULT_WINDOW_WEEKS = 4

    /**
     * Mean new metres per week over the last [windowWeeks] calendar weeks.
     *
     * Quiet weeks count as zero, so a burst three months ago does not make an area look
     * active today. Returns null only when nothing has ever been recorded.
     */
    fun recentRate(
        weeklyMeters: List<Pair<Long, Double>>,
        nowWeek: Long = System.currentTimeMillis() / WEEK_MS,
        windowWeeks: Int = DEFAULT_WINDOW_WEEKS,
    ): Double? {
        if (weeklyMeters.isEmpty() || windowWeeks <= 0) return null
        val from = nowWeek - windowWeeks + 1
        val total = weeklyMeters.filter { it.first in from..nowWeek }.sumOf { it.second }
        return total / windowWeeks
    }

    /** Weeks to finish [remainingMeters] at [metersPerWeek], or null when it is not moving. */
    fun weeksRemaining(remainingMeters: Double, metersPerWeek: Double?): Double? {
        if (metersPerWeek == null || metersPerWeek <= 1.0) return null
        if (remainingMeters <= 0) return 0.0
        return remainingMeters / metersPerWeek
    }
}
