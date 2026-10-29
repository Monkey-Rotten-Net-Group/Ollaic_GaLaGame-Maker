import SwiftUI
import UniformTypeIdentifiers

extension CharacterInfo: Identifiable {}

@MainActor
struct CharacterManagerView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: NativeWorkspace
    var initialCharacterID: String? = nil
    @State private var editing: CharacterInfo?
    @State private var deleting: CharacterInfo?
    @State private var error: String?
    @State private var query = ""

    private var visibleCharacters: [CharacterInfo] {
        matchingNativeCharacters(model.characters?.characters ?? [], query: query)
    }

    var body: some View {
        NavigationStack {
            List(visibleCharacters) { character in
                Button { editing = character } label: {
                    VStack(alignment: .leading) {
                        Text(character.name).foregroundStyle(.primary)
                        if !character.description.isEmpty { Text(character.description).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                    }
                }
                .contextMenu { Button("Delete", systemImage: "trash", role: .destructive) { deleting = character } }
            }
            .overlay {
                if model.characters?.characters.isEmpty != false { ContentUnavailableView("No Characters", systemImage: "person.2") }
                else if visibleCharacters.isEmpty { ContentUnavailableView.search(text: query) }
            }
            .searchable(text: $query, prompt: "Search Characters")
            .navigationTitle("Characters")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) { Button("New Character", systemImage: "plus") { query = ""; editing = newCharacter() } }
            }
            .sheet(item: $editing) { character in CharacterEditorView(model: model, character: character, revision: model.characters?.revision ?? "") }
            .task {
                if let initialCharacterID { editing = model.characters?.characters.first { $0.id == initialCharacterID } }
            }
            .confirmationDialog("Delete Character?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
                if let character = deleting {
                    Button("Delete", role: .destructive) {
                        Task {
                            do {
                                try await model.resourceChange {
                                    _ = try await NativeProjectStore.shared.deleteCharacter(character.id, at: model.directory, revision: model.characters?.revision ?? "")
                                }
                            } catch { self.error = error.localizedDescription }
                        }
                    }
                }
            }
            .alert("Couldn't Save Changes", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) { error = nil }
            } message: { Text(error ?? "") }
            .disabled(model.isBusy)
        }
    }
}

@MainActor
private struct CharacterEditorView: View {
    @Environment(\.dismiss) private var dismiss
    let model: NativeWorkspace
    @State private var draft: CharacterDraft
    @State private var error: String?
    @State private var busy = false
    @State private var importingReference = false
    @State private var pickingReference = false
    @State private var preview: AssetInfo?

    init(model: NativeWorkspace, character: CharacterInfo, revision: String) {
        self.model = model
        _draft = State(initialValue: CharacterDraft(character: character, revision: revision))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Profile") {
                    TextField("Name", text: $draft.character.name)
                    TextField("Aliases", text: list(\.aliases))
                    TextField("Description", text: $draft.character.description, axis: .vertical).lineLimit(3...8)
                    TextField("Personality", text: $draft.character.personality, axis: .vertical)
                    TextField("Gender", text: $draft.character.gender)
                    TextField("Age", text: $draft.character.age)
                    TextField("Stance", text: $draft.character.stance)
                    TextField("Keywords", text: list(\.keywords))
                    TextField("Dialogue Style", text: $draft.character.dialogueStyle, axis: .vertical)
                    AssetReferenceField(title: String(localized: "Default Voice"), selection: optional(\.defaultVoice), category: "vocal", model: model, emptyValue: "")
                    TextField("Voice Timbre", text: optional(\.voiceTimbre))
                    TextField("Color Theme", text: optional(\.colorTheme))
                    TextField("Notes", text: $draft.character.notes, axis: .vertical)
                }
                Section("Sprites") {
                    ForEach(draft.character.sprites.indices, id: \.self) { index in
                        VStack(alignment: .leading) {
                            HStack {
                                TextField("Emotion", text: $draft.character.sprites[index].emotion)
                                Button("Move Up", systemImage: "arrow.up") { draft.moveSprite(from: index, to: index - 1) }
                                    .disabled(index == 0).help("Move Up")
                                Button("Move Down", systemImage: "arrow.down") { draft.moveSprite(from: index, to: index + 1) }
                                    .disabled(index + 1 == draft.character.sprites.count).help("Move Down")
                            }.labelStyle(.iconOnly).buttonStyle(.borderless)
                            AssetReferenceField(title: String(localized: "Figure"), selection: $draft.character.sprites[index].file, category: "figure", model: model, emptyValue: "")
                            TextField("Prompt", text: Binding(get: { draft.character.sprites[index].prompt ?? "" }, set: { draft.character.sprites[index].prompt = $0.isEmpty ? nil : $0 }))
                            Button("Remove Sprite", systemImage: "minus.circle", role: .destructive) { draft.character.sprites.remove(at: index) }
                        }
                    }
                    Button("Add Sprite", systemImage: "plus") { draft.character.sprites.append(CharacterSprite(emotion: "", file: "", prompt: nil, extraJson: "{}")) }
                }
                Section("Reference Images") {
                    ForEach(draft.character.referenceImages, id: \.self) { reference in
                        HStack {
                            Text(reference)
                            Spacer()
                            if let asset = model.assets.first(where: { $0.category == "reference" && $0.name == "\(draft.character.id)/\(reference)" }) {
                                Button("Preview", systemImage: "eye") { preview = asset }.labelStyle(.iconOnly).help("Preview")
                            }
                            Button("Remove", systemImage: "minus.circle", role: .destructive) { draft.character.referenceImages.removeAll { $0 == reference } }.labelStyle(.iconOnly)
                        }
                    }
                    Button("Add Reference", systemImage: "folder") { pickingReference = true }
                        .disabled(draft.character.id.isEmpty || draft.character.referenceImages.count >= 5)
                    Button("Import Reference", systemImage: "square.and.arrow.down") { importingReference = true }.disabled(draft.character.id.isEmpty || draft.character.referenceImages.count >= 5)
                }
                Section("Relations") {
                    ForEach(draft.character.relations.indices, id: \.self) { index in
                        VStack(alignment: .leading) {
                            TextField("Target ID", text: $draft.character.relations[index].targetId)
                            Menu("Character") {
                                ForEach(model.characters?.characters.filter { $0.id != draft.character.id } ?? []) { other in
                                    Button(other.name) { draft.character.relations[index].targetId = other.id }
                                }
                            }
                            TextField("Relation", text: $draft.character.relations[index].relationType)
                            TextField("Description", text: $draft.character.relations[index].description, axis: .vertical)
                            Button("Remove Relation", systemImage: "minus.circle", role: .destructive) { draft.character.relations.remove(at: index) }
                        }
                    }
                    Button("Add Relation", systemImage: "plus") { draft.character.relations.append(CharacterRelation(targetId: "", relationType: "", description: "", extraJson: "{}")) }
                }
            }
            .disabled(busy || model.isBusy).navigationTitle("Character").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { if draft.requestDismiss() { dismiss() } }.disabled(busy || model.isBusy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        busy = true
                        Task {
                            defer { busy = false }
                            var saved: CharactersSnapshot?
                            do {
                                try await model.resourceChange { saved = try await NativeProjectStore.shared.saveCharacter(draft.character, at: model.directory, revision: draft.revision) }
                                if let saved { try draft.saved(saved) }
                                dismiss()
                            } catch {
                                if let saved { try? draft.saved(saved) }
                                self.error = error.localizedDescription
                            }
                        }
                    }.disabled(busy || model.isBusy || draft.character.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .interactiveDismissDisabled(busy || model.isBusy || draft.isDirty)
            .onChange(of: model.characters?.revision) { _, _ in
                if let snapshot = model.characters { draft.synchronize(with: snapshot) }
            }
            .confirmationDialog("Discard Changes?", isPresented: Binding(get: { draft.confirmingDiscard }, set: { if !$0 { draft.keepEditing() } }), titleVisibility: .visible) {
                Button("Discard Changes", role: .destructive) { dismiss() }
                Button("Keep Editing", role: .cancel) { draft.keepEditing() }
            }
            .sheet(item: $preview) { asset in AssetMediaView(url: model.assetURL(asset)) }
            .sheet(isPresented: $pickingReference) {
                NativeAssetPicker(model: model, category: "reference", prefix: "\(draft.character.id)/", allowClear: false) { asset in
                    if let asset {
                        let name = String(asset.name.dropFirst(draft.character.id.count + 1))
                        if !draft.character.referenceImages.contains(name) { draft.character.referenceImages.append(name) }
                    }
                }
            }
            .fileImporter(isPresented: $importingReference, allowedContentTypes: [.image]) { result in
                Task {
                    do {
                        let url = try result.get()
                        try await model.importAssets([url], category: "reference", prefix: "\(draft.character.id)/")
                        if !draft.character.referenceImages.contains(url.lastPathComponent) { draft.character.referenceImages.append(url.lastPathComponent) }
                    } catch { self.error = error.localizedDescription }
                }
            }
            .alert("Couldn't Save Changes", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) { error = nil }
            } message: { Text(error ?? "") }
        }
    }

    private func optional(_ key: WritableKeyPath<CharacterInfo, String?>) -> Binding<String> {
        Binding(get: { draft.character[keyPath: key] ?? "" }, set: { draft.character[keyPath: key] = $0.isEmpty ? nil : $0 })
    }
    private func list(_ key: WritableKeyPath<CharacterInfo, [String]>) -> Binding<String> {
        Binding(get: { draft.character[keyPath: key].joined(separator: ", ") }, set: { draft.character[keyPath: key] = $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } })
    }
}
