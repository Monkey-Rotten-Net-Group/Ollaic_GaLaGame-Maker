package com.ollaic.galagame_maker.home

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ViewList
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.ollaic.galagame_maker.BuildConfig
import com.ollaic.galagame_maker.R
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.Calendar

private enum class LibraryFilter(val title: Int, val icon: ImageVector, val emptyTitle: Int) {
  All(R.string.home_all, Icons.Outlined.Folder, R.string.home_empty),
  Recent(R.string.home_recent, Icons.Outlined.Schedule, R.string.home_empty_recent),
  Favorites(R.string.home_favorites, Icons.Outlined.StarOutline, R.string.home_empty_favorites),
  Trash(R.string.home_trash, Icons.Outlined.DeleteOutline, R.string.home_empty_trash),
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NativeHomeScreen(snapshot: HomeSnapshot, onAction: (String, String?) -> Unit) {
  var query by rememberSaveable { mutableStateOf("") }
  var filter by rememberSaveable { mutableStateOf(LibraryFilter.All) }
  var grid by rememberSaveable { mutableStateOf(false) }
  var menuOpen by remember { mutableStateOf(false) }
  var aboutOpen by remember { mutableStateOf(false) }
  val createLabel = stringResource(R.string.home_create)
  val focus = LocalFocusManager.current
  val projects = remember(snapshot.projects, filter, query) {
    val candidates = when (filter) {
      LibraryFilter.All -> snapshot.projects.filter { !it.deleted }
      LibraryFilter.Recent -> snapshot.projects.filter { !it.deleted }.take(5)
      LibraryFilter.Favorites -> snapshot.projects.filter { !it.deleted && it.favorite }
      LibraryFilter.Trash -> snapshot.projects.filter { it.deleted }
    }
    candidates.filter {
      it.name.contains(query.trim(), ignoreCase = true) ||
        it.description.contains(query.trim(), ignoreCase = true)
    }
  }
  Scaffold(
    modifier = Modifier.fillMaxSize().imePadding(),
    containerColor = MaterialTheme.colorScheme.background,
    topBar = {
      TopAppBar(
        title = {
          Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(Icons.Outlined.AutoStories, null, tint = OllaicPink, modifier = Modifier.size(26.dp))
            Text("Ollaic", fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
          }
        },
        actions = {
          Box {
            IconButton(onClick = { menuOpen = true }) {
              Icon(Icons.Outlined.MoreVert, stringResource(R.string.home_more))
            }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
              DropdownMenuItem(
                text = { Text(stringResource(R.string.home_about)) },
                leadingIcon = { Icon(Icons.Outlined.Info, null) },
                onClick = { menuOpen = false; aboutOpen = true },
              )
            }
          }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
      )
    },
    bottomBar = {
      if (snapshot.ready) Row(
        modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 20.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.End,
      ) {
        ExtendedFloatingActionButton(
          modifier = Modifier.semantics { contentDescription = createLabel },
          onClick = {
            filter = LibraryFilter.All
            query = ""
            focus.clearFocus()
            onAction("create", null)
          },
          icon = { Icon(Icons.Outlined.Add, null) },
          text = { Text(createLabel) },
          containerColor = MaterialTheme.colorScheme.primary,
          contentColor = MaterialTheme.colorScheme.onPrimary,
        )
      }
    },
  ) { padding ->
    LazyVerticalGrid(
      columns = if (grid) GridCells.Adaptive(160.dp) else GridCells.Fixed(1),
      modifier = Modifier.fillMaxSize().padding(padding),
      contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 16.dp),
      horizontalArrangement = Arrangement.spacedBy(12.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      item(span = { GridItemSpan(maxLineSpan) }) {
        Column(Modifier.padding(top = 8.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
          Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(6.dp).background(MaterialTheme.colorScheme.tertiary, RoundedCornerShape(1.dp)))
            Text(
              remember { SimpleDateFormat("yyyy.MM.dd", Locale.getDefault()).format(Date()) },
              style = MaterialTheme.typography.labelMedium.copy(fontFamily = FontFamily.Monospace),
              color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
          }
          Text(greeting(), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        }
      }
      item(span = { GridItemSpan(maxLineSpan) }) {
        OutlinedTextField(
          value = query,
          onValueChange = { query = it },
          modifier = Modifier.fillMaxWidth(),
          placeholder = { Text(stringResource(R.string.home_search)) },
          leadingIcon = { Icon(Icons.Outlined.Search, null) },
          trailingIcon = {
            if (query.isNotEmpty()) IconButton(onClick = { query = "" }) {
              Icon(Icons.Outlined.Close, stringResource(R.string.home_clear_search))
            }
          },
          singleLine = true,
          keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
          keyboardActions = KeyboardActions(onSearch = { focus.clearFocus() }),
          colors = OutlinedTextFieldDefaults.colors(
            unfocusedBorderColor = MaterialTheme.colorScheme.outlineVariant,
            unfocusedContainerColor = MaterialTheme.colorScheme.surface,
            focusedContainerColor = MaterialTheme.colorScheme.surface,
          ),
        )
      }
      item(span = { GridItemSpan(maxLineSpan) }) {
        Row(
          modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
          horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          LibraryFilter.entries.forEach { value ->
            FilterChip(
              selected = filter == value,
              onClick = { filter = value; focus.clearFocus() },
              label = { Text(stringResource(value.title)) },
              leadingIcon = { Icon(value.icon, null, Modifier.size(16.dp)) },
            )
          }
        }
      }
      if (snapshot.error.isNotBlank()) item(span = { GridItemSpan(maxLineSpan) }) {
        Row(
          modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.errorContainer).padding(12.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Icon(Icons.Outlined.ErrorOutline, null, tint = MaterialTheme.colorScheme.error)
          Text(snapshot.error, Modifier.weight(1f).padding(horizontal = 8.dp), style = MaterialTheme.typography.bodySmall)
          if (!snapshot.ready) IconButton(onClick = { onAction("retry", null) }) {
            Icon(Icons.Outlined.Refresh, stringResource(R.string.home_retry))
          }
          IconButton(onClick = { onAction("dismissError", null) }) {
            Icon(Icons.Outlined.Close, stringResource(R.string.home_dismiss))
          }
        }
      }
      item(span = { GridItemSpan(maxLineSpan) }) {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
          Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.home_library), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text(stringResource(R.string.home_project_count, projects.size), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
          IconButton(onClick = { grid = !grid }) {
            Icon(
              if (grid) Icons.AutoMirrored.Outlined.ViewList else Icons.Outlined.GridView,
              stringResource(if (grid) R.string.home_list_view else R.string.home_grid_view),
            )
          }
          TextButton(onClick = {
            filter = LibraryFilter.All
            query = ""
            focus.clearFocus()
            onAction("import", null)
          }, enabled = snapshot.ready && snapshot.canImport) {
            Icon(Icons.Outlined.FileDownload, null, Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text(stringResource(R.string.home_import))
          }
        }
      }
      when {
        !snapshot.ready && snapshot.error.isEmpty() -> item(span = { GridItemSpan(maxLineSpan) }) {
          Box(Modifier.fillMaxWidth().height(220.dp), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp)
          }
        }
        projects.isEmpty() -> item(span = { GridItemSpan(maxLineSpan) }) {
          Column(
            modifier = Modifier.fillMaxWidth().heightIn(min = 240.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
          ) {
            Icon(
              if (query.isNotBlank()) Icons.Outlined.SearchOff else filter.icon,
              null,
              modifier = Modifier.size(56.dp),
              tint = MaterialTheme.colorScheme.secondary.copy(alpha = 0.55f),
            )
            Spacer(Modifier.height(16.dp))
            Text(stringResource(if (query.isNotBlank()) R.string.home_no_results else filter.emptyTitle), style = MaterialTheme.typography.titleMedium)
            if (query.isNotBlank()) TextButton(onClick = { query = "" }) {
              Text(stringResource(R.string.home_clear_search))
            }
          }
        }
        else -> items(projects, key = { it.id }) { project ->
          ProjectItem(project, grid, onAction)
        }
      }
    }
  }
  if (aboutOpen) AlertDialog(
    onDismissRequest = { aboutOpen = false },
    icon = { Icon(Icons.Outlined.AutoStories, null, tint = OllaicPink) },
    title = { Text("Ollaic") },
    text = { Text(BuildConfig.VERSION_NAME) },
    confirmButton = { TextButton(onClick = { aboutOpen = false }) { Text(stringResource(R.string.home_done)) } },
  )
}

@Composable
private fun greeting(): String {
  val hour = remember { Calendar.getInstance().get(Calendar.HOUR_OF_DAY) }
  return stringResource(when (hour) {
    in 5..10 -> R.string.home_morning
    in 11..13 -> R.string.home_noon
    in 14..17 -> R.string.home_afternoon
    else -> R.string.home_evening
  })
}

@Composable
private fun ProjectItem(project: HomeProject, grid: Boolean, onAction: (String, String?) -> Unit) {
  val colors = MaterialTheme.colorScheme
  val tint = when (Math.floorMod(project.id.hashCode(), 3)) {
    0 -> colors.primary
    1 -> colors.secondary
    else -> colors.tertiary
  }
  Card(
    onClick = { if (!project.deleted) onAction("open", project.id) },
    modifier = Modifier.fillMaxWidth(),
    shape = RoundedCornerShape(8.dp),
    colors = CardDefaults.cardColors(containerColor = colors.surface),
    border = BorderStroke(1.dp, colors.outlineVariant),
  ) {
    if (grid) {
      Column(Modifier.padding(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
          ProjectIcon(tint)
          Spacer(Modifier.weight(1f))
          ProjectMenu(project, onAction)
        }
        Spacer(Modifier.height(16.dp))
        Text(project.name, style = MaterialTheme.typography.titleMedium, minLines = 2, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(project.description, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant, minLines = 2, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.height(8.dp))
        HorizontalDivider(color = colors.outlineVariant)
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
          Text(projectStatus(project), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
          FavoriteButton(project, onAction)
        }
      }
    } else {
      Row(Modifier.padding(start = 14.dp, top = 10.dp, end = 4.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        ProjectIcon(tint)
        Column(Modifier.weight(1f).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
          Text(project.name, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
          if (project.description.isNotBlank()) Text(project.description, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
          Text(projectStatus(project), style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
          FavoriteButton(project, onAction)
          ProjectMenu(project, onAction)
        }
      }
    }
  }
}

@Composable
private fun projectStatus(project: HomeProject): String = if (project.draft && project.sceneCount == 0) {
  stringResource(R.string.home_draft)
} else {
  stringResource(R.string.home_scene_count, project.sceneCount)
}

@Composable
private fun ProjectIcon(tint: Color) {
  Box(Modifier.size(44.dp).background(tint.copy(alpha = 0.10f), RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
    Icon(Icons.Outlined.AutoStories, null, tint = tint, modifier = Modifier.size(24.dp))
  }
}

@Composable
private fun FavoriteButton(project: HomeProject, onAction: (String, String?) -> Unit) {
  if (!project.deleted) IconButton(onClick = { onAction("favorite", project.id) }) {
    Icon(
      if (project.favorite) Icons.Outlined.Star else Icons.Outlined.StarOutline,
      stringResource(if (project.favorite) R.string.home_unfavorite else R.string.home_favorite),
      tint = if (project.favorite) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
      modifier = Modifier.size(20.dp),
    )
  }
}

@Composable
private fun ProjectMenu(project: HomeProject, onAction: (String, String?) -> Unit) {
  var expanded by remember { mutableStateOf(false) }
  Box {
    IconButton(onClick = { expanded = true }) {
      Icon(Icons.Outlined.MoreVert, stringResource(R.string.home_project_actions), Modifier.size(20.dp))
    }
    DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
      if (project.deleted) {
        DropdownMenuItem(
          text = { Text(stringResource(R.string.home_restore)) },
          leadingIcon = { Icon(Icons.Outlined.RestoreFromTrash, null) },
          onClick = { expanded = false; onAction("restore", project.id) },
        )
        DropdownMenuItem(
          text = { Text(stringResource(R.string.home_remove)) },
          leadingIcon = { Icon(Icons.Outlined.DeleteForever, null) },
          onClick = { expanded = false; onAction("remove", project.id) },
        )
      } else {
        DropdownMenuItem(
          text = { Text(stringResource(R.string.home_edit)) },
          leadingIcon = { Icon(Icons.Outlined.Edit, null) },
          onClick = { expanded = false; onAction("edit", project.id) },
        )
        DropdownMenuItem(
          text = { Text(stringResource(R.string.home_move_to_trash)) },
          leadingIcon = { Icon(Icons.Outlined.DeleteOutline, null) },
          onClick = { expanded = false; onAction("delete", project.id) },
        )
      }
    }
  }
}

@Preview(showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun HomePreview() {
  OllaicTheme { NativeHomeScreen(HomeSnapshot(ready = true)) { _, _ -> } }
}
