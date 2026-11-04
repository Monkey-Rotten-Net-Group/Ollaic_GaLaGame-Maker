package com.ollaic.galagame_maker

import androidx.compose.foundation.clickable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.MenuBook
import androidx.compose.material.icons.automirrored.outlined.ViewList
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource

@Composable
fun FeatureUnavailableDialog(title: Int, onDismiss: () -> Unit) {
  AlertDialog(onDismissRequest = onDismiss,
    title = { Text(stringResource(title)) },
    text = { Text(stringResource(R.string.feature_unavailable)) },
    confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.home_done)) } },
  )
}

@Composable
fun PendingProjectTools(available: Set<Int> = emptySet(), onSelect: (Int) -> Unit) {
  listOf(
    R.string.workspace_preview to Icons.Outlined.PlayArrow,
    R.string.workspace_publish to Icons.Outlined.Publish,
    R.string.workspace_character_manager to Icons.Outlined.PeopleOutline,
    R.string.workspace_animation_manager to Icons.Outlined.Animation,
    R.string.workspace_scene_graph to Icons.Outlined.AccountTree,
    R.string.workspace_outline to Icons.AutoMirrored.Outlined.ViewList,
    R.string.workspace_snapshots to Icons.Outlined.PhotoCamera,
    R.string.workspace_memory to Icons.AutoMirrored.Outlined.MenuBook,
    R.string.workspace_ai to Icons.Outlined.AutoAwesome,
    R.string.workspace_ai_uploads to Icons.Outlined.AttachFile,
    R.string.workspace_flow to Icons.Outlined.Schema,
    R.string.workspace_voice_dubbing to Icons.Outlined.Mic,
    R.string.workspace_matting to Icons.Outlined.AutoFixHigh,
    R.string.workspace_game_config to Icons.Outlined.Tune,
    R.string.workspace_settings to Icons.Outlined.Settings,
  ).forEach { (title, icon) ->
    ListItem(
      modifier = Modifier.clickable { onSelect(title) },
      leadingContent = { Icon(icon, null) },
      headlineContent = { Text(stringResource(title)) },
      supportingContent = if (title in available) null else ({ Text(stringResource(R.string.feature_pending)) }),
      trailingContent = { Icon(if (title in available) Icons.Outlined.ChevronRight else Icons.Outlined.LockClock, null) },
      colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.background),
    )
  }
}
