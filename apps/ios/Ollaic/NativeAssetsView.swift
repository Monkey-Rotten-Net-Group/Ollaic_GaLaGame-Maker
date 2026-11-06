import SwiftUI
import UniformTypeIdentifiers
import QuickLook
import AVKit

enum AssetCategory {
    static let all = ["background", "figure", "bgm", "vocal", "video", "animation", "tex", "reference"]
    static func title(_ value: String) -> String {
        switch value {
        case "background": String(localized: "Backgrounds")
        case "figure": String(localized: "Figures")
        case "bgm": String(localized: "Background Music")
        case "vocal": String(localized: "Voices and Effects")
        case "video": String(localized: "Videos")
        case "animation": String(localized: "Animations")
        case "tex": String(localized: "Textures")
        default: String(localized: "References")
        }
    }
}

@MainActor
struct NativeAssetsView: View {
    @Bindable var model: NativeWorkspace
    let selectUsage: (AssetUsage) -> Void
    @State private var category = "background"
    @State private var query = ""
    @State private var importing = false
    @State private var selected: AssetInfo?
    @State private var animation = false
    @State private var pendingUsage: AssetUsage?

    private var visibleAssets: [AssetInfo] {
        model.assets.filter { $0.category == category && (query.isEmpty || $0.name.localizedStandardContains(query) || $0.alias.localizedStandardContains(query)) }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("Category", selection: $category) { ForEach(AssetCategory.all, id: \.self) { Text(AssetCategory.title($0)).tag($0) } }
                    .frame(maxWidth: .infinity, alignment: .leading)
                if category == "animation" {
                    Button("New Animation", systemImage: "plus") { animation = true }.labelStyle(.iconOnly).help("New Animation")
                }
                Button("Import Assets", systemImage: "square.and.arrow.down") { importing = true }
                    .labelStyle(.iconOnly).help("Import Assets").accessibilityIdentifier("import-assets")
            }.padding(.horizontal, 16).frame(minHeight: 48)
            TextField("Search Assets", text: $query).textFieldStyle(.roundedBorder).padding(.horizontal, 16).padding(.bottom, 10)
            Divider()
            List(visibleAssets) { asset in
                Button { selected = asset } label: {
                    HStack {
                        Image(systemName: "doc")
                        VStack(alignment: .leading) {
                            Text(asset.alias.isEmpty ? asset.name : asset.alias).foregroundStyle(.primary)
                            if !asset.alias.isEmpty { Text(asset.name).font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        Text(ByteCountFormatter.string(fromByteCount: Int64(asset.size), countStyle: .file)).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .overlay { if visibleAssets.isEmpty { ContentUnavailableView("No Assets", systemImage: "photo.on.rectangle") } }
        }
        .sheet(item: $selected, onDismiss: {
            if let pendingUsage { self.pendingUsage = nil; selectUsage(pendingUsage) }
        }) { asset in
            AssetDetailsView(model: model, asset: asset) { pendingUsage = $0 }
        }
        .sheet(isPresented: $animation) { AnimationEditorView(model: model, name: nil) }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            let destinationCategory = category
            model.perform { try await model.importAssets(result.get(), category: destinationCategory) }
        }
    }
}

@MainActor
struct AssetDetailsView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: NativeWorkspace
    let asset: AssetInfo
    let selectUsage: (AssetUsage) -> Void
    @State private var details: AssetDetails?
    @State private var usages: [AssetUsage] = []
    @State private var name = ""
    @State private var error: String?
    @State private var preview = false
    @State private var animation = false
    @State private var importingReferences = false
    @State private var deleting = false
    @State private var pickingReferences = false
    @State private var referencePreview: AssetInfo?
    private var referenceLayout: NativeAssetReferences? { try? NativeAssetReferences(asset: asset) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(asset.name).textSelection(.enabled)
                    Button("Preview", systemImage: "eye") { preview = true }
                    if ["background", "figure", "bgm", "vocal", "video", "animation"].contains(asset.category) {
                        Button("Insert into Script", systemImage: "text.badge.plus") {
                            perform {
                                guard let scene = model.activeScene else { throw WorkspaceError.missingScene }
                                try await model.saveLine(sceneID: scene.id, lineID: nil, source: assetCommand(category: asset.category, name: asset.name))
                                dismiss()
                            }
                        }
                    }
                    if asset.category == "animation" { Button("Edit Animation", systemImage: "pencil") { animation = true } }
                }
                if details != nil {
                    Section("Metadata") {
                        TextField("Alias", text: detail(\.alias))
                        TextField("Description", text: detail(\.description), axis: .vertical).lineLimit(3...8)
                        TextField("Tags", text: Binding(get: { details?.tags.joined(separator: ", ") ?? "" }, set: { details?.tags = $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }))
                        Button("Save Metadata", systemImage: "checkmark") {
                            perform {
                                guard let details else { return }
                                try await model.resourceChange { try await NativeProjectStore.shared.saveDetails(details, asset: asset, at: model.directory) }
                                try await load()
                            }
                        }
                    }
                    Section("References") {
                        ForEach(details?.references ?? [], id: \.self) { reference in
                            HStack {
                                Text(reference)
                                Spacer()
                                if let layout = referenceLayout,
                                   let linked = model.assets.first(where: { $0.category == "reference" && $0.name == layout.assetName(reference) }) {
                                    Button("Preview", systemImage: "eye") { referencePreview = linked }.labelStyle(.iconOnly).help("Preview")
                                }
                                Button("Delete", systemImage: "minus.circle", role: .destructive) { details?.references.removeAll { $0 == reference } }.labelStyle(.iconOnly)
                            }
                        }
                        if let prefix = try? assetReferencePrefix(category: asset.category, name: asset.name), !prefix.isEmpty {
                            Button("Add Reference", systemImage: "folder") { pickingReferences = true }
                            Button("Import References", systemImage: "square.and.arrow.down") { importingReferences = true }
                        }
                    }
                }
                Section("Usages") {
                    if usages.isEmpty { Text("No Known Usages").foregroundStyle(.secondary) }
                    ForEach(usages.indices, id: \.self) { index in
                        let usage = usages[index]
                        Button {
                            selectUsage(usage)
                            dismiss()
                        } label: {
                            VStack(alignment: .leading) {
                                Text("\(usage.fileName):\(usage.lineNumber)").font(.caption)
                                Text(usage.content).lineLimit(3).foregroundStyle(.secondary)
                            }
                        }.disabled(NativeEditorNavigation.target(for: usage, in: model) == nil)
                    }
                }
                Section {
                    TextField("File Name", text: $name)
                    Button("Rename", systemImage: "pencil") {
                        perform {
                            try await model.resourceChange { try await NativeProjectStore.shared.rename(asset, to: name, at: model.directory, revision: model.revision) }
                            dismiss()
                        }
                    }.disabled(name == asset.name || name.isEmpty)
                    Button("Delete Asset", systemImage: "trash", role: .destructive) { deleting = true }
                }
            }
            .disabled(model.isBusy).navigationTitle("Asset").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.disabled(model.isBusy) } }
            .task { do { name = asset.name; try await load() } catch { self.error = error.localizedDescription } }
            .sheet(isPresented: $preview) { AssetMediaView(url: model.assetURL(asset)) }
            .sheet(isPresented: $animation) { AnimationEditorView(model: model, name: asset.name) }
            .sheet(item: $referencePreview) { reference in AssetMediaView(url: model.assetURL(reference)) }
            .sheet(isPresented: $pickingReferences) {
                if let layout = referenceLayout {
                    NativeAssetPicker(model: model, category: "reference", prefix: layout.prefix, allowClear: false) { reference in
                        if let reference {
                            let name = layout.relativeName(reference.name)
                            if details?.references.contains(name) == false { details?.references.append(name) }
                        }
                    }
                }
            }
            .fileImporter(isPresented: $importingReferences, allowedContentTypes: [.image, .audio, .movie], allowsMultipleSelection: true) { result in
                perform {
                    let urls = try result.get()
                    let prefix = try assetReferencePrefix(category: asset.category, name: asset.name)
                    try await model.importAssets(urls, category: "reference", prefix: prefix)
                    for url in urls {
                        let name = url.lastPathComponent
                        if details?.references.contains(name) == false { details?.references.append(name) }
                    }
                }
            }
            .confirmationDialog("Delete Asset?", isPresented: $deleting, titleVisibility: .visible) {
                Button("Delete Asset", role: .destructive) {
                    perform {
                        try await model.resourceChange { try await NativeProjectStore.shared.delete(asset, at: model.directory, revision: model.revision) }
                        dismiss()
                    }
                }
            }
            .alert("Couldn't Save Changes", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) { error = nil }
            } message: { Text(error ?? "") }
        }
    }

    private func detail(_ key: WritableKeyPath<AssetDetails, String>) -> Binding<String> {
        Binding(get: { details?[keyPath: key] ?? "" }, set: { details?[keyPath: key] = $0 })
    }
    private func load() async throws {
        details = try await NativeProjectStore.shared.details(asset, at: model.directory)
        usages = try await NativeProjectStore.shared.usages(asset, at: model.directory)
    }
    private func perform(_ work: @escaping () async throws -> Void) {
        Task { do { try await work() } catch { self.error = error.localizedDescription } }
    }
}

struct AnimationEditorView: View {
    let model: NativeWorkspace
    let name: String?
    @State private var resource: TextResource?
    @State private var error: String?
    @State private var fileName = "animation.json"

    var body: some View {
        Group {
            if let resource {
                NativeTextSheet(title: name ?? fileName, text: resource.source) { source, _ in
                    try await model.resourceChange {
                        try await NativeProjectStore.shared.saveAnimation(name ?? fileName, source: source, revision: resource.revision, at: model.directory)
                    }
                }
            } else if name == nil {
                NavigationStack {
                    Form {
                        TextField("File Name", text: $fileName)
                        Button("Create") { resource = TextResource(source: "[{\"alpha\":1,\"duration\":300}]", revision: "") }
                    }.navigationTitle("New Animation")
                }
            } else if let error { ContentUnavailableView(error, systemImage: "exclamationmark.triangle") }
            else { ProgressView() }
        }
        .task {
            if let name {
                do { resource = try await NativeProjectStore.shared.animation(name, at: model.directory) }
                catch { self.error = error.localizedDescription }
            }
        }
    }
}

struct AssetMediaView: View {
    @Environment(\.dismiss) private var dismiss
    let url: URL
    @State private var player: AVPlayer?
    private var isMedia: Bool { ["mp3", "wav", "ogg", "m4a", "aac", "mp4", "webm", "mov"].contains(url.pathExtension.lowercased()) }
    var body: some View {
        NavigationStack {
            Group {
                if isMedia { VideoPlayer(player: player).onAppear { player = AVPlayer(url: url) }.onDisappear { player?.pause(); player = nil } }
                else { NativeQuickLook(url: url) }
            }
            .navigationTitle(url.lastPathComponent).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
    }
}

private struct NativeQuickLook: UIViewControllerRepresentable {
    let url: URL
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }
    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) {}
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}
