package com.ollaic.galagame_maker.home

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

val OllaicPink = Color(0xFFCE799E)

private val LightColors = lightColorScheme(
  primary = Color(0xFFA43758),
  onPrimary = Color.White,
  primaryContainer = Color(0xFFF8DDE8),
  onPrimaryContainer = Color(0xFF552036),
  secondary = Color(0xFF006398),
  secondaryContainer = Color(0xFFDDEFFC),
  onSecondaryContainer = Color(0xFF004D77),
  tertiary = Color(0xFF006B56),
  tertiaryContainer = Color(0xFFD8F3EB),
  onTertiaryContainer = Color(0xFF00372B),
  background = Color(0xFFF7F8FA),
  onBackground = Color(0xFF191C1E),
  surface = Color.White,
  onSurface = Color(0xFF191C1E),
  surfaceVariant = Color(0xFFECEEF1),
  onSurfaceVariant = Color(0xFF62565D),
  outline = Color(0xFF897175),
  outlineVariant = Color(0xFFE3E7EF),
  error = Color(0xFFC14646),
  errorContainer = Color(0xFFFCE8E8),
)

private val DarkColors = darkColorScheme(
  primary = Color(0xFFEEB1C9),
  onPrimary = Color(0xFF4F1730),
  primaryContainer = Color(0xFF60243F),
  onPrimaryContainer = Color(0xFFFFD9E7),
  secondary = Color(0xFF9ED1FA),
  secondaryContainer = Color(0xFF164765),
  onSecondaryContainer = Color(0xFFDDEFFC),
  tertiary = Color(0xFF8BDBBF),
  tertiaryContainer = Color(0xFF164D3D),
  onTertiaryContainer = Color(0xFFD8F3EB),
  background = Color(0xFF18191C),
  onBackground = Color(0xFFF3F1F3),
  surface = Color(0xFF222326),
  onSurface = Color(0xFFF3F1F3),
  surfaceVariant = Color(0xFF303136),
  onSurfaceVariant = Color(0xFFCFC3CA),
  outlineVariant = Color(0xFF3D3E43),
)

private fun TextStyle.ollaic() = copy(fontFamily = FontFamily.SansSerif, letterSpacing = 0.sp)

private val OllaicTypography = Typography().let {
  Typography(
    displayLarge = it.displayLarge.ollaic(),
    displayMedium = it.displayMedium.ollaic(),
    displaySmall = it.displaySmall.ollaic(),
    headlineLarge = it.headlineLarge.ollaic(),
    headlineMedium = it.headlineMedium.ollaic(),
    headlineSmall = it.headlineSmall.ollaic(),
    titleLarge = it.titleLarge.ollaic(),
    titleMedium = it.titleMedium.ollaic(),
    titleSmall = it.titleSmall.ollaic(),
    bodyLarge = it.bodyLarge.ollaic(),
    bodyMedium = it.bodyMedium.ollaic(),
    bodySmall = it.bodySmall.ollaic(),
    labelLarge = it.labelLarge.ollaic(),
    labelMedium = it.labelMedium.ollaic(),
    labelSmall = it.labelSmall.ollaic(),
  )
}

@Composable
fun OllaicTheme(content: @Composable () -> Unit) {
  MaterialTheme(
    colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
    typography = OllaicTypography,
    shapes = Shapes(
      extraSmall = RoundedCornerShape(4.dp),
      small = RoundedCornerShape(8.dp),
      medium = RoundedCornerShape(8.dp),
      large = RoundedCornerShape(8.dp),
      extraLarge = RoundedCornerShape(8.dp),
    ),
    content = content,
  )
}
