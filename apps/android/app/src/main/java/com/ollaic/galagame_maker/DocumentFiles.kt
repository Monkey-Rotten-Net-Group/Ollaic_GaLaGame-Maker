package com.ollaic.galagame_maker

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

object DocumentFiles {
  const val MAX_BYTES = 512L * 1024 * 1024

  suspend fun <T> read(context: Context, uri: Uri, maxBytes: Long = MAX_BYTES, consume: suspend (File, String) -> T): T = withContext(Dispatchers.IO) {
    val name = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) cursor.getString(0) else null
    } ?: uri.lastPathSegment.orEmpty()
    val temporary = File.createTempFile("ollaic-import-", ".tmp", context.cacheDir)
    try {
      val input = checkNotNull(context.contentResolver.openInputStream(uri)) { "Cannot open selected document" }
      input.use { source -> temporary.outputStream().use { output ->
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
          currentCoroutineContext().ensureActive()
          val count = source.read(buffer)
          if (count < 0) break
          total += count
          check(total <= maxBytes) { "Selected document exceeds the size limit" }
          output.write(buffer, 0, count)
        }
      } }
      consume(temporary, name)
    } finally { temporary.delete() }
  }

  suspend fun <T> write(context: Context, uri: Uri, produce: suspend (File) -> T): T = withContext(Dispatchers.IO + NonCancellable) {
    val temporary = File.createTempFile("ollaic-export-", ".tmp", context.cacheDir)
    try {
      val result = produce(temporary)
      val stream = checkNotNull(context.contentResolver.openOutputStream(uri, "wt")) { "Cannot open export destination" }
      stream.use { output -> temporary.inputStream().use { it.copyTo(output) } }
      result
    } finally { temporary.delete() }
  }
}
