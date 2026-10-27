package com.ollaic.galagame_maker.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.ollaic.core.*
import com.ollaic.galagame_maker.R
import org.json.JSONArray
import org.json.JSONObject

internal val CharacterSaver = Saver<CharacterInfo, String>(save = { encodeCharacter(it) }, restore = { decodeCharacter(it) })
internal val AssetDetailsSaver = Saver<AssetDetails, String>(save = { value ->
  JSONObject().put("alias", value.alias).put("description", value.description).put("tags", JSONArray(value.tags))
    .put("references", JSONArray(value.references)).put("revision", value.revision).toString()
}, restore = { source ->
  val json = JSONObject(source)
  val tags = json.getJSONArray("tags"); val references = json.getJSONArray("references")
  AssetDetails(json.getString("alias"), json.getString("description"), List(tags.length()) { tags.getString(it) },
    List(references.length()) { references.getString(it) }, json.getString("revision"))
})

@Composable
internal fun StringListField(values: List<String>, title: Int, enabled: Boolean = true, onChange: (List<String>) -> Unit) {
  var newValue by rememberSaveable { mutableStateOf("") }
  Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
    Text(stringResource(title), style = MaterialTheme.typography.titleSmall)
    values.forEachIndexed { index, value ->
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text(value, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        CommandTool(Icons.Outlined.Close, R.string.management_remove_link, enabled) { onChange(values.filterIndexed { i, _ -> i != index }) }
      }
    }
    OutlinedTextField(value = newValue, onValueChange = { newValue = it }, singleLine = true, enabled = enabled,
      label = { Text(stringResource(title)) }, modifier = Modifier.fillMaxWidth(), trailingIcon = {
        CommandTool(Icons.Outlined.Add, R.string.management_add, enabled && newValue.isNotBlank()) {
          val next = newValue.trim(); if (next !in values) onChange(values + next); newValue = ""
        }
      })
  }
}

@Composable
internal fun CharacterColor(value: String?, onChange: (String?) -> Unit) {
  val colors = listOf("#b53d65", "#167795", "#39816b", "#a06928", "#8b569b", "#b15048", "#5f7386", "#7e8132")
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Text(stringResource(R.string.character_color), style = MaterialTheme.typography.titleSmall)
    Row(Modifier.horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
      CommandTool(Icons.Outlined.FormatColorReset, R.string.asset_none) { onChange(null) }
      ((value?.takeIf { it !in colors }?.let { listOf(it) } ?: emptyList()) + colors).forEach { color ->
        val parsed = runCatching { Color(android.graphics.Color.parseColor(color)) }.getOrDefault(Color.Gray)
        Box(Modifier.size(48.dp).clickable { onChange(color) }.semantics { contentDescription = color }, contentAlignment = Alignment.Center) {
          Box(Modifier.size(30.dp).background(parsed, CircleShape).border(if (value == color) 3.dp else 1.dp,
            if (value == color) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.outlineVariant, CircleShape))
        }
      }
    }
  }
}
