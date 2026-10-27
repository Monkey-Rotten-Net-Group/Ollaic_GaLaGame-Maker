package com.ollaic.galagame_maker.home

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.ollaic.galagame_maker.R
import com.ollaic.galagame_maker.DocumentFiles
import com.ollaic.galagame_maker.FeatureUnavailableDialog
import com.ollaic.galagame_maker.workspace.ProjectWorkspace
import com.ollaic.galagame_maker.workspace.WorkspaceDraftStore
import java.text.DateFormat
import java.util.Date
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NativeHomeApp(store: HomeDraftStore, workspaces: WorkspaceDraftStore) {
  var snapshot by remember { mutableStateOf(HomeSnapshot()) }
  var creating by rememberSaveable { mutableStateOf(false) }
  var editingId by rememberSaveable { mutableStateOf<String?>(null) }
  var workspaceId by rememberSaveable { mutableStateOf<String?>(null) }
  var confirmId by rememberSaveable { mutableStateOf<String?>(null) }
  var permanent by rememberSaveable { mutableStateOf(false) }
  var saving by remember { mutableStateOf(false) }
  var unavailable by rememberSaveable { mutableStateOf<Int?>(null) }
  var dialogError by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()
  val context = LocalContext.current
  val initialScene = stringResource(R.string.workspace_initial_scene)

  suspend fun load() {
    try {
      val failures = mutableListOf<String>()
      val projects = store.load().map { project ->
        try { workspaces.summary(project) } catch (error: Exception) {
          if (error is CancellationException) throw error
          failures += "${project.name}: ${error.message}"
          project
        }
      }
      snapshot = HomeSnapshot(ready = true, projects = projects, error = failures.joinToString("\n"), canImport = true)
    } catch (error: Exception) {
      if (error is CancellationException) throw error
      snapshot = snapshot.copy(error = error.message.orEmpty())
    }
  }

  fun update(transform: suspend (List<HomeProject>) -> List<HomeProject>, complete: () -> Unit = {}, failed: suspend () -> Unit = {}) {
    if (saving) return
    saving = true
    scope.launch {
      try {
        snapshot = HomeSnapshot(ready = true, projects = withContext(NonCancellable) { store.update(transform) }, canImport = true)
        complete()
      } catch (error: Exception) {
        if (error is CancellationException) throw error
        try { withContext(NonCancellable) { failed() } } catch (cleanup: Exception) { error.addSuppressed(cleanup) }
        if (creating || editingId != null) dialogError = error.message
        snapshot = snapshot.copy(error = error.message.orEmpty())
      } finally {
        saving = false
      }
    }
  }

  val importProject = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
    if (uri != null && !saving) {
      saving = true
      scope.launch {
        try {
          val imported = DocumentFiles.read(context, uri) { archive, _ ->
            withContext(NonCancellable) {
              val project = workspaces.importArchive(archive)
              try {
                project to store.update { listOf(project) + it }
              } catch (error: Exception) {
                workspaces.delete(project.id)
                throw error
              }
            }
          }
          snapshot = HomeSnapshot(ready = true, projects = imported.second, canImport = true)
          workspaceId = imported.first.id
        } catch (error: Exception) {
          if (error is CancellationException) throw error
          snapshot = snapshot.copy(error = error.message.orEmpty())
        } finally { saving = false }
      }
    }
  }

  LaunchedEffect(store) { load() }
  val opened = snapshot.projects.firstOrNull { it.id == workspaceId && !it.deleted }
  if (workspaceId != null && !snapshot.ready && snapshot.error.isBlank()) {
    Box(Modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.Center) { CircularProgressIndicator() }
  } else if (opened != null) {
    ProjectWorkspace(opened, workspaces, store,
      onClose = { workspaceId = null; scope.launch { load() } },
      onEditProject = { editingId = opened.id },
    )
  } else NativeHomeScreen(snapshot, busy = saving) { action, id ->
    if (saving) return@NativeHomeScreen
    when (action) {
      "import" -> importProject.launch(arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream"))
      "settings" -> unavailable = R.string.workspace_settings
      "create" -> { dialogError = null; creating = true }
      "open" -> workspaceId = id
      "edit" -> { dialogError = null; editingId = id }
      "favorite" -> update({ projects -> projects.map { if (it.id == id) it.copy(favorite = !it.favorite) else it } })
      "delete", "remove" -> { confirmId = id; permanent = action == "remove" }
      "restore" -> update({ projects -> projects.map { if (it.id == id) it.copy(deleted = false) else it } })
      "retry" -> scope.launch { load() }
      "dismissError" -> snapshot = snapshot.copy(error = "")
    }
  }

  unavailable?.let { title -> FeatureUnavailableDialog(title) { unavailable = null } }

  if (creating || editingId != null) {
    val project = snapshot.projects.find { it.id == editingId }
    DraftDialog(
      project = project,
      saving = saving,
      error = dialogError,
      onDismiss = { if (!saving) { creating = false; editingId = null } },
      onSave = { name, description ->
        dialogError = null
        val draft = HomeProject(
          id = project?.id ?: UUID.randomUUID().toString(),
          name = name,
          description = description,
          lastModified = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date()),
          sceneCount = project?.sceneCount ?: 0,
          favorite = project?.favorite ?: false,
          deleted = false,
        )
        update(
          transform = { projects ->
            val current = projects.firstOrNull { it.id == draft.id }
            val updated = current?.copy(name = draft.name, description = draft.description, lastModified = draft.lastModified) ?: draft
            workspaces.updateProject(updated, initialScene)
            listOf(updated) + projects.filter { it.id != draft.id }
          },
          complete = {
            creating = false
            editingId = null
            if (project == null) workspaceId = draft.id
          },
          failed = { if (project == null) workspaces.delete(draft.id) },
        )
      },
    )
  }

  if (confirmId != null) AlertDialog(
    onDismissRequest = { if (!saving) confirmId = null },
    title = { Text(stringResource(if (permanent) R.string.home_confirm_remove else R.string.home_confirm_trash)) },
    text = { Text(snapshot.projects.find { it.id == confirmId }?.name.orEmpty()) },
    confirmButton = {
      TextButton(enabled = !saving, onClick = {
        val id = confirmId ?: return@TextButton
        val removePermanently = permanent
        update(
          transform = { projects ->
            if (removePermanently) {
              check(projects.any { it.id == id && it.deleted }) { "Project is unavailable" }
              workspaces.delete(id)
              projects.filter { it.id != id }
            } else projects.map { if (it.id == id) it.copy(deleted = true) else it }
          },
          complete = { confirmId = null },
        )
      }) { Text(stringResource(if (permanent) R.string.home_remove else R.string.home_move_to_trash)) }
    },
    dismissButton = { TextButton(onClick = { if (!saving) confirmId = null }) { Text(stringResource(R.string.home_cancel)) } },
  )
}

@Composable
private fun DraftDialog(project: HomeProject?, saving: Boolean, error: String?, onDismiss: () -> Unit, onSave: (String, String) -> Unit) {
  var name by rememberSaveable(project?.id) { mutableStateOf(project?.name.orEmpty()) }
  var description by rememberSaveable(project?.id) { mutableStateOf(project?.description.orEmpty()) }
  AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text(stringResource(if (project == null) R.string.home_create else R.string.home_edit)) },
    text = {
      Column(Modifier.heightIn(max = 280.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        OutlinedTextField(
          value = name,
          onValueChange = { name = it },
          modifier = Modifier.fillMaxWidth(),
          label = { Text(stringResource(R.string.home_name)) },
          singleLine = true,
          enabled = !saving,
        )
        OutlinedTextField(
          value = description,
          onValueChange = { description = it },
          modifier = Modifier.fillMaxWidth(),
          label = { Text(stringResource(R.string.home_description)) },
          minLines = 3,
          maxLines = 5,
          enabled = !saving,
        )
      }
    },
    confirmButton = {
      TextButton(enabled = name.isNotBlank() && !saving, onClick = { onSave(name.trim(), description.trim()) }) {
        Text(stringResource(if (project == null) R.string.home_create_draft else R.string.home_save))
      }
    },
    dismissButton = { TextButton(enabled = !saving, onClick = onDismiss) { Text(stringResource(R.string.home_cancel)) } },
  )
}
