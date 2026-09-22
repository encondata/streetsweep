package com.example.streetsweep.domain

/**
 * Decides whether a GPS fix is worth storing.
 *
 * Fixes arrive every [UPDATE_INTERVAL_MS]; a fix is stored only if it is at least
 * [MIN_SPACING_FEET] from the last *stored* point, so sitting at a red light produces
 * a single point rather than one every 15 seconds. Fixes with poor reported accuracy
 * are discarded outright so a bad fix never pollutes the track or the spacing rule.
 */
class PointFilter(
    val minSpacingMeters: Double = MIN_SPACING_METERS,
    val maxAccuracyMeters: Float = MAX_ACCURACY_METERS,
) {
    enum class Decision { STORE, TOO_CLOSE, INACCURATE }

    /**
     * @param accuracyMeters horizontal accuracy radius; 0 means "unknown" and is allowed through.
     * @param lastStored the last point that was actually persisted for this session, or null at session start.
     */
    fun evaluate(candidate: LatLngPoint, accuracyMeters: Float, lastStored: LatLngPoint?): Decision {
        if (accuracyMeters > maxAccuracyMeters) return Decision.INACCURATE
        if (lastStored == null) return Decision.STORE
        return if (Geo.distanceMeters(lastStored, candidate) >= minSpacingMeters) {
            Decision.STORE
        } else {
            Decision.TOO_CLOSE
        }
    }

    companion object {
        const val UPDATE_INTERVAL_MS = 15_000L
        const val MIN_SPACING_FEET = 50.0
        val MIN_SPACING_METERS: Double = Geo.feetToMeters(MIN_SPACING_FEET) // ≈ 15.24 m
        const val MAX_ACCURACY_METERS = 50f
    }
}
