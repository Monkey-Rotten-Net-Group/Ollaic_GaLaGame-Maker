import SwiftUI

extension CommandKind {
    static let editorKinds: [Self] = [.dialogue, .narrator, .comment, .intro, .choose, .changeScene, .callScene, .end,
                                     .label, .jumpLabel, .setVar, .getUserInput, .setTextbox, .setTransform,
                                     .changeBg, .changeFigure, .miniAvatar, .bgm, .playEffect, .playVideo,
                                     .setAnimation, .unlockCg, .unlockBgm]
    var editorTitle: String {
        switch self {
        case .dialogue: String(localized: "Dialogue")
        case .narrator: String(localized: "Narration")
        case .comment: String(localized: "Note")
        case .intro: String(localized: "Intro")
        case .choose: String(localized: "Choices")
        case .changeScene: String(localized: "Change Scene")
        case .callScene: String(localized: "Call Scene")
        case .end: String(localized: "End")
        case .label: String(localized: "Label")
        case .jumpLabel: String(localized: "Jump to Label")
        case .setVar: String(localized: "Set Variable")
        case .getUserInput: String(localized: "User Input")
        case .setTextbox: String(localized: "Textbox")
        case .setTransform: String(localized: "Transform")
        case .changeBg: String(localized: "Background")
        case .changeFigure: String(localized: "Figure")
        case .miniAvatar: String(localized: "Mini Avatar")
        case .bgm: String(localized: "Background Music")
        case .playEffect: String(localized: "Sound Effect")
        case .playVideo: String(localized: "Video")
        case .setAnimation: String(localized: "Animation")
        case .unlockCg: String(localized: "Unlock CG")
        case .unlockBgm: String(localized: "Unlock BGM")
        }
    }
    var editorIdentifier: String {
        switch self {
        case .dialogue: "new-dialogue"
        case .narrator: "new-narration"
        case .comment: "new-note"
        default: "new-\(String(describing: self))"
        }
    }
    var editorSymbol: String {
        switch self {
        case .dialogue: "bubble.left"
        case .narrator: "text.alignleft"
        case .comment: "note.text"
        case .intro: "display"
        case .choose: "arrow.triangle.branch"
        case .changeScene: "arrow.right"
        case .callScene: "arrow.turn.down.right"
        case .end: "stop.circle"
        case .label: "tag"
        case .jumpLabel: "arrow.right.to.line"
        case .setVar: "function"
        case .getUserInput: "keyboard"
        case .setTextbox: "text.bubble"
        case .setTransform: "arrow.up.and.down.and.arrow.left.and.right"
        case .changeBg: "photo"
        case .changeFigure: "person"
        case .miniAvatar: "person.crop.circle"
        case .bgm: "music.note"
        case .playEffect: "speaker.wave.2"
        case .playVideo: "film"
        case .setAnimation: "wand.and.stars"
        case .unlockCg, .unlockBgm: "lock.open"
        }
    }
    var categoryColor: Color {
        let tones: (light: UInt32, dark: UInt32)
        switch self {
        case .dialogue: tones = (0xA43758, 0xEEB1C9)
        case .narrator: tones = (0x006398, 0x9ED1FA)
        case .comment: tones = (0x006B56, 0x8BDBBF)
        case .changeBg, .unlockCg: tones = (0x047857, 0x6EE7B7)
        case .changeFigure, .miniAvatar: tones = (0x7E22CE, 0xD8B4FE)
        case .bgm, .playEffect, .playVideo, .unlockBgm: tones = (0x0369A1, 0x7DD3FC)
        case .intro, .setAnimation, .setTransform: tones = (0x5B21B6, 0xC4B5FD)
        case .choose, .changeScene, .callScene, .end, .label, .jumpLabel,
             .setVar, .getUserInput, .setTextbox:
            tones = (0x92400E, 0xFCD34D)
        }
        // Caption accents need darker light-mode colors than the system tint palette.
        return Color(uiColor: UIColor { traits in
            let rgb = traits.userInterfaceStyle == .dark ? tones.dark : tones.light
            return UIColor(
                red: CGFloat((rgb >> 16) & 0xFF) / 255,
                green: CGFloat((rgb >> 8) & 0xFF) / 255,
                blue: CGFloat(rgb & 0xFF) / 255,
                alpha: 1
            )
        })
    }
    var assetCategory: String? {
        switch self {
        case .changeBg, .unlockCg: "background"
        case .changeFigure, .miniAvatar: "figure"
        case .bgm, .unlockBgm: "bgm"
        case .playEffect: "vocal"
        case .playVideo: "video"
        case .setAnimation: "animation"
        default: nil
        }
    }
}

@MainActor
struct CommandEditorSheet: View {
    @Environment(\.dismiss) private var dismiss
    let model: NativeWorkspace
    let sceneID: UUID
    let line: NativeLine?
    @State private var draft: CommandDraft
    @State private var busy = false
    @State private var error: String?
    @State private var showingConflict = false

    private var currentSource: String? {
        model.document?.scenes.first { $0.id == sceneID }?.lines.first { $0.id == line?.id }?.source
    }

    init(model: NativeWorkspace, sceneID: UUID, line: NativeLine?, kind: CommandKind?) {
        self.model = model
        self.sceneID = sceneID
        self.line = line
        _draft = State(initialValue: CommandDraft(source: line?.source, kind: kind))
    }

    var body: some View {
        NavigationStack {
            Form {
                Picker("Editor Mode", selection: Binding(get: { draft.rawMode }, set: { switchMode($0) })) {
                    Text("Form").tag(false)
                    Text("Source").tag(true)
                }.pickerStyle(.segmented).accessibilityIdentifier("command-mode")
                if draft.hasConflict {
                    Button("Review Project Changes") { showingConflict = true }
                }
                if draft.rawMode {
                    TextEditor(text: $draft.raw).font(.system(.body, design: .monospaced)).frame(minHeight: 260).accessibilityIdentifier("entry-text")
                } else {
                    Section {
                        Picker("Command Type", selection: Binding(get: { draft.edit.kind }, set: { kind in
                            draft.edit = draft.edit.changingKind(to: kind, sceneNames: model.document?.scenes.map(\.fileName) ?? [])
                            error = nil
                        })) {
                            ForEach(CommandKind.editorKinds, id: \.self) { kind in
                                Label(kind.editorTitle, systemImage: kind.editorSymbol).tag(kind)
                            }
                        }
                        .pickerStyle(.menu)
                        .accessibilityIdentifier("command-type-picker")
                    }
                    fields.id(draft.edit.kind)
                    if draft.edit.kind != .comment {
                        Section("Execution") {
                            Toggle("Continue Automatically", isOn: $draft.edit.next)
                            TextField("Condition", text: $draft.edit.when)
                        }
                    }
                }
            }
            .disabled(busy || model.isBusy).navigationTitle(draft.rawMode ? String(localized: "Raw Command") : draft.edit.kind.editorTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(busy || model.isBusy || draft.hasConflict || (line != nil && currentSource == nil)
                                  || (draft.rawMode && draft.raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                        .accessibilityIdentifier("save-entry")
                }
            }
            .interactiveDismissDisabled(busy)
            .alert("Couldn't Save Changes", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) { error = nil }
            } message: { Text(error ?? "") }
            .onChange(of: currentSource) { _, incoming in
                if let incoming, !draft.synchronize(with: incoming) { showingConflict = true }
                else if incoming == nil && line != nil { error = WorkspaceError.missingEntry.localizedDescription }
            }
            .alert("Command Updated", isPresented: $showingConflict) {
                Button("Use Project Version") { if let currentSource { draft.useProjectVersion(currentSource) } }
                Button("Keep My Changes", role: .destructive) { if let currentSource { draft.keepMyChanges(over: currentSource) } }
            } message: { Text("This content changed in the project. Review the latest version before saving.") }
        }
    }

    @ViewBuilder private var fields: some View {
        switch draft.edit.kind {
        case .dialogue, .narrator, .comment:
            Section {
                if draft.edit.kind == .dialogue {
                    HStack {
                        TextField("Speaker", text: Binding(get: { draft.edit.speaker }, set: {
                            draft.edit.selectSpeaker($0, characters: model.characters?.characters ?? [])
                        })).accessibilityIdentifier("entry-speaker")
                        Menu {
                            ForEach(model.characters?.characters ?? [], id: \.id) { character in
                                ForEach([character.name] + character.aliases, id: \.self) { name in
                                    Button(name) { draft.edit.selectSpeaker(name, characters: model.characters?.characters ?? []) }
                                }
                            }
                        } label: { Image(systemName: "person.crop.rectangle") }.accessibilityLabel("Character")
                    }
                }
                TextField("Text", text: $draft.edit.content, axis: .vertical).lineLimit(5...14).accessibilityIdentifier("entry-text")
                if draft.edit.kind != .comment { AssetReferenceField(title: String(localized: "Voice"), selection: $draft.edit.voice, category: "vocal", model: model, emptyValue: "") }
            }
        case .intro:
            Section("Text") {
                TextField("Text", text: Binding(get: { draft.edit.introLines.joined(separator: "\n") }, set: { draft.edit.introLines = $0.components(separatedBy: "\n") }), axis: .vertical).lineLimit(5...14)
            }
        case .choose:
            Section("Choices") {
                ForEach(draft.edit.choices.indices, id: \.self) { index in
                    VStack(alignment: .leading) {
                        TextField("Choice Text", text: $draft.edit.choices[index].text)
                        targetField(String(localized: "Target"), selection: $draft.edit.choices[index].target, labels: true)
                        HStack {
                            Button("Move Up", systemImage: "arrow.up") { draft.edit.choices.swapAt(index, index - 1) }.disabled(index == 0)
                            Button("Move Down", systemImage: "arrow.down") { draft.edit.choices.swapAt(index, index + 1) }.disabled(index + 1 == draft.edit.choices.count)
                            Spacer()
                            Button("Delete", systemImage: "trash", role: .destructive) { draft.edit.choices.remove(at: index) }
                        }.labelStyle(.iconOnly).buttonStyle(.borderless)
                    }
                }
                Button("Add Choice", systemImage: "plus") { draft.edit.choices.append(CommandChoice(text: "", target: "")) }
            }
        case .changeScene, .callScene:
            Section { targetField(String(localized: "Scene"), selection: $draft.edit.scene, labels: false) }
        case .label, .jumpLabel:
            Section { targetField(String(localized: "Label"), selection: $draft.edit.label, labels: true, scenes: false) }
        case .setVar:
            Section { TextField("Variable", text: $draft.edit.variable); TextField("Value", text: $draft.edit.value) }
        case .getUserInput:
            Section {
                TextField("Variable", text: $draft.edit.variable)
                TextField("Title", text: $draft.edit.title)
                TextField("Button", text: $draft.edit.button)
            }
        case .setTextbox:
            Section { Picker("Textbox", selection: $draft.edit.content) { Text("Show").tag("show"); Text("Hide").tag("hide") } }
        case .setTransform:
            Section("Transform") { TextEditor(text: $draft.edit.content).font(.system(.body, design: .monospaced)).frame(minHeight: 160); TextField("Target", text: $draft.edit.target) }
        case .end: EmptyView()
        default:
            if let category = draft.edit.kind.assetCategory {
                Section {
                    AssetReferenceField(title: draft.edit.kind.editorTitle, selection: assetSelection, category: category, model: model,
                                        allowClear: ![.unlockCg, .unlockBgm, .setAnimation].contains(draft.edit.kind),
                                        allowsManualEntry: draft.edit.kind != .changeFigure)
                    if [.bgm, .playEffect, .playVideo].contains(draft.edit.kind) {
                        Toggle("Custom Volume", isOn: Binding(get: { draft.edit.volume != nil }, set: { draft.edit.volume = $0 ? 100 : nil }))
                        if draft.edit.volume != nil {
                            Stepper("Volume: \(draft.edit.volume ?? 100)", value: Binding(get: { Int(draft.edit.volume ?? 100) }, set: { draft.edit.volume = Int32($0) }), in: 0...100)
                        }
                    }
                    if [.unlockCg, .unlockBgm].contains(draft.edit.kind) { TextField("Display Name", text: $draft.edit.displayName) }
                    if draft.edit.kind == .setAnimation { TextField("Target", text: $draft.edit.target) }
                }
                if draft.edit.kind == .changeFigure { figureFields }
            }
        }
    }

    private var figureFields: some View {
        Section("Figure") {
            Picker("Position", selection: $draft.edit.figurePosition) {
                Text("Left").tag("left"); Text("Center").tag("center"); Text("Right").tag("right")
            }.pickerStyle(.segmented)
            Picker("Character", selection: Binding(get: {
                findNativeCharacter(draft.edit.figureCharacter, in: model.characters?.characters ?? [])?.id ?? draft.edit.figureCharacter
            }, set: { id in
                draft.edit.selectFigureCharacter(id, characters: model.characters?.characters ?? [], assets: model.assets)
            })) {
                Text("None").tag("")
                if !draft.edit.figureCharacter.isEmpty,
                   findNativeCharacter(draft.edit.figureCharacter, in: model.characters?.characters ?? []) == nil {
                    Text(draft.edit.figureCharacter).tag(draft.edit.figureCharacter)
                }
                ForEach(model.characters?.characters ?? [], id: \.id) { character in
                    Text(character.name).tag(character.id)
                }
            }.pickerStyle(.menu)
            if let character = findNativeCharacter(draft.edit.figureCharacter, in: model.characters?.characters ?? []) {
                Picker("Sprite", selection: Binding(get: { selectedSpriteIndex(character) }, set: { index in
                    if index == -1 { draft.edit.selectFigureAsset("none", characters: model.characters?.characters ?? [], assets: model.assets) }
                    else if character.sprites.indices.contains(index) {
                        do { try draft.edit.selectFigureSprite(character.sprites[index], character: character, assets: model.assets) }
                        catch { self.error = error.localizedDescription }
                    }
                })) {
                    Text("None").tag(-1)
                    if selectedSpriteIndex(character) == -2 { Text(draft.edit.figureEmotion).tag(-2) }
                    ForEach(character.sprites.indices, id: \.self) { index in
                        let sprite = character.sprites[index]
                        let file = (try? resolveSprite(character: character, sprite: sprite, assets: model.assets)) ?? ""
                        let repeated = character.sprites.filter { $0.emotion == sprite.emotion }.count > 1
                        Text(repeated ? "\(sprite.emotion) (\(URL(fileURLWithPath: file).lastPathComponent))" : sprite.emotion)
                            .tag(index).disabled(file.isEmpty)
                    }
                }.pickerStyle(.menu)
            } else {
                Picker("Sprite", selection: .constant(-1)) { Text("None").tag(-1) }.disabled(true)
            }
            DisclosureGroup("Advanced") {
                TextField("Figure ID", text: $draft.edit.figureId)
            }
        }
    }

    private func selectedSpriteIndex(_ character: CharacterInfo) -> Int {
        character.sprites.firstIndex {
            ($0.emotion == draft.edit.figureEmotion || draft.edit.figureEmotion.isEmpty)
                && (try? resolveSprite(character: character, sprite: $0, assets: model.assets)) == draft.edit.asset
        } ?? (draft.edit.figureEmotion.isEmpty ? -1 : -2)
    }

    private var assetSelection: Binding<String> {
        Binding(get: { draft.edit.asset }, set: { name in
            if draft.edit.kind == .changeFigure {
                draft.edit.selectFigureAsset(name, characters: model.characters?.characters ?? [], assets: model.assets)
            } else { draft.edit.asset = name }
        })
    }

    private func targetField(_ title: String, selection: Binding<String>, labels: Bool, scenes: Bool = true) -> some View {
        HStack {
            TextField(title, text: selection)
            Menu {
                Button("Continue") { selection.wrappedValue = "" }
                if scenes {
                    ForEach(model.document?.scenes ?? []) { scene in Button(scene.name) { selection.wrappedValue = scene.fileName } }
                }
                if labels {
                    let names = Set(model.activeScene?.lines.compactMap { try? readCommand(source: $0.source) }.filter { $0.kind == .label }.map(\.label) ?? []).sorted()
                    ForEach(names, id: \.self) { label in Button(label) { selection.wrappedValue = label } }
                }
            } label: { Image(systemName: "list.bullet") }.accessibilityLabel(title)
        }
    }

    private func save() {
        busy = true
        Task {
            defer { busy = false }
            do {
                if let currentSource, !draft.synchronize(with: currentSource) { showingConflict = true; return }
                let source = try draft.renderedSource()
                try await model.saveLine(sceneID: sceneID, lineID: line?.id, source: source,
                                         expectedSource: line == nil ? nil : draft.observedSource)
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }

    private func switchMode(_ source: Bool) {
        do {
            try draft.switchMode(source)
        } catch { self.error = error.localizedDescription }
    }
}

struct AssetReferenceField: View {
    let title: String
    @Binding var selection: String
    let category: String
    let model: NativeWorkspace
    var emptyValue = "none"
    var allowClear = true
    var allowsManualEntry = true
    @State private var preview: AssetInfo?
    @State private var picking = false

    var body: some View {
        HStack {
            if allowsManualEntry {
                TextField(title, text: $selection)
                Button("Select Asset", systemImage: "folder") { picking = true }
                    .labelStyle(.iconOnly).accessibilityLabel(title).help("Select Asset")
            } else {
                Button { picking = true } label: {
                    HStack {
                        Text(title).foregroundStyle(.primary)
                        Spacer()
                        Text(selectedAssetName).foregroundStyle(.secondary).lineLimit(1)
                        Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(.secondary)
                    }.contentShape(Rectangle())
                }.buttonStyle(.plain)
            }
            if let asset = model.assets.first(where: { $0.category == category && $0.name == selection }) {
                Button("Preview", systemImage: "eye") { preview = asset }.labelStyle(.iconOnly).help("Preview")
            }
        }
        .sheet(item: $preview) { asset in AssetMediaView(url: model.assetURL(asset)) }
        .sheet(isPresented: $picking) {
            NativeAssetPicker(model: model, category: category, selection: selection, allowClear: allowClear) {
                selection = $0?.name ?? emptyValue
            }
        }
    }

    private var selectedAssetName: String {
        if selection.isEmpty || selection == "none" { return String(localized: "None") }
        let asset = model.assets.first { $0.category == category && $0.name == selection }
        return asset.flatMap { $0.alias.isEmpty ? nil : $0.alias } ?? selection
    }
}

extension AssetInfo: Identifiable {
    public var id: String { "\(category)/\(name)" }
}
