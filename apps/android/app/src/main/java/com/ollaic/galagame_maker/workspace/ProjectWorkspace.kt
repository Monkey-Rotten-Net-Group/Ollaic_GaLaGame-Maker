package com.ollaic.galagame_maker.workspace

import androidx.activity.compose.BackHandler
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListState
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
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.ollaic.galagame_maker.R
import com.ollaic.galagame_maker.FeatureUnavailableDialog
import com.ollaic.core.AssetInfo
import com.ollaic.core.CharacterInfo
import com.ollaic.core.AssetUsage
import com.ollaic.galagame_maker.home.HomeDraftStore
import com.ollaic.galagame_maker.home.HomeProject
import kotlinx.coroutines.launch
import kotlinx.coroutines.CancellationException

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
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
  var menu by remember { mutableStateOf(false) }
  var sourceScene by rememberSaveable(project.id) { mutableStateOf<String?>(null) }
  var unavailable by rememberSaveable(project.id) { mutableStateOf<Int?>(null) }
  var assets by remember(project.id) { mutableStateOf<List<AssetInfo>>(emptyList()) }
  var assetRevision by remember(project.id) { mutableStateOf(0) }
  var assetError by remember(project.id) { mutableStateOf<String?>(null) }
  var characters by remember(project.id) { mutableStateOf<List<CharacterInfo>>(emptyList()) }
  var showingCharacters by rememberSaveable(project.id) { mutableStateOf(false) }
  var characterInitialName by rememberSaveable(project.id) { mutableStateOf<String?>(null) }
  var assetFilter by rememberSaveable(project.id) { mutableStateOf("all") }
  var assetAction by rememberSaveable(project.id) { mutableStateOf<String?>(null) }
  var assetSelection by rememberSaveable(project.id) { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()
  val initialScene = stringResource(R.string.workspace_initial_scene)
  val scene = document?.scenes?.firstOrNull { it.id == selectedScene } ?: document?.scenes?.firstOrNull()
  val scriptScroll = rememberSaveable(project.id, saver = LazyListState.Saver) { LazyListState() }
  var scrollScene by rememberSaveable(project.id) { mutableStateOf<String?>(null) }
  LaunchedEffect(scene?.id) {
    val id = scene?.id ?: return@LaunchedEffect
    if (scrollScene != null && scrollScene != id) scriptScroll.scrollToItem(0)
    scrollScene = id
  }
  val files = rememberWorkspaceFiles(project, document, scene, editor, workspaces,
    onImportedScene = { imported ->
      editor.edit { it.copy(scenes = it.scenes + imported) }
      selectedScene = imported.id
      tab = WorkspaceTab.Script
    },
    onAssetsChanged = { assetRevision++; editor.resourcesChanged(project.id) },
  )
  val blocked = leaving || files.busy || state.managingAssets
  val lifecycle = LocalLifecycleOwner.current.lifecycle

  LaunchedEffect(project.id) { editor.open(project, initialScene) }
  LaunchedEffect(project.id, tab, assetRevision, state.resourceRevision, document != null, addingBlock, editingBlock, showingCharacters) {
    if (document != null && (tab == WorkspaceTab.Assets || addingBlock || editingBlock != null || showingCharacters)) try {
      assets = workspaces.assets(project.id)
      characters = workspaces.characters(project.id).characters
    } catch (error: Exception) {
      if (error is CancellationException) throw error
      assetError = error.message
    }
  }
  DisposableEffect(editor, lifecycle) {
    val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) editor.save() }
    lifecycle.addObserver(observer)
    onDispose { lifecycle.removeObserver(observer) }
  }

  fun exit() {
    if (blocked) return
    leaving = true
    scope.launch {
      if (editor.close()) onClose() else exitFailed = true
      leaving = false
    }
  }
  val rootKeyboard = LocalSoftwareKeyboardController.current
  val rootImeVisible = WindowInsets.isImeVisible
  BackHandler { if (rootImeVisible) rootKeyboard?.hide() else exit() }

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
  fun feature(title: Int) {
    when (title) {
      R.string.workspace_character_manager -> { characterInitialName = null; showingCharacters = true }
      R.string.workspace_animation_manager -> { assetFilter = "animation"; tab = WorkspaceTab.Assets }
      else -> unavailable = title
    }
  }
  fun openUsage(usage: AssetUsage) {
    val target = document?.scenes?.firstOrNull { it.fileName == usage.fileName }
    if (target != null) {
      selectedScene = target.id; tab = WorkspaceTab.Script; blockScene = target.id
      var line = 1
      editingBlock = target.blocks.firstOrNull { block ->
        val start = line; line += (block.source?.count { it == '\n' } ?: 1).coerceAtLeast(1)
        usage.lineNumber.toInt() in start until line
      }?.id
      addingBlock = false
    } else if (usage.command == "character") { characterInitialName = usage.content; showingCharacters = true }
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
              "up" -> (index - 1 downTo 0).firstOrNull { !blocks[it].isBlankLine }?.let { blocks.add(it, blocks.removeAt(index)) }
              "down" -> (index + 1..blocks.lastIndex).firstOrNull { !blocks[it].isBlankLine }?.let { blocks.add(it, blocks.removeAt(index)) }
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
            navigationIcon = { IconButton(onClick = ::exit, enabled = !blocked) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, stringResource(R.string.workspace_back)) } },
            title = {
              Column {
                Text(project.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(stringResource(when {
                  files.busy -> R.string.workspace_transferring
                  state.saving || state.managingAssets || leaving -> R.string.workspace_saving
                  state.error != null && document == null -> R.string.workspace_load_error
                  state.error != null -> R.string.workspace_save_error
                  document == null -> R.string.workspace_loading
                  state.dirty -> R.string.workspace_unsaved
                  else -> R.string.workspace_saved
                }), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
              }
            },
            actions = {
              IconButton(onClick = { editor.save() }, enabled = document != null && !state.saving && !blocked && (state.dirty || state.error != null)) {
                Icon(Icons.Outlined.Save, stringResource(R.string.workspace_save))
              }
              Box {
                IconButton(onClick = { menu = true }, enabled = document != null && !blocked) { Icon(Icons.Outlined.MoreVert, stringResource(R.string.workspace_more)) }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                  DropdownMenuItem(text = { Text(stringResource(R.string.workspace_export_project)) }, leadingIcon = { Icon(Icons.Outlined.FileUpload, null) }, onClick = { menu = false; files.exportProject() })
                  DropdownMenuItem(text = { Text(stringResource(R.string.workspace_import_scene)) }, leadingIcon = { Icon(Icons.Outlined.FileDownload, null) }, onClick = { menu = false; files.importScene() })
                  DropdownMenuItem(text = { Text(stringResource(R.string.workspace_export_scene)) }, leadingIcon = { Icon(Icons.Outlined.FileUpload, null) }, enabled = scene != null, onClick = { menu = false; files.exportScene() })
                  DropdownMenuItem(text = { Text(stringResource(R.string.workspace_edit_source)) }, leadingIcon = { Icon(Icons.Outlined.Code, null) }, enabled = scene != null, onClick = { menu = false; sourceScene = scene?.id })
                  HorizontalDivider()
                  listOf(R.string.workspace_script_search to Icons.Outlined.Search, R.string.workspace_paste_command to Icons.Outlined.ContentPaste, R.string.workspace_snapshots to Icons.Outlined.PhotoCamera, R.string.workspace_ai to Icons.Outlined.AutoAwesome, R.string.workspace_publish to Icons.Outlined.Publish, R.string.workspace_settings to Icons.Outlined.Settings).forEach { (title, icon) ->
                    DropdownMenuItem(text = { Column { Text(stringResource(title)); Text(stringResource(R.string.feature_pending), style = MaterialTheme.typography.labelSmall) } }, leadingIcon = { Icon(icon, null) }, onClick = { menu = false; unavailable = title })
                  }
                }
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
        if (files.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
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
                  TextButton(onClick = { scenePicker = true }, enabled = !blocked, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Outlined.FolderOpen, null, Modifier.size(18.dp))
                    Text(scene?.name ?: stringResource(R.string.workspace_scenes), Modifier.weight(1f).padding(horizontal = 8.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Icon(Icons.Outlined.ExpandMore, stringResource(R.string.workspace_select_scene), Modifier.size(18.dp))
                  }
                  IconButton(onClick = { editor.undo() }, enabled = state.history?.canUndo == true && !blocked) { Icon(Icons.AutoMirrored.Outlined.Undo, stringResource(R.string.workspace_undo)) }
                  IconButton(onClick = { editor.redo() }, enabled = state.history?.canRedo == true && !blocked) { Icon(Icons.AutoMirrored.Outlined.Redo, stringResource(R.string.workspace_redo)) }
                  IconButton(onClick = { sourceScene = scene?.id }, enabled = scene != null && !blocked) { Icon(Icons.Outlined.Code, stringResource(R.string.workspace_edit_source)) }
                  IconButton(onClick = { unavailable = R.string.workspace_preview }, enabled = !blocked) { Icon(Icons.Outlined.PlayArrow, stringResource(R.string.workspace_preview), tint = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
              }
              HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
              Row(Modifier.weight(1f).fillMaxWidth()) {
                if (wide && current == WorkspaceTab.Script) {
                  SceneListPanel(document.scenes, scene?.id.orEmpty(), !blocked, ::select, ::newScene, ::rename, ::delete, Modifier.width(220.dp))
                  VerticalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                }
                when (current) {
                  WorkspaceTab.Script -> scene?.let { activeScene -> key(activeScene.id) { ScriptPanel(activeScene, scriptScroll, !blocked, { editBlock(it) }, ::blockAction, ::feature) } }
                  WorkspaceTab.Scenes -> SceneListPanel(document.scenes, scene?.id.orEmpty(), !blocked, ::select, ::newScene, ::rename, ::delete)
                  WorkspaceTab.Assets -> WorkspaceAssets(assets, workspaces.projectDirectory(project.id), !blocked, assetFilter, { assetFilter = it }, files.importAsset, { asset ->
                    try {
                      val source = com.ollaic.core.assetCommand(asset.category, asset.name)
                      val target = scene?.id
                      val insertIndex = scene?.visibleBlocks?.size ?: 0
                      editor.edit { draft -> draft.copy(scenes = draft.scenes.map { current -> if (current.id != target) current else current.copy(blocks = current.blocks + WorkspaceCodec.blocks(source)) }) }
                      tab = WorkspaceTab.Script
                      scope.launch { withFrameNanos { }; scriptScroll.animateScrollToItem(insertIndex) }
                    } catch (error: Exception) { assetError = error.message }
                  }, { asset, action -> assetSelection = "${asset.category}/${asset.name}"; assetAction = action },
                    { assetSelection = null; assetAction = "animation" })
                  WorkspaceTab.Project -> ProjectDraftPanel(project, document, !blocked, onEditProject, files.exportProject, ::feature)
                }
              }
              if (!ime && current in listOf(WorkspaceTab.Script, WorkspaceTab.Scenes)) {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                  Text(
                    stringResource(if (current == WorkspaceTab.Script) R.string.workspace_block_count else R.string.workspace_scene_count, if (current == WorkspaceTab.Script) scene?.visibleBlocks?.size ?: 0 else document.scenes.size),
                    Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                  )
                  FilledTonalButton(onClick = { if (current == WorkspaceTab.Script) editBlock(null) else newScene() }, enabled = !blocked) {
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
    SceneListPanel(document.scenes, scene?.id.orEmpty(), !blocked, ::select, ::newScene, ::rename, ::delete, Modifier.fillMaxWidth().height((document.scenes.size * 76 + 56).coerceIn(180, 520).dp))
  }
  if (document != null && (addingScene || renamingScene != null)) {
    SceneNameDialog(document.scenes.firstOrNull { it.id == renamingScene }, document.scenes, onDismiss = { addingScene = false; renamingScene = null }) { name ->
      val id = renamingScene
      if (id != null) editor.edit { draft ->
        val old = draft.scenes.first { it.id == id }
        val fileName = if (old.fileName == "start.txt") old.fileName else com.ollaic.core.sceneFileName(name)
        draft.copy(scenes = draft.scenes.map { current ->
          val renamed = if (current.id == id) current.copy(name = name, fileName = fileName) else current
          renamed.copy(blocks = renamed.blocks.map { block ->
            val source = com.ollaic.core.editLine(block.source.orEmpty(), block.kind.name, block.speaker, block.text)
            val rewritten = com.ollaic.core.renameSceneReferences(source, old.fileName, fileName)
            if (rewritten == source) block else WorkspaceCodec.classify(block.copy(kind = BlockKind.Command, speaker = "", text = rewritten.trimEnd('\r', '\n'), source = rewritten))
          })
        })
      }
      else {
        val created = DraftScene(name = name, fileName = com.ollaic.core.sceneFileName(name))
        editor.edit { it.copy(scenes = it.scenes + created) }
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
    BlockEditorSheet(existing, document.scenes, blockScene, assets, characters, workspaces.projectDirectory(project.id), !blocked,
      files.importAsset, { characterInitialName = null; showingCharacters = true }, onDismiss = { addingBlock = false; editingBlock = null }) { source ->
      val values = WorkspaceCodec.blocks(source).mapIndexed { index, block ->
        if (index == 0 && existing != null) block.copy(id = existing.id) else block
      }
      val target = blockScene
      editor.edit { draft -> draft.copy(scenes = draft.scenes.map { current ->
        if (current.id != target) current else current.copy(blocks = if (existing == null) current.blocks + values else current.blocks.flatMap { if (it.id == existing.id) values else listOf(it) })
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
  document?.scenes?.firstOrNull { it.id == sourceScene }?.let { selected ->
    SceneSourceSheet(selected, onDismiss = { sourceScene = null }) { source ->
      editor.edit { draft -> draft.copy(scenes = draft.scenes.map { if (it.id == selected.id) it.copy(blocks = WorkspaceCodec.blocks(source)) else it }) }
      sourceScene = null
    }
  }
  assetAction?.let { action ->
    val asset = assets.firstOrNull { "${it.category}/${it.name}" == assetSelection }
    if (asset != null || (action == "animation" && assetSelection == null)) AssetManagementSheet(action, asset, assets, project.id, workspaces, editor,
      onDismiss = { assetAction = null; assetSelection = null }, onChanged = { assetRevision++; editor.resourcesChanged(project.id) }, onUsage = ::openUsage)
  }
  if (showingCharacters) CharacterManager(project.id, workspaces, assets, workspaces.projectDirectory(project.id), characterInitialName,
    files.importAsset, { assetRevision++; editor.resourcesChanged(project.id) }, ::feature, onDismiss = { showingCharacters = false })
  unavailable?.let { title -> FeatureUnavailableDialog(title) { unavailable = null } }
  val operationError = files.error ?: assetError
  if (operationError != null || files.notice != null) AlertDialog(
    onDismissRequest = { files.dismiss(); assetError = null },
    title = { Text(stringResource(if (operationError != null) R.string.workspace_error else R.string.workspace_operation_result)) },
    text = { Text(operationError ?: files.notice.orEmpty()) },
    confirmButton = { TextButton(onClick = { files.dismiss(); assetError = null }) { Text(stringResource(R.string.home_done)) } },
  )
}
