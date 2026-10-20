package com.ollaic.galagame_maker.home

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.ollaic.galagame_maker.R
import java.text.DateFormat
import java.util.Date
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NativeHomeApp(store: HomeDraftStore) {
  var snapshot by remember { mutableStateOf(HomeSnapshot()) }
  var creating by rememberSaveable { mutableStateOf(false) }
  var editingId by rememberSaveable { mutableStateOf<String?>(null) }
  var detailsId by rememberSaveable { mutableStateOf<String?>(null) }
  var confirmId by rememberSaveable { mutableStateOf<String?>(null) }
  var permanent by rememberSaveable { mutableStateOf(false) }
  var saving by remember { mutableStateOf(false) }
  val scope = rememberCoroutineScope()

  suspend fun load() {
    try {
      snapshot = HomeSnapshot(ready = true, projects = store.load())
    } catch (error: Exception) {
      if (error is CancellationException) throw error
      snapshot = snapshot.copy(error = error.message.orEmpty())
    }
  }

  fun update(transform: (List<HomeProject>) -> List<HomeProject>, complete: () -> Unit = {}) {
    if (saving) return
    saving = true
    scope.launch {
      try {
        snapshot = HomeSnapshot(ready = true, projects = store.update(transform))
        complete()
      } catch (error: Exception) {
        if (error is CancellationException) throw error
        snapshot = snapshot.copy(error = error.message.orEmpty())
      } finally {
        saving = false
      }
    }
  }

  LaunchedEffect(store) { load() }
  NativeHomeScreen(snapshot) { action, id ->
    when (action) {
      "create" -> creating = true
      "open" -> detailsId = id
      "edit" -> editingId = id
      "favorite" -> update({ projects -> projects.map { if (it.id == id) it.copy(favorite = !it.favorite) else it } })
      "delete", "remove" -> { confirmId = id; permanent = action == "remove" }
      "restore" -> update({ projects -> projects.map { if (it.id == id) it.copy(deleted = false) else it } })
      "retry" -> scope.launch { load() }
      "dismissError" -> snapshot = snapshot.copy(error = "")
    }
  }

  if (creating || editingId != null) {
    val project = snapshot.projects.find { it.id == editingId }
    DraftDialog(
      project = project,
      saving = saving,
      onDismiss = { if (!saving) { creating = false; editingId = null } },
      onSave = { name, description ->
        val draft = HomeProject(
          id = project?.id ?: UUID.randomUUID().toString(),
          name = name,
          description = description,
          lastModified = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date()),
          sceneCount = 0,
          favorite = project?.favorite ?: false,
          deleted = false,
        )
        update(
          transform = { projects -> listOf(draft) + projects.filter { it.id != draft.id } },
          complete = { creating = false; editingId = null },
        )
      },
    )
  }

  snapshot.projects.find { it.id == detailsId }?.let { project ->
    ModalBottomSheet(onDismissRequest = { detailsId = null }) {
      Column(Modifier.fillMaxWidth().padding(24.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(project.name, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        Text(stringResource(R.string.home_draft), color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelLarge)
        if (project.description.isNotBlank()) Text(project.description, style = MaterialTheme.typography.bodyLarge)
        HorizontalDivider()
        Text(project.lastModified, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        TextButton(onClick = { detailsId = null; editingId = project.id }) { Text(stringResource(R.string.home_edit)) }
        Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars))
      }
    }
  }

  if (confirmId != null) AlertDialog(
    onDismissRequest = { if (!saving) confirmId = null },
    title = { Text(stringResource(if (permanent) R.string.home_confirm_remove else R.string.home_confirm_trash)) },
    text = { Text(snapshot.projects.find { it.id == confirmId }?.name.orEmpty()) },
    confirmButton = {
      TextButton(enabled = !saving, onClick = {
        val id = confirmId
        update(
          transform = { projects ->
            if (permanent) projects.filter { it.id != id }
            else projects.map { if (it.id == id) it.copy(deleted = true) else it }
          },
          complete = { confirmId = null },
        )
      }) { Text(stringResource(if (permanent) R.string.home_remove else R.string.home_move_to_trash)) }
    },
    dismissButton = { TextButton(onClick = { if (!saving) confirmId = null }) { Text(stringResource(R.string.home_cancel)) } },
  )
}

@Composable
private fun DraftDialog(project: HomeProject?, saving: Boolean, onDismiss: () -> Unit, onSave: (String, String) -> Unit) {
  var name by rememberSaveable(project?.id) { mutableStateOf(project?.name.orEmpty()) }
  var description by rememberSaveable(project?.id) { mutableStateOf(project?.description.orEmpty()) }
  AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text(stringResource(if (project == null) R.string.home_create else R.string.home_edit)) },
    text = {
      Column(Modifier.heightIn(max = 280.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
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
