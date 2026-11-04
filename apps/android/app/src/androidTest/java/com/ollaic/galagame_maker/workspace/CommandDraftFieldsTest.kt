package com.ollaic.galagame_maker.workspace

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.ollaic.core.CommandChoice
import com.ollaic.core.CommandKind
import com.ollaic.core.newCommand
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CommandDraftFieldsTest {
  @Test fun optionalFieldsCanBeSetAndClearedWithoutDroppingIncomingFields() {
    val before = newCommand(CommandKind.BGM)
    val edited = mergeCommandFields(before, before.copy(volume = 35), before.copy(asset = "new.ogg"))
    assertEquals(35, edited.volume)
    assertEquals("new.ogg", edited.asset)
    val cleared = mergeCommandFields(edited, edited.copy(volume = null), edited.copy(asset = "other.ogg"))
    assertNull(cleared.volume)
    assertEquals("other.ogg", cleared.asset)
  }

  @Test fun changedCollectionsAndCommandTypesRemainUserOwned() {
    val before = newCommand(CommandKind.CHOOSE).copy(choices = listOf(CommandChoice("Before", "start.txt")))
    val draft = before.copy(choices = listOf(CommandChoice("Draft", "next.txt")))
    val incoming = before.copy(next = true, `when` = "ready")
    val merged = mergeCommandFields(before, draft, incoming)
    assertEquals(draft.choices, merged.choices)
    assertTrue(merged.next)
    assertEquals("ready", merged.`when`)
    val replacement = newCommand(CommandKind.END)
    assertEquals(replacement, mergeCommandFields(before, replacement, incoming))
  }
}
