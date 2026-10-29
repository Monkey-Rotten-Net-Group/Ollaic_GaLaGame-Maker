import Foundation

enum NativeTab: String, CaseIterable, Identifiable {
    case script, scenes, assets, project
    var id: String { rawValue }
}

enum NativeUsageTarget: Equatable {
    case command(sceneID: UUID, lineID: UUID)
    case character(String)
}

@MainActor
struct NativeEditorNavigation {
    var tab: NativeTab = .script
    private(set) var usageTarget: NativeUsageTarget?

    static func target(for usage: AssetUsage, in workspace: NativeWorkspace) -> NativeUsageTarget? {
        if usage.command == "character",
           let character = findNativeCharacter(usage.content, in: workspace.characters?.characters ?? []) {
            return .character(character.id)
        }
        guard let scene = workspace.document?.scenes.first(where: { $0.fileName == usage.fileName }) else { return nil }
        var start: UInt32 = 1
        for line in scene.lines where !line.source.isEmpty {
            let newlines = line.source.utf8.filter { $0 == 10 }.count
            let span = UInt32(max(1, newlines + (line.source.utf8.last == 10 ? 0 : 1)))
            if (start..<(start + span)).contains(usage.lineNumber) { return .command(sceneID: scene.id, lineID: line.id) }
            start += span
        }
        return nil
    }

    mutating func showUsage(_ usage: AssetUsage, in workspace: NativeWorkspace) -> Bool {
        guard let target = Self.target(for: usage, in: workspace) else { return false }
        if case .command(let sceneID, _) = target {
            workspace.selectedSceneID = sceneID
            tab = .script
        }
        usageTarget = target
        return true
    }
}
