package com.ollaic.galagame_maker.workspace

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Subject
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.ollaic.galagame_maker.R
import com.ollaic.galagame_maker.home.HomeProject
import com.ollaic.galagame_maker.PendingProjectTools

enum class WorkspaceTab(val title: Int, val icon: ImageVector) {
  Script(R.string.workspace_script, Icons.Outlined.FormatListNumbered),
  Scenes(R.string.workspace_scenes, Icons.Outlined.AccountTree),
  Assets(R.string.workspace_assets, Icons.Outlined.PhotoLibrary),
  Project(R.string.workspace_project, Icons.Outlined.FolderOpen),
}

fun BlockKind.title(): Int = when (this) {
  BlockKind.Dialogue -> R.string.workspace_dialogue
  BlockKind.Narration -> R.string.workspace_narration
  BlockKind.Note -> R.string.workspace_note
  BlockKind.Command -> R.string.workspace_raw_command
}

@Composable
private fun BlockKind.color(): Color = when (this) {
  BlockKind.Dialogue -> MaterialTheme.colorScheme.primary
  BlockKind.Narration -> MaterialTheme.colorScheme.secondary
  BlockKind.Note -> MaterialTheme.colorScheme.tertiary
    BlockKind.Command -> MaterialTheme.colorScheme.secondary
}

@Composable
fun EmptyWorkspacePanel(icon: ImageVector, title: Int, modifier: Modifier = Modifier) {
  Column(
    modifier.fillMaxSize().padding(24.dp),
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Icon(icon, null, Modifier.size(48.dp), tint = MaterialTheme.colorScheme.secondary.copy(alpha = 0.6f))
    Spacer(Modifier.height(16.dp))
    Text(stringResource(title), style = MaterialTheme.typography.titleMedium)
  }
}

@Composable
fun ScriptPanel(scene: DraftScene, scrollState: LazyListState, enabled: Boolean, onEdit: (ScriptBlock) -> Unit, onAction: (String, String) -> Unit, onFeature: (Int) -> Unit) {
  val blocks = scene.visibleBlocks
  if (blocks.isEmpty()) {
    EmptyWorkspacePanel(Icons.AutoMirrored.Outlined.Subject, R.string.workspace_empty_script)
    return
  }
  LazyColumn(
    Modifier.fillMaxSize(),
    state = scrollState,
    contentPadding = PaddingValues(16.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    itemsIndexed(blocks, key = { _, block -> block.id }) { index, block ->
      var menu by remember { mutableStateOf(false) }
      val title = if (block.kind == BlockKind.Command) commandTitles[block.command] ?: R.string.workspace_raw_command else block.kind.title()
      val preview = if (block.kind == BlockKind.Command) {
        when {
          block.command == "setTextbox" && block.preview == "show" -> stringResource(R.string.command_show)
          block.command == "setTextbox" && block.preview == "hide" -> stringResource(R.string.command_hide)
          else -> (block.preview ?: block.text).trimEnd('\r', '\n')
        }
      } else block.text
      Card(
        onClick = { if (enabled) onEdit(block) },
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(8.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
      ) {
        Column(Modifier.fillMaxWidth().padding(start = 14.dp, end = 8.dp, bottom = 16.dp)) {
          Row(verticalAlignment = Alignment.CenterVertically) {
            Text((index + 1).toString().padStart(2, '0'), Modifier.width(32.dp), style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            Box(Modifier.size(6.dp).background(block.kind.color(), RoundedCornerShape(1.dp)))
            Text(stringResource(title), Modifier.padding(horizontal = 6.dp), style = MaterialTheme.typography.labelMedium, color = block.kind.color())
            Text(block.speaker, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Box {
              IconButton(onClick = { menu = true }, enabled = enabled) { Icon(Icons.Outlined.MoreVert, stringResource(R.string.workspace_block_actions)) }
              DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text(stringResource(R.string.workspace_edit_block)) }, leadingIcon = { Icon(Icons.Outlined.Edit, null) }, onClick = { menu = false; onEdit(block) })
                listOf(R.string.workspace_copy_command to Icons.Outlined.ContentCopy, R.string.workspace_paste_command to Icons.Outlined.ContentPaste).forEach { (title, icon) ->
                  DropdownMenuItem(text = { Column { Text(stringResource(title)); Text(stringResource(R.string.feature_pending), style = MaterialTheme.typography.labelSmall) } }, leadingIcon = { Icon(icon, null) }, onClick = { menu = false; onFeature(title) })
                }
                DropdownMenuItem(text = { Text(stringResource(R.string.workspace_duplicate)) }, leadingIcon = { Icon(Icons.Outlined.ContentCopy, null) }, onClick = { menu = false; onAction("duplicate", block.id) })
                DropdownMenuItem(text = { Text(stringResource(R.string.workspace_move_up)) }, leadingIcon = { Icon(Icons.Outlined.ArrowUpward, null) }, enabled = index > 0, onClick = { menu = false; onAction("up", block.id) })
                DropdownMenuItem(text = { Text(stringResource(R.string.workspace_move_down)) }, leadingIcon = { Icon(Icons.Outlined.ArrowDownward, null) }, enabled = index < blocks.lastIndex, onClick = { menu = false; onAction("down", block.id) })
                DropdownMenuItem(text = { Text(stringResource(R.string.workspace_delete_block)) }, leadingIcon = { Icon(Icons.Outlined.DeleteOutline, null) }, onClick = { menu = false; onAction("delete", block.id) })
              }
            }
          }
          if (preview.isNotBlank()) Text(preview, style = MaterialTheme.typography.bodyLarge, maxLines = 6, overflow = TextOverflow.Ellipsis)
        }
      }
    }
  }
}

@Composable
fun SceneListPanel(
  scenes: List<DraftScene>, selected: String, enabled: Boolean,
  onSelect: (String) -> Unit, onNew: () -> Unit,
  onRename: (DraftScene) -> Unit, onDelete: (DraftScene) -> Unit,
  modifier: Modifier = Modifier,
) {
  Column(modifier.fillMaxHeight()) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
      Text(stringResource(R.string.workspace_scene_count, scenes.size), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
      IconButton(onClick = onNew, enabled = enabled) { Icon(Icons.Outlined.Add, stringResource(R.string.workspace_new_scene)) }
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
      itemsIndexed(scenes, key = { _, scene -> scene.id }) { index, scene ->
        var menu by remember { mutableStateOf(false) }
        Row(
          Modifier.fillMaxWidth().background(
            if (scene.id == selected) MaterialTheme.colorScheme.primaryContainer else Color.Transparent,
            RoundedCornerShape(4.dp),
          ).selectable(selected = scene.id == selected, enabled = enabled) { onSelect(scene.id) }.padding(start = 12.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Text((index + 1).toString().padStart(2, '0'), Modifier.width(28.dp), style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = MaterialTheme.colorScheme.onSurfaceVariant)
          Column(Modifier.weight(1f).padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(scene.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(stringResource(R.string.workspace_block_count, scene.visibleBlocks.size), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
          Box {
            IconButton(onClick = { menu = true }, enabled = enabled) { Icon(Icons.Outlined.MoreVert, stringResource(R.string.workspace_scene_actions)) }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
              DropdownMenuItem(text = { Text(stringResource(R.string.workspace_rename_scene)) }, leadingIcon = { Icon(Icons.Outlined.Edit, null) }, onClick = { menu = false; onRename(scene) })
              DropdownMenuItem(text = { Text(stringResource(R.string.workspace_delete_scene)) }, leadingIcon = { Icon(Icons.Outlined.DeleteOutline, null) }, enabled = scenes.size > 1 && scene.fileName != "start.txt", onClick = { menu = false; onDelete(scene) })
            }
          }
        }
      }
    }
  }
}

@Composable
fun ProjectDraftPanel(project: HomeProject, document: WorkspaceDraft, enabled: Boolean, onEditProject: () -> Unit, onExport: () -> Unit, onFeature: (Int) -> Unit, onNotes: (String) -> Unit) {
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
    item {
      Text(project.name, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
      if (project.description.isNotBlank()) Text(project.description, Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
      TextButton(onClick = onEditProject, enabled = enabled, contentPadding = PaddingValues(vertical = 8.dp)) { Text(stringResource(R.string.home_edit)) }
    }
    item {
      val statistics = listOf(
        document.scenes.size to R.string.workspace_scenes,
        document.scenes.sumOf { it.visibleBlocks.size } to R.string.workspace_commands,
        document.scenes.sumOf { scene -> scene.blocks.sumOf { it.text.length } } to R.string.workspace_characters,
      )
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        statistics.forEach { (count, label) ->
          Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(count.toString(), style = MaterialTheme.typography.titleLarge)
            Text(stringResource(label), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
        }
      }
    }
    item { HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant) }
    item {
      OutlinedTextField(
        value = document.notes,
        onValueChange = onNotes,
        modifier = Modifier.fillMaxWidth(),
        label = { Text(stringResource(R.string.workspace_project_notes)) },
        minLines = 6,
        enabled = enabled,
      )
    }
    item {
      FilledTonalButton(onClick = onExport, enabled = enabled) {
        Icon(Icons.Outlined.FileUpload, null, Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text(stringResource(R.string.workspace_export_project))
      }
    }
    item { HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant) }
    item { Text(stringResource(R.string.workspace_project_tools), style = MaterialTheme.typography.titleSmall) }
    item { PendingProjectTools(setOf(R.string.workspace_character_manager, R.string.workspace_animation_manager)) { if (enabled) onFeature(it) } }
  }
}
