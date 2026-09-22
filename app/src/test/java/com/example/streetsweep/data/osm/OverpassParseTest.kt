package com.example.streetsweep.data.osm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class OverpassParseTest {
    @Test
    fun `parses ways with geometry and computes length`() {
        val json = """
            {"elements":[
              {"type":"way","id":15377309,"tags":{"name":"West 8th Street","highway":"secondary"},
               "geometry":[{"lat":30.2699,"lon":-97.7421},{"lat":30.2699,"lon":-97.7411}]},
              {"type":"way","id":2,"tags":{"highway":"residential"},"geometry":[{"lat":30.27,"lon":-97.74},{"lat":30.271,"lon":-97.74}]},
              {"type":"node","id":3},
              {"type":"way","id":4,"tags":{"highway":"residential"},"geometry":[{"lat":30.27,"lon":-97.74}]}
            ]}
        """.trimIndent()
        val streets = OverpassClient.parse(json)
        assertEquals(2, streets.size)
        assertEquals("West 8th Street", streets[0].name)
        assertEquals("secondary", streets[0].highway)
        assertEquals(96.0, streets[0].lengthMeters, 3.0) // 0.001 deg of longitude at 30N is about 96 m
        assertNull(streets[1].name)
        assertEquals(111.0, streets[1].lengthMeters, 2.0)
    }
}
