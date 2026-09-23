package com.example.streetsweep.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.EmojiEvents
import androidx.compose.material.icons.filled.Place
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.streetsweep.R

/** How much of the screen's width the logo spans. */
private const val WIDTH_FRACTION = 0.72f

private val PROMISES = listOf(
    Triple(Icons.Default.Place, "Track your drives", "Every street you cover, recorded"),
    Triple(Icons.Default.BarChart, "See your progress", "Neighbourhood, city, metro"),
    Triple(Icons.Default.EmojiEvents, "Complete neighbourhoods", "Grey turns green as you sweep"),
)

/**
 * The opening screen: the logo as it was drawn, the line that says what the app is for,
 * and the three things it does.
 *
 * The system's own splash cannot arrange any of this -- its icon slot is square and masked
 * and it holds one image -- so the app draws its own first frame on the same colour the
 * launch window uses, and the two meet without a seam.
 *
 * [revealed] fades this in as the launcher's splash fades out.
 */
@Composable
fun SplashLockup(visible: Boolean, revealed: Boolean, modifier: Modifier = Modifier) {
    AnimatedVisibility(
        visible = visible,
        enter = fadeIn(tween(0)),
        exit = fadeOut(tween(360)),
        modifier = modifier,
    ) {
        val logoAlpha by animateFloatAsState(
            targetValue = if (revealed) 1f else 0f,
            animationSpec = tween(300),
            label = "logo",
        )
        val listAlpha by animateFloatAsState(
            targetValue = if (revealed) 1f else 0f,
            // A beat behind the logo, so the eye lands on the mark first.
            animationSpec = tween(durationMillis = 420, delayMillis = 240),
            label = "promises",
        )
        val scheme = MaterialTheme.colorScheme
        Box(
            Modifier
                .fillMaxSize()
                // Every stop is opaque. A translucent one lets the map show through,
                // which is exactly what a splash must not do.
                .background(
                    Brush.verticalGradient(
                        listOf(
                            scheme.background,
                            scheme.background,
                            lerp(scheme.background, scheme.primary, 0.10f),
                        )
                    )
                )
                // Nothing aimed at the map underneath should land while this is up.
                .pointerInput(Unit) { detectTapGestures { } },
        ) {
            Column(
                Modifier
                    .fillMaxSize()
                    .padding(horizontal = 28.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Image(
                    painter = painterResource(R.drawable.splash_lockup),
                    contentDescription = stringResource(R.string.app_name),
                    modifier = Modifier
                        .fillMaxWidth(WIDTH_FRACTION)
                        .alpha(logoAlpha),
                    contentScale = ContentScale.FillWidth,
                )
                Spacer(Modifier.height(28.dp))
                Text(
                    "Turn every drive into progress",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = scheme.onBackground,
                    modifier = Modifier.alpha(listAlpha),
                )
                Spacer(Modifier.height(26.dp))
                Column(
                    Modifier.fillMaxWidth().alpha(listAlpha),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    PROMISES.forEach { (icon, title, detail) -> Promise(icon, title, detail) }
                }
            }
        }
    }
}

@Composable
private fun Promise(icon: ImageVector, title: String, detail: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier
                .size(38.dp)
                .clip(RoundedCornerShape(11.dp))
                .background(MaterialTheme.colorScheme.primaryContainer),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                icon,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onPrimaryContainer,
                modifier = Modifier.size(20.dp),
            )
        }
        Spacer(Modifier.width(14.dp))
        Column {
            Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Text(
                detail,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
