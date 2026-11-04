package com.ollaic.galagame_maker.preview

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.FullscreenExit
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.ollaic.galagame_maker.home.OllaicTheme
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PreviewFullscreenControlsTest {
  @get:Rule val compose = createComposeRule()

  @Test fun controlsFollowTheGameAcrossPortraitSquareAndLandscapeViewports() {
    var width by mutableStateOf(180.dp)
    var height by mutableStateOf(300.dp)
    val exited = AtomicInteger()
    val returned = AtomicInteger()
    compose.setContent { OllaicTheme {
      // Keep host system insets outside the synthetic viewport when changing its aspect ratio.
      Box(Modifier.safeDrawingPadding()) {
        Box(Modifier.size(width, height).testTag("preview-viewport")) {
          PreviewFullscreenControls {
            IconButton(onClick = { exited.incrementAndGet() }, modifier = Modifier.testTag("exit-fullscreen")) {
              Icon(Icons.Outlined.FullscreenExit, "Exit fullscreen")
            }
            IconButton(onClick = { returned.incrementAndGet() }, modifier = Modifier.testTag("return-editor")) {
              Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Return to editor")
            }
          }
        }
      }
    } }

    for ((index, size) in listOf(180.dp to 300.dp, 240.dp to 240.dp, 300.dp to 180.dp).withIndex()) {
      compose.runOnIdle { width = size.first; height = size.second }
      val viewport = bounds("preview-viewport")
      val exit = bounds("exit-fullscreen")
      val back = bounds("return-editor")
      assertTrue("Exit control must remain inside the viewport", viewport.contains(exit.topLeft) && viewport.contains(exit.bottomRight))
      assertTrue("Back control must remain inside the viewport", viewport.contains(back.topLeft) && viewport.contains(back.bottomRight))
      if (size.first <= size.second) {
        assertTrue("Controls must follow the clockwise-rotated game to the lower right", exit.center.y > viewport.center.y)
        assertTrue(exit.center.x > viewport.center.x)
        assertEquals(exit.center.x, back.center.x, 1f)
        assertTrue("Exit must precede Back along the rotated game axis", exit.center.y < back.center.y)
      } else {
        assertTrue("Landscape controls must stay at the top: viewport=$viewport, exit=$exit, back=$back", exit.center.y < viewport.center.y)
        assertEquals(exit.center.y, back.center.y, 1f)
        assertTrue(exit.center.x < back.center.x)
      }
      compose.onNodeWithTag("exit-fullscreen").performTouchInput { click(center) }
      compose.onNodeWithTag("return-editor").performTouchInput { click(center) }
      compose.runOnIdle {
        assertEquals(index + 1, exited.get())
        assertEquals(index + 1, returned.get())
      }
    }
  }

  private fun bounds(tag: String): Rect = compose.onNodeWithTag(tag).fetchSemanticsNode().boundsInRoot
}
