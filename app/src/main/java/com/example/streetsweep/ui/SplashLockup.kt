package com.example.streetsweep.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import com.example.streetsweep.R

/** How much of the screen's width the logo spans. */
private const val WIDTH_FRACTION = 0.84f

/**
 * The logo the way it was drawn: the pin with the name and strapline directly beneath it,
 * across the width of the screen. The system's own splash cannot arrange it this way --
 * its icon slot is square and masked, so words can only sit at the foot -- so the app
 * draws this itself, on the same colour the launch window uses.
 *
 * [revealed] fades the logo in as the launcher's splash fades out. The background is up
 * from the first frame either way, so the two never show a seam between them.
 */
@Composable
fun SplashLockup(visible: Boolean, revealed: Boolean, modifier: Modifier = Modifier) {
    AnimatedVisibility(
        visible = visible,
        enter = fadeIn(tween(0)),
        exit = fadeOut(tween(340)),
        modifier = modifier,
    ) {
        val logoAlpha by animateFloatAsState(
            targetValue = if (revealed) 1f else 0f,
            animationSpec = tween(300),
            label = "logo",
        )
        Box(
            Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background)
                // Nothing aimed at the map underneath should land while this is up.
                .pointerInput(Unit) { detectTapGestures { } },
            contentAlignment = Alignment.Center,
        ) {
            Image(
                painter = painterResource(R.drawable.splash_lockup),
                contentDescription = stringResource(R.string.app_name),
                modifier = Modifier
                    .fillMaxWidth(WIDTH_FRACTION)
                    .alpha(logoAlpha),
                contentScale = ContentScale.FillWidth,
            )
        }
    }
}
