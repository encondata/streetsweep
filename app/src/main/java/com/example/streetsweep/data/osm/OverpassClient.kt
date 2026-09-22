package com.example.streetsweep.data.osm

import com.example.streetsweep.domain.Bounds
import com.example.streetsweep.domain.Geo
import com.example.streetsweep.domain.LatLngPoint
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

data class OsmStreet(
    val id: Long,
    val name: String?,
    val highway: String,
    val lengthMeters: Double,
    val shape: List<LatLngPoint>,
)

class OverpassException(message: String) : IOException(message)

/** Downloads the drivable street network inside a bounding box from the Overpass API. */
class OverpassClient(private val baseUrl: suspend () -> String) {

    suspend fun streetsIn(box: Bounds): List<OsmStreet> = withContext(Dispatchers.IO) {
        val query = "[out:json][timeout:90];" +
            "way[\"highway\"~\"^($HIGHWAY_CLASSES)(_link)?\$\"]" +
            "(${box.south},${box.west},${box.north},${box.east});out geom;"
        val conn = URL(baseUrl()).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 15_000
            conn.readTimeout = 120_000
            conn.doOutput = true
            conn.setRequestProperty("User-Agent", ValhallaClient.USER_AGENT)
            conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            conn.outputStream.use { it.write(("data=" + URLEncoder.encode(query, "UTF-8")).toByteArray()) }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code !in 200..299) throw OverpassException("Overpass HTTP $code" + if (code == 429) " (rate limited, try again in a minute)" else "")
            parse(text)
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        const val DEFAULT_BASE_URL = "https://overpass-api.de/api/interpreter"

        /** Streets a car can be expected to sweep. No motorways, service roads or driveways. */
        const val HIGHWAY_CLASSES = "primary|secondary|tertiary|unclassified|residential|living_street"

        fun parse(json: String): List<OsmStreet> = try {
            val root = JSONObject(json)
            val elements = root.optJSONArray("elements") ?: return emptyList()
            val out = ArrayList<OsmStreet>(elements.length())
            for (i in 0 until elements.length()) {
                val e = elements.getJSONObject(i)
                if (e.optString("type") != "way") continue
                val geom = e.optJSONArray("geometry") ?: continue
                val shape = List(geom.length()) { j ->
                    val g = geom.getJSONObject(j)
                    LatLngPoint(g.getDouble("lat"), g.getDouble("lon"))
                }
                if (shape.size < 2) continue
                val tags = e.optJSONObject("tags") ?: JSONObject()
                var length = 0.0
                for (j in 1 until shape.size) length += Geo.distanceMeters(shape[j - 1], shape[j])
                out += OsmStreet(
                    id = e.getLong("id"),
                    name = tags.optString("name").takeIf { it.isNotEmpty() },
                    highway = tags.optString("highway"),
                    lengthMeters = length,
                    shape = shape,
                )
            }
            out
        } catch (e: JSONException) {
            throw OverpassException("Malformed Overpass response: ${e.message}")
        }
    }
}
