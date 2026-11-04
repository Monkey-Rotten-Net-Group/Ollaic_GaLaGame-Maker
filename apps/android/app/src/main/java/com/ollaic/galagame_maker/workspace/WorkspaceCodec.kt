package com.ollaic.galagame_maker.workspace

import com.ollaic.core.SceneSource
import com.ollaic.core.WorkspaceSnapshot
import com.ollaic.core.assembleLines
import com.ollaic.core.decodeLines
import com.ollaic.core.editLine
import org.json.JSONArray
import org.json.JSONObject

internal object WorkspaceCodec {
  fun sources(document: WorkspaceDraft): List<SceneSource> = document.scenes.mapIndexed { index, scene ->
    val name = scene.fileName.ifBlank { if (index == 0) "start.txt" else "scene-${scene.id}.txt" }
    SceneSource(name, assembleLines(scene.blocks.map { editLine(it.source.orEmpty(), it.kind.name, it.speaker, it.text) }))
  }

  fun blocks(source: String): List<ScriptBlock> = decodeLines(source).map { line ->
    val kind = BlockKind.valueOf(line.kind)
    ScriptBlock(kind = kind, speaker = line.speaker, text = line.text, source = line.source,
      command = if (kind == BlockKind.Command) line.command else "raw",
      preview = if (kind == BlockKind.Command && line.command != "raw") line.preview else null)
  }

  fun classify(block: ScriptBlock): ScriptBlock {
    if (block.kind != BlockKind.Command) return block
    val line = decodeLines(block.text).singleOrNull()
    return block.copy(command = line?.command ?: "raw", preview = line?.takeIf { it.command != "raw" }?.preview)
  }

  fun fromNative(projectId: String, snapshot: WorkspaceSnapshot): WorkspaceDraft {
    val cached = runCatching { decode(projectId, JSONObject(snapshot.editorState)) }.getOrNull()
    if (cached != null && runCatching {
      sources(cached).associate { it.fileName to it.source } == snapshot.scenes.associate { it.fileName to it.source }
    }.getOrDefault(false)) return cached.copy(notes = snapshot.notes)
    return WorkspaceDraft(
      scenes = snapshot.scenes.sortedWith(compareBy({ it.fileName != "start.txt" }, { it.fileName })).map { scene ->
        DraftScene(name = scene.fileName.removeSuffix(".txt"), fileName = scene.fileName, blocks = blocks(scene.source))
      },
      notes = snapshot.notes,
    ).also { it.validate() }
  }

  fun decode(projectId: String, root: JSONObject): WorkspaceDraft {
    val version = root.getInt("version")
    require(version in 1..2) { "Unsupported workspace version" }
    require(root.getString("projectId") == projectId) { "Workspace project mismatch" }
    val scenes = root.getJSONArray("scenes")
    return WorkspaceDraft(
      scenes = List(scenes.length()) { index ->
        val scene = scenes.getJSONObject(index)
        val blocks = scene.getJSONArray("blocks")
        DraftScene(
          id = scene.getString("id"),
          name = scene.getString("name"),
          fileName = if (version == 1) { if (index == 0) "start.txt" else "scene-${index + 1}.txt" } else scene.optString("fileName"),
          blocks = List(blocks.length()) { blockIndex ->
            val block = blocks.getJSONObject(blockIndex)
            classify(ScriptBlock(
              id = block.getString("id"), kind = BlockKind.valueOf(block.getString("kind")),
              speaker = block.optString("speaker"), text = block.getString("text"),
              source = if (block.has("source") && !block.isNull("source")) block.getString("source") else null,
            ))
          },
        )
      },
      notes = root.optString("notes"),
    ).also { it.validate() }
  }

  fun encode(projectId: String, document: WorkspaceDraft): String {
    val scenes = JSONArray()
    document.scenes.forEach { scene ->
      val blocks = JSONArray()
      scene.blocks.forEach { block ->
        blocks.put(JSONObject().put("id", block.id).put("kind", block.kind.name)
          .put("speaker", block.speaker).put("text", block.text).put("source", block.source))
      }
      scenes.put(JSONObject().put("id", scene.id).put("name", scene.name).put("fileName", scene.fileName).put("blocks", blocks))
    }
    return JSONObject().put("version", 2).put("projectId", projectId).put("scenes", scenes).put("notes", document.notes).toString()
  }
}
