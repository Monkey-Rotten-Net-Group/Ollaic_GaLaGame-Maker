package com.ollaic.galagame_maker.preview

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.graphics.Bitmap
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.ViewCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ollaic.galagame_maker.R
import java.io.ByteArrayInputStream
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RuntimePreviewScreen(projectName: String, model: RuntimePreviewViewModel, onClose: () -> Unit) {
  val state by model.state.collectAsStateWithLifecycle()
  val context = LocalContext.current
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  val scope = rememberCoroutineScope()
  var fullscreen by rememberSaveable { mutableStateOf(false) }
  var closing by remember { mutableStateOf(false) }
  var customView by remember { mutableStateOf<View?>(null) }
  var customCallback by remember { mutableStateOf<WebChromeClient.CustomViewCallback?>(null) }
  var webView by remember { mutableStateOf<WebView?>(null) }

  fun closeCustomView() { customCallback?.onCustomViewHidden(); customCallback = null; customView = null }
  fun exit() {
    if (closing) return
    closing = true
    webView?.stopLoading()
    webView?.loadUrl("about:blank")
    scope.launch { model.close(); onClose() }
  }
  BackHandler {
    when { customView != null -> closeCustomView(); fullscreen -> fullscreen = false; else -> exit() }
  }
  val import = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
    if (uri != null) model.importDocument(uri)
  }
  DisposableEffect(model, lifecycle) {
    val observer = LifecycleEventObserver { _, event ->
      when (event) {
        Lifecycle.Event.ON_START -> if (!closing && model.state.value.phase == PreviewPhase.Paused) model.open()
        Lifecycle.Event.ON_STOP -> {
          closeCustomView()
          webView?.let { releasePreviewWebView(it) }; webView = null
          model.pause()
        }
        else -> {}
      }
    }
    lifecycle.addObserver(observer)
    onDispose { lifecycle.removeObserver(observer); model.pause() }
  }
  LaunchedEffect(model) { model.open() }

  val view = LocalView.current
  val activity = context.activity()
  val controller = remember(activity, view) { activity?.window?.let { WindowCompat.getInsetsController(it, view) } }
  val previousBehavior = remember(controller) { controller?.systemBarsBehavior }
  val previousVisibility = remember(view) {
    val insets = ViewCompat.getRootWindowInsets(view)
    (insets?.isVisible(WindowInsetsCompat.Type.statusBars()) ?: true) to
      (insets?.isVisible(WindowInsetsCompat.Type.navigationBars()) ?: true)
  }
  LaunchedEffect(controller, fullscreen, customView != null) {
    if (fullscreen || customView != null) {
      controller?.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      controller?.hide(WindowInsetsCompat.Type.systemBars())
    } else {
      previousBehavior?.let { controller?.systemBarsBehavior = it }
      controller?.show(WindowInsetsCompat.Type.systemBars())
    }
  }
  DisposableEffect(controller) {
    onDispose {
      previousBehavior?.let { controller?.systemBarsBehavior = it }
      if (previousVisibility.first) controller?.show(WindowInsetsCompat.Type.statusBars()) else controller?.hide(WindowInsetsCompat.Type.statusBars())
      if (previousVisibility.second) controller?.show(WindowInsetsCompat.Type.navigationBars()) else controller?.hide(WindowInsetsCompat.Type.navigationBars())
    }
  }

  Scaffold(
    modifier = Modifier.fillMaxSize().testTag("runtime-preview"),
    topBar = {
      if (!fullscreen && customView == null) TopAppBar(
        title = { Column {
          Text(stringResource(R.string.preview_title), style = MaterialTheme.typography.titleMedium)
          Text(projectName, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        } },
        navigationIcon = { PreviewTool(Icons.AutoMirrored.Outlined.ArrowBack, R.string.preview_back, "preview-back", !closing, ::exit) },
        actions = {
          PreviewTool(Icons.Outlined.Refresh, R.string.preview_restart, "preview-restart", state.url != null && !closing) { model.open() }
          PreviewTool(Icons.Outlined.Fullscreen, R.string.preview_fullscreen, "preview-fullscreen", state.url != null) { fullscreen = true }
        },
      )
    },
  ) { padding ->
    Box(Modifier.fillMaxSize().padding(if (fullscreen || customView != null) PaddingValues() else padding)) {
      val url = state.url
      if (url != null) key(url) {
        AndroidView(factory = { parent ->
          createPreviewWebView(parent, url, model, onCustomView = { value, callback -> customView = value; customCallback = callback }).also { webView = it }
        }, modifier = Modifier.fillMaxSize(), onRelease = { releasePreviewWebView(it); if (webView === it) webView = null })
      }
      if (state.phase != PreviewPhase.Ready) Surface(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically)) {
          val status = when (state.phase) {
            PreviewPhase.Checking -> R.string.preview_checking
            PreviewPhase.NeedsEngine -> R.string.preview_engine_missing
            PreviewPhase.Downloading -> R.string.preview_downloading
            PreviewPhase.Installing -> R.string.preview_installing
            PreviewPhase.Paused -> R.string.preview_paused
            PreviewPhase.Error -> R.string.preview_failed
            else -> R.string.preview_loading
          }
          Text(stringResource(status), Modifier.testTag("preview-status"), style = MaterialTheme.typography.titleMedium)
          Text("WebGAL ${model.repository.version}", style = MaterialTheme.typography.bodySmall)
          if (state.phase == PreviewPhase.Error) Text(state.error.orEmpty(), Modifier.testTag("preview-error"), color = MaterialTheme.colorScheme.error)
          if (state.phase == PreviewPhase.Downloading) {
            val total = state.downloadSize
            Text(if (total == null) android.text.format.Formatter.formatShortFileSize(context, state.downloaded)
              else "${android.text.format.Formatter.formatShortFileSize(context, state.downloaded)} / ${android.text.format.Formatter.formatShortFileSize(context, total)}")
          }
          if (state.phase in listOf(PreviewPhase.Checking, PreviewPhase.Downloading, PreviewPhase.Installing, PreviewPhase.Loading)) CircularProgressIndicator()
          if (state.phase == PreviewPhase.Error) FilledTonalButton(onClick = model::open, enabled = !closing, modifier = Modifier.testTag("preview-retry")) {
            Icon(Icons.Outlined.Refresh, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.home_retry))
          }
          if (state.phase in listOf(PreviewPhase.NeedsEngine, PreviewPhase.Error)) {
            Button(onClick = model::download, enabled = !closing, modifier = Modifier.testTag("preview-download")) {
              Icon(Icons.Outlined.FileDownload, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.preview_download))
            }
            TextButton(onClick = { import.launch(arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream")) }, enabled = !closing, modifier = Modifier.testTag("preview-import")) {
              Icon(Icons.Outlined.FolderOpen, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.preview_import))
            }
          }
        }
      }
      if (state.phase == PreviewPhase.Ready) Box(Modifier.size(0.dp).testTag("preview-ready"))
      if (fullscreen && customView == null) PreviewFullscreenControls {
        PreviewTool(Icons.Outlined.FullscreenExit, R.string.preview_exit_fullscreen, "preview-exit-fullscreen", true) { fullscreen = false }
        PreviewTool(Icons.AutoMirrored.Outlined.ArrowBack, R.string.preview_back, "preview-back", !closing, ::exit)
      }
      customView?.let { custom -> AndroidView(factory = { (custom.parent as? ViewGroup)?.removeView(custom); custom }, modifier = Modifier.fillMaxSize()) }
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PreviewTool(icon: ImageVector, label: Int, tag: String, enabled: Boolean, action: () -> Unit) {
  val title = stringResource(label)
  TooltipBox(positionProvider = TooltipDefaults.rememberPlainTooltipPositionProvider(), tooltip = { PlainTooltip { Text(title) } }, state = rememberTooltipState()) {
    IconButton(onClick = action, enabled = enabled, modifier = Modifier.testTag(tag)) { Icon(icon, title) }
  }
}

internal fun createPreviewWebView(context: Context, url: String, model: RuntimePreviewViewModel,
  onCustomView: (View?, WebChromeClient.CustomViewCallback?) -> Unit = { _, _ -> },
): WebView = WebView(context).apply {
  // Chromium's wrap-content mode can force the CSS layout height to zero.
  layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
  val expected = Uri.parse(url)
  fun allowed(uri: Uri) = uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port == expected.port
  contentDescription = context.getString(R.string.preview_title)
  settings.javaScriptEnabled = true
  settings.domStorageEnabled = true
  settings.allowFileAccess = false
  settings.allowContentAccess = false
  settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
  settings.mediaPlaybackRequiresUserGesture = false
  settings.setSupportMultipleWindows(false)
  setBackgroundColor(android.graphics.Color.BLACK)
  webViewClient = object : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = !allowed(request.url)
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
      if (allowed(request.url)) return null
      return WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(byteArrayOf()))
    }
    override fun onPageStarted(view: WebView, page: String, favicon: Bitmap?) {
      if (page != url && page != "about:blank") model.pageFailed(url, context.getString(R.string.preview_navigation_blocked))
    }
    override fun onPageFinished(view: WebView, page: String) { if (page == url) model.pageLoaded(url) }
    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
      if (request.isForMainFrame) model.pageFailed(url, error.description.toString())
    }
    override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
      if (request.isForMainFrame) model.pageFailed(url, "HTTP ${response.statusCode}")
    }
    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
      releasePreviewWebView(view)
      model.pageFailed(url, context.getString(R.string.preview_renderer_failed))
      return true
    }
  }
  webChromeClient = object : WebChromeClient() {
    override fun onShowCustomView(view: View, callback: CustomViewCallback) { onCustomView(view, callback) }
    override fun onHideCustomView() { onCustomView(null, null) }
  }
  loadUrl(url)
}

private object ReleasedPreviewWebView

private fun releasePreviewWebView(view: WebView) {
  if (view.tag === ReleasedPreviewWebView) return
  view.tag = ReleasedPreviewWebView
  view.stopLoading()
  view.clearFocus()
  (view.parent as? ViewGroup)?.removeView(view)
  view.destroy()
}

private tailrec fun Context.activity(): Activity? = when (this) {
  is Activity -> this
  is ContextWrapper -> baseContext.activity()
  else -> null
}
