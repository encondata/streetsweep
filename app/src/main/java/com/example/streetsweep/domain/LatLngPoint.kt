package com.example.streetsweep.domain

/** Plain coordinate pair with no Android or Maps SDK dependency, so core logic stays unit-testable. */
data class LatLngPoint(val latitude: Double, val longitude: Double)
