package com.ollaic.galagame_maker.workspace

import org.junit.Assert.*
import org.junit.Test

class CommandDraftMergeTest {
  @Test fun disjointSourceChangesKeepBothEditsAndLineEndings() {
    assertEquals("setAnimation:my%20fade -target=draft; keep\r\n", mergeCommandSource(
      "setAnimation:my fade -target=fig; keep\r\n",
      "setAnimation:my fade -target=draft; keep\r\n",
      "setAnimation:my%20fade -target=fig; keep\r\n",
    ))
  }

  @Test fun insertionBoundariesAndEmptySourcesRemainStable() {
    assertEquals("aXc!", mergeCommandSource("abc", "abc!", "aXc"))
    assertEquals("!aXc", mergeCommandSource("abc", "!abc", "aXc"))
    assertEquals("latest", mergeCommandSource("", "", "latest"))
    assertEquals("draft", mergeCommandSource("base", "draft", "base"))
  }

  @Test fun overlappingChangesRequireAnExplicitChoice() {
    assertNull(mergeCommandSource("abc", "aXc", "aYc"))
    assertNull(mergeCommandSource("abc", "a!bc", "a?bc"))
    assertEquals("aXc", mergeCommandSource("abc", "aXc", "aXc"))
  }

  @Test fun sourceMergeKeepsNonAsciiText() {
    assertEquals("\u4f60\u597d!", mergeCommandSource("\u4f60a", "\u4f60a!", "\u4f60\u597d"))
  }
}
