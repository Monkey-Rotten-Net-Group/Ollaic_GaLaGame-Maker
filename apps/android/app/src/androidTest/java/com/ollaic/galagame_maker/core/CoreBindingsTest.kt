package com.ollaic.galagame_maker.core

import android.content.res.AssetManager
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import android.content.Context
import com.ollaic.core.*
import java.io.File
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CoreBindingsTest {
  private fun copyFixture(assets: AssetManager, source: String, target: File) {
    val children = assets.list(source).orEmpty()
    if (children.isEmpty()) {
      check(target.parentFile!!.isDirectory || target.parentFile!!.mkdirs())
      assets.open(source).use { input -> target.outputStream().use { input.copyTo(it) } }
    } else {
      check(target.isDirectory || target.mkdirs())
      children.forEach { copyFixture(assets, "$source/$it", File(target, it)) }
    }
  }

  @Test fun realNativeLibraryCreatesEditsAndRestoresAProject() {
    assertEquals("0.1.0", coreVersion())
    val context = ApplicationProvider.getApplicationContext<Context>()
    val directory = File(context.cacheDir, "uniffi-${UUID.randomUUID()}").also { check(it.mkdirs()) }
    try {
      val root = File(directory, "project").absolutePath
      assertEquals(listOf("start.txt"), createProject(root, "Android binding").scenes)
      val before = loadWorkspace(root)
      val source = editLine("", "Dialogue", "Alice", "Hello through UniFFI")
      saveWorkspace(root, listOf(SceneSource("start.txt", source)), "Native notes", "", before.revision)
      val report = exportProject(root, File(directory, "project.zip").absolutePath)
      val imported = importProject(report.outputPath, File(directory, "restored").absolutePath)
      val restored = loadWorkspace(imported.path)
      assertEquals("Native notes", restored.notes)
      assertEquals("Hello through UniFFI", decodeLines(restored.scenes.single().source).single().text)
    } finally { directory.deleteRecursively() }
  }

  @Test fun desktopFixtureRetainsUnknownCommandsAndEditorFilesAcrossNativeBindings() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val directory = File(context.cacheDir, "desktop-${UUID.randomUUID()}").also { check(it.mkdirs()) }
    try {
      val project = File(directory, "project")
      copyFixture(InstrumentationRegistry.getInstrumentation().context.assets, "desktop-project", project)
      val summary = openProject(project.absolutePath)
      assertEquals("Desktop Round Trip", summary.name)
      val before = loadWorkspace(project.absolutePath)
      val scenes = before.scenes.map { scene ->
        if (scene.fileName != "start.txt") scene else {
          val lines = decodeLines(scene.source).map { line ->
            if (line.speaker == "Alice") editLine(line.source, line.kind, line.speaker, "Edited on Android") else line.source
          }
          SceneSource(scene.fileName, assembleLines(lines))
        }
      }
      saveWorkspace(project.absolutePath, scenes, "", "", before.revision)
      val report = exportProject(project.absolutePath, File(directory, "edited.zip").absolutePath)
      val imported = importProject(report.outputPath, File(directory, "restored").absolutePath)
      val restored = File(imported.path)
      assertTrue(File(restored, "game/scene/start.txt").readText().contains("futureExtension:payload -custom=value;"))
      assertTrue(File(restored, "game/scene/start.txt").readText().contains("Edited on Android"))
      listOf("project-metadata.json", "story-plan.json", ".ollaic/memory.json", "game/background/park.svg").forEach { path ->
        assertArrayEquals(path, File(project, path).readBytes(), File(restored, path).readBytes())
      }
    } finally { directory.deleteRecursively() }
  }

  @Test fun representativeCommandRecordsRoundTripThroughKotlinProjectSaveAndExport() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val directory = File(context.cacheDir, "commands-${UUID.randomUUID()}").also { check(it.mkdirs()) }
    try {
      val root = File(directory, "project").absolutePath
      createProject(root, "Structured commands")
      val sources = listOf(
        "Alice:Hello -v1; keep\r\n", "choose:Next:chapter.txt|Stay;\n",
        "getUserInput:name -title=Your name -buttonText=All done;\n",
        "changeFigure:none -left -id=hero -figureCharacter=Alice -figureEmotion=happy;\n",
        "bgm:none -volume=30;\n",
      )
      val changed = sources.map { source ->
        val edit = readCommand(source)
        assertEquals(source, editCommand(source, edit))
        val updated = when (edit.kind) {
          CommandKind.CHOOSE -> edit.copy(choices = edit.choices.reversed() + CommandChoice("Label", "branch_a"), `when` = "score > 1")
          CommandKind.GET_USER_INPUT -> edit.copy(variable = "answer", title = "New title", button = "Continue")
          CommandKind.CHANGE_FIGURE -> edit.copy(figurePosition = "right", figureEmotion = "sad")
          CommandKind.BGM -> edit.copy(volume = null)
          else -> edit.copy(next = true, `when` = "score > 1")
        }
        editCommand(source, updated).also { assertEquals(updated, readCommand(it)) }
      }
      val fresh = newCommand(CommandKind.SET_VAR).copy(variable = "ready", value = "true")
      val source = assembleLines(changed + editCommand("", fresh))
      val before = loadWorkspace(root)
      saveWorkspace(root, listOf(SceneSource("start.txt", source), SceneSource("chapter.txt", "end:;\n")), "", "", before.revision)
      val report = exportProject(root, File(directory, "commands.zip").absolutePath)
      val restored = importProject(report.outputPath, File(directory, "restored").absolutePath)
      val restoredSource = loadWorkspace(restored.path).scenes.first { it.fileName == "start.txt" }.source
      assertEquals(source, restoredSource)
      assertEquals(6, decodeLines(restoredSource).size)
      assertTrue(restoredSource.contains("-v1"))
      assertTrue(restoredSource.contains("; keep\r\n"))
    } finally { directory.deleteRecursively() }
  }

  @Test fun realCatalogApisPreserveCharacterMetadataAndAssetLinksAcrossExport() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val directory = File(context.cacheDir, "catalog-${UUID.randomUUID()}").also { check(it.mkdirs()) }
    try {
      val root = File(directory, "project").absolutePath
      createProject(root, "Catalog bindings")
      val image = File(directory, "sprite.png").apply { writeBytes(byteArrayOf(1, 2, 3, 4)) }
      importAsset(root, image.absolutePath, "figure", "hero/happy.png")
      val before = loadCharacters(root)
      val character = newCharacter().copy(name = "Alice", age = "18", extraJson = "{\"future\":true}",
        sprites = listOf(CharacterSprite("happy", "hero/happy.png", "A smile", "{\"futureSprite\":1}")))
      assertEquals(character, decodeCharacter(encodeCharacter(character)))
      val saved = saveCharacter(root, character, before.revision)
      assertTrue(saved.characters.single().id.startsWith("char_"))
      val details = assetDetails(root, "figure", "hero/happy.png")
      saveAssetDetails(root, "figure", "hero/happy.png", details.copy(alias = "Alice happy", tags = listOf("portrait")))
      val workspace = loadWorkspace(root)
      val source = assetCommand("figure", "hero/happy.png")
      val revision = saveWorkspace(root, listOf(SceneSource("start.txt", source)), "", "", workspace.revision)
      assertEquals(2, assetUsages(root, "figure", "hero/happy.png").size)
      renameAsset(root, "figure", "hero/happy.png", "hero/renamed.png", revision)
      assertEquals("hero/renamed.png", loadCharacters(root).characters.single().sprites.single().file)
      assertEquals("Alice happy", listAssets(root).single { it.name == "hero/renamed.png" }.alias)
      assertTrue(loadWorkspace(root).scenes.single().source.contains("hero/renamed.png"))
      val animation = saveAnimation(root, "fade.json", "[{\"alpha\":0,\"duration\":100}]", "")
      assertEquals(animation, readAnimation(root, "fade.json"))
      importAsset(root, image.absolutePath, "background", "park.png")
      val prefix = assetReferencePrefix("background", "park.png")
      assertEquals("backgrounds/park.png/", prefix)
      importAsset(root, image.absolutePath, "reference", prefix + "ref.png")
      val background = assetDetails(root, "background", "park.png")
      saveAssetDetails(root, "background", "park.png", background.copy(references = listOf("ref.png")))
      renameAsset(root, "background", "park.png", "evening.png", loadWorkspace(root).revision)
      assertTrue(listAssets(root).any { it.category == "reference" && it.name == "backgrounds/evening.png/ref.png" })
      assertFalse(listAssets(root).any { it.category == "reference" && it.name == "backgrounds/park.png/ref.png" })
      assertEquals(1, assetUsages(root, "reference", "backgrounds/evening.png/ref.png").size)
      val report = exportProject(root, File(directory, "catalog.zip").absolutePath)
      val imported = importProject(report.outputPath, File(directory, "restored").absolutePath)
      val restored = loadCharacters(imported.path).characters.single()
      assertTrue(restored.extraJson.contains("future"))
      assertTrue(restored.sprites.single().extraJson.contains("futureSprite"))
      assertEquals("Alice happy", assetDetails(imported.path, "figure", "hero/renamed.png").alias)
      val latest = loadCharacters(imported.path)
      assertTrue(deleteCharacter(imported.path, latest.characters.single().id, latest.revision).characters.isEmpty())
    } finally { directory.deleteRecursively() }
  }
}
