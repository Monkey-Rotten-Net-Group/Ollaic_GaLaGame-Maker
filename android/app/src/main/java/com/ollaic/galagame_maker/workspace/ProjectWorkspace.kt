package com.ollaic.galagame_maker.workspace

import androidx.activity.compose.BackHandler
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Redo
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.ollaic.galagame_maker.R
import com.ollaic.galagame_maker.home.HomeDraftStore
import com.ollaic.galagame_maker.home.HomeProject
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProjectWorkspace(project: HomeProject, workspaces: WorkspaceDraftStore, projects: HomeDraftStore, onClose: () -> Unit, onEditProject: () -> Unit) {
  val factory = remember(workspaces, projects) { WorkspaceViewModel.Factory(workspaces, projects) }
  val editor: WorkspaceViewModel = viewModel(key = "native-workspace", factory = factory)
  val editorState by editor.state.collectAsStateWithLifecycle()
  val state = editorState.takeIf { it.projectId == project.id } ?: WorkspaceState(projectId = project.id)
  val document = state.document
  var selectedScene by rememberSaveable(project.id) { mutableStateOf<String?>(null) }
  var tab by rememberSaveable(project.id) { mutableStateOf(WorkspaceTab.Script) }
  var scenePicker by rememberSaveable(project.id) { mutableStateOf(false) }
  var addingScene by rememberSaveable(project.id) { mutableStateOf(false) }
  var renamingScene by rememberSaveable(project.id) { mutableStateOf<String?>(null) }
  var deletingScene by rememberSaveable(project.id) { mutableStateOf<String?>(null) }
  var addingBlock by rememberSaveable(project.id) { mutableStateOf(false) }
  var editingBlock by rememberSaveable(project.id) { mutableStateOf<String?>(null) }
  var blockScene by rememberSaveable(project.id) { mutableStateOf<String?>(null) }
  var leaving by remember { mutableStateOf(false) }
  var exitFailed by remember { mutableStateOf(false) }
  val scope = rememberCoroutineScope()
  val initialScene = stringResource(R.string.workspace_initial_scene)
  val scene = document?.scenes?.firstOrNull { it.id == selectedScene } ?: document?.scenes?.firstOrNull()
  val lifecycle = LocalLifecycleOwner.current.lifecycle

  LaunchedEffect(project.id) { editor.open(project, initialScene) }
  DisposableEffect(editor, lifecycle) {
    val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) editor.save() }
    lifecycle.addObserver(observer)
    onDispose { lifecycle.removeObserver(observer) }
  }

  fun exit() {
    if (leaving) return
    leaving = true
    scope.launch {
      if (editor.close()) onClose() else exitFailed = true
      leaving = false
    }
  }
  BackHandler { exit() }

  fun select(id: String) {
    selectedScene = id
    tab = WorkspaceTab.Script
    scenePicker = false
  }
  fun newScene() { scenePicker = false; addingScene = true }
  fun rename(value: DraftScene) { scenePicker = false; renamingScene = value.id }
  fun delete(value: DraftScene) { scenePicker = false; deletingScene = value.id }
  fun editBlock(value: ScriptBlock?) {
    blockScene = scene?.id
    editingBlock = value?.id
    addingBlock = value == null
  }
  fun blockAction(action: String, id: String) {
    val sceneId = scene?.id ?: return
    editor.edit { draft ->
      draft.copy(scenes = draft.scenes.map { current ->
        if (current.id != sceneId) current else {
          val index = current.blocks.indexOfFirst { it.id == id }
          if (index < 0) current else {
            val blocks = current.blocks.toMutableList()
            when (action) {
              "duplicate" -> blocks.add(index + 1, blocks[index].copy(id = java.util.UUID.randomUUID().toString()))
              "delete" -> blocks.removeAt(index)
              "up" -> if (index > 0) blocks.add(index - 1, blocks.removeAt(index))
              "down" -> if (index < blocks.lastIndex) blocks.add(index + 1, blocks.removeAt(index))
            }
            current.copy(blocks = blocks.toList())
          }
        }
      })
    }
  }

  BoxWithConstraints(Modifier.fillMaxSize()) {
    val wide = maxWidth >= 720.dp
    val ime = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    Scaffold(
      modifier = Modifier.fillMaxSize().imePadding(),
      containerColor = MaterialTheme.colorScheme.background,
      topBar = {
        Column {
          TopAppBar(
            navigationIcon = { IconButton(onClick = ::exit, enabled = !leaving) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, stringResource(R.string.workspace_back)) } },
            title = {
              Column {
                Text(project.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(stringResource(when {
                  state.saving || leaving -> R.string.workspace_saving
                  state.error != null && document == null -> R.string.workspace_load_error
                  state.error != null -> R.string.workspace_save_error
                  document == null -> R.string.workspace_loading
                  state.dirty -> R.string.workspace_unsaved
                  else -> R.string.workspace_saved
                }), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
              }
            },
            actions = {
              IconButton(onClick = { editor.save() }, enabled = document != null && !state.saving && !leaving && (state.dirty || state.error != null)) {
                Icon(Icons.Outlined.Save, stringResource(R.string.workspace_save))
              }
            },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
          )
        }
      },
      bottomBar = {
        Column(Modifier.navigationBarsPadding()) {
          if (!wide && !ime) NavigationBar(containerColor = MaterialTheme.colorScheme.surface, windowInsets = WindowInsets(0, 0, 0, 0)) {
            WorkspaceTab.entries.forEach { value -> NavigationBarItem(selected = tab == value, onClick = { tab = value }, icon = { Icon(value.icon, null) }, label = { Text(stringResource(value.title)) }) }
          }
        }
      },
    ) { padding ->
      Column(Modifier.fillMaxSize().padding(padding)) {
        state.error?.let { error ->
          Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.ErrorOutline, null, tint = MaterialTheme.colorScheme.error)
            Text(error, Modifier.weight(1f).padding(8.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, maxLines = 3, overflow = TextOverflow.Ellipsis)
            IconButton(onClick = { if (document == null) editor.open(project, initialScene) else editor.save() }) { Icon(Icons.Outlined.Refresh, stringResource(R.string.home_retry)) }
          }
        }
        if (document == null) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
          if (state.error == null) CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp)
        } else Row(Modifier.fillMaxSize()) {
          if (wide) {
            NavigationRail(containerColor = MaterialTheme.colorScheme.surface, windowInsets = WindowInsets(0, 0, 0, 0)) {
              WorkspaceTab.entries.forEach { value -> NavigationRailItem(selected = tab == value, onClick = { tab = value }, icon = { Icon(value.icon, null) }, label = { Text(stringResource(value.title)) }) }
            }
            VerticalDivider(color = MaterialTheme.colorScheme.outlineVariant)
          }
          Crossfade(targetState = tab, modifier = Modifier.weight(1f).fillMaxHeight(), animationSpec = tween(180), label = "workspace-panel") { current ->
            Column(Modifier.fillMaxSize()) {
              if (current == WorkspaceTab.Script) {
                Row(Modifier.fillMaxWidth().height(48.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                  TextButton(onClick = { scenePicker = true }, enabled = !leaving, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Outlined.FolderOpen, null, Modifier.size(18.dp))
                    Text(scene?.name ?: stringResource(R.string.workspace_scenes), Modifier.weight(1f).padding(horizontal = 8.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Icon(Icons.Outlined.ExpandMore, stringResource(R.string.workspace_select_scene), Modifier.size(18.dp))
                  }
                  IconButton(onClick = { editor.undo() }, enabled = state.history?.canUndo == true && !leaving) { Icon(Icons.AutoMirrored.Outlined.Undo, stringResource(R.string.workspace_undo)) }
                  IconButton(onClick = { editor.redo() }, enabled = state.history?.canRedo == true && !leaving) { Icon(Icons.AutoMirrored.Outlined.Redo, stringResource(R.string.workspace_redo)) }
                  IconButton(onClick = {}, enabled = false) { Icon(Icons.Outlined.PlayArrow, stringResource(R.string.workspace_preview)) }
                }
              }
              HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
              Row(Modifier.weight(1f).fillMaxWidth()) {
                if (wide && current == WorkspaceTab.Script) {
                  SceneListPanel(document.scenes, scene?.id.orEmpty(), !leaving, ::select, ::newScene, ::rename, ::delete, Modifier.width(220.dp))
                  VerticalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                }
                when (current) {
                  WorkspaceTab.Script -> scene?.let { activeScene -> key(activeScene.id) { ScriptPanel(activeScene, !leaving, { editBlock(it) }, ::blockAction) } }
                  WorkspaceTab.Scenes -> SceneListPanel(document.scenes, scene?.id.orEmpty(), !leaving, ::select, ::newScene, ::rename, ::delete)
                  WorkspaceTab.Assets -> AssetDraftPanel()
                  WorkspaceTab.Project -> ProjectDraftPanel(project, document, !leaving, onEditProject) { notes -> editor.edit { it.copy(notes = notes) } }
                }
              }
              if (!ime && current in listOf(WorkspaceTab.Script, WorkspaceTab.Scenes)) {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                  Text(
                    stringResource(if (current == WorkspaceTab.Script) R.string.workspace_block_count else R.string.workspace_scene_count, if (current == WorkspaceTab.Script) scene?.blocks?.size ?: 0 else document.scenes.size),
                    Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                  )
                  FilledTonalButton(onClick = { if (current == WorkspaceTab.Script) editBlock(null) else newScene() }, enabled = !leaving) {
                    Icon(Icons.Outlined.Add, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(stringResource(if (current == WorkspaceTab.Script) R.string.workspace_add_block else R.string.workspace_new_scene))
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  if (scenePicker && document != null) ModalBottomSheet(onDismissRequest = { scenePicker = false }) {
    SceneListPanel(document.scenes, scene?.id.orEmpty(), !leaving, ::select, ::newScene, ::rename, ::delete, Modifier.fillMaxWidth().height((document.scenes.size * 76 + 56).coerceIn(180, 520).dp))
  }
  if (document != null && (addingScene || renamingScene != null)) {
    SceneNameDialog(document.scenes.firstOrNull { it.id == renamingScene }, document.scenes, onDismiss = { addingScene = false; renamingScene = null }) { name ->
      val id = renamingScene
      if (id != null) editor.edit { it.copy(scenes = it.scenes.map { current -> if (current.id == id) current.copy(name = name) else current }) }
      else {
        val created = DraftScene(name = name)
        editor.edit { it.copy(scenes = it.scenes + created) }
        selectedScene = created.id
        tab = WorkspaceTab.Script
      }
      addingScene = false
      renamingScene = null
    }
  }
  if (document != null && deletingScene != null) AlertDialog(
    onDismissRequest = { deletingScene = null },
    title = { Text(stringResource(R.string.workspace_delete_scene)) },
    text = { Text(document.scenes.firstOrNull { it.id == deletingScene }?.name.orEmpty()) },
    confirmButton = { TextButton(onClick = {
      val id = deletingScene
      editor.edit { if (it.scenes.size > 1) it.copy(scenes = it.scenes.filterNot { value -> value.id == id }) else it }
      deletingScene = null
    }) { Text(stringResource(R.string.home_remove)) } },
    dismissButton = { TextButton(onClick = { deletingScene = null }) { Text(stringResource(R.string.home_cancel)) } },
  )
  if (document != null && (addingBlock || editingBlock != null)) {
    val existing = document.scenes.firstOrNull { it.id == blockScene }?.blocks?.firstOrNull { it.id == editingBlock }
    BlockEditorSheet(existing, onDismiss = { addingBlock = false; editingBlock = null }) { kind, speaker, text ->
      val value = ScriptBlock(id = existing?.id ?: java.util.UUID.randomUUID().toString(), kind = kind, speaker = if (kind == BlockKind.Dialogue) speaker else "", text = text)
      val target = blockScene
      editor.edit { draft -> draft.copy(scenes = draft.scenes.map { current ->
        if (current.id != target) current else current.copy(blocks = if (existing == null) current.blocks + value else current.blocks.map { if (it.id == value.id) value else it })
      }) }
      addingBlock = false
      editingBlock = null
    }
  }
  if (exitFailed) AlertDialog(
    onDismissRequest = { exitFailed = false },
    title = { Text(stringResource(R.string.workspace_save_error)) },
    text = { Column { Text(state.error.orEmpty()); TextButton(onClick = { editor.discard(); onClose() }) { Text(stringResource(R.string.workspace_discard)) } } },
    confirmButton = { TextButton(onClick = { exitFailed = false; exit() }) { Text(stringResource(R.string.home_retry)) } },
    dismissButton = { TextButton(onClick = { exitFailed = false }) { Text(stringResource(R.string.workspace_stay)) } },
  )
}
