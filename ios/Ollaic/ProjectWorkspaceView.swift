import SwiftUI

private enum WorkspaceTab: String, CaseIterable, Identifiable {
    case script, scenes, assets, project
    var id: String { rawValue }
    var title: String {
        switch self {
        case .script: String(localized: "Script")
        case .scenes: String(localized: "Scenes")
        case .assets: String(localized: "Assets")
        case .project: String(localized: "Project")
        }
    }
    var symbol: String {
        switch self {
        case .script: "text.alignleft"
        case .scenes: "doc.on.doc"
        case .assets: "photo.on.rectangle"
        case .project: "folder"
        }
    }
}

private enum WorkspaceSheet: Identifiable {
    case entry(UUID, ScriptEntry?, ScriptKind), scene(DraftScene?), notes, project

    var id: String {
        switch self {
        case .entry(let scene, let entry, let kind): "entry-\(scene)-\(entry?.id.uuidString ?? kind.rawValue)"
        case .scene(let scene): "scene-\(scene?.id.uuidString ?? "new")"
        case .notes: "notes"
        case .project: "project"
        }
    }
}

@MainActor
struct ProjectWorkspaceView: View {
    @Environment(ProjectLibrary.self) private var library
    @Environment(\.horizontalSizeClass) private var sizeClass
    let projectID: UUID
    @State private var tab: WorkspaceTab = .script
    @State private var selectedSceneID: UUID?
    @State private var selectedEntryID: UUID?
    @State private var sheet: WorkspaceSheet?
    @State private var deletingScene: DraftScene?
    @State private var loadError: String?
    @State private var actionError: String?

    private var project: LocalProject? { library.project(projectID) }
    private var draft: WorkspaceDraft? { project?.workspace }
    private var activeScene: DraftScene? {
        draft?.scenes.first { $0.id == selectedSceneID } ?? draft?.scenes.first
    }

    var body: some View {
        Group {
            if project == nil || project?.isDeleted == true {
                ContentUnavailableView("Project Unavailable", systemImage: "folder.badge.questionmark")
            } else if let loadError {
                ContentUnavailableView {
                    Label("Couldn't Load Editor", systemImage: "exclamationmark.triangle")
                } description: { Text(loadError) } actions: {
                    Button("Retry") { Task { await open() } }
                }
            } else if let draft {
                VStack(spacing: 0) {
                    if sizeClass == .regular {
                        HStack {
                            Picker("Workspace", selection: $tab) {
                                ForEach(WorkspaceTab.allCases) { Text($0.title).tag($0) }
                            }
                            .pickerStyle(.segmented)
                            .frame(maxWidth: 480)
                            .accessibilityIdentifier("workspace-tabs")
                            Spacer(minLength: 16)
                            saveState
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        Divider()
                        HStack(spacing: 0) {
                            if tab == .script {
                                scenesPanel(draft)
                                    .frame(width: 220)
                                Divider()
                            }
                            panel(tab, draft: draft)
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    } else {
                        TabView(selection: $tab) {
                            ForEach(WorkspaceTab.allCases) { item in
                                panel(item, draft: draft)
                                    .tabItem { Label(item.title, systemImage: item.symbol) }
                                    .tag(item)
                            }
                        }
                    }
                }
                .disabled(library.isSaving)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle(project?.name ?? String(localized: "Editor"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Preview", systemImage: "play") {}.disabled(true).help("Preview")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Project Settings", systemImage: "slider.horizontal.3") { sheet = .project }
                    Button("Writing Notes", systemImage: "note.text") { sheet = .notes }
                    Divider()
                    Button("AI Assistant", systemImage: "sparkles") {}.disabled(true)
                    Button("Export", systemImage: "square.and.arrow.up") {}.disabled(true)
                } label: { Label("Project Actions", systemImage: "ellipsis.circle") }
                .disabled(draft == nil || library.isSaving)
                .accessibilityIdentifier("workspace-options")
            }
        }
        .task(id: projectID) { await open() }
        .sheet(item: $sheet) { route in
            switch route {
            case .entry(let sceneID, let existing, let kind):
                ScriptEntrySheet(entry: existing, kind: kind) { value in
                    try await commit { draft in
                        guard let sceneIndex = draft.scenes.firstIndex(where: { $0.id == sceneID }) else { throw WorkspaceError.missingScene }
                        if let existing {
                            guard let index = draft.scenes[sceneIndex].entries.firstIndex(where: { $0.id == existing.id }) else { throw WorkspaceError.missingEntry }
                            draft.scenes[sceneIndex].entries[index] = value
                        } else {
                            draft.scenes[sceneIndex].entries.append(value)
                        }
                    }
                    selectedEntryID = value.id
                }
            case .scene(let existing):
                SceneNameSheet(scene: existing) { name in
                    let id = existing?.id ?? UUID()
                    try await commit { draft in
                        if existing != nil {
                            guard let index = draft.scenes.firstIndex(where: { $0.id == id }) else { throw WorkspaceError.missingScene }
                            draft.scenes[index].name = name
                        } else {
                            draft.scenes.append(DraftScene(id: id, name: name))
                        }
                    }
                    if existing == nil { selectScene(id) }
                }
            case .notes:
                WorkspaceNotesSheet(notes: draft?.notes ?? "") { notes in
                    try await commit { $0.notes = notes }
                }
            case .project:
                ProjectEditorSheet(project: project)
            }
        }
        .confirmationDialog("Delete Scene?", isPresented: Binding(get: { deletingScene != nil }, set: { if !$0 { deletingScene = nil } }), titleVisibility: .visible) {
            if let scene = deletingScene {
                Button("Delete Scene", role: .destructive) {
                    perform {
                        try await commit { draft in
                            guard draft.scenes.count > 1 else { throw WorkspaceError.invalidDocument }
                            draft.scenes.removeAll { $0.id == scene.id }
                        }
                        if selectedSceneID == scene.id { selectedSceneID = draft?.scenes.first?.id }
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { Text(deletingScene?.name ?? "") }
        .alert("Couldn't Save Changes", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            Button("OK", role: .cancel) { actionError = nil }
        } message: { Text(actionError ?? "") }
    }

    @ViewBuilder private func panel(_ tab: WorkspaceTab, draft: WorkspaceDraft) -> some View {
        switch tab {
        case .script:
            scriptPanel
        case .scenes:
            scenesPanel(draft)
        case .assets:
            VStack(spacing: 0) {
                HStack {
                    Text("Assets").font(.headline)
                    Spacer()
                    Button("Import Assets", systemImage: "square.and.arrow.down") {}.disabled(true)
                }
                .padding(16)
                Divider()
                ContentUnavailableView("No Assets", systemImage: "photo.on.rectangle")
            }
        case .project:
            Form {
                Section("Project") {
                    if let project {
                        Text(project.name).font(.headline)
                        if !project.synopsis.isEmpty { Text(project.synopsis).foregroundStyle(.secondary) }
                    }
                    Button("Project Settings", systemImage: "slider.horizontal.3") { sheet = .project }
                }
                Section("Overview") {
                    LabeledContent("Scenes", value: "\(draft.scenes.count)")
                    LabeledContent("Entries", value: "\(draft.scenes.reduce(0) { $0 + $1.entries.count })")
                    LabeledContent("Characters", value: "\(draft.scenes.reduce(0) { $0 + $1.entries.reduce(0) { $0 + $1.text.count } })")
                }
                Section {
                    if draft.notes.isEmpty {
                        Text("No Writing Notes").foregroundStyle(.secondary)
                    } else {
                        Text(draft.notes).textSelection(.enabled)
                    }
                    Button("Edit Notes", systemImage: "pencil") { sheet = .notes }
                        .accessibilityIdentifier("edit-notes")
                } header: { Text("Writing Notes") }
            }
        }
    }

    private var scriptPanel: some View {
        VStack(spacing: 0) {
            if let scene = activeScene {
                HStack(spacing: 4) {
                    Menu {
                        if let draft {
                            ForEach(draft.scenes) { item in
                                Button { selectScene(item.id) } label: {
                                    Label(item.name, systemImage: item.id == scene.id ? "checkmark" : "doc.text")
                                }
                            }
                        }
                        Divider()
                        Button("New Scene", systemImage: "plus") { sheet = .scene(nil) }
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "doc.text")
                            Text(scene.name).lineLimit(1)
                            Image(systemName: "chevron.down").font(.caption)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .frame(minHeight: 44)
                    }
                    .foregroundStyle(.primary)
                    .accessibilityIdentifier("scene-picker")
                    Button("Undo", systemImage: "arrow.uturn.backward", action: undo)
                        .labelStyle(.iconOnly)
                        .disabled(!library.canUndoWorkspace(projectID)).help("Undo").accessibilityIdentifier("workspace-undo")
                        .frame(width: 44, height: 44)
                    Button("Redo", systemImage: "arrow.uturn.forward", action: redo)
                        .labelStyle(.iconOnly)
                        .disabled(!library.canRedoWorkspace(projectID)).help("Redo").accessibilityIdentifier("workspace-redo")
                        .frame(width: 44, height: 44)
                    Menu {
                        ForEach(ScriptKind.allCases) { kind in
                            Button(kind.title, systemImage: kind.symbol) { sheet = .entry(scene.id, nil, kind) }
                                .accessibilityIdentifier("new-\(kind.rawValue)")
                        }
                    } label: {
                        Image(systemName: "plus").frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Add Entry")
                    .accessibilityIdentifier("new-entry")
                    .help("Add Entry")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
                .background(.bar)
                Divider()
                if scene.entries.isEmpty {
                    ContentUnavailableView {
                        Label("No Script Entries", systemImage: "text.alignleft")
                    } actions: {
                        Button("Add Dialogue", systemImage: "plus") { sheet = .entry(scene.id, nil, .dialogue) }
                    }
                } else {
                    List {
                        ForEach(Array(scene.entries.enumerated()), id: \.element.id) { index, entry in
                            HStack(alignment: .top, spacing: 12) {
                                Text(String(format: "%02d", index + 1))
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(.tertiary)
                                    .frame(width: 24)
                                    .padding(.top, 4)
                                Button {
                                    selectedEntryID = entry.id
                                    sheet = .entry(scene.id, entry, entry.kind)
                                } label: {
                                    VStack(alignment: .leading, spacing: 8) {
                                        HStack(spacing: 8) {
                                            Label(entry.kind.title, systemImage: entry.kind.symbol)
                                                .foregroundStyle(entry.kind == .dialogue ? Color.accentColor : entry.kind == .narration ? .blue : .teal)
                                            if !entry.speaker.isEmpty { Text(entry.speaker).foregroundStyle(.primary) }
                                        }
                                        .font(.caption.weight(.semibold))
                                        Text(entry.text).font(.body).foregroundStyle(.primary)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("\(entry.kind.title), \(entry.speaker), \(entry.text)")
                                .accessibilityIdentifier("entry-content-\(entry.id)")
                                Menu { entryActions(entry, index: index, scene: scene) } label: {
                                    Image(systemName: "ellipsis").frame(width: 36, height: 44)
                                }
                                .accessibilityLabel("Entry Actions")
                                .accessibilityIdentifier("entry-actions-\(index + 1)")
                            }
                            .padding(.vertical, 10)
                            .listRowBackground(selectedEntryID == entry.id ? Color.accentColor.opacity(0.06) : Color(uiColor: .secondarySystemGroupedBackground))
                            .contextMenu { entryActions(entry, index: index, scene: scene) }
                            .swipeActions {
                                Button("Delete Entry", systemImage: "trash", role: .destructive) {
                                    perform { try await removeEntry(entry.id, sceneID: scene.id) }
                                }
                            }
                        }
                    }
                    .listStyle(.plain)
                    .accessibilityIdentifier("script-entries")
                }
                if sizeClass != .regular {
                    HStack {
                        Text("\(scene.entries.count) entries")
                        Spacer()
                        saveState
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.bar)
                }
            }
        }
    }

    private func scenesPanel(_ draft: WorkspaceDraft) -> some View {
        List {
            Section {
                ForEach(draft.scenes) { scene in
                    Button { selectScene(scene.id) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "doc.text").foregroundStyle(Color.accentColor)
                            VStack(alignment: .leading, spacing: 5) {
                                Text(scene.name).font(.subheadline.weight(.medium)).foregroundStyle(.primary).lineLimit(2)
                                Text("\(scene.entries.count) entries").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                            if scene.id == activeScene?.id { Image(systemName: "checkmark").font(.caption).foregroundStyle(Color.accentColor) }
                        }
                        .padding(.vertical, 6)
                    }
                    .accessibilityIdentifier("scene-\(scene.name)")
                    .contextMenu {
                        Button("Rename Scene", systemImage: "pencil") { sheet = .scene(scene) }
                        Button("Delete Scene", systemImage: "trash", role: .destructive) { deletingScene = scene }
                            .disabled(draft.scenes.count < 2)
                    }
                    .swipeActions {
                        Button("Delete Scene", systemImage: "trash", role: .destructive) { deletingScene = scene }
                            .disabled(draft.scenes.count < 2)
                        Button("Rename Scene", systemImage: "pencil") { sheet = .scene(scene) }.tint(.blue)
                    }
                }
            } header: { Text("Scenes") }
            Section {
                Button("New Scene", systemImage: "plus") { sheet = .scene(nil) }
                    .accessibilityIdentifier("new-scene")
            }
        }
        .listStyle(.sidebar)
        .accessibilityIdentifier("scene-list")
    }

    @ViewBuilder private func entryActions(_ entry: ScriptEntry, index: Int, scene: DraftScene) -> some View {
        Button("Edit Entry", systemImage: "pencil") { sheet = .entry(scene.id, entry, entry.kind) }
        Button("Duplicate", systemImage: "plus.square.on.square") {
            perform {
                try await commit { draft in
                    guard let s = draft.scenes.firstIndex(where: { $0.id == scene.id }),
                          let i = draft.scenes[s].entries.firstIndex(where: { $0.id == entry.id }) else { throw WorkspaceError.missingEntry }
                    var copy = draft.scenes[s].entries[i]
                    copy.id = UUID()
                    draft.scenes[s].entries.insert(copy, at: i + 1)
                }
            }
        }
        Button("Move Up", systemImage: "arrow.up") { moveEntry(entry.id, sceneID: scene.id, offset: -1) }.disabled(index == 0)
        Button("Move Down", systemImage: "arrow.down") { moveEntry(entry.id, sceneID: scene.id, offset: 1) }.disabled(index == scene.entries.count - 1)
        Button("Delete Entry", systemImage: "trash", role: .destructive) {
            perform { try await removeEntry(entry.id, sceneID: scene.id) }
        }
    }

    private var saveState: some View {
        Label(library.isSaving ? String(localized: "Saving") : String(localized: "Saved"), systemImage: library.isSaving ? "clock" : "checkmark.circle")
            .font(.caption).foregroundStyle(.secondary)
            .accessibilityIdentifier("workspace-save-state")
    }

    private func selectScene(_ id: UUID) {
        selectedSceneID = id
        selectedEntryID = nil
        tab = .script
    }

    private func open() async {
        loadError = nil
        do { try await library.openWorkspace(projectID) }
        catch { loadError = error.localizedDescription }
    }

    private func commit(_ mutation: (inout WorkspaceDraft) throws -> Void) async throws {
        try await library.editWorkspace(projectID, mutation: mutation)
    }

    private func undo() {
        perform { try await library.undoWorkspace(projectID) }
    }

    private func redo() {
        perform { try await library.redoWorkspace(projectID) }
    }

    private func removeEntry(_ id: UUID, sceneID: UUID) async throws {
        try await commit { draft in
            guard let index = draft.scenes.firstIndex(where: { $0.id == sceneID }) else { throw WorkspaceError.missingScene }
            draft.scenes[index].entries.removeAll { $0.id == id }
        }
    }

    private func moveEntry(_ id: UUID, sceneID: UUID, offset: Int) {
        perform {
            try await commit { draft in
                guard let s = draft.scenes.firstIndex(where: { $0.id == sceneID }),
                      let i = draft.scenes[s].entries.firstIndex(where: { $0.id == id }) else { throw WorkspaceError.missingEntry }
                let target = i + offset
                guard draft.scenes[s].entries.indices.contains(target) else { return }
                draft.scenes[s].entries.swapAt(i, target)
            }
        }
    }

    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        Task {
            do { try await action() }
            catch { actionError = error.localizedDescription }
        }
    }
}
