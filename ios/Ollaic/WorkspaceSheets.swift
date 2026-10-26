import SwiftUI

struct ScriptEntrySheet: View {
    @Environment(\.dismiss) private var dismiss
    let onSave: (ScriptEntry) async throws -> Void
    private let entryID: UUID
    private let creating: Bool
    @State private var kind: ScriptKind
    @State private var speaker: String
    @State private var text: String
    @State private var saving = false
    @State private var error: String?

    init(entry: ScriptEntry? = nil, kind: ScriptKind = .dialogue, onSave: @escaping (ScriptEntry) async throws -> Void) {
        self.onSave = onSave
        entryID = entry?.id ?? UUID()
        creating = entry == nil
        _kind = State(initialValue: entry?.kind ?? kind)
        _speaker = State(initialValue: entry?.speaker ?? "")
        _text = State(initialValue: entry?.text ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Type", selection: $kind) {
                        ForEach(ScriptKind.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("entry-kind")
                }
                if kind == .dialogue {
                    Section("Speaker") {
                        TextField("Speaker", text: $speaker)
                            .accessibilityIdentifier("entry-speaker")
                    }
                }
                Section(kind.title) {
                    TextField("Text", text: $text, axis: .vertical)
                        .lineLimit(7...16)
                        .accessibilityIdentifier("entry-text")
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .disabled(saving)
            .navigationTitle(creating ? String(localized: "New Entry") : String(localized: "Edit Entry"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        saving = true
                        Task {
                            defer { saving = false }
                            do {
                                try await onSave(ScriptEntry(
                                    id: entryID, kind: kind,
                                    speaker: kind == .dialogue ? speaker.trimmingCharacters(in: .whitespacesAndNewlines) : "",
                                    text: text.trimmingCharacters(in: .whitespacesAndNewlines)
                                ))
                                dismiss()
                            } catch { self.error = error.localizedDescription }
                        }
                    }
                    .fontWeight(.semibold)
                    .disabled(saving || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("save-entry")
                }
            }
            .alert("Couldn't Save Changes", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) { error = nil }
            } message: { Text(error ?? "") }
            .interactiveDismissDisabled(saving)
        }
    }
}

struct SceneNameSheet: View {
    @Environment(\.dismiss) private var dismiss
    let scene: DraftScene?
    let onSave: (String) async throws -> Void
    @State private var name: String
    @State private var saving = false
    @State private var error: String?

    init(scene: DraftScene? = nil, onSave: @escaping (String) async throws -> Void) {
        self.scene = scene
        self.onSave = onSave
        _name = State(initialValue: scene?.name ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Scene Name") {
                    TextField("Scene Name", text: $name)
                        .accessibilityIdentifier("scene-name")
                }
            }
            .disabled(saving)
            .navigationTitle(scene == nil ? String(localized: "New Scene") : String(localized: "Rename Scene"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        saving = true
                        Task {
                            defer { saving = false }
                            do {
                                try await onSave(name.trimmingCharacters(in: .whitespacesAndNewlines))
                                dismiss()
                            } catch { self.error = error.localizedDescription }
                        }
                    }
                    .disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("save-scene")
                }
            }
            .alert("Couldn't Save Changes", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) { error = nil }
            } message: { Text(error ?? "") }
            .interactiveDismissDisabled(saving)
        }
    }
}

struct WorkspaceNotesSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onSave: (String) async throws -> Void
    @State private var text: String
    @State private var saving = false
    @State private var error: String?

    init(notes: String, onSave: @escaping (String) async throws -> Void) {
        self.onSave = onSave
        _text = State(initialValue: notes)
    }

    var body: some View {
        NavigationStack {
            TextEditor(text: $text)
                .padding(12)
                .accessibilityIdentifier("workspace-notes")
                .disabled(saving)
                .navigationTitle("Writing Notes")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            saving = true
                            Task {
                                defer { saving = false }
                                do { try await onSave(text); dismiss() }
                                catch { self.error = error.localizedDescription }
                            }
                        }
                        .disabled(saving)
                        .accessibilityIdentifier("save-notes")
                    }
                }
                .alert("Couldn't Save Changes", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                    Button("OK", role: .cancel) { error = nil }
                } message: { Text(error ?? "") }
                .interactiveDismissDisabled(saving)
        }
    }
}
