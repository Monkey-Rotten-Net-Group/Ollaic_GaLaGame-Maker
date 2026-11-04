package com.ollaic.galagame_maker.workspace

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.ollaic.core.*
import com.ollaic.galagame_maker.DocumentFiles
import com.ollaic.galagame_maker.R
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

internal fun spriteFile(character: CharacterInfo, sprite: CharacterSprite, assets: List<AssetInfo>): String =
  if (sprite.file.isNotBlank()) sprite.file else runCatching { resolveSprite(character, sprite, assets.filter { it.category == "figure" }) }.getOrDefault("")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CharacterManager(projectId: String, store: WorkspaceDraftStore, assets: List<AssetInfo>, root: File,
  initialName: String?, onImport: (String) -> Unit, onChanged: () -> Unit, onFeature: (Int) -> Unit, onDismiss: () -> Unit) {
  var snapshot by remember(projectId) { mutableStateOf<CharactersSnapshot?>(null) }
  var selectedId by rememberSaveable(projectId) { mutableStateOf<String?>(null) }
  var editingRevision by rememberSaveable(projectId) { mutableStateOf("") }
  var query by rememberSaveable(projectId) { mutableStateOf("") }
  var creating by rememberSaveable(projectId) { mutableStateOf(false) }
  var deleting by rememberSaveable(projectId) { mutableStateOf<String?>(null) }
  var error by remember { mutableStateOf<String?>(null) }
  var busy by remember { mutableStateOf(false) }
  var loading by remember { mutableStateOf(true) }
  var reload by remember { mutableStateOf(0) }
  var detailDirty by remember(selectedId) { mutableStateOf(false) }
  var detailBusy by remember { mutableStateOf(false) }
  var pendingNavigation by remember { mutableStateOf(false) }
  var pendingId by remember { mutableStateOf<String?>(null) }
  var pendingClose by remember { mutableStateOf(false) }
  var pendingCreate by remember { mutableStateOf(false) }
  val wide = LocalConfiguration.current.screenWidthDp >= 720
  val scope = rememberCoroutineScope()
  fun navigate(id: String?, close: Boolean = false) {
    if (busy || detailBusy) return
    pendingCreate = false
    if (detailDirty) { pendingId = id; pendingClose = close; pendingNavigation = true }
    else if (close) onDismiss() else { selectedId = id; editingRevision = snapshot?.revision.orEmpty() }
  }
  LaunchedEffect(projectId, reload) {
    loading = true
    try {
      snapshot = store.characters(projectId)
      if (selectedId == null && initialName != null) selectedId = snapshot?.characters?.firstOrNull { it.name == initialName }?.id
      if (editingRevision.isEmpty()) editingRevision = snapshot?.revision.orEmpty()
    } catch (failure: Exception) { if (failure is CancellationException) throw failure; error = failure.message }
    finally { loading = false }
  }
  val selected = snapshot?.characters?.firstOrNull { it.id == selectedId }
  EditorDialog(onDismissRequest = { navigate(null, selectedId == null || wide) }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
    Scaffold(topBar = { TopAppBar(title = { Text(selected?.name ?: stringResource(R.string.workspace_character_manager), maxLines = 1, overflow = TextOverflow.Ellipsis) },
      navigationIcon = { IconButton(modifier = Modifier.testTag("character-back"), enabled = !busy && !detailBusy, onClick = { navigate(null, selectedId == null || wide) }) {
        Icon(Icons.AutoMirrored.Outlined.ArrowBack, stringResource(R.string.management_back))
      } }, actions = {
        if (selected == null || wide) IconButton(enabled = snapshot != null && !busy && !detailBusy, onClick = {
          if (detailDirty) { pendingCreate = true; pendingNavigation = true } else creating = true
        }) { Icon(Icons.Outlined.PersonAdd, stringResource(R.string.character_create)) }
        if (selected != null) IconButton(enabled = !busy && !detailBusy, onClick = { deleting = selected.id }) { Icon(Icons.Outlined.DeleteOutline, stringResource(R.string.character_delete)) }
      }) }) { padding ->
      Column(Modifier.padding(padding).fillMaxSize()) {
        val current = snapshot
        if (current == null) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
          if (loading) CircularProgressIndicator() else Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(stringResource(R.string.workspace_load_error))
            TextButton(onClick = { reload++ }) { Icon(Icons.Outlined.Refresh, null); Text(stringResource(R.string.home_retry)) }
          }
        } else Row(Modifier.fillMaxSize()) {
          if (selected == null || wide) Column(if (wide) Modifier.width(280.dp).fillMaxHeight() else Modifier.weight(1f)) {
          OutlinedTextField(value = query, onValueChange = { query = it }, singleLine = true,
            label = { Text(stringResource(R.string.character_search)) }, leadingIcon = { Icon(Icons.Outlined.Search, null) },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp))
          val shown = current.characters.filter { query.isBlank() || listOf(it.name, it.description, it.personality).plus(it.aliases).plus(it.keywords).any { value -> value.contains(query, true) } }
          if (shown.isEmpty()) EmptyWorkspacePanel(Icons.Outlined.PeopleOutline, R.string.character_empty, Modifier.weight(1f))
          else LazyColumn(Modifier.weight(1f)) { items(shown, key = { it.id }) { character ->
            val image = remember(character, assets) { character.sprites.firstNotNullOfOrNull { sprite -> spriteFile(character, sprite, assets).takeIf { file -> assets.any { it.category == "figure" && it.name == file } } } }
            ListItem(modifier = Modifier.clickable(enabled = !busy && !detailBusy) { if (selectedId != character.id) navigate(character.id) },
              leadingContent = { if (image != null) AssetThumbnail(File(root, "game/figure/$image"), Modifier.size(56.dp)) else Icon(Icons.Outlined.PersonOutline, null, Modifier.size(40.dp)) },
              headlineContent = { Text(character.name) }, supportingContent = { Text(character.description, maxLines = 2) },
              trailingContent = { Icon(Icons.Outlined.ChevronRight, null) }, colors = ListItemDefaults.colors(containerColor =
                if (selectedId == character.id) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.background))
          } }
          }
          if (wide) VerticalDivider()
          if (selected != null) Box(Modifier.weight(1f).fillMaxHeight()) {
            key(selected.id) {
              CharacterDetail(selected, editingRevision, current.characters, assets, root, projectId, store, onImport, onChanged, onFeature,
                onSaved = { updated -> snapshot = updated; editingRevision = updated.revision }, onDirty = { detailDirty = it }, onBusy = { detailBusy = it }, onError = { error = it })
            }
          } else if (wide) EmptyWorkspacePanel(Icons.Outlined.PeopleOutline, R.string.workspace_character_manager, Modifier.weight(1f))
        }
      }
    }
    if (pendingNavigation) AlertDialog(onDismissRequest = { pendingNavigation = false },
      title = { Text(stringResource(R.string.workspace_unsaved)) }, text = { Text(stringResource(R.string.character_discard)) },
      confirmButton = { TextButton(modifier = Modifier.testTag("character-discard"), onClick = {
        val close = pendingClose; val id = pendingId; pendingNavigation = false; detailDirty = false
        if (pendingCreate) { pendingCreate = false; selectedId = null; creating = true }
        else if (close) onDismiss() else { selectedId = id; editingRevision = snapshot?.revision.orEmpty() }
      }) { Text(stringResource(R.string.character_discard_action)) } },
      dismissButton = { TextButton(modifier = Modifier.testTag("character-stay"), onClick = { pendingNavigation = false }) { Text(stringResource(R.string.workspace_stay)) } })
    if (creating) {
      var name by rememberSaveable { mutableStateOf("") }
      val keyboard = remember { KeyboardDismissGuard() }
      AlertDialog(onDismissRequest = { if (!keyboard.consumeDismiss() && !busy) creating = false }, title = { Text(stringResource(R.string.character_create)) },
        text = { BindKeyboardDismiss(keyboard); OutlinedTextField(value = name, onValueChange = { name = it }, enabled = !busy, singleLine = true, label = { Text(stringResource(R.string.character_name)) }) },
        confirmButton = { TextButton(enabled = name.isNotBlank() && !busy, onClick = { busy = true; scope.launch {
          try {
            val result = store.saveCharacter(projectId, newCharacter().copy(name = name.trim()), checkNotNull(snapshot).revision)
            snapshot = result; selectedId = result.characters.last().id; editingRevision = result.revision; query = ""; creating = false; onChanged()
          } catch (failure: Exception) { if (failure is CancellationException) throw failure; error = failure.message }
          finally { busy = false }
        } }) { Text(stringResource(R.string.management_create)) } },
        dismissButton = { TextButton(enabled = !busy, onClick = { creating = false }) { Text(stringResource(R.string.home_cancel)) } })
    }
    deleting?.let { id -> AlertDialog(onDismissRequest = { if (!busy) deleting = null },
      title = { Text(stringResource(R.string.character_delete)) }, text = { Text(snapshot?.characters?.firstOrNull { it.id == id }?.name.orEmpty()) },
      confirmButton = { TextButton(enabled = !busy, onClick = { busy = true; scope.launch {
        try { val result = store.deleteCharacter(projectId, id, checkNotNull(snapshot).revision); snapshot = result; editingRevision = result.revision; selectedId = null; deleting = null; onChanged() }
        catch (failure: Exception) { if (failure is CancellationException) throw failure; error = failure.message }
        finally { busy = false }
      } }) { Text(stringResource(R.string.home_remove)) } },
      dismissButton = { TextButton(enabled = !busy, onClick = { deleting = null }) { Text(stringResource(R.string.home_cancel)) } }) }
    error?.let { reason -> AlertDialog(onDismissRequest = { error = null }, title = { Text(stringResource(R.string.workspace_error)) },
      text = { Text(reason) }, confirmButton = { TextButton(onClick = { error = null }) { Text(stringResource(R.string.home_done)) } }) }
  }
}

@Composable
private fun CharacterDetail(character: CharacterInfo, initialRevision: String, characters: List<CharacterInfo>, assets: List<AssetInfo>, root: File,
  projectId: String, store: WorkspaceDraftStore, onImport: (String) -> Unit, onChanged: () -> Unit, onFeature: (Int) -> Unit,
  onSaved: (CharactersSnapshot) -> Unit, onDirty: (Boolean) -> Unit, onBusy: (Boolean) -> Unit, onError: (String) -> Unit) {
  var draft by rememberSaveable(character.id, stateSaver = CharacterSaver) { mutableStateOf(character) }
  var revision by rememberSaveable(character.id) { mutableStateOf(initialRevision) }
  var page by rememberSaveable(character.id) { mutableStateOf(0) }
  var busy by remember { mutableStateOf(false) }
  var pickingReference by rememberSaveable(character.id) { mutableStateOf(false) }
  var referenceOwner by rememberSaveable { mutableStateOf<String?>(null) }
  var referenceProject by rememberSaveable { mutableStateOf<String?>(null) }
  var preview by remember { mutableStateOf<AssetInfo?>(null) }
  val pageStates = rememberSaveableStateHolder()
  val scrollStates = listOf(rememberScrollState(), rememberScrollState(), rememberScrollState())
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  LaunchedEffect(draft, character) { onDirty(draft != character) }
  LaunchedEffect(initialRevision, character) { if (draft == character) revision = initialRevision }
  LaunchedEffect(busy) { onBusy(busy) }
  DisposableEffect(character.id) { onDispose { onBusy(false) } }
  suspend fun save(value: CharacterInfo) {
    val before = draft
    val result = store.saveCharacter(projectId, value, revision)
    val saved = result.characters.first { it.id == value.id }
    draft = if (draft == before) saved else draft.copy(referenceImages =
      (draft.referenceImages + value.referenceImages.filter { it !in before.referenceImages }).distinct().take(5))
    revision = result.revision; onSaved(result); onDirty(draft != saved); onChanged()
  }
  val referenceImport = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
    val owner = referenceOwner; val ownerProject = referenceProject; referenceOwner = null; referenceProject = null
    if (uri != null && (owner != draft.id || ownerProject != projectId)) onError(context.getString(R.string.workspace_import_cancelled))
    else if (uri != null) { busy = true; scope.launch {
      try {
        val imported = DocumentFiles.read(context, uri) { source, name -> store.importAsset(projectId, source, "reference", "${draft.id}/$name") }
        onChanged()
        save(draft.copy(referenceImages = (draft.referenceImages + imported.name.substringAfterLast('/')).distinct().take(5)))
      } catch (failure: Exception) { if (failure is CancellationException) throw failure; onError(failure.message.orEmpty()) }
      finally { busy = false }
    } }
  }
  Column(Modifier.fillMaxSize().imePadding()) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
      Text(if (draft == character) stringResource(R.string.workspace_saved) else stringResource(R.string.workspace_unsaved),
        Modifier.weight(1f).testTag(if (draft == character) "character-saved" else "character-unsaved"), style = MaterialTheme.typography.labelMedium)
      TextButton(modifier = Modifier.testTag("character-save"), enabled = !busy && draft.name.isNotBlank(), onClick = { busy = true; scope.launch {
        try { save(draft) } catch (failure: Exception) { if (failure is CancellationException) throw failure; onError(failure.message.orEmpty()) } finally { busy = false }
      } }) { Icon(Icons.Outlined.Check, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.home_save)) }
    }
    TabRow(selectedTabIndex = page) {
      listOf(R.string.character_profile, R.string.character_sprites, R.string.character_relationships).forEachIndexed { index, title ->
        Tab(selected = page == index, onClick = { page = index }, text = { Text(stringResource(title)) })
      }
    }
    Column(Modifier.weight(1f).verticalScroll(scrollStates[page]).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
      pageStates.SaveableStateProvider(page) { when (page) {
        0 -> {
          CommandText(draft.name, R.string.character_name) { draft = draft.copy(name = it) }
          StringListField(draft.aliases, R.string.character_aliases) { draft = draft.copy(aliases = it) }
          CommandText(draft.description, R.string.character_description, multiline = true) { draft = draft.copy(description = it) }
          CommandText(draft.personality, R.string.character_personality, multiline = true) { draft = draft.copy(personality = it) }
          CommandSuggestions(draft.gender, R.string.character_gender, listOf("男", "女", "其他")) { draft = draft.copy(gender = it) }
          CommandText(draft.age, R.string.character_age) { draft = draft.copy(age = it) }
          CommandSuggestions(draft.stance, R.string.character_stance, listOf("正义", "混沌", "中立", "邪恶")) { draft = draft.copy(stance = it) }
          StringListField(draft.keywords, R.string.character_keywords) { draft = draft.copy(keywords = it) }
          CommandText(draft.dialogueStyle, R.string.character_dialogue_style, multiline = true) { draft = draft.copy(dialogueStyle = it) }
          AssetField(draft.defaultVoice.orEmpty(), R.string.character_default_voice, "vocal", assets, root, onImport = onImport) { draft = draft.copy(defaultVoice = it.takeIf { it.isNotEmpty() }) }
          CommandText(draft.voiceTimbre.orEmpty(), R.string.character_timbre) { draft = draft.copy(voiceTimbre = it.takeIf { it.isNotEmpty() }) }
          CharacterColor(draft.colorTheme) { draft = draft.copy(colorTheme = it) }
          CommandText(draft.notes, R.string.character_notes, multiline = true) { draft = draft.copy(notes = it) }
        }
        1 -> {
          Row(verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.character_references), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
            CommandTool(Icons.Outlined.FolderOpen, R.string.asset_select, draft.referenceImages.size < 5) { pickingReference = true }
            CommandTool(Icons.Outlined.FileDownload, R.string.workspace_import_asset, !busy && draft.referenceImages.size < 5) {
              referenceOwner = draft.id; referenceProject = projectId; referenceImport.launch(arrayOf("image/*"))
            }
          }
          draft.referenceImages.forEachIndexed { index, file ->
            val linked = assets.firstOrNull { it.category == "reference" && it.name == "${draft.id}/$file" }
            Row(verticalAlignment = Alignment.CenterVertically) {
              if (linked != null) AssetThumbnail(File(root, "game/reference/${linked.name}"), Modifier.size(64.dp).clickable { preview = linked })
              else Icon(Icons.Outlined.HideImage, null, Modifier.size(48.dp))
              Text(file, Modifier.weight(1f).padding(8.dp), style = MaterialTheme.typography.bodyMedium)
              CommandTool(Icons.Outlined.Close, R.string.management_remove_link) { draft = draft.copy(referenceImages = draft.referenceImages.filterIndexed { i, _ -> i != index }) }
            }
          }
          HorizontalDivider()
          Row(verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.character_sprites), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
            CommandTool(Icons.Outlined.AutoAwesome, R.string.character_generate) { onFeature(R.string.character_generate) }
            CommandTool(Icons.Outlined.Add, R.string.character_add_sprite) { draft = draft.copy(sprites = draft.sprites + CharacterSprite("", "", null, "{}")) }
          }
          draft.sprites.forEachIndexed { index, sprite ->
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
              Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.character_sprite_number, index + 1), Modifier.weight(1f), style = MaterialTheme.typography.labelLarge)
                CommandTool(Icons.Outlined.ArrowUpward, R.string.workspace_move_up, index > 0) { draft = draft.copy(sprites = draft.sprites.toMutableList().apply { add(index - 1, removeAt(index)) }) }
                CommandTool(Icons.Outlined.ArrowDownward, R.string.workspace_move_down, index < draft.sprites.lastIndex) { draft = draft.copy(sprites = draft.sprites.toMutableList().apply { add(index + 1, removeAt(index)) }) }
                CommandTool(Icons.Outlined.DeleteOutline, R.string.management_remove_link) { draft = draft.copy(sprites = draft.sprites.filterIndexed { i, _ -> i != index }) }
              }
              CommandText(sprite.emotion, R.string.command_figure_emotion) { value -> draft = draft.copy(sprites = draft.sprites.mapIndexed { i, old -> if (i == index) old.copy(emotion = value) else old }) }
              val resolved = remember(draft, sprite, assets) { spriteFile(draft, sprite, assets) }
              AssetField(resolved, R.string.asset_file, "figure", assets, root, onImport = onImport) { value ->
                draft = draft.copy(sprites = draft.sprites.mapIndexed { i, old -> if (i == index) old.copy(file = value) else old })
              }
              CommandText(sprite.prompt.orEmpty(), R.string.character_sprite_prompt, multiline = true) { value ->
                draft = draft.copy(sprites = draft.sprites.mapIndexed { i, old -> if (i == index) old.copy(prompt = value) else old })
              }
              HorizontalDivider()
            }
          }
        }
        2 -> {
          Row(verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.character_relationships), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
            CommandTool(Icons.Outlined.Add, R.string.management_add, characters.size > 1) { draft = draft.copy(relations = draft.relations + CharacterRelation("", "", "", "{}")) }
          }
          draft.relations.forEachIndexed { index, relation ->
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
              Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.character_relation_number, index + 1), Modifier.weight(1f), style = MaterialTheme.typography.labelLarge)
                CommandTool(Icons.Outlined.DeleteOutline, R.string.management_remove_link) { draft = draft.copy(relations = draft.relations.filterIndexed { i, _ -> i != index }) }
              }
              CommandSuggestions(characters.firstOrNull { it.id == relation.targetId }?.name ?: relation.targetId,
                R.string.character_relation_target, characters.filter { it.id != draft.id }.map { it.name }) { value ->
                val target = characters.firstOrNull { it.name == value }?.id ?: value
                draft = draft.copy(relations = draft.relations.mapIndexed { i, old -> if (i == index) old.copy(targetId = target) else old })
              }
              CommandText(relation.relationType, R.string.character_relation_type) { value -> draft = draft.copy(relations = draft.relations.mapIndexed { i, old -> if (i == index) old.copy(relationType = value) else old }) }
              CommandText(relation.description, R.string.asset_description, multiline = true) { value -> draft = draft.copy(relations = draft.relations.mapIndexed { i, old -> if (i == index) old.copy(description = value) else old }) }
              HorizontalDivider()
            }
          }
        }
      } }
      Spacer(Modifier.height(16.dp).navigationBarsPadding())
    }
  }
  if (pickingReference) AssetPickerDialog("reference", assets.filter { it.category != "reference" || it.name.startsWith("${draft.id}/") }, "", false,
    onImport = { referenceOwner = draft.id; referenceProject = projectId; referenceImport.launch(arrayOf("image/*")) },
    onDismiss = { pickingReference = false }, onSelect = { selected ->
      if (selected != null) draft = draft.copy(referenceImages = (draft.referenceImages + selected.name.substringAfterLast('/')).distinct().take(5))
      pickingReference = false
    })
  preview?.let { AssetPreviewDialog(it, root) { preview = null } }
}
