package com.ollaic.galagame_maker.home

data class HomeProject(
  val id: String,
  val name: String,
  val description: String,
  val lastModified: String,
  val sceneCount: Int,
  val favorite: Boolean,
  val deleted: Boolean,
  val draft: Boolean = true,
)

data class HomeSnapshot(
  val ready: Boolean = false,
  val projects: List<HomeProject> = emptyList(),
  val error: String = "",
  val canImport: Boolean = false,
)
