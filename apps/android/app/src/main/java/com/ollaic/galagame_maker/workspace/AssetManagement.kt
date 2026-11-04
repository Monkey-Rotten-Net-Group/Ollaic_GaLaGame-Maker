package com.ollaic.galagame_maker.workspace

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.ollaic.core.*
import com.ollaic.galagame_maker.R
import com.ollaic.galagame_maker.DocumentFiles
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AssetManagementSheet(action: String, asset: AssetInfo?, assets: List<AssetInfo>, projectId: String, store: WorkspaceDraftStore,
  editor: WorkspaceViewModel, onDismiss: () -> Unit, onChanged: () -> Unit, onUsage: (AssetUsage) -> Unit) {
  val key = "$action/${asset?.category}/${asset?.name}"
  val failureMessage = stringResource(R.string.workspace_error)
  val context = LocalContext.current
  val projectState by editor.state.collectAsStateWithLifecycle()
  var details by remember(key) { mutableStateOf<AssetDetails?>(null) }
  var usages by remember(key) { mutableStateOf<List<AssetUsage>?>(null) }
  var animation by remember(key) { mutableStateOf<TextResource?>(null) }
  var loading by remember(key) { mutableStateOf(true) }
  var error by remember(key) { mutableStateOf<String?>(null) }
  var mutating by remember(key) { mutableStateOf(false) }
  val scope = rememberCoroutineScope()
  LaunchedEffect(key, projectId, projectState.resourceRevision) {
    try {
      when (action) {
        "metadata" -> details = store.assetDetails(projectId, checkNotNull(asset))
        "usage", "delete", "rename" -> {
          check(editor.persist()) { editor.state.value.error.orEmpty() }
          usages = store.usages(projectId, checkNotNull(asset))
        }
        "animation" -> animation = asset?.let { store.animation(projectId, it.name) } ?: TextResource("[{\"alpha\":0,\"duration\":0},{\"alpha\":1,\"duration\":300}]", "")
      }
    } catch (failure: Exception) { if (failure is CancellationException) throw failure; error = failure.message }
    finally { loading = false }
  }
  val title = when (action) {
    "metadata" -> R.string.workspace_asset_metadata; "usage" -> R.string.workspace_asset_usage
    "rename" -> R.string.workspace_rename_asset; "delete" -> R.string.workspace_delete_asset
    else -> if (asset == null) R.string.animation_create else R.string.animation_edit
  }
  EditorBottomSheet(onDismissRequest = onDismiss) {
    Column(Modifier.fillMaxWidth().fillMaxHeight(0.9f).padding(horizontal = 16.dp).imePadding()) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(title), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
        IconButton(onClick = onDismiss) { Icon(Icons.Outlined.Close, stringResource(R.string.home_done)) }
      }
      if (projectState.managingAssets) LinearProgressIndicator(Modifier.fillMaxWidth())
      if (loading) Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
      else Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        if (asset != null) Text(asset.name, style = MaterialTheme.typography.bodyMedium)
        when (action) {
          "metadata" -> details?.let { initial ->
            var draft by rememberSaveable(key, stateSaver = AssetDetailsSaver) { mutableStateOf(initial) }
            var busy by remember { mutableStateOf(false) }
            var referenceOwner by rememberSaveable { mutableStateOf<String?>(null) }
            val ownerKey = "$projectId/${asset?.category}/${asset?.name}"
            val prefix = remember(asset?.category, asset?.name) {
              asset?.let { runCatching { assetReferencePrefix(it.category, it.name) }.getOrDefault("") }.orEmpty()
            }
            val referenceImport = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
              val owner = referenceOwner; referenceOwner = null
              if (uri != null && owner != ownerKey) error = context.getString(R.string.workspace_import_cancelled)
              else if (uri != null) { busy = true; scope.launch {
                try {
                  val imported = DocumentFiles.read(context, uri) { source, name -> store.importAsset(projectId, source, "reference", "$prefix$name") }
                  draft = draft.copy(references = (draft.references + imported.name.removePrefix(prefix)).distinct()); onChanged()
                } catch (failure: Exception) { if (failure is CancellationException) throw failure; error = failure.message }
                finally { busy = false }
              } }
            }
            LaunchedEffect(initial) { if (draft.copy(revision = initial.revision) == initial) draft = draft.copy(revision = initial.revision) }
            val editable = !busy && !projectState.managingAssets
            CommandText(draft.alias, R.string.asset_alias, enabled = editable) { draft = draft.copy(alias = it) }
            CommandText(draft.description, R.string.asset_description, multiline = true, enabled = editable) { draft = draft.copy(description = it) }
            StringListField(draft.tags, R.string.asset_tags, editable) { draft = draft.copy(tags = it) }
            if (prefix.isNotBlank()) ReferenceAssetsField(draft.references, prefix, assets, store.projectDirectory(projectId), editable,
              onImport = { referenceOwner = ownerKey; referenceImport.launch(arrayOf(if (asset?.category == "background") "image/*" else "audio/*")) },
              onChange = { draft = draft.copy(references = it) })
            else if (draft.references.isNotEmpty()) StringListField(draft.references, R.string.asset_references, editable) { draft = draft.copy(references = it) }
            Button(enabled = editable, onClick = { busy = true; scope.launch {
              try { if (editor.mutateProject(projectId) { store.saveAssetDetails(it, checkNotNull(asset), draft) }) { onChanged(); onDismiss() }
                else error = editor.state.value.error ?: failureMessage }
              catch (failure: Exception) { if (failure is CancellationException) throw failure; error = failure.message }
              finally { busy = false }
            } }) { Icon(Icons.Outlined.Check, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.home_save)) }
          }
          "usage", "rename", "delete" -> usages?.let { used ->
            Text(stringResource(R.string.asset_usage_count, used.size), style = MaterialTheme.typography.titleSmall)
            if (action == "rename") {
              var name by rememberSaveable(key) { mutableStateOf(asset?.name.orEmpty()) }
              CommandText(name, R.string.asset_file) { name = it }
              Button(enabled = name.isNotBlank() && name != asset?.name && !mutating && !projectState.managingAssets, onClick = { mutating = true; scope.launch {
                try { if (editor.mutateProject(projectId) { store.renameAsset(it, checkNotNull(asset), name.trim()) }) { onChanged(); onDismiss() }
                else error = editor.state.value.error ?: failureMessage } finally { mutating = false }
              } }) { Icon(Icons.Outlined.DriveFileRenameOutline, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.home_save)) }
            }
            if (action == "delete") {
              Text(stringResource(if (used.isEmpty()) R.string.asset_confirm_delete else R.string.asset_in_use), style = MaterialTheme.typography.bodyMedium)
              Button(enabled = used.isEmpty() && !mutating && !projectState.managingAssets, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error), onClick = { mutating = true; scope.launch {
                try { if (editor.mutateProject(projectId) { store.deleteAsset(it, checkNotNull(asset)) }) { onChanged(); onDismiss() }
                else error = editor.state.value.error ?: failureMessage } finally { mutating = false }
              } }) { Icon(Icons.Outlined.DeleteOutline, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.workspace_delete_asset)) }
            }
            used.forEach { usage ->
              val openable = usage.fileName != "game/config/asset-metadata.json" && usage.fileName != "game/config.txt"
              ListItem(modifier = Modifier.clickable(enabled = openable) { onUsage(usage); onDismiss() },
                headlineContent = { Text(usage.fileName + if (usage.lineNumber > 0u) ":${usage.lineNumber}" else "") },
                supportingContent = { Text(usage.content, maxLines = 3) }, trailingContent = if (openable) ({ Icon(Icons.Outlined.ChevronRight, null) }) else null,
                colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.background))
            }
          }
          "animation" -> animation?.let { initial ->
            var name by rememberSaveable(key) { mutableStateOf(asset?.name.orEmpty()) }
            var source by rememberSaveable(key) { mutableStateOf(initial.source) }
            val revision by rememberSaveable(key) { mutableStateOf(initial.revision) }
            var busy by remember { mutableStateOf(false) }
            val editable = !busy && !projectState.managingAssets
            OutlinedTextField(value = name, onValueChange = { name = it }, enabled = editable && asset == null, singleLine = true,
              label = { Text(stringResource(R.string.asset_file)) }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(value = source, onValueChange = { source = it }, enabled = editable, minLines = 8, modifier = Modifier.fillMaxWidth(),
              label = { Text(stringResource(R.string.animation_frames)) }, textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace))
            Button(enabled = editable && name.isNotBlank() && source.isNotBlank(), onClick = { busy = true; scope.launch {
              val requestedName = name.trim().let { if (asset == null && !it.substringAfterLast('/').contains('.')) "$it.json" else it }
              try { if (editor.mutateProject(projectId) { store.saveAnimation(it, requestedName, source, revision) }) { onChanged(); onDismiss() }
                else error = editor.state.value.error ?: failureMessage }
              catch (failure: Exception) { if (failure is CancellationException) throw failure; error = failure.message }
              finally { busy = false }
            } }) { Icon(Icons.Outlined.Check, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.home_save)) }
          }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        Spacer(Modifier.height(16.dp))
      }
      Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars))
    }
  }
}
