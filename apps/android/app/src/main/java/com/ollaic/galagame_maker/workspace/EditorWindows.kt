package com.ollaic.galagame_maker.workspace

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.SoftwareKeyboardController
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

@Stable
internal class KeyboardDismissGuard {
  var visible by mutableStateOf(false)
  var controller: SoftwareKeyboardController? = null

  fun consumeDismiss(): Boolean {
    if (!visible) return false
    controller?.hide()
    return true
  }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun BindKeyboardDismiss(guard: KeyboardDismissGuard) {
  // A floating dialog can have a visible IME with zero inset height.
  val visible = WindowInsets.isImeVisible
  val controller = LocalSoftwareKeyboardController.current
  SideEffect { guard.visible = visible; guard.controller = controller }
  BackHandler(enabled = visible) { controller?.hide() }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun EditorBottomSheet(onDismissRequest: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
  val keyboard = remember { KeyboardDismissGuard() }
  val state = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = { value ->
    value != SheetValue.Hidden || !keyboard.consumeDismiss()
  })
  ModalBottomSheet(onDismissRequest = { if (!keyboard.consumeDismiss()) onDismissRequest() }, sheetState = state) {
    BindKeyboardDismiss(keyboard)
    content()
  }
}

@Composable
internal fun EditorDialog(onDismissRequest: () -> Unit, properties: DialogProperties = DialogProperties(), content: @Composable () -> Unit) {
  val keyboard = remember { KeyboardDismissGuard() }
  Dialog(onDismissRequest = { if (!keyboard.consumeDismiss()) onDismissRequest() }, properties = properties) {
    BindKeyboardDismiss(keyboard)
    content()
  }
}
