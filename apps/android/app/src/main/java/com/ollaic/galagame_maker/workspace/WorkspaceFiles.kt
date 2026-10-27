package com.ollaic.galagame_maker.workspace

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.platform.LocalContext
import com.ollaic.galagame_maker.DocumentFiles
import com.ollaic.galagame_maker.R
import com.ollaic.galagame_maker.home.HomeProject
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

data class WorkspaceFileActions(
  val busy: Boolean,
  val error: String?,
  val notice: String?,
  val dismiss: () -> Unit,
  val exportProject: () -> Unit,
  val importScene: () -> Unit,
  val exportScene: () -> Unit,
  val importAsset: (String) -> Unit,
)

@Composable
fun rememberWorkspaceFiles(
  project: HomeProject,
  document: WorkspaceDraft?,
  scene: DraftScene?,
  editor: WorkspaceViewModel,
  workspaces: WorkspaceDraftStore,
  onImportedScene: (DraftScene) -> Unit,
  onAssetsChanged: () -> Unit,
): WorkspaceFileActions {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  var busy by remember(project.id) { mutableStateOf(false) }
  var error by remember(project.id) { mutableStateOf<String?>(null) }
  var notice by remember(project.id) { mutableStateOf<String?>(null) }
  var exportSceneId by rememberSaveable(project.id) { mutableStateOf<String?>(null) }
  var assetCategory by rememberSaveable { mutableStateOf("background") }
  var assetImportOwner by rememberSaveable { mutableStateOf<String?>(null) }

  fun transfer(operation: suspend () -> Unit) {
    if (busy) return
    busy = true
    scope.launch {
      try { operation() } catch (failure: Exception) {
        if (failure is CancellationException) throw failure
        error = failure.message ?: failure.javaClass.simpleName
      } finally { busy = false }
    }
  }

  val projectExport = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/zip")) { uri ->
    if (uri != null) transfer {
      val report = DocumentFiles.write(context, uri) { output -> workspaces.exportArchive(project.id, output) }
      notice = if (report.warnings.isEmpty()) context.getString(R.string.workspace_exported) else report.warnings.joinToString("\n") {
        if (it.contains("runtime")) context.getString(R.string.workspace_runtime_missing) else it
      }
    }
  }
  val sceneImport = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
    if (uri != null) transfer {
      val imported = DocumentFiles.read(context, uri, 32L * 1024 * 1024) { input, name ->
        val fileName = com.ollaic.core.sceneFileName(name)
        val source = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(input.readBytes())).toString()
        DraftScene(name = fileName.removeSuffix(".txt"), fileName = fileName, blocks = WorkspaceCodec.blocks(source))
      }
      check(document?.scenes?.none { it.fileName.equals(imported.fileName, ignoreCase = true) } == true) { context.getString(R.string.workspace_duplicate_scene) }
      onImportedScene(imported)
    }
  }
  val sceneExport = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/plain")) { uri ->
    if (uri != null) transfer {
      val selected = checkNotNull(document?.scenes?.firstOrNull { it.id == exportSceneId }) { "Scene is unavailable" }
      DocumentFiles.write(context, uri) { output -> output.writeText(WorkspaceCodec.sources(WorkspaceDraft(listOf(selected))).single().source) }
      notice = context.getString(R.string.workspace_scene_exported)
    }
  }
  val assetImport = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
    val owner = assetImportOwner; assetImportOwner = null
    if (uri != null && owner != project.id) error = context.getString(R.string.workspace_import_cancelled)
    else if (uri != null) transfer {
      DocumentFiles.read(context, uri) { source, name -> workspaces.importAsset(project.id, source, assetCategory, name) }
      onAssetsChanged()
      notice = context.getString(R.string.workspace_asset_imported)
    }
  }
  return WorkspaceFileActions(
    busy = busy, error = error, notice = notice, dismiss = { error = null; notice = null },
    exportProject = { transfer { if (editor.persist()) projectExport.launch("${project.name.replace(Regex("[\\\\/:*?\"<>|]"), "_")}.zip") } },
    importScene = { if (!busy) sceneImport.launch(arrayOf("text/plain", "application/octet-stream")) },
    exportScene = { transfer {
      if (scene != null && editor.persist()) { exportSceneId = scene.id; sceneExport.launch(scene.fileName.ifBlank { "scene.txt" }) }
    } },
    importAsset = { category ->
      if (!busy) {
        assetCategory = category
        assetImportOwner = project.id
        val mime = when (category) { "background", "figure", "tex", "reference" -> "image/*"; "bgm", "vocal" -> "audio/*"; "video" -> "video/*"; else -> "*/*" }
        assetImport.launch(arrayOf(mime))
      }
    },
  )
}
