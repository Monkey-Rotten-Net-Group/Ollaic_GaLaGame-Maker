import Foundation

func matchingNativeCharacters(_ characters: [CharacterInfo], query: String) -> [CharacterInfo] {
    let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return characters }
    return characters.filter { character in
        ([character.name, character.description, character.personality] + character.aliases + character.keywords)
            .contains { $0.localizedStandardContains(query) }
    }
}

struct CharacterDraft {
    var character: CharacterInfo
    private(set) var original: CharacterInfo
    var revision: String
    private(set) var confirmingDiscard = false
    var isDirty: Bool { character != original }

    init(character: CharacterInfo, revision: String) {
        self.character = character
        self.original = character
        self.revision = revision
    }

    mutating func requestDismiss() -> Bool {
        confirmingDiscard = isDirty
        return !isDirty
    }

    mutating func keepEditing() { confirmingDiscard = false }

    mutating func moveSprite(from index: Int, to destination: Int) {
        guard index != destination, character.sprites.indices.contains(index), character.sprites.indices.contains(destination) else { return }
        let sprite = character.sprites.remove(at: index)
        character.sprites.insert(sprite, at: destination)
    }

    mutating func synchronize(with snapshot: CharactersSnapshot) {
        guard !character.id.isEmpty, let current = snapshot.characters.first(where: { $0.id == character.id }) else { return }
        if !isDirty { character = current; original = current; revision = snapshot.revision }
        else if current == original { revision = snapshot.revision }
    }

    mutating func saved(_ snapshot: CharactersSnapshot) throws {
        guard let saved = snapshot.characters.first(where: { character.id.isEmpty ? $0.name == character.name : $0.id == character.id }) else {
            throw NativeProjectError.invalid(String(localized: "This character is no longer available."))
        }
        character = saved
        original = saved
        revision = snapshot.revision
        confirmingDiscard = false
    }
}
