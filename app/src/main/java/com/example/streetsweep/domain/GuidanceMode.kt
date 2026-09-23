package com.example.streetsweep.domain

/** What, if anything, the app should be pointing you towards while you drive. */
enum class GuidanceMode {
    /** Nothing. The map just records. */
    OFF,

    /** Whichever street still owing happens to be closest. Good for wandering. */
    NEAREST,

    /** A worked-out order for the whole area, chosen to keep backtracking down. */
    ROUTE,
}
