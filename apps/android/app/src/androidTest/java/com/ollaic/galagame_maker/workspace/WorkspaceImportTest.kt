package com.ollaic.galagame_maker.workspace

import android.content.Context
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.ollaic.galagame_maker.home.HomeDraftStore
import com.ollaic.galagame_maker.home.HomeProject
import java.io.File
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WorkspaceImportTest {
  private lateinit var directory: File
  private lateinit var workspaces: WorkspaceDraftStore
  private lateinit var projects: HomeDraftStore
  private lateinit var project: HomeProject
  private lateinit var source: File
  private val owner = object : ViewModelStoreOwner { override val viewModelStore = ViewModelStore() }

  @Before fun prepare() = runBlocking {
    val context = ApplicationProvider.getApplicationContext<Context>()
    directory = File(context.cacheDir, "workspace-import-${UUID.randomUUID()}").also { check(it.mkdirs()) }
    workspaces = WorkspaceDraftStore(directory)
    projects = HomeDraftStore(directory)
    project = HomeProject(UUID.randomUUID().toString(), "Animation import", "", "", 1, false, false)
    projects.update { listOf(project) }
    workspaces.open(project, "Opening")
    val root = workspaces.projectDirectory(project.id)
    File(root, "game/scene/start.txt").writeText("setAnimation:my fade -target=fig;\n")
    File(root, "game/animation/animationTable.json").writeText("[\"my fade\"]")
    source = File(directory, "frames.json").also { it.writeText("[{\"alpha\":1,\"duration\":300}]") }
  }

  @After fun cleanUp() = runBlocking {
    withContext(Dispatchers.Main) { owner.viewModelStore.clear() }
    directory.deleteRecursively()
    Unit
  }

  private suspend fun open(): WorkspaceViewModel {
    val model = withContext(Dispatchers.Main) {
      ViewModelProvider(owner, WorkspaceViewModel.Factory(workspaces, projects))[WorkspaceViewModel::class.java].also {
        it.open(project, "Opening")
      }
    }
    withTimeout(5_000) { model.state.first { it.document != null || it.error != null } }
    assertNull(model.state.value.error)
    return model
  }

  private fun append(document: WorkspaceDraft, text: String): WorkspaceDraft = document.copy(
    scenes = document.scenes.mapIndexed { index, scene ->
      if (index == 0) scene.copy(blocks = scene.blocks + ScriptBlock(kind = BlockKind.Narration, text = text)) else scene
    },
  )

  @Test fun animationImportPreservesUnsavedEditsRefreshesIdsAndAllowsTheNextSave() = runBlocking {
    val model = open()
    val sceneId = model.state.value.document!!.scenes[0].id
    val animationId = model.state.value.document!!.scenes[0].blocks[0].id
    withContext(Dispatchers.Main) {
      model.edit { append(it, "Before import") }
      assertTrue(model.importAsset(project.id, source, "animation", "my fade.json"))
      assertEquals(sceneId, model.state.value.document!!.scenes[0].id)
      assertEquals(animationId, model.state.value.document!!.scenes[0].blocks[0].id)
      assertTrue(WorkspaceCodec.sources(model.state.value.document!!)[0].source.contains("setAnimation:my%20fade"))
      model.edit { append(it, "After import") }
      assertTrue(model.persist())
      assertNull(model.state.value.error)
      assertFalse(model.state.value.dirty)
      assertTrue(model.close())
    }
    val loaded = WorkspaceDraftStore(directory).load(project.id)!!
    val script = WorkspaceCodec.sources(loaded)[0].source
    assertTrue(script.contains("Before import"))
    assertTrue(script.contains("After import"))
    assertTrue(script.contains("setAnimation:my%20fade -target=fig;"))
    assertEquals(sceneId, loaded.scenes[0].id)
    assertEquals(animationId, loaded.scenes[0].blocks[0].id)
  }

  @Test fun failedAnimationImportKeepsEditsAndDoesNotPoisonLaterSaves() = runBlocking {
    val model = open()
    File(workspaces.projectDirectory(project.id), "game/animation/my fade.json").writeText("[{\"duration\":100}]")
    withContext(Dispatchers.Main) {
      model.edit { append(it, "Before failed import") }
      assertFalse(model.importAsset(project.id, source, "animation", "my fade.json"))
      assertNotNull(model.state.value.error)
      model.edit { append(it, "After failed import") }
      assertTrue(model.persist())
      assertTrue(model.close())
    }
    val script = WorkspaceCodec.sources(WorkspaceDraftStore(directory).load(project.id)!!)[0].source
    assertTrue(script.contains("Before failed import"))
    assertTrue(script.contains("After failed import"))
    assertEquals("[{\"duration\":100}]", File(workspaces.projectDirectory(project.id), "game/animation/my fade.json").readText())
  }
}
