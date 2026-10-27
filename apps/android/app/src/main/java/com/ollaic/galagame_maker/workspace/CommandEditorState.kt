package com.ollaic.galagame_maker.workspace

import androidx.compose.runtime.saveable.Saver
import com.ollaic.core.CommandChoice
import com.ollaic.core.CommandEdit
import com.ollaic.core.CommandKind
import com.ollaic.core.newCommand
import org.json.JSONArray
import org.json.JSONObject

internal val CommandEditSaver = Saver<CommandEdit, String>(
  save = { edit ->
    JSONObject().put("kind", edit.kind.name).put("content", edit.content).put("speaker", edit.speaker)
      .put("scene", edit.scene).put("label", edit.label).put("variable", edit.variable).put("value", edit.value)
      .put("title", edit.title).put("button", edit.button).put("target", edit.target)
      .put("next", edit.next).put("when", edit.`when`).put("intro", JSONArray(edit.introLines))
      .put("asset", edit.asset).put("voice", edit.voice).put("figurePosition", edit.figurePosition)
      .put("figureId", edit.figureId).put("figureCharacter", edit.figureCharacter).put("figureEmotion", edit.figureEmotion)
      .put("volume", edit.volume).put("displayName", edit.displayName)
      .put("choices", JSONArray().also { choices -> edit.choices.forEach {
        choices.put(JSONObject().put("text", it.text).put("target", it.target))
      } }).toString()
  },
  restore = { saved ->
    val json = JSONObject(saved)
    val choices = json.getJSONArray("choices")
    val intro = json.getJSONArray("intro")
    newCommand(CommandKind.valueOf(json.getString("kind"))).copy(
      content = json.getString("content"), speaker = json.getString("speaker"),
      scene = json.getString("scene"), label = json.getString("label"),
      variable = json.getString("variable"), value = json.getString("value"),
      title = json.getString("title"), button = json.getString("button"), target = json.getString("target"),
      next = json.getBoolean("next"), `when` = json.getString("when"),
      asset = json.optString("asset"), voice = json.optString("voice"),
      figurePosition = json.optString("figurePosition", if (CommandKind.valueOf(json.getString("kind")) == CommandKind.CHANGE_FIGURE) "center" else ""),
      figureId = json.optString("figureId"), figureCharacter = json.optString("figureCharacter"), figureEmotion = json.optString("figureEmotion"),
      volume = if (json.has("volume") && !json.isNull("volume")) json.getInt("volume") else null,
      displayName = json.optString("displayName"),
      introLines = List(intro.length()) { intro.getString(it) },
      choices = List(choices.length()) { choices.getJSONObject(it).let { CommandChoice(it.getString("text"), it.getString("target")) } },
    )
  },
)
