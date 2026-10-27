package com.ollaic.galagame_maker.workspace

import java.util.UUID

enum class BlockKind { Dialogue, Narration, Note, Command }

data class ScriptBlock(
  val id: String = UUID.randomUUID().toString(),
  val kind: BlockKind,
  val speaker: String = "",
  val text: String,
  val source: String? = null,
  val command: String = "raw",
  val preview: String? = null,
) {
  val isBlankLine: Boolean get() = kind == BlockKind.Command && text.isBlank()
}

data class DraftScene(
  val id: String = UUID.randomUUID().toString(),
  val name: String,
  val blocks: List<ScriptBlock> = emptyList(),
  val fileName: String = "",
) {
  val visibleBlocks: List<ScriptBlock> get() = blocks.filterNot { it.isBlankLine }
}

data class WorkspaceDraft(
  val scenes: List<DraftScene>,
  val notes: String = "",
) {
  fun validate() {
    require(scenes.isNotEmpty()) { "A workspace must contain a scene" }
    require(scenes.map { it.id }.distinct().size == scenes.size) { "Duplicate scene IDs" }
    scenes.forEach { scene ->
      require(scene.id.isNotBlank() && scene.name.isNotBlank()) { "Invalid scene" }
      require(scene.blocks.map { it.id }.distinct().size == scene.blocks.size) { "Duplicate block IDs" }
      require(scene.blocks.all { it.id.isNotBlank() && (it.source != null || it.kind == BlockKind.Command || it.text.isNotBlank()) }) { "Invalid script block" }
    }
  }
}

data class WorkspaceHistory(
  val current: WorkspaceDraft,
  private val past: List<WorkspaceDraft> = emptyList(),
  private val future: List<WorkspaceDraft> = emptyList(),
) {
  val canUndo: Boolean get() = past.isNotEmpty()
  val canRedo: Boolean get() = future.isNotEmpty()

  fun edit(document: WorkspaceDraft): WorkspaceHistory = if (document == current) this else {
    document.validate()
    WorkspaceHistory(document, (past + current).takeLast(50))
  }

  fun undo(): WorkspaceHistory = if (!canUndo) this else {
    WorkspaceHistory(past.last(), past.dropLast(1), listOf(current) + future)
  }

  fun redo(): WorkspaceHistory = if (!canRedo) this else {
    WorkspaceHistory(future.first(), (past + current).takeLast(50), future.drop(1))
  }
}
