package com.ollaic.galagame_maker.ui

import android.content.Context
import android.view.KeyEvent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.ollaic.core.*
import com.ollaic.galagame_maker.R
import com.ollaic.galagame_maker.home.HomeDraftStore
import com.ollaic.galagame_maker.home.HomeProject
import com.ollaic.galagame_maker.home.OllaicTheme
import com.ollaic.galagame_maker.workspace.*
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class EditorInteractionTest {
  @get:Rule val compose = createComposeRule()
  private lateinit var directory: File
  private var showing by mutableStateOf(true)

  @Before fun prepare() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    directory = File(context.cacheDir, "editor-ui-${UUID.randomUUID()}").also { check(it.mkdirs()) }
  }

  @After fun cleanUp() {
    compose.runOnIdle { showing = false }
    compose.waitForIdle()
    directory.deleteRecursively()
  }

  private fun mount(content: @Composable () -> Unit) {
    compose.setContent { OllaicTheme { if (showing) content() } }
  }

  private fun awaitTag(tag: String) {
    compose.waitUntil(5_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
  }

  private fun pressBack() = InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)

  private fun workspace() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val project = HomeProject(UUID.randomUUID().toString(), "Scene navigation", "", "", 2, false, false)
    val workspaces = WorkspaceDraftStore(directory)
    val projects = HomeDraftStore(directory)
    runBlocking {
      projects.update { listOf(project) }
      workspaces.save(project.id, WorkspaceDraft(listOf(
        DraftScene(name = "Opening", fileName = "start.txt", blocks = listOf(ScriptBlock(kind = BlockKind.Narration, text = "Opening script"))),
        DraftScene(name = "Current chapter", fileName = "chapter.txt", blocks = listOf(ScriptBlock(kind = BlockKind.Narration, text = "Keep editing this scene"))),
      )))
    }
    mount { ProjectWorkspace(project, workspaces, projects, {}, {}) }
    compose.waitUntil(5_000) { compose.onAllNodesWithText("Opening script").fetchSemanticsNodes().isNotEmpty() }
    compose.onNodeWithText(context.getString(R.string.workspace_scenes)).performClick()
    compose.onNodeWithText("Current chapter").performClick()
    compose.onNodeWithText("Keep editing this scene").assertIsDisplayed()
  }

  private fun createScene(name: String) {
    val context = ApplicationProvider.getApplicationContext<Context>()
    compose.onNodeWithContentDescription(context.getString(R.string.workspace_new_scene)).performClick()
    compose.onNodeWithTag("field-workspace_scene_name").performTextInput(name)
    compose.onNodeWithTag("scene-name-save").performClick()
    compose.onNodeWithTag("scene-name-save").assertDoesNotExist()
    compose.waitUntil(5_000) { compose.onAllNodesWithText(context.getString(R.string.workspace_saved)).fetchSemanticsNodes().isNotEmpty() }
  }

  @Test fun creatingSceneFromSceneListKeepsCurrentSelectionAndTab() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    workspace()
    compose.onNodeWithText(context.getString(R.string.workspace_scenes)).performClick()
    createScene("New chapter")
    compose.onNodeWithText(context.getString(R.string.workspace_scenes)).assertIsSelected()
    compose.onNodeWithText("Current chapter").assertIsSelected()
    compose.onNodeWithText("New chapter").assertIsNotSelected()
    compose.onNodeWithText(context.getString(R.string.workspace_script)).performClick()
    compose.onNodeWithText("Keep editing this scene").assertIsDisplayed()
    compose.onNodeWithText(context.getString(R.string.workspace_scenes)).performClick()
    compose.onNodeWithText("New chapter").performClick()
    compose.onNodeWithText(context.getString(R.string.workspace_script)).assertIsSelected()
  }

  @Test fun creatingSceneFromScriptPickerKeepsCurrentScript() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    workspace()
    compose.onNodeWithContentDescription(context.getString(R.string.workspace_select_scene)).performClick()
    createScene("New chapter")
    compose.onNodeWithText(context.getString(R.string.workspace_script)).assertIsSelected()
    compose.onNodeWithText("Keep editing this scene").assertIsDisplayed()
    compose.onNodeWithText(context.getString(R.string.workspace_scenes)).performClick()
    compose.onNodeWithText("Current chapter").assertIsSelected()
    compose.onNodeWithText("New chapter").assertIsNotSelected()
  }

  private fun fields(initial: CommandEdit, assets: List<AssetInfo> = emptyList(), characters: List<CharacterInfo> = emptyList()) {
    mount {
      var edit by remember { mutableStateOf(initial) }
      Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        CommandFields(edit, listOf("start.txt", "chapter.txt"), listOf("branch_a"), assets, characters, directory, {}, {}) { edit = it }
      }
    }
  }

  @Test fun emptySourceSwitchHidesTypePickerAndSaveTracksInput() {
    val saved = AtomicBoolean(false)
    mount {
      var enabled by remember { mutableStateOf(true) }
      BlockEditorSheet(null, emptyList(), null, emptyList(), emptyList(), directory, enabled, {}, {}, {}, {
        saved.set(true); enabled = false
      })
    }
    compose.onNodeWithTag("command-mode-source").performClick()
    compose.onNodeWithTag("command-type-picker").assertDoesNotExist()
    compose.onNodeWithTag("command-error").assertDoesNotExist()
    compose.onNodeWithTag("command-save").assertIsNotEnabled()
    compose.onNodeWithTag("command-mode-form").performClick()
    compose.onNodeWithTag("command-type-picker").assertIsDisplayed()
    compose.onNodeWithTag("command-error").assertDoesNotExist()
    compose.onNodeWithTag("command-mode-source").performClick()
    compose.onNodeWithTag("command-source").performTextInput("label:branch_a;")
    compose.onNodeWithTag("command-save").assertIsEnabled().performClick()
    compose.waitUntil { saved.get() }
    compose.onNodeWithTag("command-save").assertIsNotEnabled()
  }

  @Test fun validDefaultMediaCommandSwitchesToSource() {
    mount { BlockEditorSheet(null, emptyList(), null, emptyList(), emptyList(), directory, true, {}, {}, {}, {}) }
    compose.onNodeWithTag("command-type-picker").performClick()
    compose.onNodeWithTag("command-kind-BGM").performScrollTo().performClick()
    compose.onNodeWithTag("command-mode-source").performClick()
    compose.onNodeWithTag("command-source").assertTextContains("bgm:none;", substring = true)
    compose.onNodeWithTag("command-error").assertDoesNotExist()
    compose.onNodeWithTag("command-save").assertIsEnabled()
  }

  @Test fun choiceControlsAddReorderAndDeleteVisibleRows() {
    fields(newCommand(CommandKind.CHOOSE).copy(choices = listOf(CommandChoice("First", ""), CommandChoice("Second", ""))))
    compose.onNode(hasTestTag("tool-workspace_move_up") and hasAnyAncestor(hasTestTag("command-choice-0")), true).assertIsNotEnabled()
    compose.onNode(hasTestTag("tool-workspace_move_down") and hasAnyAncestor(hasTestTag("command-choice-0")), true).performClick()
    compose.onNode(hasTestTag("field-command_choice_text") and hasAnyAncestor(hasTestTag("command-choice-0"))).assertTextContains("Second")
    compose.onNodeWithTag("tool-command_add_choice").performClick()
    compose.onNodeWithTag("command-choice-2").assertExists()
    compose.onNode(hasTestTag("tool-command_delete_choice") and hasAnyAncestor(hasTestTag("command-choice-0")), true).performClick()
    compose.onNode(hasTestTag("field-command_choice_text") and hasAnyAncestor(hasTestTag("command-choice-0"))).assertTextContains("First")
    compose.onNodeWithTag("command-choice-2").assertDoesNotExist()
  }

  @Test fun volumeOverrideShowsSliderAndCanBeRemoved() {
    fields(newCommand(CommandKind.BGM))
    compose.onNodeWithTag("command-volume").assertDoesNotExist()
    compose.onNodeWithTag("command-volume-override").performClick()
    compose.onNodeWithTag("command-volume").performSemanticsAction(SemanticsActions.SetProgress) { assertTrue(it(35f)) }
    compose.onNodeWithTag("command-volume").assertRangeInfoEquals(androidx.compose.ui.semantics.ProgressBarRangeInfo(35f, 0f..100f, 99))
    compose.onNodeWithTag("command-volume-override").performClick()
    compose.onNodeWithTag("command-volume").assertDoesNotExist()
  }

  @Test fun assetPickerFiltersByCategoryAndAliasAndReturnsSelection() {
    fields(newCommand(CommandKind.BGM), listOf(
      AssetInfo(category = "bgm", name = "theme.ogg", size = 10uL, alias = "Evening music"),
      AssetInfo(category = "bgm", name = "other.ogg", size = 10uL, alias = "Morning"),
      AssetInfo(category = "background", name = "theme.png", size = 10uL, alias = "Evening image"),
    ))
    compose.onNodeWithTag("asset-pick-bgm").performClick()
    compose.onNodeWithTag("asset-search").performTextInput("Evening")
    compose.onNodeWithTag("asset-option-background-theme.png").assertDoesNotExist()
    compose.onNodeWithTag("asset-option-bgm-other.ogg").assertDoesNotExist()
    compose.onNodeWithTag("asset-option-bgm-theme.ogg").performClick()
    compose.onNodeWithTag("asset-search").assertDoesNotExist()
    compose.onNodeWithTag("asset-value-bgm").assertTextContains("theme.ogg")
  }

  @Test fun selectingCharacterAndExpressionUpdatesTheAssetField() {
    val character = newCharacter().copy(name = "Alice", sprites = listOf(
      CharacterSprite("happy", "alice-happy.png", null, "{}"), CharacterSprite("sad", "alice-sad.png", null, "{}"),
    ))
    fields(newCommand(CommandKind.CHANGE_FIGURE), characters = listOf(character))
    compose.onNodeWithTag("select-workspace_speaker", true).performClick()
    compose.onNodeWithText("Alice").performClick()
    compose.onNodeWithTag("asset-value-figure").assertTextContains("alice-happy.png")
    compose.onNodeWithTag("select-command_figure_emotion", true).performClick()
    compose.onNodeWithText("sad").performClick()
    compose.onNodeWithTag("asset-value-figure").assertTextContains("alice-sad.png")
  }

  @Test fun characterDraftGuardsNavigationAndSaveClearsDirtyState() = runBlocking {
    val store = WorkspaceDraftStore(directory)
    val id = UUID.randomUUID().toString()
    store.save(id, WorkspaceDraft(listOf(DraftScene(name = "Start"))))
    val snapshot = store.characters(id)
    store.saveCharacter(id, newCharacter().copy(name = "Alice"), snapshot.revision)
    val changed = AtomicInteger(0)
    mount { CharacterManager(id, store, emptyList(), store.projectDirectory(id), "Alice", {}, { changed.incrementAndGet() }, {}, {}) }
    awaitTag("character-saved")
    compose.onNodeWithTag("field-character_name").performTextReplacement("Alice draft")
    awaitTag("character-unsaved")
    compose.onNodeWithTag("character-back").performClick()
    compose.onNodeWithTag("character-stay").performClick()
    compose.onNodeWithTag("field-character_name").assertTextContains("Alice draft")
    compose.onNodeWithTag("character-save").performClick()
    compose.waitUntil(5_000) { changed.get() == 1 }
    compose.onNodeWithTag("character-saved").assertExists()
    compose.onNodeWithTag("character-back").performClick()
    compose.onNodeWithTag("character-discard").assertDoesNotExist()
  }

  @Test fun keyboardBackPreservesBottomSheetDraft() = keyboardBackPreservesDraft(sheet = true)

  @Test fun keyboardBackPreservesDialogDraft() = keyboardBackPreservesDraft(sheet = false)

  @OptIn(ExperimentalLayoutApi::class)
  private fun keyboardBackPreservesDraft(sheet: Boolean) {
    val imeVisible = AtomicBoolean(false)
    val dismissed = AtomicBoolean(false)
    mount {
      var draft by remember { mutableStateOf("") }
      val content: @Composable () -> Unit = {
        val visible = WindowInsets.isImeVisible
        SideEffect { imeVisible.set(visible) }
        CommandText(draft, R.string.character_name) { draft = it }
      }
      if (sheet) EditorBottomSheet({ dismissed.set(true) }) { content() }
      else EditorDialog({ dismissed.set(true) }) {
        Column(Modifier.fillMaxWidth().heightIn(min = 160.dp)) { content() }
      }
    }
    compose.onNodeWithTag("field-character_name").performClick().performTextInput("Draft")
    compose.waitUntil(5_000) { imeVisible.get() }
    pressBack()
    compose.waitUntil(5_000) { !imeVisible.get() || dismissed.get() }
    assertFalse("Back with the IME open must keep the editor", dismissed.get())
    compose.onNodeWithTag("field-character_name").assertTextContains("Draft")
    pressBack()
    compose.waitUntil(5_000) { dismissed.get() }
  }
}
