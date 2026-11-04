package com.ollaic.galagame_maker.workspace

import android.util.Base64
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.viewinterop.AndroidView
import com.ollaic.galagame_maker.R
import java.io.ByteArrayInputStream
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
internal fun SvgAssetPreview(file: File, modifier: Modifier) {
  var loading by remember(file.absolutePath, file.lastModified()) { mutableStateOf(true) }
  val encoded by produceState<String?>(null, file.absolutePath, file.lastModified()) {
    value = withContext(Dispatchers.IO) {
      runCatching { if (file.length() > 4 * 1024 * 1024) null else Base64.encodeToString(file.readBytes(), Base64.NO_WRAP) }.getOrNull()
    }
    loading = false
  }
  var webView by remember(file.absolutePath) { mutableStateOf<WebView?>(null) }
  Box(modifier, contentAlignment = Alignment.Center) {
    val svg = encoded
    if (svg != null) AndroidView(factory = { context ->
      WebView(context).apply {
        webView = this; contentDescription = file.name
        settings.javaScriptEnabled = false; settings.allowFileAccess = false; settings.allowContentAccess = false
        settings.blockNetworkLoads = true
        setBackgroundColor(android.graphics.Color.TRANSPARENT)
        webViewClient = object : WebViewClient() {
          override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?) = true
          override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? =
            if (request?.url?.scheme == "data") null else WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(byteArrayOf()))
        }
        loadDataWithBaseURL(null, "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body style='margin:0;height:100vh;display:flex;align-items:center;justify-content:center'><img style='width:100%;height:100%;object-fit:contain' src='data:image/svg+xml;base64,$svg'></body></html>", "text/html", "UTF-8", null)
      }
    }, modifier = Modifier.matchParentSize())
    else if (loading) CircularProgressIndicator()
    else Text(stringResource(R.string.workspace_unsupported_preview))
  }
  DisposableEffect(file.absolutePath) { onDispose { webView?.destroy() } }
}
