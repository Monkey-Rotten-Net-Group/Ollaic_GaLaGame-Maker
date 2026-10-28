package com.ollaic.galagame_maker.ui

import android.content.Context
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.espresso.Espresso.closeSoftKeyboard
import com.ollaic.core.AssetInfo
import com.ollaic.core.readCommand
import com.ollaic.galagame_maker.R
import com.ollaic.galagame_maker.home.HomeDraftStore
import com.ollaic.galagame_maker.home.HomeProject
import com.ollaic.galagame_maker.home.OllaicTheme
import com.ollaic.galagame_maker.workspace.*
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CommandSheetImportTest {
  @get:Rule val compose = createComposeRule()
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private val owner = object : ViewModelStoreOwner { override val viewModelStore = ViewModelStore() }
  private lateinit var directory: File
  private lateinit var workspaces: WorkspaceDraftStore
  private lateinit var project: HomeProject
  private lateinit var model: WorkspaceViewModel
  private var showing by mutableStateOf(true)
  private val original = "setAnimation:my fade -target=fig -future=keep; comment\r\n"

  @Before fun prepare() = runBlocking {
    directory = File(context.cacheDir, "command-sheet-import-${UUID.randomUUID()}").also { check(it.mkdirs()) }
    workspaces = WorkspaceDraftStore(directory)
    val projects = HomeDraftStore(directory)
    project = HomeProject(UUID.randomUUID().toString(), "Import regression", "", "", 1, false, false)
    projects.update { listOf(project) }
    workspaces.open(project, "Opening")
    val root = workspaces.projectDirectory(project.id)
    File(root, "game/scene/start.txt").writeText(original)
    File(root, "game/animation/animationTable.json").writeText("[\"my fade\"]")
    model = withContext(Dispatchers.Main) {
      ViewModelProvider(owner, WorkspaceViewModel.Factory(workspaces, projects))[WorkspaceViewModel::class.java].also { it.open(project, "Opening") }
    }
    withTimeout(5_000) { model.state.first { it.document != null } }
    Unit
  }

  @After fun cleanUp() = runBlocking {
    compose.runOnIdle { showing = false }
    compose.waitForIdle()
    withContext(Dispatchers.Main) { owner.viewModelStore.clear() }
    directory.deleteRecursively()
    Unit
  }

  @Test fun openFormKeepsTheCanonicalReferenceAfterAnimationImport() = importFromOpenForm(false)

  @Test fun openFormKeepsPendingFieldsWhenAnimationImportUpdatesItsSource() = importFromOpenForm(true)

  private fun importFromOpenForm(editTarget: Boolean) {
    val imported = AtomicBoolean(false)
    val persisted = AtomicBoolean(false)
    val emitted = AtomicReference<String>()
    val file = File(directory, "frames.json").also { it.writeText("[{\"alpha\":1,\"duration\":300}]") }
    compose.setContent { OllaicTheme { if (showing) {
      val state by model.state.collectAsState()
      val document = state.document!!
      val scene = document.scenes[0]
      val block = scene.blocks[0]
      val scope = rememberCoroutineScope()
      var assets by remember { mutableStateOf<List<AssetInfo>>(emptyList()) }
      BlockEditorSheet(block, document.scenes, scene.id, assets, emptyList(), workspaces.projectDirectory(project.id), !state.managingAssets,
        onImport = { category -> scope.launch {
          assertTrue(model.importAsset(project.id, file, category, "my fade.json"))
          assets = workspaces.assets(project.id)
          imported.set(true)
        } }, onManageCharacters = {}, onDismiss = {}, onSave = { source ->
          emitted.set(source)
          model.edit { draft -> draft.copy(scenes = draft.scenes.map { current ->
            if (current.id != scene.id) current else current.copy(blocks = WorkspaceCodec.blocks(source).mapIndexed { index, fresh ->
              if (index == 0) fresh.copy(id = block.id) else fresh
            })
          }) }
          scope.launch { persisted.set(model.persist()) }
        })
    } } }
    if (editTarget) {
      compose.onNodeWithTag("field-command_transform_target").performScrollTo().performTextReplacement("draft-target")
      closeSoftKeyboard()
    }
    compose.onNodeWithTag("asset-pick-animation").performScrollTo().performClick()
    compose.onNodeWithContentDescription(context.getString(R.string.workspace_import_asset)).performClick()
    compose.waitUntil(10_000) { imported.get() }
    compose.onNodeWithTag("asset-option-animation-my fade.json").performClick()
    compose.onNodeWithTag("command-save").performClick()
    try { compose.waitUntil(10_000) { persisted.get() || model.state.value.error != null } }
    catch (failure: Throwable) { throw AssertionError("Save did not complete: emitted=${emitted.get()}, error=${model.state.value.error}, commandErrors=${compose.onAllNodesWithTag("command-error").fetchSemanticsNodes()}", failure) }
    assertTrue(model.state.value.error, persisted.get())
    val rendered = checkNotNull(emitted.get())
    assertTrue(rendered.startsWith("setAnimation:my%20fade"))
    assertEquals(if (editTarget) "draft-target" else "fig", readCommand(rendered).target)
    assertTrue(rendered.contains("-future=keep"))
    assertTrue(rendered.endsWith("; comment\r\n"))
    assertEquals(rendered, File(workspaces.projectDirectory(project.id), "game/scene/start.txt").readText())
    assertTrue(File(workspaces.projectDirectory(project.id), "game/animation/animationTable.json").readText().contains("my%20fade"))
  }

  @Test fun sourceDraftKeepsLocalEditsAndIncomingReferenceNormalization() {
    var block by mutableStateOf(WorkspaceCodec.blocks(original).single())
    val saved = AtomicReference<String>()
    compose.setContent { OllaicTheme { if (showing) {
      BlockEditorSheet(block, emptyList(), null, emptyList(), emptyList(), directory, true, {}, {}, {}, { saved.set(it) })
    } } }
    compose.onNodeWithTag("command-mode-source").performClick()
    compose.onNodeWithTag("command-source").performTextReplacement(original.replace("target=fig", "target=draft-target"))
    compose.runOnIdle { block = block.copy(text = original.replace("my fade", "my%20fade").trimEnd(), source = original.replace("my fade", "my%20fade")) }
    compose.onNodeWithTag("command-save").performClick()
    compose.waitUntil { saved.get() != null }
    assertEquals(original.replace("my fade", "my%20fade").replace("target=fig", "target=draft-target"), saved.get())
  }

  @Test fun formDraftAdoptsUpdatedAssetWithoutDiscardingTheEditedTarget() {
    var block by mutableStateOf(WorkspaceCodec.blocks(original).single())
    val saved = AtomicReference<String>()
    compose.setContent { OllaicTheme { if (showing) {
      BlockEditorSheet(block, emptyList(), null, emptyList(), emptyList(), directory, true, {}, {}, {}, { saved.set(it) })
    } } }
    compose.onNodeWithTag("field-command_transform_target").performScrollTo().performTextReplacement("draft-target")
    closeSoftKeyboard()
    val incoming = original.replace("my fade", "renamed")
    compose.runOnIdle { block = block.copy(text = incoming.trimEnd(), source = incoming) }
    compose.onNodeWithTag("command-save").performClick()
    compose.waitUntil { saved.get() != null }
    val rendered = checkNotNull(saved.get())
    assertEquals("renamed.json", readCommand(rendered).asset)
    assertEquals("draft-target", readCommand(rendered).target)
    assertTrue(rendered.contains("-future=keep"))
    assertTrue(rendered.endsWith("; comment\r\n"))
  }

  @Test fun overlappingSourceEditsCanExplicitlyAcceptTheProjectUpdate() = sourceConflict(false)

  @Test fun overlappingSourceEditsKeepTheDraftUntilExplicitOverwrite() = sourceConflict(true)

  private fun sourceConflict(overwrite: Boolean) {
    var block by mutableStateOf(WorkspaceCodec.blocks(original).single())
    val saved = AtomicReference<String>()
    compose.setContent { OllaicTheme { if (showing) {
      BlockEditorSheet(block, emptyList(), null, emptyList(), emptyList(), directory, true, {}, {}, {}, { saved.set(it) })
    } } }
    compose.onNodeWithTag("command-mode-source").performClick()
    val local = original.replace("my fade", "local")
    compose.onNodeWithTag("command-source").performTextReplacement(local)
    val incoming = original.replace("my fade", "incoming")
    compose.runOnIdle { block = block.copy(text = incoming.trimEnd(), source = incoming) }
    compose.onNodeWithTag("command-save").assertIsNotEnabled()
    compose.onNodeWithTag(if (overwrite) "command-overwrite-update" else "command-use-update").performClick()
    compose.onNodeWithTag("command-source").assertTextContains(if (overwrite) local else incoming)
    compose.onNodeWithTag("command-save").performClick()
    compose.waitUntil { saved.get() != null }
    assertEquals(if (overwrite) local else incoming, saved.get())
  }
}
