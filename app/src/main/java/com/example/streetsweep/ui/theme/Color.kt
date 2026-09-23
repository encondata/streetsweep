package com.example.streetsweep.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Taken straight from the logo: the navy of the pin's edge, the green of the streets
 * already driven, and the grey of the ones still waiting. Green leads, because the whole
 * point of the app is turning grey streets green.
 */

// ---- light ----
val BrandGreen = Color(0xFF1E7A28)
val OnBrandGreen = Color(0xFFFFFFFF)
val BrandGreenContainer = Color(0xFFBCEFB6)
val OnBrandGreenContainer = Color(0xFF00210A)

val BrandNavy = Color(0xFF10314F)
val OnBrandNavy = Color(0xFFFFFFFF)
val BrandNavyContainer = Color(0xFFD0E4FA)
val OnBrandNavyContainer = Color(0xFF001B33)

/** Streets part-driven, and the track being recorded right now. */
val BrandAmber = Color(0xFF7D5700)
val OnBrandAmber = Color(0xFFFFFFFF)
val BrandAmberContainer = Color(0xFFFFDFA6)
val OnBrandAmberContainer = Color(0xFF281800)

val LightBackground = Color(0xFFF4F7FB)
val OnLightBackground = Color(0xFF0D1B28)
val LightSurface = Color(0xFFFFFFFF)
val LightSurfaceVariant = Color(0xFFE1E8EF)
val OnLightSurfaceVariant = Color(0xFF45525F)
val LightOutline = Color(0xFF76828F)
val LightOutlineVariant = Color(0xFFC4CDD7)
// Material derives nothing here: left unset, every container falls back to the
// baseline lilac, which is what the navigation bar was showing.
val LightSurfaceDim = Color(0xFFD7DEE6)
val LightSurfaceBright = Color(0xFFF9FBFD)
val LightContainerLowest = Color(0xFFFFFFFF)
val LightContainerLow = Color(0xFFF1F5FA)
val LightContainer = Color(0xFFEBF1F7)
val LightContainerHigh = Color(0xFFE4ECF3)
val LightContainerHighest = Color(0xFFDDE6EF)
val LightInverseSurface = Color(0xFF17293A)
val LightInverseOnSurface = Color(0xFFEDF2F8)

// ---- dark ----
val BrandGreenDark = Color(0xFF6FDC6A)
val OnBrandGreenDark = Color(0xFF003910)
val BrandGreenContainerDark = Color(0xFF0E5A18)
val OnBrandGreenContainerDark = Color(0xFFBCEFB6)

val BrandNavyDark = Color(0xFFA9C9EC)
val OnBrandNavyDark = Color(0xFF082742)
val BrandNavyContainerDark = Color(0xFF244C72)
val OnBrandNavyContainerDark = Color(0xFFD0E4FA)

val BrandAmberDark = Color(0xFFF2C36C)
val OnBrandAmberDark = Color(0xFF412E00)
val BrandAmberContainerDark = Color(0xFF5D4300)
val OnBrandAmberContainerDark = Color(0xFFFFDFA6)

val DarkBackground = Color(0xFF071320)
val OnDarkBackground = Color(0xFFE2EAF2)
val DarkSurface = Color(0xFF0C1B2A)
val DarkSurfaceVariant = Color(0xFF1C2E40)
val OnDarkSurfaceVariant = Color(0xFFB6C4D1)
val DarkOutline = Color(0xFF7E8C99)
val DarkOutlineVariant = Color(0xFF35485B)
val DarkSurfaceDim = Color(0xFF060F1A)
val DarkSurfaceBright = Color(0xFF23394E)
val DarkContainerLowest = Color(0xFF040C16)
val DarkContainerLow = Color(0xFF0B1A28)
val DarkContainer = Color(0xFF101F30)
val DarkContainerHigh = Color(0xFF18293B)
val DarkContainerHighest = Color(0xFF213448)
val DarkInverseSurface = Color(0xFFE2EAF2)
val DarkInverseOnSurface = Color(0xFF17293A)
