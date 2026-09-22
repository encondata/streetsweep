package com.example.streetsweep.ui.map

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.example.streetsweep.R

/** Subdued stylised street grid, tiled, used behind the map screen when no map tiles are available. */
@Composable
fun StreetPatternBackdrop(modifier: Modifier = Modifier, tile: Dp = 200.dp) {
    val painter = painterResource(R.drawable.bg_street_map)
    Canvas(modifier) {
        val t = tile.toPx()
        val cols = (size.width / t).toInt() + 1
        val rows = (size.height / t).toInt() + 1
        for (r in 0..rows) for (c in 0..cols) {
            translate(left = c * t, top = r * t) {
                with(painter) { draw(Size(t, t)) }
            }
        }
    }
}
