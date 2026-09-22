package com.example.streetsweep.data.osm

import com.example.streetsweep.domain.LatLngPoint
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** One road segment (between intersections) the trace was matched onto. */
data class MatchedEdge(
    val wayId: Long,
    val names: List<String>,
    val roadClass: String,
    val lengthMeters: Double,
    /** Geometry of just this edge, taken from the matched shape. */
    val shape: List<LatLngPoint>,
)

data class MatchResult(
    /** Road-following geometry for the whole trace. */
    val shape: List<LatLngPoint>,
    val edges: List<MatchedEdge>,
    /** For each input point, the index into [edges] it matched to, or null if unmatched. */
    val matchedEdgeIndex: List<Int?>,
)

class RoadMatchException(message: String) : IOException(message)

interface RoadMatchClient {
    suspend fun match(points: List<LatLngPoint>): MatchResult
}

/**
 * Map matching through Valhalla's `trace_attributes` endpoint (OpenStreetMap data).
 * Default server is the community instance run by FOSSGIS e.V.; fair use only.
 */
class ValhallaClient(private val baseUrl: suspend () -> String) : RoadMatchClient {

    override suspend fun match(points: List<LatLngPoint>): MatchResult = withContext(Dispatchers.IO) {
        require(points.size >= 2) { "Need at least two points to match" }
        val body = JSONObject().apply {
            put("shape", JSONArray().apply { points.forEach { put(JSONObject().put("lat", it.latitude).put("lon", it.longitude)) } })
            put("costing", "auto")
            put("shape_match", "map_snap")
            put("units", "kilometers")
            put("filters", JSONObject().put("action", "include").put("attributes", JSONArray(ATTRIBUTES)))
        }
        val url = URL(baseUrl().trimEnd('/') + "/trace_attributes")
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("User-Agent", USER_AGENT)
            conn.outputStream.use { it.write(body.toString().toByteArray()) }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code !in 200..299) throw RoadMatchException(parseError(text) ?: "Valhalla HTTP $code")
            parse(text)
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        const val DEFAULT_BASE_URL = "https://valhalla1.openstreetmap.de"
        const val USER_AGENT = "StreetSweep/1.0 (personal street-coverage app)"
        private val ATTRIBUTES = listOf(
            "edge.way_id", "edge.names", "edge.length", "edge.road_class",
            "edge.begin_shape_index", "edge.end_shape_index",
            "shape", "matched.point", "matched.type", "matched.edge_index",
        )

        fun parseError(json: String): String? = try {
            JSONObject(json).optString("error").takeIf { it.isNotEmpty() }
        } catch (e: JSONException) {
            null
        }

        fun parse(json: String): MatchResult = try {
            val root = JSONObject(json)
            root.optString("error").takeIf { it.isNotEmpty() }?.let { throw RoadMatchException(it) }
            val shape = EncodedPolyline.decode(root.optString("shape"), precision = 6)
            val edgesJson = root.optJSONArray("edges") ?: JSONArray()
            val edges = List(edgesJson.length()) { i ->
                val e = edgesJson.getJSONObject(i)
                val begin = e.optInt("begin_shape_index", 0).coerceIn(0, maxOf(0, shape.size - 1))
                val end = e.optInt("end_shape_index", begin).coerceIn(begin, maxOf(0, shape.size - 1))
                val names = e.optJSONArray("names")?.let { arr -> List(arr.length()) { arr.getString(it) } }.orEmpty()
                MatchedEdge(
                    wayId = e.optLong("way_id", -1L),
                    names = names,
                    roadClass = e.optString("road_class", ""),
                    lengthMeters = e.optDouble("length", 0.0) * 1000.0,
                    shape = if (shape.isEmpty()) emptyList() else shape.subList(begin, end + 1),
                )
            }
            val matchedJson = root.optJSONArray("matched_points") ?: JSONArray()
            val matched = List(matchedJson.length()) { i ->
                val m = matchedJson.getJSONObject(i)
                if (m.optString("type") == "unmatched" || !m.has("edge_index")) null else m.getInt("edge_index")
            }
            MatchResult(shape, edges, matched)
        } catch (e: JSONException) {
            throw RoadMatchException("Malformed Valhalla response: ${e.message}")
        }
    }
}
