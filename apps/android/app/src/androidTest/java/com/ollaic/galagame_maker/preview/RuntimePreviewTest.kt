package com.ollaic.galagame_maker.preview

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.os.ParcelFileDescriptor
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.ollaic.galagame_maker.R
import com.ollaic.galagame_maker.home.HomeDraftStore
import com.ollaic.galagame_maker.home.HomeProject
import com.ollaic.galagame_maker.home.OllaicTheme
import com.ollaic.galagame_maker.workspace.*
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import org.json.JSONTokener
import org.junit.After
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RuntimePreviewTest {
  @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private lateinit var directory: File
  private lateinit var workspaces: WorkspaceDraftStore
  private lateinit var projects: HomeDraftStore
  private lateinit var project: HomeProject
  private lateinit var repository: RuntimePreviewRepository
  private var showing by mutableStateOf(true)

  @Before fun prepare() = runBlocking {
    directory = File(context.cacheDir, "runtime-preview-${UUID.randomUUID()}").also { check(it.mkdirs()) }
    workspaces = WorkspaceDraftStore(directory)
    projects = HomeDraftStore(directory)
    project = HomeProject(UUID.randomUUID().toString(), "Runtime integration", "", "", 2, false, false)
    repository = RuntimePreviewRepository(context, File(directory, "runtime"))
    projects.update { listOf(project) }
    val start = DraftScene(name = "Opening", fileName = "start.txt", blocks = WorkspaceCodec.blocks(
      "changeBg:stage.png -next;\nchangeFigure:hero.png -next;\nAlice:Preview entry;\nchoose:Continue:second.txt;\n",
    ))
    val second = DraftScene(name = "Second", fileName = "second.txt", blocks = WorkspaceCodec.blocks(
      (1..30).joinToString("\n", postfix = "\n") { "Alice:Second line $it;" },
    ))
    workspaces.save(project.id, WorkspaceDraft(listOf(start, second)))
    workspaces.updateProject(project, "Opening")
    val bitmap = Bitmap.createBitmap(16, 16, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.RED) }
    for (path in listOf("game/background/stage.png", "game/figure/hero.png")) {
      File(workspaces.projectDirectory(project.id), path).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    bitmap.recycle()
  }

  @After fun cleanUp() {
    compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
    compose.runOnIdle { showing = false }
    compose.waitForIdle()
    directory.deleteRecursively()
  }

  private fun mount() {
    compose.setContent { OllaicTheme { if (showing) ProjectWorkspace(project, workspaces, projects, {}, {}, repository) } }
    compose.waitUntil(10_000) { compose.onAllNodesWithText("Preview entry").fetchSemanticsNodes().isNotEmpty() }
  }

  private fun awaitReady(previousUrl: String? = null): String {
    var url: String? = null
    compose.waitUntil(60_000) {
      val error = compose.onAllNodesWithTag("preview-error").fetchSemanticsNodes()
      check(error.isEmpty()) { "Preview failed: $error" }
      url = currentUrl()
      compose.onAllNodesWithTag("preview-ready").fetchSemanticsNodes().isNotEmpty() && url != null && url != previousUrl
    }
    return checkNotNull(url)
  }

  private fun webView(): WebView? {
    val result = AtomicReference<WebView>()
    InstrumentationRegistry.getInstrumentation().runOnMainSync {
      fun find(view: View): WebView? = when (view) {
        is WebView -> view
        is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { find(view.getChildAt(it)) }
        else -> null
      }
      result.set(ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
        .firstNotNullOfOrNull { find(it.window.decorView) })
    }
    return result.get()
  }

  private fun evaluate(script: String): String {
    val complete = CountDownLatch(1)
    val result = AtomicReference<String>()
    val web = checkNotNull(webView()) { "Preview WebView is unavailable" }
    InstrumentationRegistry.getInstrumentation().runOnMainSync {
      web.evaluateJavascript(script) { value -> result.set(value); complete.countDown() }
    }
    check(complete.await(5, TimeUnit.SECONDS)) { "WebView script evaluation timed out" }
    return JSONTokener(result.get()).nextValue().toString()
  }

  private fun currentUrl(): String? {
    val result = AtomicReference<String>()
    val web = webView() ?: return null
    InstrumentationRegistry.getInstrumentation().runOnMainSync { result.set(web.url) }
    return result.get()
  }

  private fun canInteract(selector: String): Boolean = evaluate("""
    (() => {
      const target = document.querySelector(${org.json.JSONObject.quote(selector)});
      if (!target) return false;
      for (let node = target; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) <= 0) return false;
      }
      const rect = target.getBoundingClientRect();
      const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
      const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
      if (right <= left || bottom <= top) return false;
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      return hit === target || target.contains(hit);
    })()
  """.trimIndent()) == "true"

  private fun enterGame() {
    assertTrue("Ready preview must expose an interactive engine entry screen", canInteract(".html-body__title-enter"))
    evaluate("document.querySelector('.html-body__title-enter').click();true")
    val start = "[class*=\"Title_buttonList\"] > [class*=\"Title_button\"]"
    try {
      compose.waitUntil(10_000) { canInteract(start) }
    } catch (error: Throwable) {
      val details = evaluate("""
        (() => {
          const target = document.querySelector(${org.json.JSONObject.quote(start)});
          const parents = [];
          for (let node = target; node; node = node.parentElement) {
            const style = getComputedStyle(node), rect = node.getBoundingClientRect();
            parents.push({id:node.id, class:node.className, display:style.display, visibility:style.visibility,
              opacity:style.opacity, pointerEvents:style.pointerEvents, zIndex:style.zIndex,
              rect:{left:rect.left,top:rect.top,width:rect.width,height:rect.height}});
          }
          const rect = target?.getBoundingClientRect();
          const hit = rect ? document.elementsFromPoint(rect.left + rect.width/2, rect.top + rect.height/2)
            .slice(0,6).map(node => ({id:node.id,class:node.className})) : [];
          return JSON.stringify({parents,hit,entry:document.querySelector('.html-body__title-enter')?.style.cssText});
        })()
      """.trimIndent())
      throw AssertionError("Title menu is not interactive: $details", error)
    }
    evaluate("document.querySelector(${org.json.JSONObject.quote(start)}).click();true")
  }

  private fun dialogueText(): String = evaluate("""
    (() => {
      const text = document.querySelector('#textBoxMain [class*="_text_"]');
      if (!text) return '';
      const copy = text.cloneNode(true);
      copy.querySelectorAll('[class*="_outer_"], [class*="_inner_"]').forEach(node => node.remove());
      return copy.textContent.replace(/\u00a0/g, ' ');
    })()
  """.trimIndent())

  private fun clickGameText(text: String) = evaluate("""
    (() => {
      const target = Array.from(document.querySelectorAll('#chooseContainer div,#chooseContainer span,#chooseContainer button'))
        .find(node => node.childElementCount === 0 && node.textContent.trim() === ${org.json.JSONObject.quote(text)}
          && node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible');
      if (!target) return false;
      target.click();
      return true;
    })()
  """.trimIndent())

  private fun assertClosed(url: String) {
    compose.waitUntil(5_000) {
      val connection = URL(url).openConnection() as HttpURLConnection
      connection.connectTimeout = 1_000; connection.readTimeout = 1_000
      try { runCatching { connection.responseCode }.isFailure }
      finally { connection.disconnect() }
    }
  }

  @Test fun savesBeforeOpeningAndKeepsSaveFailuresInTheEditor() {
    mount()
    compose.onNodeWithText(context.getString(R.string.workspace_scenes)).performClick()
    compose.onNodeWithContentDescription(context.getString(R.string.workspace_new_scene)).performClick()
    compose.onNodeWithTag("field-workspace_scene_name").performTextInput("Unsaved scene")
    File(directory, "native-home-drafts.json").writeText("invalid library")
    compose.onNodeWithTag("scene-name-save").performClick()
    compose.onNodeWithText("Opening").performClick()
    compose.onNodeWithContentDescription(context.getString(R.string.workspace_preview)).performClick()
    compose.waitUntil(5_000) { compose.onAllNodesWithText(context.getString(R.string.workspace_save_error)).fetchSemanticsNodes().isNotEmpty() }
    compose.onNodeWithTag("runtime-preview").assertDoesNotExist()
    compose.onNodeWithText("Preview entry").assertIsDisplayed()
  }

  @Test fun realEngineRunsFromStartRestartsAndReturnsToTheOriginalEditorPosition() = runBlocking {
    assumeTrue("Run android:test:preview with WEBGAL_TEST_RUNTIME_ZIP", InstrumentationRegistry.getArguments().getString("previewRuntimeArchive") == "true")
    val archive = File(directory, "engine.zip")
    val descriptor = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand("cat /data/local/tmp/ollaic-preview-runtime.zip")
    ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { input -> archive.outputStream().use { input.copyTo(it) } }
    repository.install(archive)
    val root = workspaces.projectDirectory(project.id)
    val original = listOf("game/config.txt", "game/scene/start.txt", "game/scene/second.txt").associateWith { File(root, it).readText() }
    mount()
    compose.onNodeWithText(context.getString(R.string.workspace_scenes)).performClick()
    compose.onNodeWithText("Second").performClick()
    compose.onNodeWithTag("workspace-script").performScrollToNode(hasText("Second line 20"))
    compose.onNodeWithText("Second line 20").assertIsDisplayed()
    compose.onNodeWithContentDescription(context.getString(R.string.workspace_preview)).performClick()
    val firstUrl = awaitReady()
    enterGame()
    try {
      compose.waitUntil(20_000) { dialogueText() == "Preview entry" }
    } catch (error: Throwable) {
      throw AssertionError("Entry scene did not appear: ${evaluate("document.body.innerText")}", error)
    }
    assertEquals("Preview entry", dialogueText())
    evaluate("document.getElementById('FullScreenClick').click();true")
    evaluate("document.getElementById('FullScreenClick').click();true")
    try {
      compose.waitUntil(20_000) { evaluate("document.body.innerText").contains("Continue") }
    } catch (error: Throwable) {
      throw AssertionError("Choice did not appear: ${evaluate("document.body.innerText")}", error)
    }
    assertEquals("true", clickGameText("Continue"))
    compose.waitUntil(20_000) { dialogueText() == "Second line 1" }
    compose.onNodeWithTag("preview-fullscreen").performClick()
    compose.onNodeWithTag("preview-exit-fullscreen").assertExists().performClick()
    compose.onNodeWithTag("preview-restart").performClick()
    val secondUrl = awaitReady(firstUrl)
    assertNotEquals(firstUrl, secondUrl)
    assertClosed(firstUrl)
    assertTrue("Restart must restore the interactive engine entry screen", canInteract(".html-body__title-enter"))
    assertFalse(evaluate("document.body.innerText").contains("Preview entry"))
    compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
    assertClosed(secondUrl)
    compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
    compose.waitForIdle()
    val resumedUrl = awaitReady(secondUrl)
    assertNotEquals(secondUrl, resumedUrl)
    assertTrue("Resume must restore the interactive engine entry screen", canInteract(".html-body__title-enter"))
    compose.onNodeWithTag("preview-back").performClick()
    compose.waitUntil(10_000) { compose.onAllNodesWithTag("runtime-preview").fetchSemanticsNodes().isEmpty() }
    compose.onNodeWithText("Second line 20").assertIsDisplayed()
    assertClosed(resumedUrl)
    original.forEach { (path, content) -> assertEquals("Preview changed $path", content, File(root, path).readText()) }
  }
}
