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
}
