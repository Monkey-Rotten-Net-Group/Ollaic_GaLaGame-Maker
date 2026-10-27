package com.ollaic.galagame_maker.workspace

import android.util.AtomicFile
import com.ollaic.core.AssetInfo
import com.ollaic.core.ExportReport
import com.ollaic.core.createProject
import com.ollaic.core.exportProject
import com.ollaic.core.importProject
import com.ollaic.core.loadWorkspace
import com.ollaic.core.openProject
import com.ollaic.core.saveWorkspace
import com.ollaic.core.updateProjectMetadata
import com.ollaic.galagame_maker.home.HomeProject
import java.io.File
import java.io.FileNotFoundException
import java.text.DateFormat
import java.util.Date
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject

class WorkspaceDraftStore(private val directory: File) {
  private val lock = Mutex()
  private val revisions = mutableMapOf<String, String>()

  private fun validatedId(projectId: String): String {
    val id = UUID.fromString(projectId).toString()
    require(id == projectId) { "Invalid project ID" }
    return id
  }

  fun projectDirectory(projectId: String): File = File(directory, "projects/${validatedId(projectId)}")

  private fun legacyFile(projectId: String) = AtomicFile(File(directory, "workspaces/${validatedId(projectId)}/workspace.json"))

  private fun legacy(projectId: String): WorkspaceDraft? {
    val bytes = try { legacyFile(projectId).readFully() } catch (_: FileNotFoundException) { return null }
    return WorkspaceCodec.decode(projectId, JSONObject(bytes.toString(Charsets.UTF_8)))
  }

  private fun readNative(projectId: String): WorkspaceDraft {
    val snapshot = loadWorkspace(projectDirectory(projectId).absolutePath)
    val document = WorkspaceCodec.fromNative(projectId, snapshot)
    revisions[projectId] = snapshot.revision
    return document
  }

  private fun createStaged(projectId: String, name: String, description: String, document: WorkspaceDraft) {
    document.validate()
    val target = projectDirectory(projectId)
    val library = checkNotNull(target.parentFile)
    check(library.isDirectory || library.mkdirs()) { "Cannot create project library" }
    val staging = File(library, ".migrate-$projectId-${UUID.randomUUID()}")
    try {
      createProject(staging.absolutePath, name)
      val snapshot = loadWorkspace(staging.absolutePath)
      saveWorkspace(staging.absolutePath, WorkspaceCodec.sources(document), document.notes, WorkspaceCodec.encode(projectId, document), snapshot.revision)
      updateProjectMetadata(staging.absolutePath, name, description)
      check(!target.exists() && staging.renameTo(target)) { "Cannot activate project" }
      revisions[projectId] = loadWorkspace(target.absolutePath).revision
    } finally { if (staging.exists()) staging.deleteRecursively() }
  }

  suspend fun open(project: HomeProject, initialSceneName: String): WorkspaceDraft = withContext(Dispatchers.IO) {
    lock.withLock {
      if (!projectDirectory(project.id).exists()) {
        val document = legacy(project.id) ?: WorkspaceDraft(listOf(DraftScene(name = initialSceneName, fileName = "start.txt")))
        createStaged(project.id, project.name, project.description, document)
      }
      readNative(project.id)
    }
  }

  suspend fun load(projectId: String): WorkspaceDraft? = withContext(Dispatchers.IO) {
    lock.withLock { if (projectDirectory(projectId).exists()) readNative(projectId) else legacy(projectId) }
  }

  suspend fun save(projectId: String, document: WorkspaceDraft) = withContext(Dispatchers.IO) {
    lock.withLock {
      document.validate()
      val root = projectDirectory(projectId)
      if (!root.exists()) {
        createStaged(projectId, "Untitled", "", document)
        return@withLock
      }
      val sources = WorkspaceCodec.sources(document)
      val state = WorkspaceCodec.encode(projectId, document)
      val revision = revisions.getOrPut(projectId) { loadWorkspace(root.absolutePath).revision }
      try {
        revisions[projectId] = saveWorkspace(root.absolutePath, sources, document.notes, state, revision)
      } catch (error: Exception) {
        // A previous failed call may have left a durable journal that Rust completes on read.
        val recovered = runCatching { loadWorkspace(root.absolutePath) }.getOrNull()
        if (recovered != null && recovered.scenes.associate { it.fileName to it.source } == sources.associate { it.fileName to it.source } && recovered.notes == document.notes && recovered.editorState == state) {
          revisions[projectId] = recovered.revision
        } else throw error
      }
    }
  }

  suspend fun updateProject(project: HomeProject, initialSceneName: String) = withContext(Dispatchers.IO) {
    lock.withLock {
      if (!projectDirectory(project.id).exists()) {
        createStaged(project.id, project.name, project.description, legacy(project.id) ?: WorkspaceDraft(listOf(DraftScene(name = initialSceneName, fileName = "start.txt"))))
      } else updateProjectMetadata(projectDirectory(project.id).absolutePath, project.name, project.description)
    }
  }

  suspend fun summary(project: HomeProject): HomeProject = withContext(Dispatchers.IO) {
    lock.withLock {
      if (!projectDirectory(project.id).exists()) return@withLock project
      val info = openProject(projectDirectory(project.id).absolutePath)
      project.copy(name = info.name.ifBlank { project.name }, description = info.description, sceneCount = info.scenes.size)
    }
  }

  suspend fun importArchive(archive: File): HomeProject = withContext(Dispatchers.IO) {
    lock.withLock {
      val id = UUID.randomUUID().toString()
      val info = importProject(archive.absolutePath, projectDirectory(id).absolutePath)
      HomeProject(id = id, name = info.name.ifBlank { "Imported project" }, description = info.description,
        sceneCount = info.scenes.size, lastModified = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date()), favorite = false, deleted = false)
    }
  }

  suspend fun exportArchive(projectId: String, archive: File): ExportReport = withContext(Dispatchers.IO) {
    lock.withLock { exportProject(projectDirectory(projectId).absolutePath, archive.absolutePath) }
  }

  suspend fun assets(projectId: String): List<AssetInfo> = withContext(Dispatchers.IO) {
    lock.withLock { com.ollaic.core.listAssets(projectDirectory(projectId).absolutePath) }
  }

  suspend fun importAsset(projectId: String, source: File, category: String, name: String): AssetInfo = withContext(Dispatchers.IO) {
    lock.withLock { com.ollaic.core.importAsset(projectDirectory(projectId).absolutePath, source.absolutePath, category, name) }
  }

  suspend fun characters(projectId: String): com.ollaic.core.CharactersSnapshot = withContext(Dispatchers.IO) {
    lock.withLock { com.ollaic.core.loadCharacters(projectDirectory(projectId).absolutePath) }
  }

  suspend fun saveCharacter(projectId: String, character: com.ollaic.core.CharacterInfo, revision: String) = withContext(Dispatchers.IO) {
    lock.withLock { com.ollaic.core.saveCharacter(projectDirectory(projectId).absolutePath, character, revision) }
  }

  suspend fun deleteCharacter(projectId: String, id: String, revision: String) = withContext(Dispatchers.IO) {
    lock.withLock { com.ollaic.core.deleteCharacter(projectDirectory(projectId).absolutePath, id, revision) }
  }

  suspend fun assetDetails(projectId: String, asset: AssetInfo) = withContext(Dispatchers.IO) {
    lock.withLock { com.ollaic.core.assetDetails(projectDirectory(projectId).absolutePath, asset.category, asset.name) }
  }

  suspend fun saveAssetDetails(projectId: String, asset: AssetInfo, details: com.ollaic.core.AssetDetails) = withContext(Dispatchers.IO) {
    lock.withLock { com.ollaic.core.saveAssetDetails(projectDirectory(projectId).absolutePath, asset.category, asset.name, details) }
  }

  suspend fun usages(projectId: String, asset: AssetInfo) = withContext(Dispatchers.IO) {
    lock.withLock { com.ollaic.core.assetUsages(projectDirectory(projectId).absolutePath, asset.category, asset.name) }
  }

  suspend fun renameAsset(projectId: String, asset: AssetInfo, name: String) = withContext(Dispatchers.IO) {
    lock.withLock {
      val root = projectDirectory(projectId).absolutePath
      val revision = revisions.getOrPut(projectId) { loadWorkspace(root).revision }
      com.ollaic.core.renameAsset(root, asset.category, asset.name, name, revision)
    }
  }

  suspend fun deleteAsset(projectId: String, asset: AssetInfo) = withContext(Dispatchers.IO) {
    lock.withLock {
      val root = projectDirectory(projectId).absolutePath
      val revision = revisions.getOrPut(projectId) { loadWorkspace(root).revision }
      com.ollaic.core.deleteAsset(root, asset.category, asset.name, revision)
    }
  }

  suspend fun animation(projectId: String, name: String) = withContext(Dispatchers.IO) {
    lock.withLock { com.ollaic.core.readAnimation(projectDirectory(projectId).absolutePath, name) }
  }

  suspend fun saveAnimation(projectId: String, name: String, source: String, revision: String) = withContext(Dispatchers.IO) {
    lock.withLock { com.ollaic.core.saveAnimation(projectDirectory(projectId).absolutePath, name, source, revision) }
  }

  suspend fun delete(projectId: String) = withContext(Dispatchers.IO) {
    lock.withLock {
      val target = projectDirectory(projectId)
      check(!target.exists() || target.deleteRecursively()) { "Cannot delete project directory" }
      val legacy = checkNotNull(legacyFile(projectId).baseFile.parentFile)
      check(!legacy.exists() || legacy.deleteRecursively()) { "Cannot delete legacy workspace" }
      revisions.remove(projectId)
    }
  }
}
