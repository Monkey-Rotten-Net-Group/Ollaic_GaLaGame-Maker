package com.ollaic.galagame_maker.workspace

import android.util.AtomicFile
import java.io.File
import java.io.FileNotFoundException
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

class WorkspaceDraftStore(private val directory: File) {
  private val lock = Mutex()

  private fun file(projectId: String): AtomicFile {
    val id = UUID.fromString(projectId).toString()
    require(id == projectId) { "Invalid project ID" }
    return AtomicFile(File(directory, "workspaces/$id/workspace.json"))
  }

  suspend fun load(projectId: String): WorkspaceDraft? = withContext(Dispatchers.IO) {
    lock.withLock {
      val bytes = try {
        file(projectId).readFully()
      } catch (_: FileNotFoundException) {
        return@withLock null
      }
      val root = JSONObject(bytes.toString(Charsets.UTF_8))
      require(root.getInt("version") == 1) { "Unsupported workspace version" }
      require(root.getString("projectId") == projectId) { "Workspace project mismatch" }
      val scenes = root.getJSONArray("scenes")
      WorkspaceDraft(
        scenes = List(scenes.length()) { index ->
          val scene = scenes.getJSONObject(index)
          val blocks = scene.getJSONArray("blocks")
          DraftScene(
            id = scene.getString("id"),
            name = scene.getString("name"),
            blocks = List(blocks.length()) { blockIndex ->
              val block = blocks.getJSONObject(blockIndex)
              ScriptBlock(
                id = block.getString("id"),
                kind = BlockKind.valueOf(block.getString("kind")),
                speaker = block.optString("speaker"),
                text = block.getString("text"),
              )
            },
          )
        },
        notes = root.optString("notes"),
      ).also { it.validate() }
    }
  }

  suspend fun delete(projectId: String) = withContext(Dispatchers.IO) {
    lock.withLock {
      val target = checkNotNull(file(projectId).baseFile.parentFile)
      check(!target.exists() || target.deleteRecursively()) { "Cannot delete workspace directory" }
    }
  }

  suspend fun save(projectId: String, document: WorkspaceDraft) = withContext(Dispatchers.IO) {
    lock.withLock {
      document.validate()
      val scenes = JSONArray()
      document.scenes.forEach { scene ->
        val blocks = JSONArray()
        scene.blocks.forEach { block ->
          blocks.put(JSONObject()
            .put("id", block.id)
            .put("kind", block.kind.name)
            .put("speaker", block.speaker)
            .put("text", block.text))
        }
        scenes.put(JSONObject().put("id", scene.id).put("name", scene.name).put("blocks", blocks))
      }
      val bytes = JSONObject()
        .put("version", 1)
        .put("projectId", projectId)
        .put("scenes", scenes)
        .put("notes", document.notes)
        .toString().toByteArray(Charsets.UTF_8)
      val target = file(projectId)
      check(target.baseFile.parentFile?.let { it.isDirectory || it.mkdirs() } == true) {
        "Cannot create workspace directory"
      }
      val stream = target.startWrite()
      try {
        stream.write(bytes)
        target.finishWrite(stream)
      } catch (error: Throwable) {
        target.failWrite(stream)
        throw error
      }
    }
  }
}
