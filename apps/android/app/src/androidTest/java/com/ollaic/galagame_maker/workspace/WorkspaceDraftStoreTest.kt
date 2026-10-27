package com.ollaic.galagame_maker.workspace

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import android.content.Context
import com.ollaic.galagame_maker.home.HomeDraftStore
import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WorkspaceDraftStoreTest {
  private fun temporaryDirectory(): File {
    val context = ApplicationProvider.getApplicationContext<Context>()
    return File(context.cacheDir, "workspace-test-${UUID.randomUUID()}").also { check(it.mkdirs()) }
  }

  @Test fun roundTripPreservesScenesBlocksAndProjectIsolation() = runBlocking {
    val directory = temporaryDirectory()
    try {
      val store = WorkspaceDraftStore(directory)
      val first = UUID.randomUUID().toString()
      val second = UUID.randomUUID().toString()
      assertNull(store.load(first))
      val document = WorkspaceDraft(listOf(
        DraftScene(name = "Start", blocks = listOf(ScriptBlock(kind = BlockKind.Dialogue, speaker = "Alice", text = "Hello"))),
        DraftScene(name = "Next"),
      ), notes = "Project notes")
      store.save(first, document)
      assertEquals(document, WorkspaceDraftStore(directory).load(first))
      assertNull(store.load(second))
      store.save(second, WorkspaceDraft(listOf(DraftScene(name = "Other"))))
      assertEquals(document, store.load(first))
    } finally { directory.deleteRecursively() }
  }

  @Test fun invalidDocumentAndProjectPathCannotOverwriteSavedData() = runBlocking {
    val directory = temporaryDirectory()
    try {
      val store = WorkspaceDraftStore(directory)
      val id = UUID.randomUUID().toString()
      val document = WorkspaceDraft(listOf(DraftScene(name = "Start")))
      store.save(id, document)
      assertTrue(runCatching { store.save(id, document.copy(scenes = emptyList())) }.isFailure)
      assertTrue(runCatching { store.save("../outside", document) }.isFailure)
      assertEquals(document, store.load(id))
    } finally { directory.deleteRecursively() }
  }

  @Test fun legacyHomeIndexLoadsAndRoundTripsSceneCounts() = runBlocking {
    val directory = temporaryDirectory()
    try {
      val id = UUID.randomUUID().toString()
      File(directory, "native-home-drafts.json").writeText(
        """{"version":1,"projects":[{"id":"$id","name":"Legacy","description":"","lastModified":""}]}"""
      )
      val store = HomeDraftStore(directory)
      assertEquals(0, store.load().single().sceneCount)
      store.update { list -> list.map { it.copy(sceneCount = 3) } }
      assertEquals(3, HomeDraftStore(directory).load().single().sceneCount)
    } finally { directory.deleteRecursively() }
  }

  @Test fun deletionRemovesWorkspaceAndAtomicFilesWithoutAffectingOtherProjects() = runBlocking {
    val directory = temporaryDirectory()
    try {
      val store = WorkspaceDraftStore(directory)
      val first = UUID.randomUUID().toString()
      val second = UUID.randomUUID().toString()
      val document = WorkspaceDraft(listOf(DraftScene(name = "Start")), notes = "Private notes")
      store.save(first, document)
      store.save(second, document)
      val target = store.projectDirectory(first)
      File(target, "workspace.json.bak").writeText("Old content")
      File(target, "workspace.json.new").writeText("Pending content")

      store.delete(first)

      assertFalse(target.exists())
      assertNull(store.load(first))
      assertEquals(document, store.load(second))
      store.delete(first)
      assertTrue(runCatching { store.delete("../outside") }.isFailure)
      assertEquals(document, store.load(second))
    } finally { directory.deleteRecursively() }
  }

  @Test fun legacyDraftMigrationCreatesAWebGalProjectAndRetainsTheOriginal() = runBlocking {
    val directory = temporaryDirectory()
    try {
      val id = UUID.randomUUID().toString()
      val sceneId = UUID.randomUUID().toString()
      val blockId = UUID.randomUUID().toString()
      val legacy = File(directory, "workspaces/$id/workspace.json")
      check(legacy.parentFile!!.mkdirs())
      val root = org.json.JSONObject("""{"version":1,"projectId":"$id","notes":"Writing notes","scenes":[{"id":"$sceneId","name":"Opening","blocks":[{"id":"$blockId","kind":"Dialogue","speaker":"Alice","text":"Legacy dialogue"}]}]}""")
      root.getJSONArray("scenes").getJSONObject(0).getJSONArray("blocks").getJSONObject(0).put("text", "Legacy dialogue; punctuation\nSecond line")
      val source = root.toString()
      legacy.writeText(source)
      val project = com.ollaic.galagame_maker.home.HomeProject(id = id, name = "Legacy project", description = "Synopsis", lastModified = "", sceneCount = 0, favorite = false, deleted = false)
      val store = WorkspaceDraftStore(directory)
      val migrated = store.open(project, "Opening")
      assertEquals(sceneId, migrated.scenes.single().id)
      assertEquals(blockId, migrated.scenes.single().blocks.single().id)
      assertEquals("Writing notes", migrated.notes)
      assertEquals("start.txt", migrated.scenes.single().fileName)
      assertEquals("Alice:Legacy dialogue\\; punctuation;\nAlice:Second line;\n", File(store.projectDirectory(id), "game/scene/start.txt").readText())
      assertEquals("Legacy project", com.ollaic.core.openProject(store.projectDirectory(id).absolutePath).name)
      assertEquals(source, legacy.readText())
      assertEquals(migrated, WorkspaceDraftStore(directory).open(project, "Opening"))
    } finally { directory.deleteRecursively() }
  }

  @Test fun importedProjectEditsAreSavedToWebGalAndSurviveRepositoryRecreation() = runBlocking {
    val directory = temporaryDirectory()
    try {
      val desktop = File(directory, "desktop")
      com.ollaic.core.createProject(desktop.absolutePath, "Desktop project")
      val original = "changeBg:park.png -next;\r\nAlice:Hello -v1.ogg; inline\r\n\r\nfutureExtension:keep -flag=value;\n"
      File(desktop, "game/scene/start.txt").writeText(original)
      File(desktop, "story-plan.json").writeText("{\"preserved\":true}")
      val archive = File(directory, "desktop.zip")
      com.ollaic.core.exportProject(desktop.absolutePath, archive.absolutePath)
      val store = WorkspaceDraftStore(directory)
      val project = store.importArchive(archive)
      val loaded = store.open(project, "Opening")
      val edited = loaded.copy(notes = "New notes", scenes = loaded.scenes.map { scene ->
        scene.copy(blocks = scene.blocks.map { block ->
          if (block.speaker == "Alice") block.copy(text = "Edited on Android") else block
        })
      })
      store.save(project.id, edited)
      assertEquals(edited, WorkspaceDraftStore(directory).open(project, "Opening"))
      val exported = File(directory, "android.zip")
      store.exportArchive(project.id, exported)
      val restored = com.ollaic.core.importProject(exported.absolutePath, File(directory, "restored").absolutePath)
      val source = File(restored.path, "game/scene/start.txt").readText()
      assertTrue(source.contains("Alice:Edited on Android -v1.ogg; inline\r\n"))
      assertTrue(source.contains("changeBg:park.png -next;\r\n"))
      assertTrue(source.contains("futureExtension:keep -flag=value;\n"))
      assertEquals("{\"preserved\":true}", File(restored.path, "story-plan.json").readText())
    } finally { directory.deleteRecursively() }
  }

  @Test fun externalSceneChangesCannotBeOverwrittenByAStaleEditor() = runBlocking {
    val directory = temporaryDirectory()
    try {
      val store = WorkspaceDraftStore(directory)
      val project = com.ollaic.galagame_maker.home.HomeProject(id = UUID.randomUUID().toString(), name = "Conflict", description = "", lastModified = "", sceneCount = 0, favorite = false, deleted = false)
      val opened = store.open(project, "Opening")
      val scene = File(store.projectDirectory(project.id), "game/scene/start.txt")
      scene.writeText("External edit;\n")
      assertTrue(runCatching { store.save(project.id, opened.copy(notes = "Local notes")) }.isFailure)
      assertEquals("External edit;\n", scene.readText())
    } finally { directory.deleteRecursively() }
  }

  @Test fun existingEditorCacheRecoversCommandTypesWithoutChangingSourceOrIds() {
    val source = "callScene:chapter2.txt -when=ready; keep\r\nchangeBg:park.png;\r\nlabel:branch_a;\r\njumpLabel:branch_a;\r\n"
    val oldBlocks = com.ollaic.core.decodeLines(source).mapIndexed { index, line ->
      ScriptBlock(id = "block-$index", kind = BlockKind.Command, text = line.text, source = line.source)
    }
    val previous = WorkspaceDraft(listOf(DraftScene(id = "scene", name = "Start", fileName = "start.txt", blocks = oldBlocks)))
    val cached = WorkspaceCodec.encode("project", previous)
    val restored = WorkspaceCodec.fromNative("project", com.ollaic.core.WorkspaceSnapshot(
      listOf(com.ollaic.core.SceneSource("start.txt", source)), "", cached, "revision",
    ))
    val blocks = restored.scenes.single().blocks
    assertEquals("scene", restored.scenes.single().id)
    assertEquals(oldBlocks.map { it.id }, blocks.map { it.id })
    assertEquals(listOf("callScene", "changeBg", "label", "jumpLabel"), blocks.map { it.command })
    assertEquals(listOf("chapter2.txt", "park.png", "branch_a", "branch_a"), blocks.map { it.preview })
    assertTrue(blocks.all { commandTitles.containsKey(it.command) })
    assertEquals(source, WorkspaceCodec.sources(restored).single().source)
    val renamed = WorkspaceCodec.classify(blocks[0].copy(text = "callScene:renamed.txt;", source = "callScene:renamed.txt;"))
    assertEquals("callScene", renamed.command)
    assertEquals("renamed.txt", renamed.preview)
    assertEquals("changeBg", WorkspaceCodec.blocks(com.ollaic.core.assetCommand("background", "new.png")).single().command)
  }
}
