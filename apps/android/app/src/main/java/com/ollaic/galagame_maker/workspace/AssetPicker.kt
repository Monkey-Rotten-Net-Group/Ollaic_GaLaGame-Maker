package com.ollaic.galagame_maker.workspace

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import com.ollaic.core.AssetInfo
import com.ollaic.galagame_maker.R
import java.io.File

@Composable
internal fun AssetField(value: String, title: Int, category: String, assets: List<AssetInfo>, root: File,
  allowClear: Boolean = true, emptyValue: String = "", onImport: (String) -> Unit, onChange: (String) -> Unit) {
  var picking by rememberSaveable { mutableStateOf(false) }
  var previewing by remember { mutableStateOf(false) }
  val current = assets.firstOrNull { it.category == category && it.name == value }
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    OutlinedTextField(value = value, onValueChange = onChange, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("asset-value-$category"),
      label = { Text(stringResource(title)) }, trailingIcon = {
        Row {
          if (current != null) IconButton(onClick = { previewing = true }) { Icon(Icons.Outlined.Visibility, stringResource(R.string.workspace_preview_asset)) }
          IconButton(onClick = { picking = true }, modifier = Modifier.testTag("asset-pick-$category")) { Icon(Icons.Outlined.FolderOpen, stringResource(R.string.asset_select)) }
        }
      })
    if (value.isNotBlank() && value != "none") Text(current?.alias.orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis,
      style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (value.isNotBlank() && value != "none" && category in listOf("background", "figure")) {
      Box(Modifier.fillMaxWidth().height(128.dp), contentAlignment = Alignment.Center) {
        if (current != null) AssetThumbnail(File(root, "game/$category/${current.name}"), Modifier.fillMaxSize().clickable { previewing = true }, 512)
        else Icon(Icons.Outlined.HideImage, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
      }
    }
  }
  if (picking) AssetPickerDialog(category, assets, value, allowClear, onImport, { picking = false }) {
    onChange(it?.name ?: emptyValue); picking = false
  }
  if (previewing && current != null) AssetPreviewDialog(current, root) { previewing = false }
}

@Composable
internal fun AssetPickerDialog(category: String, assets: List<AssetInfo>, selected: String, allowClear: Boolean,
  onImport: (String) -> Unit, onDismiss: () -> Unit, onSelect: (AssetInfo?) -> Unit) {
  var query by rememberSaveable { mutableStateOf("") }
  val shown = assets.filter { it.category == category && (query.isBlank() || it.name.contains(query, true) || it.alias.contains(query, true)) }
  EditorDialog(onDismissRequest = onDismiss) {
    Surface(shape = MaterialTheme.shapes.small) {
      Column(Modifier.fillMaxWidth().heightIn(max = 620.dp)) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp), verticalAlignment = Alignment.CenterVertically) {
          Text(stringResource(R.string.asset_select), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
          IconButton(onClick = { onImport(category) }) { Icon(Icons.Outlined.FileDownload, stringResource(R.string.workspace_import_asset)) }
          IconButton(onClick = onDismiss) { Icon(Icons.Outlined.Close, stringResource(R.string.home_done)) }
        }
        OutlinedTextField(value = query, onValueChange = { query = it }, singleLine = true,
          label = { Text(stringResource(R.string.asset_search)) }, leadingIcon = { Icon(Icons.Outlined.Search, null) },
          modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("asset-search"))
        LazyColumn(Modifier.weight(1f, fill = false).fillMaxWidth(), contentPadding = PaddingValues(vertical = 8.dp)) {
          if (allowClear) item { ListItem(modifier = Modifier.clickable { onSelect(null) },
            headlineContent = { Text(stringResource(R.string.asset_none)) }, leadingContent = { RadioButton(selected.isBlank() || selected == "none", onClick = null) }) }
          items(shown, key = { it.name }) { asset ->
            ListItem(modifier = Modifier.testTag("asset-option-$category-${asset.name}").clickable { onSelect(asset) },
              headlineContent = { Text(asset.alias.ifBlank { asset.name }, maxLines = 2, overflow = TextOverflow.Ellipsis) },
              supportingContent = if (asset.alias.isNotBlank()) ({ Text(asset.name, maxLines = 2, overflow = TextOverflow.Ellipsis) }) else null,
              leadingContent = { RadioButton(asset.name == selected, onClick = null) })
          }
          if (shown.isEmpty()) item { Text(stringResource(if (query.isBlank()) R.string.workspace_empty_assets else R.string.asset_no_matches), Modifier.padding(24.dp), style = MaterialTheme.typography.bodyMedium) }
        }
      }
    }
  }
}
