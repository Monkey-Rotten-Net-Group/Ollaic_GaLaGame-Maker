package com.ollaic.galagame_maker.workspace

import org.junit.Assert.*
import org.junit.Test

class WorkspaceHistoryTest {
  private val initial = WorkspaceDraft(listOf(DraftScene(name = "Start")))

  @Test fun undoRedoAndBranchingPreserveDocuments() {
    val second = initial.copy(notes = "Second")
    val third = second.copy(notes = "Third")
    val edited = WorkspaceHistory(initial).edit(second).edit(third)
    assertEquals(second, edited.undo().current)
    assertEquals(third, edited.undo().redo().current)
    val branched = edited.undo().edit(second.copy(notes = "Alternative"))
    assertFalse(branched.canRedo)
    assertEquals(second, branched.undo().current)
    assertEquals(initial, branched.undo().undo().current)
  }

  @Test fun noOpDoesNotConsumeHistoryAndHistoryIsBounded() {
    val history = WorkspaceHistory(initial)
    assertSame(history, history.edit(initial))
    var edited = history
    repeat(80) { edited = edited.edit(initial.copy(notes = it.toString())) }
    var count = 0
    while (edited.canUndo) { edited = edited.undo(); count++ }
    assertEquals(50, count)
  }
}
