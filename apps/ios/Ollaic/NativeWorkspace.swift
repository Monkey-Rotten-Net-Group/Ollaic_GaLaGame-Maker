import Foundation
import Observation

enum NativeLineAction {
    case duplicate, moveUp, moveDown, delete
}

@MainActor
@Observable
final class NativeWorkspace {
    let projectID: UUID
    let directory: URL
    private(set) var document: NativeDocument?
    private(set) var revision = ""
    private(set) var assets: [AssetInfo] = []
    private(set) var characters: CharactersSnapshot?
    private(set) var isBusy = false
    private(set) var past: [NativeDocument] = []
    private(set) var future: [NativeDocument] = []
    var selectedSceneID: UUID?
    var error: String?
    private let store = NativeProjectStore.shared
    private let onSave: () async throws -> Void

    init(projectID: UUID, directory: URL, onSave: @escaping () async throws -> Void = {}) {
        self.projectID = projectID
        self.directory = directory
        self.onSave = onSave
    }

    var activeScene: NativeScene? {
        document?.scenes.first { $0.id == selectedSceneID } ?? document?.scenes.first
    }

    func load() async throws {
        guard !isBusy else { throw ProjectLibraryError.busy }
        isBusy = true
        defer { isBusy = false }
        try await reload()
    }

    private func reload(preservingLineOrder: Bool = false) async throws {
        let snapshot = try await store.load(directory)
        let assets = try await store.assets(directory)
        let characters = try await store.characters(directory)
        let previousFile = activeScene?.fileName
        var updated = NativeDocument(snapshot: snapshot)
        let previousSources = document.map { Dictionary(uniqueKeysWithValues: $0.scenes.map { ($0.fileName, $0.source) }) }
        let sources = Dictionary(uniqueKeysWithValues: snapshot.scenes.map { ($0.fileName, $0.source) })
        for index in updated.scenes.indices {
            guard let previous = document?.scenes.first(where: { $0.fileName == updated.scenes[index].fileName }) else { continue }
            updated.scenes[index].id = previous.id
            if updated.scenes[index].source == previous.source { updated.scenes[index].lines = previous.lines }
            else if preservingLineOrder && updated.scenes[index].lines.count == previous.lines.count {
                // Resource mutations rewrite references in place without inserting statements.
                for line in updated.scenes[index].lines.indices { updated.scenes[index].lines[line].id = previous.lines[line].id }
            }
        }
        var loadedRevision = snapshot.revision
        if preservingLineOrder, let previousSources, previousSources != sources {
            // Keep the cache consistent for Android readers and exported project archives.
            loadedRevision = try await store.save(updated, at: directory, projectID: projectID, revision: snapshot.revision)
        }
        document = updated
        revision = loadedRevision
        self.assets = assets
        self.characters = characters
        selectedSceneID = document?.scenes.first { $0.fileName == previousFile }?.id ?? document?.scenes.first?.id
        past.removeAll()
        future.removeAll()
    }

    func edit(_ mutation: (inout NativeDocument) throws -> Void) async throws {
        guard !isBusy else { throw ProjectLibraryError.busy }
        guard let original = document else { throw WorkspaceError.notReady }
        var updated = original
        try mutation(&updated)
        guard updated != original else { return }
        isBusy = true
        defer { isBusy = false }
        let revision = try await store.save(updated, at: directory, projectID: projectID, revision: revision)
        past.append(original)
        if past.count > 50 { past.removeFirst(past.count - 50) }
        future.removeAll()
        document = updated
        self.revision = revision
        await recordSave()
    }

    func restore(undo: Bool) async throws {
        guard !isBusy else { throw ProjectLibraryError.busy }
        guard let current = document, let target = undo ? past.last : future.last else { return }
        isBusy = true
        defer { isBusy = false }
        let revision = try await store.save(target, at: directory, projectID: projectID, revision: revision)
        if undo { past.removeLast(); future.append(current) }
        else { future.removeLast(); past.append(current) }
        document = target
        self.revision = revision
        await recordSave()
    }

    func saveLine(sceneID: UUID, lineID: UUID?, source: String, expectedSource: String? = nil) async throws {
        try await edit { document in
            guard let scene = document.scenes.firstIndex(where: { $0.id == sceneID }) else { throw WorkspaceError.missingScene }
            if let lineID {
                guard let line = document.scenes[scene].lines.firstIndex(where: { $0.id == lineID }) else { throw WorkspaceError.missingEntry }
                if let expectedSource, document.scenes[scene].lines[line].source != expectedSource { throw CommandDraftError.conflict }
                document.scenes[scene].lines[line].source = source
            } else { document.scenes[scene].lines.append(NativeLine(source: source)) }
        }
    }

    func saveSceneSource(sceneID: UUID, source: String, original: String) async throws {
        try await edit { document in
            guard let index = document.scenes.firstIndex(where: { $0.id == sceneID }) else { throw WorkspaceError.missingScene }
            let merged = try mergeScriptSource(before: original, draft: source, incoming: document.scenes[index].source)
            document.scenes[index].lines = decodeLines(source: merged).map { NativeLine(source: $0.source) }
        }
    }

    func changeLine(sceneID: UUID, lineID: UUID, action: NativeLineAction) async throws {
        try await edit { document in
            guard let scene = document.scenes.firstIndex(where: { $0.id == sceneID }),
                  let index = document.scenes[scene].lines.firstIndex(where: { $0.id == lineID }) else { throw WorkspaceError.missingEntry }
            var lines = document.scenes[scene].lines
            switch action {
            case .duplicate: lines.insert(NativeLine(source: lines[index].source), at: index + 1)
            case .delete: lines.remove(at: index)
            case .moveUp:
                guard let target = (0..<index).reversed().first(where: { !lines[$0].isBlank }) else { return }
                lines.insert(lines.remove(at: index), at: target)
            case .moveDown:
                guard let target = ((index + 1)..<lines.count).first(where: { !lines[$0].isBlank }) else { return }
                lines.insert(lines.remove(at: index), at: target)
            }
            document.scenes[scene].lines = lines
        }
    }

    func importScene(_ url: URL) async throws {
        let source = try await store.readText(url)
        let fileName = try sceneFileName(name: url.lastPathComponent)
        let scene = NativeScene(name: String(fileName.dropLast(4)), fileName: fileName,
                                lines: decodeLines(source: source).map { NativeLine(source: $0.source) })
        try await edit { document in
            guard !document.scenes.contains(where: { $0.fileName.lowercased() == fileName.lowercased() }) else { throw WorkspaceError.duplicateSceneName }
            document.scenes.append(scene)
        }
        selectedSceneID = scene.id
    }

    func saveScene(id: UUID?, name: String) async throws {
        let fileName = try sceneFileName(name: name)
        try await edit { document in
            if let id {
                guard let index = document.scenes.firstIndex(where: { $0.id == id }) else { throw WorkspaceError.missingScene }
                let old = document.scenes[index].fileName
                let new = old == "start.txt" ? old : fileName
                guard !document.scenes.contains(where: { $0.id != id && $0.fileName.lowercased() == new.lowercased() }) else { throw WorkspaceError.duplicateSceneName }
                document.scenes[index].name = name
                document.scenes[index].fileName = new
                for scene in document.scenes.indices {
                    for line in document.scenes[scene].lines.indices {
                        document.scenes[scene].lines[line].source = renameSceneReferences(source: document.scenes[scene].lines[line].source, oldName: old, newName: new)
                    }
                }
            } else {
                guard !document.scenes.contains(where: { $0.fileName.lowercased() == fileName.lowercased() }) else { throw WorkspaceError.duplicateSceneName }
                document.scenes.append(NativeScene(name: name, fileName: fileName, lines: []))
            }
        }
    }

    func deleteScene(_ id: UUID) async throws {
        try await edit { document in
            guard let scene = document.scenes.first(where: { $0.id == id }), scene.fileName != "start.txt" else {
                throw NativeProjectError.invalid(String(localized: "The entry scene cannot be deleted."))
            }
            document.scenes.removeAll { $0.id == id }
        }
    }

    func assetURL(_ asset: AssetInfo) -> URL {
        directory.appending(path: "game/\(asset.category)/\(asset.name)")
    }

    func importAssets(_ urls: [URL], category: String, prefix: String = "") async throws {
        try await resourceChange {
            for url in urls { try await self.store.importAsset(url, category: category, at: self.directory, name: prefix + url.lastPathComponent) }
        }
    }

    func resourceChange(_ operation: () async throws -> Void) async throws {
        guard !isBusy else { throw ProjectLibraryError.busy }
        isBusy = true
        defer { isBusy = false }
        let previousRevision = revision
        let previousAssets = assets
        let previousCharacters = characters
        do { try await operation() }
        catch {
            let failure = error
            // Resource journals may have committed part of a multi-file operation.
            try? await reload(preservingLineOrder: true)
            if revision != previousRevision || assets != previousAssets || characters != previousCharacters {
                await recordSave()
            }
            throw failure
        }
        await recordSave()
        try await reload(preservingLineOrder: true)
    }

    private func recordSave() async {
        // Content is already committed; an index failure must not make a retry duplicate it.
        do { try await onSave() }
        catch { self.error = error.localizedDescription }
    }

    func export() async throws -> ExportReport {
        guard !isBusy else { throw ProjectLibraryError.busy }
        isBusy = true
        defer { isBusy = false }
        return try await store.export(directory)
    }

    func perform(_ operation: @escaping () async throws -> Void) {
        Task { do { try await operation() } catch { self.error = error.localizedDescription } }
    }
}
