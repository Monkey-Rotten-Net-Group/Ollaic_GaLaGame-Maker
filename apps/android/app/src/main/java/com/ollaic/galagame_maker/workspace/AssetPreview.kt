package com.ollaic.galagame_maker.workspace

import android.media.MediaPlayer
import android.net.Uri
import android.widget.VideoView
import android.webkit.MimeTypeMap
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.ollaic.core.AssetInfo
import com.ollaic.galagame_maker.R
import java.io.File
import kotlinx.coroutines.delay

@Composable
internal fun AssetPreviewDialog(asset: AssetInfo, root: File, onDismiss: () -> Unit) {
  val file = File(root, "game/${asset.category}/${asset.name}")
  val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase())
  val category = if (asset.category == "reference") when {
    mime?.startsWith("audio/") == true -> "vocal"
    mime?.startsWith("video/") == true -> "video"
    else -> "reference"
  } else asset.category
  Dialog(onDismissRequest = onDismiss) {
    Surface(shape = MaterialTheme.shapes.small) {
      Column(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
          Text(asset.alias.ifBlank { asset.name }, Modifier.weight(1f).padding(16.dp), maxLines = 2, style = MaterialTheme.typography.titleSmall)
          IconButton(onClick = onDismiss) { Icon(Icons.Outlined.Close, stringResource(R.string.home_done)) }
        }
        when (category) {
          "background", "figure", "tex", "reference" -> AssetThumbnail(file, Modifier.fillMaxWidth().aspectRatio(1.4f), 1024)
          "bgm", "vocal" -> AudioPreview(file)
          "video" -> VideoPreview(file)
          else -> Text(stringResource(R.string.workspace_unsupported_preview), Modifier.padding(16.dp))
        }
      }
    }
  }
}

@Composable
private fun AudioPreview(file: File) {
  val player = remember(file.absolutePath) { MediaPlayer() }
  var ready by remember(file.absolutePath) { mutableStateOf(false) }
  var playing by remember(file.absolutePath) { mutableStateOf(false) }
  var duration by remember(file.absolutePath) { mutableStateOf(0) }
  var position by remember(file.absolutePath) { mutableStateOf(0) }
  var error by remember(file.absolutePath) { mutableStateOf(false) }
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  DisposableEffect(player, lifecycle) {
    player.setOnPreparedListener { duration = it.duration.coerceAtLeast(0); ready = true }
    player.setOnCompletionListener { playing = false; position = duration }
    player.setOnErrorListener { _, _, _ -> error = true; ready = false; playing = false; true }
    try { player.setDataSource(file.absolutePath); player.prepareAsync() } catch (_: Exception) { error = true }
    val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) { runCatching { if (ready) player.pause() }; playing = false } }
    lifecycle.addObserver(observer)
    onDispose { lifecycle.removeObserver(observer); player.release() }
  }
  LaunchedEffect(player, playing) { while (playing) { position = runCatching { player.currentPosition }.getOrDefault(0); delay(250) } }
  Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
    MediaPlaybackControls(ready, playing, position, duration, onToggle = {
        if (playing) player.pause() else { if (position >= duration) player.seekTo(0); player.start() }
        playing = !playing
      }, onSeek = { position = it; player.seekTo(position) })
    if (error) Text(stringResource(R.string.workspace_unsupported_preview), color = MaterialTheme.colorScheme.error)
  }
}

@Composable
private fun VideoPreview(file: File) {
  var video by remember(file.absolutePath) { mutableStateOf<VideoView?>(null) }
  var error by remember(file.absolutePath) { mutableStateOf(false) }
  var ready by remember(file.absolutePath) { mutableStateOf(false) }
  var playing by remember(file.absolutePath) { mutableStateOf(false) }
  var duration by remember(file.absolutePath) { mutableStateOf(0) }
  var position by remember(file.absolutePath) { mutableStateOf(0) }
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  AndroidView(modifier = Modifier.fillMaxWidth().aspectRatio(16f / 9f), factory = { context ->
    VideoView(context).apply {
      video = this
      setOnErrorListener { _, _, _ -> error = true; ready = false; playing = false; true }
      setOnCompletionListener { playing = false; position = duration }
      setVideoURI(Uri.fromFile(file))
      setOnPreparedListener { duration = it.duration.coerceAtLeast(0); ready = true; seekTo(1) }
    }
  })
  DisposableEffect(file.absolutePath, lifecycle) {
    val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) { video?.pause(); playing = false } }
    lifecycle.addObserver(observer)
    onDispose { lifecycle.removeObserver(observer); video?.stopPlayback() }
  }
  LaunchedEffect(video, playing) { while (playing) { position = video?.currentPosition ?: 0; delay(250) } }
  Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
    MediaPlaybackControls(ready, playing, position, duration, onToggle = {
      if (playing) video?.pause() else { if (position >= duration) video?.seekTo(0); video?.start() }
      playing = !playing
    }, onSeek = { position = it; video?.seekTo(position) })
  }
  if (error) Text(stringResource(R.string.workspace_unsupported_preview), Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error)
}

@Composable
private fun MediaPlaybackControls(ready: Boolean, playing: Boolean, position: Int, duration: Int,
  onToggle: () -> Unit, onSeek: (Int) -> Unit) {
  Row(verticalAlignment = Alignment.CenterVertically) {
    IconButton(enabled = ready, onClick = onToggle) {
      Icon(if (playing) Icons.Outlined.Pause else Icons.Outlined.PlayArrow, stringResource(if (playing) R.string.asset_pause else R.string.asset_play))
    }
    Text("${time(position)} / ${time(duration)}", style = MaterialTheme.typography.bodyMedium)
  }
  Slider(value = position.toFloat().coerceIn(0f, duration.coerceAtLeast(1).toFloat()), valueRange = 0f..duration.coerceAtLeast(1).toFloat(), enabled = ready,
    onValueChange = { onSeek(it.toInt()) })
}

private fun time(milliseconds: Int): String = "%d:%02d".format(milliseconds / 60000, milliseconds / 1000 % 60)
