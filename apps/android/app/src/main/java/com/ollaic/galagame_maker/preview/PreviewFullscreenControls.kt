package com.ollaic.galagame_maker.preview

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.dp

@Composable
internal fun PreviewFullscreenControls(content: @Composable RowScope.() -> Unit) {
  BoxWithConstraints(Modifier.fillMaxSize()) {
    // WebGAL rotates its stage clockwise when the viewport is not wider than tall.
    val rotated = maxWidth <= maxHeight
    Surface(
      modifier = Modifier
        .align(if (rotated) Alignment.BottomEnd else Alignment.TopEnd)
        .safeDrawingPadding()
        .padding(16.dp)
        .then(if (rotated) Modifier.rotateClockwise() else Modifier),
      shape = MaterialTheme.shapes.small,
    ) { Row(content = content) }
  }
}

private fun Modifier.rotateClockwise(): Modifier = layout { measurable, constraints ->
  val controls = measurable.measure(constraints.copy(
    minWidth = constraints.minHeight,
    maxWidth = constraints.maxHeight,
    minHeight = constraints.minWidth,
    maxHeight = constraints.maxWidth,
  ))
  // Swap layout bounds as well as drawing coordinates so placement and touch targets agree.
  layout(controls.height, controls.width) {
    controls.placeWithLayer(controls.height, 0) {
      rotationZ = 90f
      transformOrigin = TransformOrigin(0f, 0f)
    }
  }
}
