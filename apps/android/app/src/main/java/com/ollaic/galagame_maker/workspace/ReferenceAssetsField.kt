package com.ollaic.galagame_maker.workspace

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.ollaic.core.AssetInfo
import com.ollaic.galagame_maker.R
import java.io.File

@Composable
internal fun ReferenceAssetsField(values: List<String>, prefix: String, assets: List<AssetInfo>, root: File,
  enabled: Boolean, onImport: () -> Unit, onChange: (List<String>) -> Unit) {
  var picking by rememberSaveable(prefix) { mutableStateOf(false) }
  var preview by remember { mutableStateOf<AssetInfo?>(null) }
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Text(stringResource(R.string.asset_references), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
      CommandTool(Icons.Outlined.FolderOpen, R.string.asset_select, enabled) { picking = true }
      CommandTool(Icons.Outlined.FileDownload, R.string.workspace_import_asset, enabled, onClick = onImport)
    }
    values.forEachIndexed { index, file ->
      val linked = assets.firstOrNull { it.category == "reference" && it.name == "$prefix$file" }
      Row(verticalAlignment = Alignment.CenterVertically) {
        if (linked != null) AssetThumbnail(File(root, "game/reference/${linked.name}"), Modifier.size(48.dp).clickable { preview = linked })
        else Icon(Icons.AutoMirrored.Outlined.InsertDriveFile, null, Modifier.size(32.dp))
        Text(file, Modifier.weight(1f).padding(horizontal = 8.dp), maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
        CommandTool(Icons.Outlined.Close, R.string.management_remove_link, enabled) { onChange(values.filterIndexed { i, _ -> i != index }) }
      }
    }
  }
  if (picking) AssetPickerDialog("reference", assets.filter { it.category != "reference" || it.name.startsWith(prefix) }, "", false,
    onImport = { onImport() }, onDismiss = { picking = false }, onSelect = { selected ->
      if (selected != null) onChange((values + selected.name.removePrefix(prefix)).distinct())
      picking = false
    })
  preview?.let { AssetPreviewDialog(it, root) { preview = null } }
}
