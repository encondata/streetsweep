package com.example.streetsweep.data.osm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class ValhallaParseTest {
    // Trimmed from a real trace_attributes response (Congress Ave / W 6th St, Austin).
    private val json = """
        {"units":"kilometers","shape":"srkvx@|dwlyDkOcEoEmA",
         "edges":[
           {"way_id":891734324,"names":["Congress Avenue"],"length":0.03,"begin_shape_index":0,"end_shape_index":1,"road_class":"primary"},
           {"way_id":144469638,"names":["West 6th Street"],"length":0.017,"begin_shape_index":1,"end_shape_index":2,"road_class":"secondary"}],
         "matched_points":[
           {"lon":-97.742943,"lat":30.267706,"type":"matched","edge_index":0},
           {"lon":-97.743149,"lat":30.268167,"type":"unmatched"},
           {"lon":-97.743361,"lat":30.268959,"type":"matched","edge_index":1}]}
    """.trimIndent()

    @Test
    fun `parses shape, edges and matched points`() {
        val r = ValhallaClient.parse(json)
        assertEquals(3, r.shape.size)
        assertEquals(30.267706, r.shape[0].latitude, 1e-6)
        assertEquals(2, r.edges.size)
        assertEquals(891734324L, r.edges[0].wayId)
        assertEquals("Congress Avenue", r.edges[0].names.first())
        assertEquals(30.0, r.edges[0].lengthMeters, 1e-9)
        assertEquals(2, r.edges[0].shape.size)
        assertEquals(r.shape[1], r.edges[1].shape.first())
        assertEquals(listOf(0, null, 1), r.matchedEdgeIndex)
    }

    @Test
    fun `error payload becomes an exception`() {
        val e = assertThrows(RoadMatchException::class.java) {
            ValhallaClient.parse("""{"error":"No path could be found for input","error_code":442}""")
        }
        assertEquals("No path could be found for input", e.message)
        assertNull(ValhallaClient.parseError("{}"))
    }

    @Test
    fun `new shape after overlap starts at the first new input's edge`() {
        val r = ValhallaClient.parse(json)
        // Skip input 0 (overlap): first matched input >= 1 is input 2 on edge 1, whose shape starts at shape[1].
        val tail = RoadMatcher.newShapeAfter(r, skipInputs = 1)
        assertEquals(r.shape.subList(1, 3), tail)
        assertEquals(r.shape, RoadMatcher.newShapeAfter(r, skipInputs = 0))
    }
}
