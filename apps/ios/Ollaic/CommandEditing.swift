import Foundation

enum CommandDraftError: LocalizedError {
    case conflict
    var errorDescription: String? { String(localized: "This content changed in the project. Review the latest version before saving.") }
}

struct CommandDraft {
    var edit: CommandEdit
    var raw: String
    private(set) var rawMode: Bool
    private(set) var observedSource: String
    private var originalSource: String
    private(set) var hasConflict = false

    init(source: String?, kind: CommandKind? = nil) {
        let source = source ?? ""
        let parsed = try? readCommand(source: source)
        edit = parsed ?? newCommand(kind: kind ?? .dialogue)
        raw = source
        originalSource = source
        observedSource = source
        rawMode = parsed == nil && kind == nil
    }

    func renderedSource() throws -> String {
        rawMode ? raw : try edit.renderedSource(original: originalSource)
    }

    mutating func switchMode(_ source: Bool) throws {
        if source { raw = try edit.renderedSource(original: originalSource) }
        else {
            edit = raw.isEmpty ? newCommand(kind: edit.kind) : try readCommand(source: raw)
            originalSource = raw
        }
        rawMode = source
    }

    @discardableResult
    mutating func synchronize(with incoming: String) -> Bool {
        guard !hasConflict else { return false }
        guard incoming != observedSource else { return true }
        do {
            let mergedSource = try mergeScriptSource(before: observedSource, draft: rawMode ? raw : originalSource, incoming: incoming)
            let mergedEdit = rawMode ? edit : try mergeCommandFields(before: readCommand(source: observedSource), draft: edit,
                                                                   incoming: readCommand(source: incoming))
            if rawMode { raw = mergedSource; originalSource = incoming }
            else {
                edit = mergedEdit
                originalSource = mergedSource
                raw = mergedSource
            }
            observedSource = incoming
            return true
        } catch {
            hasConflict = true
            return false
        }
    }

    mutating func useProjectVersion(_ source: String) {
        let parsed = try? readCommand(source: source)
        edit = parsed ?? newCommand(kind: edit.kind)
        raw = source
        rawMode = parsed == nil
        originalSource = source
        observedSource = source
        hasConflict = false
    }

    mutating func keepMyChanges(over source: String) {
        observedSource = source
        hasConflict = false
    }
}

func mergeScriptSource(before: String, draft: String, incoming: String) throws -> String {
    if draft == before || draft == incoming { return incoming }
    if incoming == before { return draft }
    let base = Array(before)
    func change(_ value: String) -> (range: Range<Int>, replacement: [Character]) {
        let value = Array(value)
        var prefix = 0
        while prefix < min(base.count, value.count), base[prefix] == value[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < min(base.count, value.count) - prefix,
              base[base.count - 1 - suffix] == value[value.count - 1 - suffix] { suffix += 1 }
        return (prefix..<(base.count - suffix), Array(value[prefix..<(value.count - suffix)]))
    }
    let local = change(draft)
    let project = change(incoming)
    if (local.range.isEmpty && project.range.isEmpty && local.range.lowerBound == project.range.lowerBound)
        || (local.range.upperBound > project.range.lowerBound && project.range.upperBound > local.range.lowerBound) {
        throw CommandDraftError.conflict
    }
    var result = base
    // Apply disjoint edits from the right so both ranges refer to the original source.
    for edit in [local, project].sorted(by: {
        $0.range.lowerBound == $1.range.lowerBound ? $0.range.upperBound > $1.range.upperBound : $0.range.lowerBound > $1.range.lowerBound
    }) { result.replaceSubrange(edit.range, with: edit.replacement) }
    return String(result)
}

private func mergeCommandFields(before: CommandEdit, draft: CommandEdit, incoming: CommandEdit) throws -> CommandEdit {
    if draft.kind != before.kind {
        guard incoming == before || incoming == draft else { throw CommandDraftError.conflict }
        return draft
    }
    if incoming.kind != before.kind {
        guard draft == before else { throw CommandDraftError.conflict }
        return incoming
    }
    var result = incoming
    func merge<Value: Equatable>(_ key: WritableKeyPath<CommandEdit, Value>) throws {
        if draft[keyPath: key] != before[keyPath: key] {
            guard incoming[keyPath: key] == before[keyPath: key] || incoming[keyPath: key] == draft[keyPath: key] else { throw CommandDraftError.conflict }
            result[keyPath: key] = draft[keyPath: key]
        }
    }
    try merge(\.choices); try merge(\.content); try merge(\.speaker); try merge(\.scene)
    try merge(\.label); try merge(\.variable); try merge(\.value); try merge(\.title)
    try merge(\.button); try merge(\.introLines); try merge(\.target); try merge(\.next)
    try merge(\.when); try merge(\.asset); try merge(\.voice); try merge(\.figurePosition)
    try merge(\.figureId); try merge(\.figureCharacter); try merge(\.figureEmotion)
    try merge(\.volume); try merge(\.displayName)
    return result
}

func findNativeCharacter(_ value: String, in characters: [CharacterInfo]) -> CharacterInfo? {
    let key = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !key.isEmpty else { return nil }
    return characters.first { ([$0.id, $0.name] + $0.aliases).contains { $0.lowercased() == key } }
}

extension CommandEdit {
    func renderedSource(original: String) throws -> String {
        try editCommand(original: original, edit: self)
    }

    mutating func selectSpeaker(_ name: String, characters: [CharacterInfo]) {
        speaker = name
        if voice.isEmpty { voice = findNativeCharacter(name, in: characters)?.defaultVoice ?? voice }
    }

    mutating func selectFigureCharacter(_ name: String, characters: [CharacterInfo], assets: [AssetInfo]) {
        guard let character = findNativeCharacter(name, in: characters) else {
            figureCharacter = name; figureEmotion = ""
            return
        }
        figureCharacter = character.name
        if let sprite = character.sprites.first(where: { (try? resolveSprite(character: character, sprite: $0, assets: assets)).map { !$0.isEmpty } ?? false }),
           let file = try? resolveSprite(character: character, sprite: sprite, assets: assets) {
            figureEmotion = sprite.emotion
            asset = file
        } else { figureEmotion = "" }
    }

    mutating func selectFigureEmotion(_ emotion: String, characters: [CharacterInfo], assets: [AssetInfo]) {
        figureEmotion = emotion
        if let character = findNativeCharacter(figureCharacter, in: characters),
           let sprite = character.sprites.first(where: { $0.emotion == emotion }),
           let file = try? resolveSprite(character: character, sprite: sprite, assets: assets), !file.isEmpty {
            figureCharacter = character.name
            asset = file
        }
    }

    mutating func selectFigureSprite(_ sprite: CharacterSprite, character: CharacterInfo, assets: [AssetInfo]) throws {
        let file = try resolveSprite(character: character, sprite: sprite, assets: assets)
        guard !file.isEmpty else { throw NativeProjectError.invalid(String(localized: "The selected sprite has no image.")) }
        figureCharacter = character.name
        figureEmotion = sprite.emotion
        asset = file
    }

    mutating func selectFigureAsset(_ name: String, characters: [CharacterInfo], assets: [AssetInfo]) {
        asset = name
        guard !name.isEmpty && name != "none" else { figureCharacter = ""; figureEmotion = ""; return }
        for character in characters {
            if let sprite = character.sprites.first(where: { (try? resolveSprite(character: character, sprite: $0, assets: assets)) == name }) {
                figureCharacter = character.name; figureEmotion = sprite.emotion
                return
            }
        }
        figureCharacter = ""; figureEmotion = ""
    }

    func changingKind(to kind: CommandKind, sceneNames: [String]) -> CommandEdit {
        guard kind != self.kind else { return self }
        var replacement = newCommand(kind: kind)
        let textKinds: [CommandKind] = [.dialogue, .narrator, .comment]
        if textKinds.contains(kind), textKinds.contains(self.kind) {
            replacement.content = content
        }
        replacement.speaker = speaker
        replacement.next = next
        replacement.when = when
        if [.changeScene, .callScene].contains(kind) {
            replacement.scene = sceneNames.first ?? ""
        }
        return replacement
    }
}
