package net.streetsweep.domain

/** Which way up the map is drawn. */
enum class MapRotation(val label: String) {
    /** North stays at the top. Steady, and matches how an area was drawn. */
    NORTH_UP("North up"),

    /** The direction of travel points up, so a left turn is a left turn on screen. */
    DRIVING_UP("Driving up"),
}

/** What the map is drawn on. */
enum class MapBase(val label: String) {
    /** OpenStreetMap's standard rendering. */
    MAP("Map"),

    /** Aerial imagery. Useful for driveways, verges and anything OSM has not drawn. */
    SATELLITE("Satellite"),
}
