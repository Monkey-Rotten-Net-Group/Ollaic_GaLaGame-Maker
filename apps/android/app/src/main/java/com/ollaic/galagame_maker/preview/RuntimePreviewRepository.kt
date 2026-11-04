package com.ollaic.galagame_maker.preview

import android.content.Context
import android.os.SystemClock
import android.net.Uri
import com.ollaic.core.NativePreviewSession
import com.ollaic.core.installPreviewEngine
import com.ollaic.core.previewEngineInfo
import com.ollaic.core.previewEngineVersion
import com.ollaic.core.startPreviewSession
import com.ollaic.galagame_maker.DocumentFiles
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class RuntimePreviewRepository(
  context: Context,
  directory: File = File(context.filesDir, "runtime"),
  private val connectionFactory: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
) {
  val version: String = previewEngineVersion()
  val engineDirectory = File(directory, "webgal-$version")
  private val cache = context.applicationContext.cacheDir
  private val application = context.applicationContext

  suspend fun installed(): Boolean = withContext(Dispatchers.IO) {
    previewEngineInfo(engineDirectory.absolutePath).installed
  }

  suspend fun install(archive: File) = withContext(Dispatchers.IO + NonCancellable) {
    installPreviewEngine(archive.absolutePath, engineDirectory.absolutePath)
    Unit
  }

  suspend fun importDocument(uri: Uri) {
    DocumentFiles.read(application, uri, MAX_ARCHIVE_BYTES) { archive, _ -> install(archive) }
  }

  suspend fun download(onProgress: (Long, Long?) -> Unit, onDownloaded: () -> Unit) {
    val temporary = withContext(Dispatchers.IO) { File.createTempFile("webgal-download-", ".zip", cache) }
    try {
      downloadInto(temporary, onProgress)
      currentCoroutineContext().ensureActive()
      onDownloaded()
      install(temporary)
    } finally { withContext(Dispatchers.IO + NonCancellable) { temporary.delete() } }
  }

  private suspend fun downloadInto(output: File, onProgress: (Long, Long?) -> Unit) = withContext(Dispatchers.IO) {
    var url = URL("https://github.com/OpenWebGAL/WebGAL/releases/download/$version/WebGAL-$version-web.zip")
    val deadline = SystemClock.elapsedRealtime() + 180_000
    var redirects = 0
    while (true) {
      currentCoroutineContext().ensureActive()
      check(SystemClock.elapsedRealtime() < deadline) { "Engine download timed out" }
      val connection = connectionFactory(url)
      val cancellation = launch(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) {
        try { awaitCancellation() } finally { connection.disconnect() }
      }
      try {
        connection.connectTimeout = 15_000
        connection.readTimeout = 30_000
        connection.instanceFollowRedirects = false
        connection.useCaches = false
        val status = connection.responseCode
        if (status in listOf(301, 302, 303, 307, 308)) {
          check(redirects++ < 5) { "Too many engine download redirects" }
          val destination = URL(url, checkNotNull(connection.getHeaderField("Location")) { "Missing download redirect" })
          check(destination.protocol == "https" && (destination.host == "github.com" || destination.host.endsWith(".githubusercontent.com"))) {
            "Unexpected engine download destination"
          }
          url = destination
          continue
        }
        check(status == HttpURLConnection.HTTP_OK) { "Engine download returned HTTP $status" }
        val length = connection.contentLengthLong.takeIf { it >= 0 }
        check(length == null || length <= MAX_ARCHIVE_BYTES) { "Engine ZIP exceeds the 256 MiB limit" }
        onProgress(0, length)
        connection.inputStream.use { input -> output.outputStream().use { destination ->
          val buffer = ByteArray(64 * 1024)
          var total = 0L
          var reported = 0L
          while (true) {
            currentCoroutineContext().ensureActive()
            check(SystemClock.elapsedRealtime() < deadline) { "Engine download timed out" }
            val count = input.read(buffer)
            currentCoroutineContext().ensureActive()
            if (count < 0) break
            total += count
            check(total <= MAX_ARCHIVE_BYTES) { "Engine ZIP exceeds the 256 MiB limit" }
            destination.write(buffer, 0, count)
            if (total - reported >= 256 * 1024) { onProgress(total, length); reported = total }
          }
          check(total > 0 && (length == null || total == length)) { "Engine download is incomplete" }
          onProgress(total, length)
        } }
        break
      } finally { cancellation.cancel(); connection.disconnect() }
    }
  }

  fun start(project: File): NativePreviewSession = startPreviewSession(engineDirectory.absolutePath, project.absolutePath)

  companion object { const val MAX_ARCHIVE_BYTES = 256L * 1024 * 1024 }
}
