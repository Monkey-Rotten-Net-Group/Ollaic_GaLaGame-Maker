package com.ollaic.galagame_maker

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.ollaic.galagame_maker.home.HomeDraftStore
import com.ollaic.galagame_maker.home.NativeHomeApp
import com.ollaic.galagame_maker.home.OllaicTheme

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val drafts = HomeDraftStore(filesDir)
    setContent {
      OllaicTheme { NativeHomeApp(drafts) }
    }
  }
}
