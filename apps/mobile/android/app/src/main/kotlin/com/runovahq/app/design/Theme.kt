package com.runovahq.app.design

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.runovahq.app.R

private val LocalPalette = staticCompositionLocalOf { RunovaTokens.Dark }

@OptIn(ExperimentalTextApi::class)
private fun inter(weight: Int) = Font(
    resId = R.font.inter,
    weight = FontWeight(weight),
    variationSettings = FontVariation.Settings(FontVariation.weight(weight)),
)

val InterFamily = FontFamily(inter(400), inter(500), inter(600), inter(700))
val MonoFamily = FontFamily(Font(R.font.jetbrains_mono))
val IconFamily = FontFamily(Font(R.font.fontawesome_solid))

/** The desktop's type scale. Sizes match its Tailwind steps. */
object RunovaType {
    private val base = TextStyle(fontFamily = InterFamily, letterSpacing = (-0.011).em)

    val heading = base.copy(fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold)
    val title = base.copy(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold)
    val body = base.copy(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Normal)
    val label = base.copy(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium)
    val labelStrong = label.copy(fontWeight = FontWeight.SemiBold)
    val small = base.copy(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Normal)
    val caption = base.copy(fontSize = 11.sp, lineHeight = 14.sp, fontWeight = FontWeight.Medium)
    val mono = TextStyle(fontFamily = MonoFamily, fontSize = 13.sp, lineHeight = 17.5.sp)
}

/** The desktop's radii, from the one token they all come from. */
object RunovaShape {
    val lg = RunovaTokens.RADIUS.dp
    val md = (RunovaTokens.RADIUS - 2).dp
    val sm = (RunovaTokens.RADIUS - 4).dp
    val island = (RunovaTokens.RADIUS + 4).dp
}

object RunovaTheme {
    val colors: RunovaPalette
        @Composable get() = LocalPalette.current
}

@Composable
fun RunovaTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    CompositionLocalProvider(
        LocalPalette provides if (dark) RunovaTokens.Dark else RunovaTokens.Light,
        content = content,
    )
}
