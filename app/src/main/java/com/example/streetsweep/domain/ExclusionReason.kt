package com.example.streetsweep.domain

/** Why a street does not count toward an area's coverage. */
enum class ExclusionReason(val label: String) {
    GATED("Gated or private"),
    NOT_DRIVABLE("Not drivable"),
    NOT_NEEDED("Not needed"),
    OTHER("Other");

    companion object {
        fun fromName(name: String?): ExclusionReason = entries.firstOrNull { it.name == name } ?: OTHER
    }
}
