package com.ollaic.galagame_maker.workspace

import com.ollaic.core.CommandEdit
import org.json.JSONObject

internal fun mergeCommandFields(before: CommandEdit, draft: CommandEdit, incoming: CommandEdit): CommandEdit {
  if (draft.kind != before.kind) return draft
  val base = commandEditJson(before)
  val local = commandEditJson(draft)
  val merged = commandEditJson(incoming)
  (base.keys().asSequence() + local.keys().asSequence()).toSet().forEach { key ->
    if (local.opt(key)?.toString() != base.opt(key)?.toString()) merged.put(key, local.opt(key) ?: JSONObject.NULL)
  }
  return commandEditFromJson(merged)
}

private data class SourceChange(val start: Int, val end: Int, val replacement: String)

private fun sourceChange(before: String, after: String): SourceChange {
  val prefix = before.commonPrefixWith(after).length
  val suffix = before.substring(prefix).commonSuffixWith(after.substring(prefix)).length
  return SourceChange(prefix, before.length - suffix, after.substring(prefix, after.length - suffix))
}

internal fun mergeCommandSource(before: String, draft: String, incoming: String): String? {
  if (draft == before || draft == incoming) return incoming
  if (incoming == before) return draft
  val local = sourceChange(before, draft)
  val project = sourceChange(before, incoming)
  if (local.start == project.start && local.end == local.start && project.end == project.start) return null
  if (local.end > project.start && project.end > local.start) return null
  // Apply disjoint changes from right to left so offsets stay relative to the common base.
  return listOf(local, project)
    .sortedWith(compareByDescending<SourceChange> { it.start }.thenByDescending { it.end })
    .fold(before) { source, change -> source.replaceRange(change.start, change.end, change.replacement) }
}
