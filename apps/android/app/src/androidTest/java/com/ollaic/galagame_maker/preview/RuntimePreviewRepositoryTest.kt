package com.ollaic.galagame_maker.preview

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RuntimePreviewRepositoryTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private lateinit var directory: File

  @Before fun prepare() { directory = File(context.cacheDir, "preview-repository-${UUID.randomUUID()}").also { check(it.mkdirs()) } }
  @After fun cleanUp() { directory.deleteRecursively() }

  private fun archive(version: String): ByteArray {
    val output = ByteArrayOutputStream()
    ZipOutputStream(output).use { zip ->
      for ((name, text) in mapOf(
        "index.html" to "<html><head></head><body>WebGAL test fixture</body></html>",
        "assets/engine.js" to "console.log('fixture')",
        "webgal-engine.json" to """{"webgalVersion":"$version"}""",
      )) {
        zip.putNextEntry(ZipEntry(name)); zip.write(text.toByteArray()); zip.closeEntry()
      }
    }
    return output.toByteArray()
  }

  @Test fun downloadsPinnedEngineAndPreservesItWhenAReplacementIsInvalid() = runBlocking {
    var payload = byteArrayOf()
    val repository = RuntimePreviewRepository(context, directory) { FakeConnection(it, payload) }
    payload = archive(repository.version)
    var transferred = 0L
    repository.download({ bytes, _ -> transferred = bytes }, {})
    assertTrue(repository.installed())
    assertEquals(payload.size.toLong(), transferred)
    val before = File(repository.engineDirectory, "index.html").readText()
    payload = archive("0.0.0")
    assertTrue(runCatching { repository.download({ _, _ -> }, {}) }.isFailure)
    assertTrue(repository.installed())
    assertEquals(before, File(repository.engineDirectory, "index.html").readText())
  }

  @Test fun rejectsUnsafeRedirectsAndOversizedDownloadsBeforeInstallation() = runBlocking {
    var redirect = true
    val repository = RuntimePreviewRepository(context, directory) { url ->
      FakeConnection(url, byteArrayOf(), if (redirect) 302 else 200,
        if (redirect) "http://example.com/engine.zip" else null,
        RuntimePreviewRepository.MAX_ARCHIVE_BYTES + 1)
    }
    assertTrue(runCatching { repository.download({ _, _ -> }, {}) }.exceptionOrNull()?.message.orEmpty().contains("destination"))
    redirect = false
    assertTrue(runCatching { repository.download({ _, _ -> }, {}) }.exceptionOrNull()?.message.orEmpty().contains("256 MiB"))
    assertFalse(repository.installed())
  }

  @Test fun cancellationRemovesTemporaryDownloadWithoutPublishingAnEngine() = runBlocking {
    val before = context.cacheDir.listFiles().orEmpty().filter { it.name.startsWith("webgal-download-") }.map { it.name }.toSet()
    var cancel: () -> Unit = {}
    val repository = RuntimePreviewRepository(context, directory) { url ->
      object : FakeConnection(url, ByteArray(1024)) {
        override fun getInputStream(): InputStream = object : ByteArrayInputStream(ByteArray(1024)) {
          override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            cancel()
            return super.read(buffer, offset, length)
          }
        }
      }
    }
    val job = launch(start = CoroutineStart.LAZY) { repository.download({ _, _ -> }, {}) }
    cancel = { job.cancel() }
    job.start(); job.join()
    assertTrue(job.isCancelled)
    assertFalse(repository.installed())
    val after = context.cacheDir.listFiles().orEmpty().filter { it.name.startsWith("webgal-download-") }.map { it.name }.toSet()
    assertEquals(before, after)
  }

  @Test fun cancellationInterruptsAnInFlightRead() = runBlocking {
    val reading = CountDownLatch(1)
    val disconnected = CountDownLatch(1)
    val repository = RuntimePreviewRepository(context, directory) { url ->
      object : FakeConnection(url, ByteArray(1024)) {
        override fun disconnect() { disconnected.countDown() }
        override fun getInputStream(): InputStream = object : InputStream() {
          override fun read() = -1
          override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            reading.countDown()
            check(disconnected.await(5, TimeUnit.SECONDS)) { "Cancellation did not close the connection" }
            return -1
          }
        }
      }
    }
    val job = launch(Dispatchers.Default) { repository.download({ _, _ -> }, {}) }
    assertTrue(reading.await(5, TimeUnit.SECONDS))
    job.cancel()
    withTimeout(5_000) { job.join() }
    assertTrue(job.isCancelled)
    assertFalse(repository.installed())
  }

  private open class FakeConnection(
    url: URL,
    private val payload: ByteArray,
    private val status: Int = 200,
    private val redirect: String? = null,
    private val declaredSize: Long = payload.size.toLong(),
  ) : HttpURLConnection(url) {
    override fun connect() {}
    override fun disconnect() {}
    override fun usingProxy() = false
    override fun getResponseCode() = status
    override fun getContentLengthLong() = declaredSize
    override fun getHeaderField(name: String?) = if (name == "Location") redirect else null
    override fun getInputStream(): InputStream = ByteArrayInputStream(payload)
  }
}
