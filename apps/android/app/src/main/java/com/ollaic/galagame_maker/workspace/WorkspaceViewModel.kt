package com.ollaic.galagame_maker.workspace

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.ollaic.galagame_maker.home.HomeDraftStore
import com.ollaic.galagame_maker.home.HomeProject
import java.io.File
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class WorkspaceState(
  val projectId: String? = null,
  val history: WorkspaceHistory? = null,
  val saved: WorkspaceDraft? = null,
  val summaryDirty: Boolean = false,
  val saving: Boolean = false,
  val error: String? = null,
  val managingAssets: Boolean = false,
  val resourceRevision: Int = 0,
  val savedResourceRevision: Int = 0,
) {
  val document: WorkspaceDraft? get() = history?.current
  val dirty: Boolean get() = document != null && (document != saved || summaryDirty || resourceRevision != savedResourceRevision)
}

class WorkspaceViewModel(
  private val workspaces: WorkspaceDraftStore,
  private val projects: HomeDraftStore,
) : ViewModel() {
  private val mutable = MutableStateFlow(WorkspaceState())
  val state: StateFlow<WorkspaceState> = mutable.asStateFlow()
  private val saveLock = Mutex()
  private var opening: Job? = null
  private var saveDelay: Job? = null
  private var active = false

  fun open(project: HomeProject, initialSceneName: String) {
    if (active && mutable.value.projectId == project.id && (mutable.value.history != null || opening?.isActive == true)) return
    active = true
    opening?.cancel()
    saveDelay?.cancel()
    mutable.value = WorkspaceState(projectId = project.id)
    opening = viewModelScope.launch {
      try {
        val document = workspaces.open(project, initialSceneName)
        if (mutable.value.projectId != project.id) return@launch
        mutable.value = WorkspaceState(
          projectId = project.id,
          history = WorkspaceHistory(document),
          saved = document,
          summaryDirty = project.sceneCount != document.scenes.size,
        )
        if (mutable.value.dirty) scheduleSave()
      } catch (error: Exception) {
        if (error is CancellationException) throw error
        mutable.update { if (it.projectId == project.id) it.copy(error = error.message ?: error.javaClass.simpleName) else it }
      }
    }
  }

  fun edit(transform: (WorkspaceDraft) -> WorkspaceDraft) {
    val before = mutable.value.history ?: return
    val after = before.edit(transform(before.current))
    if (after == before) return
    mutable.update { it.copy(history = after, error = null) }
    scheduleSave()
  }

  fun undo() {
    val history = mutable.value.history ?: return
    if (history.canUndo) {
      mutable.update { it.copy(history = history.undo(), error = null) }
      scheduleSave()
    }
  }

  fun redo() {
    val history = mutable.value.history ?: return
    if (history.canRedo) {
      mutable.update { it.copy(history = history.redo(), error = null) }
      scheduleSave()
    }
  }

  private fun scheduleSave() {
    saveDelay?.cancel()
    saveDelay = viewModelScope.launch {
      delay(600)
      // A subsequent edit can cancel the debounce, but never an in-flight write.
      viewModelScope.launch { persist() }
    }
  }

  fun save() {
    saveDelay?.cancel()
    viewModelScope.launch { persist() }
  }

  fun resourcesChanged(projectId: String) {
    if (!active || mutable.value.projectId != projectId) return
    mutable.update { it.copy(resourceRevision = it.resourceRevision + 1) }
    scheduleSave()
  }

  suspend fun persist(): Boolean = saveLock.withLock {
    if (!active) return@withLock true
    val snapshot = mutable.value
    val id = snapshot.projectId ?: return@withLock true
    val document = snapshot.document ?: return@withLock true
    if (!snapshot.dirty && snapshot.error == null) return@withLock true
    mutable.update { it.copy(saving = true) }
    try {
      if (document != snapshot.saved) workspaces.save(id, document)
      val modified = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date())
      val contentChanged = document != snapshot.saved || snapshot.resourceRevision != snapshot.savedResourceRevision
      projects.update { library ->
        check(library.any { it.id == id && !it.deleted }) { "Project is unavailable" }
        val project = library.first { it.id == id }
        val updated = project.copy(
          sceneCount = document.scenes.size,
          lastModified = if (contentChanged) modified else project.lastModified,
        )
        if (contentChanged) listOf(updated) + library.filterNot { it.id == id }
        else library.map { if (it.id == id) updated else it }
      }
      mutable.update {
        if (it.projectId == id) it.copy(saved = document, savedResourceRevision = snapshot.resourceRevision, summaryDirty = false, saving = false, error = null) else it
      }
      true
    } catch (error: Exception) {
      if (error is CancellationException) throw error
      mutable.update {
        if (it.projectId == id) it.copy(saving = false, error = error.message ?: error.javaClass.simpleName) else it
      }
      false
    }
  }

  suspend fun close(): Boolean {
    saveDelay?.cancel()
    if (mutable.value.history == null) opening?.cancel()
    if (!persist()) return false
    active = false
    return true
  }

  fun discard() {
    saveDelay?.cancel()
    opening?.cancel()
    active = false
  }

  suspend fun importAsset(projectId: String, source: File, category: String, name: String): Boolean =
    mutateProject(projectId) { id -> workspaces.importAsset(id, source, category, name) }

  suspend fun mutateProject(projectId: String, operation: suspend (String) -> Unit): Boolean = kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) {
    if (!active || mutable.value.projectId != projectId) return@withContext false
    if (!persist()) return@withContext false
    saveLock.withLock {
      val before = mutable.value
      if (!active || before.projectId != projectId) return@withLock false
      val id = projectId
      mutable.update { it.copy(managingAssets = true) }
      var success = true
      var failure: String? = null
      try { operation(id) } catch (error: Exception) { success = false; failure = error.message ?: error.javaClass.simpleName }
      try {
        val loaded = workspaces.load(id) ?: error("Project is unavailable")
        val previous = before.document
        val byFile = loaded.scenes.associateBy { it.fileName }
        val document = if (previous == null || loaded == previous) loaded else loaded.copy(scenes =
          previous.scenes.mapNotNull { old -> byFile[old.fileName]?.let { fresh ->
            fresh.copy(id = old.id, name = old.name, blocks = fresh.blocks.mapIndexed { index, block ->
              if (fresh.blocks.size == old.blocks.size) block.copy(id = old.blocks[index].id) else block
            })
          } } + loaded.scenes.filter { fresh -> previous.scenes.none { it.fileName == fresh.fileName } })
        mutable.update { if (it.projectId != id) it else it.copy(
          history = if (document == it.document) it.history else WorkspaceHistory(document), saved = loaded,
          resourceRevision = it.resourceRevision + 1, error = failure,
        ) }
        if (document != loaded) workspaces.save(id, document)
        mutable.update { if (it.projectId == id) it.copy(saved = document) else it }
      } catch (error: Exception) {
        success = false
        mutable.update { if (it.projectId == id) it.copy(error = error.message) else it }
      } finally { mutable.update { if (it.projectId == id) it.copy(managingAssets = false) else it } }
      if (success && active && mutable.value.projectId == id) scheduleSave()
      success
    }
  }

  class Factory(private val workspaces: WorkspaceDraftStore, private val projects: HomeDraftStore) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
      require(modelClass.isAssignableFrom(WorkspaceViewModel::class.java))
      return WorkspaceViewModel(workspaces, projects) as T
    }
  }
}
