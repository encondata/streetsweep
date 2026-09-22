package com.example.streetsweep.data.osm

import com.example.streetsweep.domain.AreaLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AreaGeoJsonTest {

    /** What tools/area-builder.html writes out. */
    private val fromBuilder = """
        {"type":"FeatureCollection","features":[
          {"type":"Feature",
           "properties":{"kind":"area","name":"April Sound","level":"NEIGHBORHOOD","parent":"Conroe"},
           "geometry":{"type":"Polygon","coordinates":[[[-95.63,30.37],[-95.62,30.37],[-95.62,30.38],[-95.63,30.38],[-95.63,30.37]]]}},
          {"type":"Feature",
           "properties":{"kind":"area","name":"Conroe","level":"CITY"},
           "geometry":{"type":"Polygon","coordinates":[[[-95.7,30.3],[-95.5,30.3],[-95.5,30.45],[-95.7,30.45],[-95.7,30.3]]]}}
        ]}
    """.trimIndent()

    @Test
    fun `reads names, levels and nesting`() {
        val areas = AreaGeoJson.parse(fromBuilder)
        assertEquals(2, areas.size)
        val hood = areas.first { it.name == "April Sound" }
        assertEquals(AreaLevel.NEIGHBORHOOD, hood.level)
        assertEquals("Conroe", hood.parent)
        assertEquals(AreaLevel.CITY, areas.first { it.name == "Conroe" }.level)
        assertNull(areas.first { it.name == "Conroe" }.parent)
    }

    @Test
    fun `coordinates are longitude first and the closing point is dropped`() {
        val hood = AreaGeoJson.parse(fromBuilder).first { it.name == "April Sound" }
        assertEquals(4, hood.polygon.size)
        assertEquals(30.37, hood.polygon[0].latitude, 1e-9)
        assertEquals(-95.63, hood.polygon[0].longitude, 1e-9)
        assertTrue("the ring must not repeat its first point", hood.polygon.first() != hood.polygon.last())
    }

    @Test
    fun `a plain polygon from any editor counts as an area`() {
        val plain = """
            {"type":"FeatureCollection","features":[
              {"type":"Feature","properties":{},
               "geometry":{"type":"Polygon","coordinates":[[[-1,1],[1,1],[1,2],[-1,1]]]}}]}
        """.trimIndent()
        val areas = AreaGeoJson.parse(plain)
        assertEquals(1, areas.size)
        assertEquals(AreaLevel.NEIGHBORHOOD, areas[0].level)
        assertTrue(areas[0].name.startsWith("Imported area"))
    }

    @Test
    fun `lines and points from a coverage export are skipped`() {
        val coverage = """
            {"type":"FeatureCollection","features":[
              {"type":"Feature","properties":{"kind":"driven","name":"Cove Way"},
               "geometry":{"type":"LineString","coordinates":[[-95.6,30.3],[-95.6,30.31]]}},
              {"type":"Feature","properties":{"kind":"poi","note":"pothole"},
               "geometry":{"type":"Point","coordinates":[-95.6,30.3]}},
              {"type":"Feature","properties":{"kind":"area","name":"Keep me","level":"CITY"},
               "geometry":{"type":"Polygon","coordinates":[[[-1,1],[1,1],[1,2],[-1,1]]]}}]}
        """.trimIndent()
        val areas = AreaGeoJson.parse(coverage)
        assertEquals(1, areas.size)
        assertEquals("Keep me", areas[0].name)
    }

    @Test
    fun `an older export using the level number still reads`() {
        val numeric = """
            {"type":"FeatureCollection","features":[
              {"type":"Feature","properties":{"kind":"area","name":"Metroplex","level":2},
               "geometry":{"type":"Polygon","coordinates":[[[-1,1],[1,1],[1,2],[-1,1]]]}}]}
        """.trimIndent()
        assertEquals(AreaLevel.METRO, AreaGeoJson.parse(numeric)[0].level)
    }

    @Test
    fun `each polygon of a multipolygon becomes its own area`() {
        val multi = """
            {"type":"FeatureCollection","features":[
              {"type":"Feature","properties":{"kind":"area","name":"Split"},
               "geometry":{"type":"MultiPolygon","coordinates":[
                 [[[-1,1],[1,1],[1,2],[-1,1]]],
                 [[[5,5],[6,5],[6,6],[5,5]]]]}}]}
        """.trimIndent()
        assertEquals(2, AreaGeoJson.parse(multi).size)
    }

    @Test
    fun `unusable files say so instead of importing nothing quietly`() {
        assertThrows(AreaImportException::class.java) { AreaGeoJson.parse("not json at all") }
        assertThrows(AreaImportException::class.java) {
            AreaGeoJson.parse("""{"type":"FeatureCollection","features":[]}""")
        }
        // A triangle needs three distinct corners; two points is not an outline.
        assertThrows(AreaImportException::class.java) {
            AreaGeoJson.parse("""{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Polygon","coordinates":[[[0,0],[1,1],[0,0]]]}}]}""")
        }
    }

    @Test
    fun `the file the desktop builder actually wrote parses`() {
        // Captured from tools/area-builder.html running in its container.
        val real = """
            {"type":"FeatureCollection","features":[{"type":"Feature","properties":{"kind":"area","name":"Area 1","level":"NEIGHBORHOOD"},"geometry":{"type":"Polygon","coordinates":[[[-95.633755,30.37237],[-95.618219,30.37237],[-95.618219,30.364159],[-95.633755,30.364159],[-95.633755,30.37237]]]}}]}
        """.trimIndent()
        val areas = AreaGeoJson.parse(real)
        assertEquals(1, areas.size)
        assertEquals("Area 1", areas[0].name)
        assertEquals(AreaLevel.NEIGHBORHOOD, areas[0].level)
        assertEquals(4, areas[0].polygon.size)
        assertEquals(30.37237, areas[0].polygon[0].latitude, 1e-9)
        assertEquals(-95.633755, areas[0].polygon[0].longitude, 1e-9)
    }
}
