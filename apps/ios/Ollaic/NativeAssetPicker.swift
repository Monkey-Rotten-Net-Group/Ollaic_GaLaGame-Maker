import SwiftUI
import UniformTypeIdentifiers

@MainActor
struct NativeAssetPicker: View {
    @Environment(\.dismiss) private var dismiss
    let model: NativeWorkspace
    let category: String
    var prefix = ""
    var selection = ""
    var allowClear = true
    let select: (AssetInfo?) -> Void
    @State private var query = ""
    @State private var importing = false
    @State private var preview: AssetInfo?
    @State private var error: String?

    private var assets: [AssetInfo] { matchingNativeAssets(model.assets, category: category, prefix: prefix, query: query) }
    private var importTypes: [UTType] {
        switch category {
        case "background", "figure", "tex": [.image]
        case "bgm", "vocal": [.audio]
        case "video": [.movie]
        case "animation": [.json]
        default: [.item]
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if allowClear {
                    Button("None") { select(nil); dismiss() }
                }
                ForEach(assets) { asset in
                    HStack {
                        Button {
                            select(asset)
                            dismiss()
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(asset.alias.isEmpty ? asset.name : asset.alias)
                                    if !asset.alias.isEmpty { Text(asset.name).font(.caption).foregroundStyle(.secondary) }
                                }
                                Spacer()
                                if asset.name == selection { Image(systemName: "checkmark") }
                            }.contentShape(Rectangle())
                        }.buttonStyle(.plain)
                        Button("Preview", systemImage: "eye") { preview = asset }
                            .labelStyle(.iconOnly).buttonStyle(.borderless).help("Preview")
                    }
                }
            }
            .overlay { if assets.isEmpty && !query.isEmpty { ContentUnavailableView.search(text: query) } }
            .searchable(text: $query, prompt: "Search Assets")
            .navigationTitle(AssetCategory.title(category)).navigationBarTitleDisplayMode(.inline)
            .disabled(model.isBusy)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(model.isBusy) }
                ToolbarItem(placement: .primaryAction) {
                    Button("Import Assets", systemImage: "square.and.arrow.down") { importing = true }
                        .disabled(model.isBusy).help("Import Assets")
                }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: importTypes, allowsMultipleSelection: true) { result in
                Task {
                    do { try await model.importAssets(result.get(), category: category, prefix: prefix); query = "" }
                    catch { self.error = error.localizedDescription }
                }
            }
            .sheet(item: $preview) { asset in AssetMediaView(url: model.assetURL(asset)) }
            .alert("Couldn't Save Changes", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) { error = nil }
            } message: { Text(error ?? "") }
        }
    }
}
