package com.ollaic.galagame_maker.workspace

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.ollaic.galagame_maker.home.HomeDraftStore
import com.ollaic.galagame_maker.home.HomeProject
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
) {
  val document: WorkspaceDraft? get() = history?.current
  val dirty: Boolean get() = document != null && (document != saved || summaryDirty)
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
        val saved = workspaces.load(project.id)
        val document = saved ?: WorkspaceDraft(listOf(DraftScene(name = initialSceneName)))
        if (mutable.value.projectId != project.id) return@launch
        mutable.value = WorkspaceState(
          projectId = project.id,
          history = WorkspaceHistory(document),
          saved = saved,
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
      projects.update { library ->
        check(library.any { it.id == id && !it.deleted }) { "Project is unavailable" }
        val project = library.first { it.id == id }
        val updated = project.copy(
          sceneCount = document.scenes.size,
          lastModified = if (document != snapshot.saved) modified else project.lastModified,
        )
        if (document != snapshot.saved) listOf(updated) + library.filterNot { it.id == id }
        else library.map { if (it.id == id) updated else it }
      }
      mutable.update {
        if (it.projectId == id) it.copy(saved = document, summaryDirty = false, saving = false, error = null) else it
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

  class Factory(private val workspaces: WorkspaceDraftStore, private val projects: HomeDraftStore) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
      require(modelClass.isAssignableFrom(WorkspaceViewModel::class.java))
      return WorkspaceViewModel(workspaces, projects) as T
    }
  }
}
