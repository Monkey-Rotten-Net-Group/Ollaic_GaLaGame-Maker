package com.ollaic.galagame_maker.workspace

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.text.format.Formatter
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.ollaic.core.AssetInfo
import com.ollaic.galagame_maker.R
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
fun WorkspaceAssets(assets: List<AssetInfo>, root: File, enabled: Boolean, filter: String, onFilter: (String) -> Unit,
  onImport: (String) -> Unit, onInsert: (AssetInfo) -> Unit, onAction: (AssetInfo, String) -> Unit, onCreateAnimation: () -> Unit) {
  var importing by remember { mutableStateOf(false) }
  var preview by remember { mutableStateOf<AssetInfo?>(null) }
  var query by rememberSaveable(root.absolutePath) { mutableStateOf("") }
  val context = LocalContext.current
  val categories = listOf("background" to R.string.workspace_backgrounds, "figure" to R.string.workspace_figures,
    "bgm" to R.string.workspace_bgm, "vocal" to R.string.workspace_vocal, "video" to R.string.workspace_videos,
    "animation" to R.string.workspace_animations, "tex" to R.string.workspace_textures, "reference" to R.string.asset_references)
  val shown = assets.filter { (filter == "all" || it.category == filter) && (query.isBlank() || it.name.contains(query, true) || it.alias.contains(query, true)) }
  Column(Modifier.fillMaxSize()) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
      Text(stringResource(R.string.workspace_assets), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
      if (filter == "animation") CommandTool(Icons.Outlined.Add, R.string.animation_create, enabled, onClick = onCreateAnimation)
      Box {
        TextButton(onClick = { importing = true }, enabled = enabled) {
          Icon(Icons.Outlined.FileDownload, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.workspace_import_asset))
        }
        DropdownMenu(expanded = importing, onDismissRequest = { importing = false }) {
          categories.forEach { (category, title) -> DropdownMenuItem(text = { Text(stringResource(title)) }, onClick = { importing = false; onImport(category) }) }
        }
      }
    }
    Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      (listOf("all" to R.string.workspace_all_assets) + categories).forEach { (category, title) ->
        FilterChip(selected = filter == category, onClick = { onFilter(category) }, label = { Text(stringResource(title)) })
      }
    }
    OutlinedTextField(value = query, onValueChange = { query = it }, singleLine = true,
      label = { Text(stringResource(R.string.asset_search)) }, leadingIcon = { Icon(Icons.Outlined.Search, null) },
      trailingIcon = if (query.isNotBlank()) ({ IconButton(onClick = { query = "" }) { Icon(Icons.Outlined.Close, stringResource(R.string.home_clear_search)) } }) else null,
      modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp))
    if (shown.isEmpty()) EmptyWorkspacePanel(Icons.Outlined.PhotoLibrary, if (query.isBlank()) R.string.workspace_empty_assets else R.string.asset_no_matches, Modifier.weight(1f))
    else LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
      items(shown, key = { "${it.category}/${it.name}" }) { asset ->
        var menu by remember { mutableStateOf(false) }
        val file = File(root, "game/${asset.category}/${asset.name}")
        ListItem(
          headlineContent = { Text(asset.alias.ifBlank { asset.name }, maxLines = 2, overflow = TextOverflow.Ellipsis) },
          supportingContent = { Text((if (asset.alias.isNotBlank()) "${asset.name}\n" else "") + stringResource(categories.first { it.first == asset.category }.second) + " \u00b7 ${Formatter.formatShortFileSize(context, asset.size.toLong())}") },
          leadingContent = { AssetThumbnail(file, Modifier.size(48.dp).clickable { if (asset.category == "animation") onAction(asset, "animation") else preview = asset }) },
          trailingContent = {
            Box {
              IconButton(onClick = { menu = true }, enabled = enabled) { Icon(Icons.Outlined.MoreVert, stringResource(R.string.workspace_asset_actions)) }
              DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text(stringResource(R.string.workspace_insert_asset)) }, enabled = asset.category in listOf("background", "figure", "bgm", "vocal", "video", "animation"),
                  onClick = { menu = false; onInsert(asset) })
                DropdownMenuItem(text = { Text(stringResource(R.string.workspace_preview_asset)) }, onClick = { menu = false; preview = asset })
                if (asset.category == "animation") DropdownMenuItem(text = { Text(stringResource(R.string.animation_edit)) }, onClick = { menu = false; onAction(asset, "animation") })
                listOf(R.string.workspace_asset_metadata to "metadata", R.string.workspace_asset_usage to "usage").forEach { (title, action) ->
                  DropdownMenuItem(text = { Text(stringResource(title)) }, onClick = { menu = false; onAction(asset, action) })
                }
                DropdownMenuItem(text = { Text(stringResource(R.string.workspace_rename_asset)) }, onClick = { menu = false; onAction(asset, "rename") })
                DropdownMenuItem(text = { Text(stringResource(R.string.workspace_delete_asset)) }, onClick = { menu = false; onAction(asset, "delete") })
              }
            }
          },
          colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.background),
        )
      }
    }
  }
  preview?.let { asset ->
    AssetPreviewDialog(asset, root) { preview = null }
  }
}

@Composable
internal fun AssetThumbnail(file: File, modifier: Modifier, maxSize: Int = 128) {
  if (maxSize > 128 && file.extension.equals("svg", ignoreCase = true)) {
    SvgAssetPreview(file, modifier)
    return
  }
  var loading by remember(file.absolutePath, file.lastModified(), maxSize) { mutableStateOf(true) }
  val bitmap by produceState<Bitmap?>(null, file.absolutePath, file.lastModified(), maxSize) {
    value = withContext(Dispatchers.IO) {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(file.absolutePath, bounds)
      var sample = 1
      while (bounds.outWidth / sample > maxSize || bounds.outHeight / sample > maxSize) sample *= 2
      BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample })
    }
    loading = false
  }
  Box(modifier, contentAlignment = Alignment.Center) {
    val image = bitmap
    if (image != null) Image(image.asImageBitmap(), file.name, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
    else if (maxSize > 128 && !loading) Text(stringResource(R.string.workspace_unsupported_preview), style = MaterialTheme.typography.bodyMedium)
    else Icon(Icons.AutoMirrored.Outlined.InsertDriveFile, file.name, Modifier.size(32.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
  }
}
