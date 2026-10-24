package com.ollaic.galagame_maker

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import com.ollaic.galagame_maker.home.HomeDraftStore
import com.ollaic.galagame_maker.workspace.WorkspaceDraftStore

class NativeRepositories(application: Application) : AndroidViewModel(application) {
  val projects = HomeDraftStore(application.filesDir)
  val workspaces = WorkspaceDraftStore(application.filesDir)
}
