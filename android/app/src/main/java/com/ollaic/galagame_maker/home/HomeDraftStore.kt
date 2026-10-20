package com.ollaic.galagame_maker.home

import android.util.AtomicFile
import java.io.File
import java.io.FileNotFoundException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

// UI drafts are separate from WebGAL project files and the future Rust adapter.
class HomeDraftStore(directory: File) {
  private val file = AtomicFile(File(directory, "native-home-drafts.json"))
  private val lock = Mutex()

  suspend fun load(): List<HomeProject> = withContext(Dispatchers.IO) {
    lock.withLock { read() }
  }

  suspend fun update(transform: (List<HomeProject>) -> List<HomeProject>): List<HomeProject> =
    withContext(Dispatchers.IO) {
      lock.withLock {
        val projects = transform(read())
        val records = JSONArray()
        projects.forEach { project ->
          records.put(JSONObject()
            .put("id", project.id)
            .put("name", project.name)
            .put("description", project.description)
            .put("lastModified", project.lastModified)
            .put("favorite", project.favorite)
            .put("deleted", project.deleted))
        }
        val bytes = JSONObject().put("version", 1).put("projects", records)
          .toString().toByteArray(Charsets.UTF_8)
        val stream = file.startWrite()
        try {
          stream.write(bytes)
          file.finishWrite(stream)
        } catch (error: Throwable) {
          file.failWrite(stream)
          throw error
        }
        projects
      }
    }

  private fun read(): List<HomeProject> {
    val bytes = try {
      file.readFully()
    } catch (_: FileNotFoundException) {
      return emptyList()
    }
    val root = JSONObject(bytes.toString(Charsets.UTF_8))
    require(root.getInt("version") == 1) { "Unsupported draft library version" }
    val records = root.getJSONArray("projects")
    return buildList {
      for (index in 0 until records.length()) {
        val record = records.getJSONObject(index)
        val id = record.getString("id")
        val name = record.getString("name")
        require(id.isNotBlank() && name.isNotBlank()) { "Invalid project draft" }
        add(HomeProject(
          id = id,
          name = name,
          description = record.optString("description"),
          lastModified = record.optString("lastModified"),
          sceneCount = 0,
          favorite = record.optBoolean("favorite"),
          deleted = record.optBoolean("deleted"),
        ))
      }
    }
  }
}
