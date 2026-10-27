package com.ollaic.galagame_maker.workspace

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.ollaic.galagame_maker.R
import com.ollaic.core.*
import java.io.File

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BlockEditorSheet(block: ScriptBlock?, scenes: List<DraftScene>, sceneId: String?, assets: List<AssetInfo>, characters: List<CharacterInfo>,
  root: File, enabled: Boolean, onImport: (String) -> Unit, onManageCharacters: () -> Unit, onDismiss: () -> Unit, onSave: (String) -> Unit) {
  val initial = remember(block?.id) {
    block?.source ?: block?.let { editLine("", it.kind.name, it.speaker, it.text) }.orEmpty()
  }
  val parsed = remember(block?.id) { runCatching { readCommand(initial) }.getOrNull() }
  var edit by rememberSaveable(block?.id, stateSaver = CommandEditSaver) { mutableStateOf(parsed ?: newCommand(CommandKind.DIALOGUE)) }
  var sourceMode by rememberSaveable(block?.id) { mutableStateOf(initial.isNotEmpty() && parsed == null) }
  var original by rememberSaveable(block?.id) { mutableStateOf(initial) }
  var source by rememberSaveable(block?.id) { mutableStateOf(initial) }
  var error by remember { mutableStateOf<String?>(null) }
  var templates by remember { mutableStateOf(false) }
  val sceneNames = scenes.map { it.fileName }
  val labels = remember(scenes, sceneId) {
    scenes.firstOrNull { it.id == sceneId }?.let { scene ->
      scene.blocks.mapNotNull { block -> runCatching { readCommand(block.source.orEmpty()) }.getOrNull() }
        .filter { it.kind == CommandKind.LABEL }.map { it.label }.distinct()
    }.orEmpty()
  }
  val typeTitle = structuredCommands.firstOrNull { it.second == edit.kind }?.first ?: R.string.workspace_raw_command
  EditorBottomSheet(onDismissRequest = onDismiss) {
    Column(Modifier.fillMaxWidth().fillMaxHeight(0.9f).padding(horizontal = 20.dp).imePadding()) {
      Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(if (block == null) R.string.workspace_add_block else R.string.workspace_edit_block), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        TextButton(modifier = Modifier.testTag("command-save"), enabled = enabled && (!sourceMode || source.isNotBlank()), onClick = {
          try {
            val rendered = if (sourceMode) source.also { require(it.isNotBlank()) } else editCommand(original, edit)
            onSave(rendered)
          } catch (failure: Exception) { error = failure.message }
        }) {
          Icon(Icons.Outlined.Check, null, Modifier.size(18.dp))
          Spacer(Modifier.width(6.dp))
          Text(stringResource(R.string.home_save))
        }
      }
      Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
          listOf(R.string.command_form, R.string.workspace_source).forEachIndexed { index, title ->
            val raw = index == 1
            SegmentedButton(selected = sourceMode == raw, onClick = {
              if (sourceMode != raw) try {
                if (raw) source = runCatching { editCommand(original, edit) }.getOrElse { failure ->
                  if (original.isEmpty() && edit == newCommand(edit.kind)) "" else throw failure
                }
                else {
                  edit = if (source.isBlank()) newCommand(edit.kind) else readCommand(source)
                  original = if (source.isBlank()) "" else source
                }
                sourceMode = raw
                error = null
              } catch (failure: Exception) { error = failure.message }
            }, modifier = Modifier.testTag(if (raw) "command-mode-source" else "command-mode-form"), shape = SegmentedButtonDefaults.itemShape(index, 2)) {
              Text(stringResource(title))
            }
          }
        }
        if (!sourceMode) Box {
          OutlinedButton(onClick = { templates = true }, modifier = Modifier.fillMaxWidth().testTag("command-type-picker")) {
            Text(stringResource(typeTitle), Modifier.weight(1f))
            Icon(Icons.Outlined.ExpandMore, null)
          }
          DropdownMenu(expanded = templates, onDismissRequest = { templates = false }, modifier = Modifier.heightIn(max = 320.dp)) {
            structuredCommands.forEach { (title, kind) ->
              DropdownMenuItem(modifier = Modifier.testTag("command-kind-${kind.name}"), text = { Text(stringResource(title)) }, onClick = {
                if (kind != edit.kind) {
                  val baseline = edit
                  edit = newCommand(kind).let { fresh ->
                    fresh.copy(
                      content = if (kind in listOf(CommandKind.DIALOGUE, CommandKind.NARRATOR, CommandKind.COMMENT) && baseline.kind in listOf(CommandKind.DIALOGUE, CommandKind.NARRATOR, CommandKind.COMMENT)) baseline.content else fresh.content,
                      speaker = baseline.speaker,
                      scene = if (kind in listOf(CommandKind.CHANGE_SCENE, CommandKind.CALL_SCENE)) sceneNames.firstOrNull().orEmpty() else "",
                      next = baseline.next, `when` = baseline.`when`,
                    )
                  }
                }
                sourceMode = false; templates = false; error = null
              })
            }
          }
        }
        if (sourceMode) {
          OutlinedTextField(value = source, onValueChange = { source = it; error = null },
            label = { Text(stringResource(R.string.workspace_source)) }, minLines = 8, modifier = Modifier.fillMaxWidth().testTag("command-source"),
            textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace))
        } else CommandFields(edit, sceneNames, labels, assets, characters, root, onImport, onManageCharacters, onChange = { edit = it; error = null })
        error?.let { Text(it, Modifier.testTag("command-error"), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        Spacer(Modifier.height(12.dp))
      }
      Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars))
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SceneSourceSheet(scene: DraftScene, onDismiss: () -> Unit, onSave: (String) -> Unit) {
  var source by rememberSaveable(scene.id) { mutableStateOf(WorkspaceCodec.sources(WorkspaceDraft(listOf(scene))).single().source) }
  EditorBottomSheet(onDismissRequest = onDismiss) {
    Column(Modifier.fillMaxWidth().fillMaxHeight(0.9f).padding(horizontal = 16.dp).imePadding()) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text(scene.fileName, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
        TextButton(onClick = { onSave(source) }) { Icon(Icons.Outlined.Check, null); Text(stringResource(R.string.home_save)) }
      }
      OutlinedTextField(value = source, onValueChange = { source = it }, modifier = Modifier.weight(1f).fillMaxWidth(),
        textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
        label = { Text(stringResource(R.string.workspace_source)) })
      Spacer(Modifier.height(16.dp).navigationBarsPadding())
    }
  }
}

@Composable
fun SceneNameDialog(scene: DraftScene?, scenes: List<DraftScene>, onDismiss: () -> Unit, onSave: (String) -> Unit) {
  val keyboard = remember { KeyboardDismissGuard() }
  var name by rememberSaveable(scene?.id) { mutableStateOf(scene?.name.orEmpty()) }
  val proposedFile = runCatching { com.ollaic.core.sceneFileName(name) }.getOrNull()
  val duplicate = scenes.any { it.id != scene?.id && (it.name.equals(name.trim(), ignoreCase = true) || it.fileName.equals(proposedFile, ignoreCase = true)) }
  val invalid = name.isNotBlank() && runCatching { com.ollaic.core.sceneFileName(name) }.isFailure
  AlertDialog(
    onDismissRequest = { if (!keyboard.consumeDismiss()) onDismiss() },
    title = { Text(stringResource(if (scene == null) R.string.workspace_new_scene else R.string.workspace_rename_scene)) },
    text = {
      BindKeyboardDismiss(keyboard)
      OutlinedTextField(
        value = name, onValueChange = { name = it }, singleLine = true,
        label = { Text(stringResource(R.string.workspace_scene_name)) },
        isError = duplicate || invalid,
        supportingText = { if (duplicate || invalid) Text(stringResource(if (duplicate) R.string.workspace_duplicate_scene else R.string.workspace_invalid_scene)) },
        modifier = Modifier.fillMaxWidth().testTag("field-workspace_scene_name"),
      )
    },
    confirmButton = { TextButton(modifier = Modifier.testTag("scene-name-save"), enabled = name.isNotBlank() && !duplicate && !invalid, onClick = { onSave(name.trim()) }) { Text(stringResource(R.string.home_save)) } },
    dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.home_cancel)) } },
  )
}
