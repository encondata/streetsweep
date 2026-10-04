package net.streetsweep.ui.map

import org.osmdroid.tileprovider.tilesource.ITileSource
import org.osmdroid.tileprovider.tilesource.OnlineTileSourceBase
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.MapTileIndex

/**
 * Where map tiles come from. Signed in to a server: that server's own tile cache, which
 * fetches each tile from OpenStreetMap once for every phone and browser. Otherwise,
 * OpenStreetMap directly, as before.
 *
 * Kept up to date from the settings by AppContainer, so the phone map, the car screen and
 * anything else drawing tiles all agree.
 */
object MapTiles {
    @Volatile var serverBase: String? = null
        private set
    @Volatile var token: String? = null
        private set

    fun update(serverUrl: String?, serverToken: String?) {
        val base = net.streetsweep.data.server.ServerClient.normalise(serverUrl)
        val t = serverToken?.takeIf { it.isNotBlank() }
        serverBase = if (base != null && t != null) base else null
        token = if (base != null) t else null
        // osmdroid sends these with every tile request it makes.
        val headers = org.osmdroid.config.Configuration.getInstance().additionalHttpRequestProperties
        if (serverBase != null && token != null) headers["Authorization"] = "Bearer $token" else headers.remove("Authorization")
    }

    /** The standard map's tile at z/x/y, from the server when there is one. */
    fun osmUrl(z: Int, x: Int, y: Int): String =
        serverBase?.let { "$it/api/tiles/osm/$z/$x/$y" } ?: "https://tile.openstreetmap.org/$z/$x/$y.png"

    /** The tile source for the phone's map. A different name keeps the two caches apart. */
    fun source(): ITileSource {
        val base = serverBase ?: return TileSourceFactory.MAPNIK
        return object : OnlineTileSourceBase(
            "StreetSweepServer2", 0, 19, 256, ".png", arrayOf("$base/api/tiles/osm/"),
            "© OpenStreetMap contributors",
        ) {
            override fun getTileURLString(index: Long): String =
                "$baseUrl${MapTileIndex.getZoom(index)}/${MapTileIndex.getX(index)}/${MapTileIndex.getY(index)}"
        }
    }
}
