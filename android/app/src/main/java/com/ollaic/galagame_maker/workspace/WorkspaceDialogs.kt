package com.ollaic.galagame_maker.workspace

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.ollaic.galagame_maker.R

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BlockEditorSheet(block: ScriptBlock?, onDismiss: () -> Unit, onSave: (BlockKind, String, String) -> Unit) {
  var kind by rememberSaveable(block?.id) { mutableStateOf(block?.kind ?: BlockKind.Dialogue) }
  var speaker by rememberSaveable(block?.id) { mutableStateOf(block?.speaker.orEmpty()) }
  var text by rememberSaveable(block?.id) { mutableStateOf(block?.text.orEmpty()) }
  ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).imePadding()) {
      Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(if (block == null) R.string.workspace_add_block else R.string.workspace_edit_block), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        TextButton(enabled = text.isNotBlank(), onClick = { onSave(kind, speaker.trim(), text.trim()) }) {
          Icon(Icons.Outlined.Check, null, Modifier.size(18.dp))
          Spacer(Modifier.width(6.dp))
          Text(stringResource(R.string.home_save))
        }
      }
      Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
          BlockKind.entries.forEachIndexed { index, value ->
            SegmentedButton(selected = kind == value, onClick = { kind = value }, shape = SegmentedButtonDefaults.itemShape(index, BlockKind.entries.size)) {
              Text(stringResource(value.title()))
            }
          }
        }
        AnimatedVisibility(visible = kind == BlockKind.Dialogue) {
          OutlinedTextField(value = speaker, onValueChange = { speaker = it }, label = { Text(stringResource(R.string.workspace_speaker)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
        }
        OutlinedTextField(value = text, onValueChange = { text = it }, label = { Text(stringResource(R.string.workspace_content)) }, minLines = 5, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(12.dp))
      }
      Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars))
    }
  }
}

@Composable
fun SceneNameDialog(scene: DraftScene?, scenes: List<DraftScene>, onDismiss: () -> Unit, onSave: (String) -> Unit) {
  var name by rememberSaveable(scene?.id) { mutableStateOf(scene?.name.orEmpty()) }
  val duplicate = scenes.any { it.id != scene?.id && it.name.equals(name.trim(), ignoreCase = true) }
  AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text(stringResource(if (scene == null) R.string.workspace_new_scene else R.string.workspace_rename_scene)) },
    text = {
      OutlinedTextField(
        value = name, onValueChange = { name = it }, singleLine = true,
        label = { Text(stringResource(R.string.workspace_scene_name)) },
        isError = duplicate,
        supportingText = { if (duplicate) Text(stringResource(R.string.workspace_duplicate_scene)) },
        modifier = Modifier.fillMaxWidth(),
      )
    },
    confirmButton = { TextButton(enabled = name.isNotBlank() && !duplicate, onClick = { onSave(name.trim()) }) { Text(stringResource(R.string.home_save)) } },
    dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.home_cancel)) } },
  )
}
