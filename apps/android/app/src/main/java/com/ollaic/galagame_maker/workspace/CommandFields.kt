package com.ollaic.galagame_maker.workspace

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.ollaic.core.CommandChoice
import com.ollaic.core.CommandEdit
import com.ollaic.core.CommandKind
import com.ollaic.core.AssetInfo
import com.ollaic.core.CharacterInfo
import com.ollaic.galagame_maker.R
import java.io.File
import kotlin.math.roundToInt

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CommandFields(edit: CommandEdit, scenes: List<String>, labels: List<String>, assets: List<AssetInfo>,
  characters: List<CharacterInfo>, root: File, onImport: (String) -> Unit, onManageCharacters: () -> Unit, onChange: (CommandEdit) -> Unit) {
  when (edit.kind) {
    CommandKind.DIALOGUE, CommandKind.NARRATOR, CommandKind.COMMENT -> {
      if (edit.kind == CommandKind.DIALOGUE) CommandSuggestions(edit.speaker, R.string.workspace_speaker, characters.flatMap { listOf(it.name) + it.aliases }) { speaker ->
        val character = characters.firstOrNull { it.name == speaker || speaker in it.aliases }
        onChange(edit.copy(speaker = speaker, voice = character?.defaultVoice?.takeIf { edit.voice.isBlank() } ?: edit.voice))
      }
      CommandText(edit.content, R.string.workspace_content, multiline = true) { onChange(edit.copy(content = it)) }
      if (edit.kind != CommandKind.COMMENT) AssetField(edit.voice, R.string.command_voice, "vocal", assets, root, onImport = onImport) { onChange(edit.copy(voice = it)) }
    }
    CommandKind.INTRO -> CommandText(edit.introLines.joinToString("\n"), R.string.command_intro, multiline = true) {
      onChange(edit.copy(introLines = it.split('\n')))
    }
    CommandKind.CHOOSE -> {
      Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.command_choose), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
        CommandTool(Icons.Outlined.Add, R.string.command_add_choice) {
          onChange(edit.copy(choices = edit.choices + CommandChoice("", "")))
        }
      }
      edit.choices.forEachIndexed { index, choice ->
        Column(Modifier.testTag("command-choice-$index"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
          Row(verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.command_choice_number, index + 1), Modifier.weight(1f), style = MaterialTheme.typography.labelLarge)
            CommandTool(Icons.Outlined.ArrowUpward, R.string.workspace_move_up, index > 0) {
              onChange(edit.copy(choices = edit.choices.toMutableList().apply { add(index - 1, removeAt(index)) }))
            }
            CommandTool(Icons.Outlined.ArrowDownward, R.string.workspace_move_down, index < edit.choices.lastIndex) {
              onChange(edit.copy(choices = edit.choices.toMutableList().apply { add(index + 1, removeAt(index)) }))
            }
            CommandTool(Icons.Outlined.DeleteOutline, R.string.command_delete_choice) {
              onChange(edit.copy(choices = edit.choices.filterIndexed { i, _ -> i != index }))
            }
          }
          CommandText(choice.text, R.string.command_choice_text) { text ->
            onChange(edit.copy(choices = edit.choices.mapIndexed { i, old -> if (i == index) old.copy(text = text) else old }))
          }
          CommandSuggestions(choice.target, R.string.command_choice_target, (scenes + labels).distinct(), allowEmpty = true) { target ->
            onChange(edit.copy(choices = edit.choices.mapIndexed { i, old -> if (i == index) old.copy(target = target) else old }))
          }
          HorizontalDivider()
        }
      }
    }
    CommandKind.CHANGE_SCENE, CommandKind.CALL_SCENE -> CommandSuggestions(edit.scene, R.string.command_target_scene, scenes) { onChange(edit.copy(scene = it)) }
    CommandKind.LABEL -> CommandText(edit.label, R.string.command_label_name) { onChange(edit.copy(label = it)) }
    CommandKind.JUMP_LABEL -> CommandSuggestions(edit.label, R.string.command_label_name, labels) { onChange(edit.copy(label = it)) }
    CommandKind.SET_VAR -> {
      CommandText(edit.variable, R.string.command_variable_name) { onChange(edit.copy(variable = it)) }
      CommandText(edit.value, R.string.command_variable_value) { onChange(edit.copy(value = it)) }
    }
    CommandKind.GET_USER_INPUT -> {
      CommandText(edit.variable, R.string.command_variable_name) { onChange(edit.copy(variable = it)) }
      CommandText(edit.title, R.string.command_input_title) { onChange(edit.copy(title = it)) }
      CommandText(edit.button, R.string.command_input_button) { onChange(edit.copy(button = it)) }
    }
    CommandKind.SET_TEXTBOX -> {
      SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        listOf("show" to R.string.command_show, "hide" to R.string.command_hide).forEachIndexed { index, (value, title) ->
          SegmentedButton(selected = edit.content == value, onClick = { onChange(edit.copy(content = value)) },
            shape = SegmentedButtonDefaults.itemShape(index, 2)) { Text(stringResource(title)) }
        }
      }
    }
    CommandKind.SET_TRANSFORM -> {
      CommandText(edit.content, R.string.command_transform_json, multiline = true) { onChange(edit.copy(content = it)) }
      CommandText(edit.target, R.string.command_transform_target) { onChange(edit.copy(target = it)) }
    }
    CommandKind.CHANGE_BG, CommandKind.MINI_AVATAR, CommandKind.BGM, CommandKind.PLAY_EFFECT, CommandKind.PLAY_VIDEO,
    CommandKind.UNLOCK_CG, CommandKind.UNLOCK_BGM, CommandKind.SET_ANIMATION -> {
      val category = when (edit.kind) {
        CommandKind.CHANGE_BG, CommandKind.UNLOCK_CG -> "background"
        CommandKind.MINI_AVATAR -> "figure"
        CommandKind.BGM, CommandKind.UNLOCK_BGM -> "bgm"
        CommandKind.PLAY_EFFECT -> "vocal"
        CommandKind.PLAY_VIDEO -> "video"
        else -> "animation"
      }
      val unlock = edit.kind in listOf(CommandKind.UNLOCK_CG, CommandKind.UNLOCK_BGM)
      AssetField(edit.asset, R.string.asset_file, category, assets, root,
        allowClear = !unlock && edit.kind != CommandKind.SET_ANIMATION, emptyValue = "none", onImport = onImport) { onChange(edit.copy(asset = it)) }
      if (edit.kind in listOf(CommandKind.BGM, CommandKind.PLAY_EFFECT, CommandKind.PLAY_VIDEO)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
          Text(stringResource(R.string.command_custom_volume), Modifier.weight(1f))
          Switch(checked = edit.volume != null, modifier = Modifier.testTag("command-volume-override"),
            onCheckedChange = { onChange(edit.copy(volume = if (it) 100 else null)) })
        }
        edit.volume?.let { volume ->
          Text(stringResource(R.string.command_volume_value, volume), style = MaterialTheme.typography.labelLarge)
          Slider(value = volume.toFloat().coerceIn(0f, 100f), valueRange = 0f..100f, steps = 99, modifier = Modifier.testTag("command-volume"),
            onValueChange = { onChange(edit.copy(volume = it.roundToInt())) })
        }
      }
      if (unlock) CommandText(edit.displayName, R.string.command_display_name) { onChange(edit.copy(displayName = it)) }
      if (edit.kind == CommandKind.SET_ANIMATION) CommandText(edit.target, R.string.command_transform_target) { onChange(edit.copy(target = it)) }
    }
    CommandKind.CHANGE_FIGURE -> {
      Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.command_figure_character), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
        CommandTool(Icons.Outlined.ManageAccounts, R.string.workspace_character_manager, onClick = onManageCharacters)
      }
      CommandSuggestions(edit.figureCharacter, R.string.workspace_speaker, characters.map { it.name }, allowEmpty = true, emptyTitle = R.string.asset_none) { name ->
        val character = characters.firstOrNull { it.name == name }
        val sprite = character?.sprites?.firstOrNull { spriteFile(character, it, assets).isNotBlank() }
        val file = if (character != null && sprite != null) spriteFile(character, sprite, assets) else ""
        onChange(edit.copy(figureCharacter = name, figureEmotion = sprite?.emotion.orEmpty(), asset = file.ifBlank { edit.asset }))
      }
      val selectedCharacter = characters.firstOrNull { it.name == edit.figureCharacter }
      CommandSuggestions(edit.figureEmotion, R.string.command_figure_emotion, selectedCharacter?.sprites?.map { it.emotion }.orEmpty()) { emotion ->
        val sprite = selectedCharacter?.sprites?.firstOrNull { it.emotion == emotion }
        val file = if (selectedCharacter != null && sprite != null) spriteFile(selectedCharacter, sprite, assets) else ""
        onChange(edit.copy(figureEmotion = emotion, asset = file.ifBlank { edit.asset }))
      }
      AssetField(edit.asset, R.string.asset_file, "figure", assets, root, emptyValue = "none", onImport = onImport) { name ->
        val linked = characters.firstNotNullOfOrNull { character -> character.sprites.firstOrNull { spriteFile(character, it, assets) == name }?.let { character to it } }
        onChange(edit.copy(asset = name, figureCharacter = linked?.first?.name.orEmpty(), figureEmotion = linked?.second?.emotion.orEmpty()))
      }
      SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        listOf("left" to R.string.command_left, "center" to R.string.command_center, "right" to R.string.command_right).forEachIndexed { index, (value, label) ->
          SegmentedButton(selected = edit.figurePosition == value, onClick = { onChange(edit.copy(figurePosition = value)) },
            shape = SegmentedButtonDefaults.itemShape(index, 3)) { Text(stringResource(label)) }
        }
      }
      CommandText(edit.figureId, R.string.command_figure_id) { onChange(edit.copy(figureId = it)) }
    }
    CommandKind.END -> Unit
  }
  if (edit.kind != CommandKind.COMMENT) {
    Row(Modifier.fillMaxWidth().toggleable(value = edit.next, role = Role.Switch,
      onValueChange = { onChange(edit.copy(next = it)) }), verticalAlignment = Alignment.CenterVertically) {
      Text(stringResource(R.string.command_next), Modifier.weight(1f))
      Switch(checked = edit.next, onCheckedChange = null)
    }
    CommandText(edit.`when`, R.string.command_when) { onChange(edit.copy(`when` = it)) }
  }
}

@Composable
internal fun CommandText(value: String, title: Int, multiline: Boolean = false, enabled: Boolean = true, onChange: (String) -> Unit) {
  OutlinedTextField(value = value, onValueChange = onChange, label = { Text(stringResource(title)) },
    singleLine = !multiline, enabled = enabled, minLines = if (multiline) 4 else 1,
    modifier = Modifier.fillMaxWidth().testTag("field-${LocalContext.current.resources.getResourceEntryName(title)}"))
}

@Composable
internal fun CommandSuggestions(value: String, title: Int, options: List<String>, allowEmpty: Boolean = false, emptyTitle: Int = R.string.command_no_jump, onChange: (String) -> Unit) {
  var expanded by remember { mutableStateOf(false) }
  val fieldName = LocalContext.current.resources.getResourceEntryName(title)
  Box {
    OutlinedTextField(value = value, onValueChange = onChange, label = { Text(stringResource(title)) },
      singleLine = true, modifier = Modifier.fillMaxWidth().testTag("field-$fieldName"), trailingIcon = {
        CommandTool(Icons.Outlined.ExpandMore, R.string.command_select_target, options.isNotEmpty() || allowEmpty, tag = "select-$fieldName") { expanded = true }
      })
    DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, modifier = Modifier.heightIn(max = 280.dp)) {
      if (allowEmpty) DropdownMenuItem(text = { Text(stringResource(emptyTitle)) }, onClick = { onChange(""); expanded = false })
      options.forEach { target -> DropdownMenuItem(text = { Text(target) }, onClick = { onChange(target); expanded = false }) }
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CommandTool(icon: ImageVector, title: Int, enabled: Boolean = true, tag: String? = null, onClick: () -> Unit) {
  val description = stringResource(title)
  TooltipBox(positionProvider = TooltipDefaults.rememberPlainTooltipPositionProvider(),
    tooltip = { PlainTooltip { Text(description) } }, state = rememberTooltipState()) {
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.size(48.dp)
      .testTag(tag ?: "tool-${LocalContext.current.resources.getResourceEntryName(title)}")) { Icon(icon, description) }
  }
}
