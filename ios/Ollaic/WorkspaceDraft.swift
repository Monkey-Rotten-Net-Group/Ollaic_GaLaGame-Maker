import Foundation

enum ScriptKind: String, Codable, CaseIterable, Identifiable, Sendable {
    case dialogue, narration, note
    var id: String { rawValue }

    var title: String {
        switch self {
        case .dialogue: String(localized: "Dialogue")
        case .narration: String(localized: "Narration")
        case .note: String(localized: "Note")
        }
    }

    var symbol: String {
        switch self {
        case .dialogue: "bubble.left"
        case .narration: "text.alignleft"
        case .note: "note.text"
        }
    }
}

struct ScriptEntry: Codable, Hashable, Identifiable, Sendable {
    var id = UUID()
    var kind: ScriptKind
    var speaker = ""
    var text: String
}

struct DraftScene: Codable, Hashable, Identifiable, Sendable {
    var id = UUID()
    var name: String
    var entries: [ScriptEntry] = []
}

struct WorkspaceDraft: Codable, Hashable, Sendable {
    var scenes: [DraftScene]
    var notes = ""

    static func initial() -> WorkspaceDraft {
        WorkspaceDraft(scenes: [DraftScene(name: String(localized: "Opening Scene"))])
    }

    func validate() throws {
        guard !scenes.isEmpty, Set(scenes.map(\.id)).count == scenes.count else {
            throw WorkspaceError.invalidDocument
        }
        var names = Set<String>()
        for scene in scenes {
            let name = scene.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { throw WorkspaceError.emptySceneName }
            guard names.insert(name.lowercased()).inserted else { throw WorkspaceError.duplicateSceneName }
            guard Set(scene.entries.map(\.id)).count == scene.entries.count,
                  scene.entries.allSatisfy({ !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
                throw WorkspaceError.invalidDocument
            }
        }
    }
}

enum WorkspaceError: LocalizedError {
    case invalidDocument, missingScene, missingEntry, emptySceneName, duplicateSceneName, notReady

    var errorDescription: String? {
        switch self {
        case .invalidDocument: String(localized: "The editor draft could not be read.")
        case .missingScene: String(localized: "This scene is no longer available.")
        case .missingEntry: String(localized: "This entry is no longer available.")
        case .emptySceneName: String(localized: "Enter a scene name.")
        case .duplicateSceneName: String(localized: "A scene with this name already exists.")
        case .notReady: String(localized: "The editor is not ready.")
        }
    }
}
