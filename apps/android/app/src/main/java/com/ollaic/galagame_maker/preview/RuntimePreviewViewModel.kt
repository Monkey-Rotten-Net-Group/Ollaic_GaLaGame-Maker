package com.ollaic.galagame_maker.preview

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import android.net.Uri
import com.ollaic.core.NativePreviewSession
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

enum class PreviewPhase { Checking, NeedsEngine, Downloading, Installing, Loading, Ready, Paused, Error }

data class RuntimePreviewState(
  val phase: PreviewPhase = PreviewPhase.Checking,
  val url: String? = null,
  val error: String? = null,
  val downloaded: Long = 0,
  val downloadSize: Long? = null,
)

class RuntimePreviewViewModel(
  val repository: RuntimePreviewRepository,
  private val project: File,
) : ViewModel() {
  private val mutable = MutableStateFlow(RuntimePreviewState())
  val state = mutable.asStateFlow()
  private var operation: Job? = null
  private val taskLock = Mutex()
  private val session = AtomicReference<NativePreviewSession?>()
  private val cleared = AtomicBoolean(false)
  private var loadedUrl: String? = null

  private fun run(phase: PreviewPhase, action: suspend () -> Unit) {
    operation?.cancel()
    mutable.value = RuntimePreviewState(phase)
    loadedUrl = null
    operation = viewModelScope.launch {
      taskLock.withLock {
        release()
        try { action() } catch (error: Exception) {
          if (error is CancellationException) throw error
          release()
          mutable.value = RuntimePreviewState(PreviewPhase.Error, error = error.message ?: error.javaClass.simpleName)
        }
      }
    }
  }

  fun open() = run(PreviewPhase.Checking) {
    if (repository.installed()) load() else mutable.value = RuntimePreviewState(PreviewPhase.NeedsEngine)
  }

  fun download() = run(PreviewPhase.Downloading) {
    val task = currentCoroutineContext()[Job]
    repository.download({ downloaded, size ->
      mutable.update { if (task?.isActive == true && it.phase == PreviewPhase.Downloading)
        RuntimePreviewState(PreviewPhase.Downloading, downloaded = downloaded, downloadSize = size) else it }
    }, { mutable.update { if (task?.isActive == true && it.phase == PreviewPhase.Downloading) RuntimePreviewState(PreviewPhase.Installing) else it } })
    currentCoroutineContext().ensureActive()
    load()
  }

  fun importDocument(uri: Uri) = run(PreviewPhase.Installing) {
    repository.importDocument(uri)
    currentCoroutineContext().ensureActive()
    load()
  }

  private suspend fun load() {
    mutable.value = RuntimePreviewState(PreviewPhase.Loading)
    val native = withContext(Dispatchers.IO + NonCancellable) {
      repository.start(project).also {
        session.set(it)
        if (cleared.get()) session.getAndSet(null)?.release()
      }
    }
    currentCoroutineContext().ensureActive()
    val url = native.url()
    mutable.value = RuntimePreviewState(PreviewPhase.Loading, url = url)
    val ready = withTimeoutOrNull(30_000) {
      while (loadedUrl != url || !native.isReady()) delay(100)
      true
    }
    check(ready == true) { "WebGAL did not become ready within 30 seconds" }
    native.begin()
    mutable.value = RuntimePreviewState(PreviewPhase.Ready, url = url)
    var disconnected = 0
    while (true) {
      delay(1_000)
      disconnected = if (native.isReady()) 0 else disconnected + 1
      check(disconnected < 5) { "WebGAL connection was closed" }
    }
  }

  fun pageLoaded(url: String) { if (mutable.value.url == url) loadedUrl = url }

  fun pageFailed(url: String, message: String) {
    if (mutable.value.url != url) return
    run(PreviewPhase.Error) { mutable.value = RuntimePreviewState(PreviewPhase.Error, error = message) }
  }

  fun pause() {
    operation?.cancel()
    mutable.value = RuntimePreviewState(PreviewPhase.Paused)
    viewModelScope.launch { taskLock.withLock { release() } }
  }

  suspend fun close() {
    operation?.cancelAndJoin()
    taskLock.withLock { release() }
    mutable.value = RuntimePreviewState(PreviewPhase.Paused)
  }

  private suspend fun release() = withContext(Dispatchers.IO + NonCancellable) {
    session.getAndSet(null)?.release()
  }

  override fun onCleared() {
    cleared.set(true)
    session.getAndSet(null)?.let { native -> thread(name = "preview-close", isDaemon = true) { native.release() } }
  }

  class Factory(private val repository: RuntimePreviewRepository, private val project: File) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
      require(modelClass.isAssignableFrom(RuntimePreviewViewModel::class.java))
      return RuntimePreviewViewModel(repository, project) as T
    }
  }
}

private fun NativePreviewSession.release() {
  try { stop() } finally { close() }
}
