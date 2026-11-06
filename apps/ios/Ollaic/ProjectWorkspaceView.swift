import SwiftUI
import UniformTypeIdentifiers

@MainActor
struct ProjectWorkspaceView: View {
    @Environment(ProjectLibrary.self) private var library
    let projectID: UUID
    @State private var workspace: NativeWorkspace?
    @State private var error: String?

    var body: some View {
        Group {
            if library.project(projectID)?.isDeleted != false {
                ContentUnavailableView("Project Unavailable", systemImage: "folder.badge.questionmark")
            } else if let workspace { NativeEditorView(model: workspace) }
            else if let error {
                ContentUnavailableView {
                    Label("Couldn't Load Editor", systemImage: "exclamationmark.triangle")
                } description: { Text(error) } actions: { Button("Retry") { Task { await open() } } }
            } else { ProgressView() }
        }
        .navigationTitle(library.project(projectID)?.name ?? String(localized: "Editor"))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: projectID) { await open() }
    }

    private func open() async {
        error = nil
        do { workspace = try await library.nativeWorkspace(projectID) }
        catch { self.error = error.localizedDescription }
    }
}

private extension NativeTab {
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

private enum NativeEditorSheet: Identifiable {
    case command(UUID, NativeLine?, CommandKind?), scene(NativeScene?), source(UUID), project, characters(String?)
    var id: String {
        switch self {
        case .command(let scene, let line, let kind): "command-\(scene)-\(line?.id.uuidString ?? String(describing: kind))"
        case .scene(let scene): "scene-\(scene?.id.uuidString ?? "new")"
        case .source(let scene): "source-\(scene)"
        case .project: "project"
        case .characters(let id): "characters-\(id ?? "all")"
        }
    }
}

struct SceneTextDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.plainText] }
    var text: String
    init(text: String) { self.text = text }
    init(configuration: ReadConfiguration) throws { text = String(decoding: configuration.file.regularFileContents ?? Data(), as: UTF8.self) }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: Data(text.utf8)) }
}

private struct ExportItem: Identifiable {
    let id = UUID()
    let report: ExportReport
}

@MainActor
private struct NativeEditorView: View {
    @Environment(ProjectLibrary.self) private var library
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Bindable var model: NativeWorkspace
    @State private var navigation = NativeEditorNavigation()
    @State private var sheet: NativeEditorSheet?
    @State private var preview = false
    @State private var importingScene = false
    @State private var exportingScene = false
    @State private var sceneText = SceneTextDocument(text: "")
    @State private var exportItem: ExportItem?
    @State private var exportDirectory: URL?
    @State private var deletingScene: NativeScene?

    var body: some View {
        Group {
            if sizeClass == .regular {
                VStack(spacing: 0) {
                    Picker("Workspace", selection: $navigation.tab) {
                        ForEach(NativeTab.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented).frame(maxWidth: 480).padding(12)
                    .accessibilityIdentifier("workspace-tabs")
                    Divider()
                    GeometryReader { geometry in
                        HStack(spacing: 0) {
                            if navigation.tab == .script && geometry.size.width >= 720 {
                                scenes.frame(width: 230)
                                Divider()
                            }
                            panel(navigation.tab).frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    }
                }
            } else {
                TabView(selection: $navigation.tab) {
                    ForEach(NativeTab.allCases) { item in
                        panel(item).tabItem { Label(item.title, systemImage: item.symbol) }.tag(item)
                    }
                }
            }
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .disabled(model.isBusy)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Preview", systemImage: "play") { preview = true }
                    .disabled(model.isBusy).help("Preview").accessibilityIdentifier("workspace-preview")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Project Settings", systemImage: "slider.horizontal.3") { sheet = .project }
                    Button("Characters", systemImage: "person.2") { sheet = .characters(nil) }
                    Divider()
                    Button("Edit Scene Source", systemImage: "chevron.left.forwardslash.chevron.right") {
                        if let scene = model.activeScene { sheet = .source(scene.id) }
                    }
                    Button("Import Scene Text", systemImage: "square.and.arrow.down") { importingScene = true }
                    Button("Export Scene Text", systemImage: "doc.text") {
                        sceneText = SceneTextDocument(text: model.activeScene?.source ?? "")
                        exportingScene = true
                    }
                    Button("Export Project ZIP", systemImage: "square.and.arrow.up") {
                        prepareExport()
                    }
                    Button("Reload", systemImage: "arrow.clockwise") { model.perform { try await model.load() } }
                } label: { Label("Project Actions", systemImage: "ellipsis.circle") }
                .disabled(model.isBusy).accessibilityIdentifier("workspace-options")
            }
        }
        .sheet(item: $sheet) { route in
            switch route {
            case .command(let scene, let line, let kind): CommandEditorSheet(model: model, sceneID: scene, line: line, kind: kind)
            case .scene(let scene):
                NativeTextSheet(title: scene == nil ? String(localized: "New Scene") : String(localized: "Rename Scene"),
                                text: scene?.name ?? "", multiline: false, fieldID: "scene-name", saveID: "save-scene") { name, _ in
                    try await model.saveScene(id: scene?.id, name: name)
                }
            case .source(let sceneID):
                NativeTextSheet(title: String(localized: "Scene Source"), text: model.document?.scenes.first { $0.id == sceneID }?.source ?? "") { text, original in
                    try await model.saveSceneSource(sceneID: sceneID, source: text, original: original)
                }
            case .project: ProjectEditorSheet(project: library.project(model.projectID))
            case .characters(let id): CharacterManagerView(model: model, initialCharacterID: id)
            }
        }
        .sheet(item: $exportItem, onDismiss: {
            if let exportDirectory { try? FileManager.default.removeItem(at: exportDirectory) }
            exportDirectory = nil
        }) { item in ProjectExportView(report: item.report) }
        .fullScreenCover(isPresented: $preview) { RuntimePreviewView(projectURL: model.directory) }
        .fileImporter(isPresented: $importingScene, allowedContentTypes: [.plainText]) { result in
            model.perform {
                try await model.importScene(result.get())
                navigation.tab = .script
            }
        }
        .fileExporter(isPresented: $exportingScene, document: sceneText, contentType: .plainText,
                      defaultFilename: model.activeScene?.fileName ?? "scene.txt") { result in
            if case .failure(let error) = result { model.error = error.localizedDescription }
        }
        .confirmationDialog("Delete Scene?", isPresented: Binding(get: { deletingScene != nil }, set: { if !$0 { deletingScene = nil } }), titleVisibility: .visible) {
            if let scene = deletingScene { Button("Delete Scene", role: .destructive) { model.perform { try await model.deleteScene(scene.id) } } }
            Button("Cancel", role: .cancel) {}
        } message: { Text(deletingScene?.name ?? "") }
        .alert("Couldn't Save Changes", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK", role: .cancel) { model.error = nil }
        } message: { Text(model.error ?? "") }
    }

    @ViewBuilder private func panel(_ item: NativeTab) -> some View {
        switch item {
        case .script: script
        case .scenes: scenes
        case .assets:
            NativeAssetsView(model: model) { usage in
                guard navigation.showUsage(usage, in: model) else { return }
                switch navigation.usageTarget {
                case .command(let sceneID, let lineID):
                    if let line = model.document?.scenes.first(where: { $0.id == sceneID })?.lines.first(where: { $0.id == lineID }) {
                        sheet = .command(sceneID, line, nil)
                    }
                case .character(let id): sheet = .characters(id)
                case nil: break
                }
            }
        case .project:
            Form {
                Section("Project") {
                    if let project = library.project(model.projectID) {
                        Text(project.name).font(.headline)
                        if !project.synopsis.isEmpty { Text(project.synopsis) }
                    }
                    Button("Project Settings", systemImage: "slider.horizontal.3") { sheet = .project }
                }
                Section("Overview") {
                    LabeledContent("Scenes", value: "\(model.document?.scenes.count ?? 0)")
                    LabeledContent("Assets", value: "\(model.assets.count)")
                    LabeledContent("Characters", value: "\(model.characters?.characters.count ?? 0)")
                }
                Section {
                    Button("Characters", systemImage: "person.2") { sheet = .characters(nil) }
                    Button("Preview", systemImage: "play") { preview = true }
                    Button("Export Project ZIP", systemImage: "square.and.arrow.up", action: prepareExport)
                }
            }
        }
    }

    private var scenes: some View {
        List {
            Button("New Scene", systemImage: "plus") { sheet = .scene(nil) }.accessibilityIdentifier("new-scene")
            ForEach(model.document?.scenes ?? []) { scene in
                Button {
                    model.selectedSceneID = scene.id
                    navigation.tab = .script
                } label: {
                    Label(scene.name, systemImage: model.activeScene?.id == scene.id ? "doc.text.fill" : "doc.text")
                        .foregroundStyle(.primary).frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityIdentifier("scene-row-\(scene.id)")
                .contextMenu {
                    Button("Rename Scene", systemImage: "pencil") { sheet = .scene(scene) }
                    if scene.fileName != "start.txt" {
                        Button("Delete Scene", systemImage: "trash", role: .destructive) { deletingScene = scene }
                    }
                }
            }
        }
    }

    private var script: some View {
        VStack(spacing: 0) {
            HStack {
                // The label bounds also define the menu's popover anchor.
                Menu {
                    ForEach(model.document?.scenes ?? []) { scene in
                        Button(scene.name) { model.selectedSceneID = scene.id }
                            .accessibilityIdentifier("scene-choice-\(scene.id)")
                    }
                    Button("New Scene", systemImage: "plus") { sheet = .scene(nil) }
                } label: {
                    Label(model.activeScene?.name ?? String(localized: "Scenes"), systemImage: "doc.text")
                        .lineLimit(1).frame(minHeight: 44)
                }
                .labelStyle(.titleAndIcon).accessibilityIdentifier("scene-picker")
                Spacer(minLength: 8)
                Button("Undo", systemImage: "arrow.uturn.backward") { model.perform { try await model.restore(undo: true) } }
                    .disabled(model.past.isEmpty).accessibilityIdentifier("workspace-undo").help("Undo")
                Button("Redo", systemImage: "arrow.uturn.forward") { model.perform { try await model.restore(undo: false) } }
                    .disabled(model.future.isEmpty).accessibilityIdentifier("workspace-redo").help("Redo")
                Menu {
                    ForEach(CommandKind.editorKinds, id: \.self) { kind in
                        Button(kind.editorTitle, systemImage: kind.editorSymbol) {
                            if let scene = model.activeScene { sheet = .command(scene.id, nil, kind) }
                        }.accessibilityIdentifier(kind.editorIdentifier)
                    }
                    Button("Raw Command", systemImage: "chevron.left.forwardslash.chevron.right") {
                        if let scene = model.activeScene { sheet = .command(scene.id, nil, nil) }
                    }
                } label: { Label("Add Entry", systemImage: "plus") }
                .accessibilityIdentifier("new-entry").help("Add Entry")
            }
            .labelStyle(.iconOnly).buttonStyle(.borderless)
            .frame(minHeight: 48).padding(.horizontal, 16)
            Divider()
            if let scene = model.activeScene {
                List {
                    ForEach(scene.lines.filter { !$0.isBlank }) { line in
                        let decoded = line.decoded
                        let category = decoded.command == "raw" ? nil : (try? readCommand(source: line.source))?.kind
                        Button { sheet = .command(scene.id, line, nil) } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Label(category?.editorTitle ?? String(localized: "Raw Command"),
                                          systemImage: category?.editorSymbol ?? "chevron.left.forwardslash.chevron.right")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(category?.categoryColor ?? Color.secondary)
                                    if !decoded.speaker.isEmpty {
                                        Text(decoded.speaker).font(.caption.bold()).foregroundStyle(Color.primary)
                                    }
                                }
                                Text(decoded.kind == "Command" ? decoded.preview : decoded.text)
                                    .font(.body).foregroundStyle(Color.primary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .padding(.vertical, 4)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("entry-content-\(line.id)")
                        .contextMenu {
                            Button("Duplicate", systemImage: "plus.square.on.square") { lineAction(scene, line: line, action: .duplicate) }
                            Button("Move Up", systemImage: "arrow.up") { lineAction(scene, line: line, action: .moveUp) }
                            Button("Move Down", systemImage: "arrow.down") { lineAction(scene, line: line, action: .moveDown) }
                            Button("Delete", systemImage: "trash", role: .destructive) { lineAction(scene, line: line, action: .delete) }
                        }
                    }
                }
                .overlay {
                    if scene.lines.allSatisfy(\.isBlank) {
                        ContentUnavailableView("No Script Entries", systemImage: "text.alignleft")
                    }
                }
            }
        }
    }

    private func lineAction(_ scene: NativeScene, line: NativeLine, action: NativeLineAction) {
        model.perform {
            try await model.changeLine(sceneID: scene.id, lineID: line.id, action: action)
        }
    }

    private func prepareExport() {
        model.perform {
            let report = try await model.export()
            exportDirectory = URL(fileURLWithPath: report.outputPath).deletingLastPathComponent()
            exportItem = ExportItem(report: report)
        }
    }
}

struct ProjectExportView: View {
    let report: ExportReport
    var body: some View {
        NavigationStack {
            List {
                ShareLink(item: URL(fileURLWithPath: report.outputPath)) { Label("Save or Share ZIP", systemImage: "square.and.arrow.up") }
                if !report.warnings.isEmpty {
                    Section("Export Warnings") { ForEach(report.warnings, id: \.self) { Text($0) } }
                }
            }.navigationTitle("Export Project ZIP")
        }
    }
}

struct NativeTextSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    @State var text: String
    @State private var original: String
    var multiline = true
    var fieldID = "source-text"
    var saveID = "save-source"
    let save: (String, String) async throws -> Void
    @State private var busy = false
    @State private var error: String?

    init(title: String, text: String, multiline: Bool = true, fieldID: String = "source-text", saveID: String = "save-source",
         save: @escaping (String, String) async throws -> Void) {
        self.title = title
        _text = State(initialValue: text)
        _original = State(initialValue: text)
        self.multiline = multiline
        self.fieldID = fieldID
        self.saveID = saveID
        self.save = save
    }

    var body: some View {
        NavigationStack {
            Form {
                if multiline { TextEditor(text: $text).font(.system(.body, design: .monospaced)).frame(minHeight: 300).accessibilityIdentifier(fieldID) }
                else { TextField("Name", text: $text).accessibilityIdentifier(fieldID) }
            }
            .disabled(busy).navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        busy = true
                        Task {
                            defer { busy = false }
                            do { try await save(text, original); dismiss() } catch { self.error = error.localizedDescription }
                        }
                    }.disabled(busy).accessibilityIdentifier(saveID)
                }
            }
            .interactiveDismissDisabled(busy)
            .alert("Couldn't Save Changes", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) { error = nil }
            } message: { Text(error ?? "") }
        }
    }
}
