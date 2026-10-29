import Foundation

struct NativeLine: Identifiable, Equatable, Sendable {
    var id = UUID()
    var source: String
    var isBlank: Bool { source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var decoded: ScriptLine {
        let lines = decodeLines(source: source)
        if lines.count == 1 { return lines[0] }
        let text = source.trimmingCharacters(in: .newlines)
        return ScriptLine(source: source, kind: "Command", speaker: "", text: text, command: "raw", preview: text)
    }
}

struct NativeScene: Identifiable, Equatable, Sendable {
    var id = UUID()
    var name: String
    var fileName: String
    var lines: [NativeLine]
    var source: String { assembleLines(lines: lines.map(\.source)) }
}

struct NativeDocument: Equatable, Sendable {
    private struct EditorCache: Decodable {
        struct Scene: Decodable {
            struct Line: Decodable { let id: UUID; let source: String }
            let id: UUID
            let name: String
            let fileName: String
            let blocks: [Line]
        }
        let version: Int
        let scenes: [Scene]
    }

    var scenes: [NativeScene]
    var notes: String
    var editorState: String

    init(snapshot: WorkspaceSnapshot) {
        notes = snapshot.notes
        editorState = snapshot.editorState
        scenes = snapshot.scenes.sorted {
            if ($0.fileName == "start.txt") != ($1.fileName == "start.txt") { return $0.fileName == "start.txt" }
            return $0.fileName < $1.fileName
        }.map { scene in
            return NativeScene(name: String(scene.fileName.dropLast(4)), fileName: scene.fileName,
                               lines: decodeLines(source: scene.source).map { NativeLine(source: $0.source) })
        }
        if let data = snapshot.editorState.data(using: .utf8),
           let cache = try? JSONDecoder().decode(EditorCache.self, from: data), cache.version == 2,
           Set(cache.scenes.map(\.fileName)).count == cache.scenes.count,
           Set(cache.scenes.map(\.id)).count == cache.scenes.count,
           cache.scenes.allSatisfy({ Set($0.blocks.map(\.id)).count == $0.blocks.count }) {
            let actual = Dictionary(uniqueKeysWithValues: scenes.map { ($0.fileName, $0) })
            // Presentation metadata survives source changes; cached script bytes never replace files.
            let restored = cache.scenes.compactMap { cached -> NativeScene? in
                guard let scene = actual[cached.fileName] else { return nil }
                let lines = assembleLines(lines: cached.blocks.map(\.source)) == scene.source
                    ? cached.blocks.map { NativeLine(id: $0.id, source: $0.source) } : scene.lines
                return NativeScene(id: cached.id, name: cached.name, fileName: cached.fileName, lines: lines)
            }
            let known = Set(restored.map(\.fileName))
            scenes = restored + scenes.filter { !known.contains($0.fileName) }
        }
    }

    func state(projectID: UUID) throws -> String {
        let scenes: [[String: Any]] = scenes.map { scene in
            ["id": scene.id.uuidString, "name": scene.name, "fileName": scene.fileName,
             "blocks": scene.lines.map { line -> [String: Any] in
                 let decoded = line.decoded
                 // Android reconstructs raw blocks from text, including multiline statement groups.
                 let text = decoded.command == "raw" ? line.source : decoded.text
                 return ["id": line.id.uuidString, "kind": decoded.kind, "speaker": decoded.speaker,
                         "text": text, "source": line.source]
             }]
        }
        var root = editorState.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any] ?? [:]
        root["version"] = 2
        root["projectId"] = projectID.uuidString
        root["scenes"] = scenes
        root["notes"] = notes
        return String(decoding: try JSONSerialization.data(withJSONObject: root, options: [.sortedKeys]), as: UTF8.self)
    }
}

extension ProjectRepository {
    func managedURL(_ id: UUID) -> URL {
        fileURL.deletingLastPathComponent().appending(path: "ManagedProjects/\(id.uuidString)", directoryHint: .isDirectory)
    }

    func removeManaged(_ id: UUID) { try? FileManager.default.removeItem(at: managedURL(id)) }

    func prepareNative(_ project: LocalProject) throws -> UUID {
        if let id = project.nativeProjectID {
            _ = try openProject(path: managedURL(id).path)
            return id
        }
        let id = UUID()
        let destination = managedURL(id)
        let staging = destination.deletingLastPathComponent().appending(path: ".staging-\(id)")
        defer { try? FileManager.default.removeItem(at: staging) }
        _ = try createProject(path: staging.path, name: project.name)
        try updateProjectMetadata(path: staging.path, name: project.name, description: project.synopsis)
        if let legacy = project.workspace {
            let snapshot = try loadWorkspace(path: staging.path)
            var document = NativeDocument(snapshot: snapshot)
            document.scenes = try legacy.scenes.enumerated().map { index, scene in
                let file = index == 0 ? "start.txt" : "scene-\(scene.id.uuidString).txt"
                let lines = try scene.entries.map { entry in
                    let kind = entry.kind == .dialogue ? "Dialogue" : (entry.kind == .narration ? "Narration" : "Note")
                    return NativeLine(id: entry.id, source: try editLine(original: "", kind: kind, speaker: entry.speaker, text: entry.text))
                }
                return NativeScene(id: scene.id, name: scene.name, fileName: file, lines: lines)
            }
            document.notes = legacy.notes
            _ = try saveWorkspace(path: staging.path, scenes: document.scenes.map { SceneSource(fileName: $0.fileName, source: $0.source) },
                                  notes: document.notes, editorState: document.state(projectID: project.id), expectedRevision: snapshot.revision)
        }
        try FileManager.default.moveItem(at: staging, to: destination)
        return id
    }

    func importNative(_ source: URL) throws -> LocalProject {
        let id = UUID()
        let destination = managedURL(id)
        do {
            let summary = try DocumentAccess.withFile(source, limit: 512 * 1024 * 1024) {
                try importProject(archivePath: $0.path, targetPath: destination.path)
            }
            return LocalProject(id: UUID(), name: summary.name, synopsis: summary.description, tint: .rose,
                                createdAt: .now, modifiedAt: .now, isFavorite: false, nativeProjectID: id)
        } catch {
            removeManaged(id)
            throw error
        }
    }
}

enum NativeProjectError: LocalizedError {
    case invalid(String)
    var errorDescription: String? { switch self { case .invalid(let message): message } }
}

// All filesystem and FFI work runs on this actor, away from SwiftUI's main actor.
actor NativeProjectStore {
    static let shared = NativeProjectStore()

    func load(_ url: URL) throws -> WorkspaceSnapshot { try loadWorkspace(path: url.path) }

    func save(_ document: NativeDocument, at url: URL, projectID: UUID, revision: String) throws -> String {
        try saveWorkspace(path: url.path, scenes: document.scenes.map { SceneSource(fileName: $0.fileName, source: $0.source) },
                          notes: document.notes, editorState: document.state(projectID: projectID), expectedRevision: revision)
    }

    func assets(_ url: URL) throws -> [AssetInfo] { try listAssets(path: url.path) }
    func characters(_ url: URL) throws -> CharactersSnapshot { try loadCharacters(path: url.path) }
    func saveCharacter(_ value: CharacterInfo, at url: URL, revision: String) throws -> CharactersSnapshot {
        try Ollaic.saveCharacter(path: url.path, character: value, expectedRevision: revision)
    }
    func deleteCharacter(_ id: String, at url: URL, revision: String) throws -> CharactersSnapshot {
        try Ollaic.deleteCharacter(path: url.path, id: id, expectedRevision: revision)
    }
    func details(_ asset: AssetInfo, at url: URL) throws -> AssetDetails {
        var details = try assetDetails(path: url.path, category: asset.category, name: asset.name)
        details.references = try NativeAssetReferences(asset: asset).normalized(details.references)
        return details
    }
    func usages(_ asset: AssetInfo, at url: URL) throws -> [AssetUsage] { try assetUsages(path: url.path, category: asset.category, name: asset.name) }
    func saveDetails(_ details: AssetDetails, asset: AssetInfo, at url: URL) throws {
        var details = details
        details.references = try NativeAssetReferences(asset: asset).normalized(details.references)
        try saveAssetDetails(path: url.path, category: asset.category, name: asset.name, details: details)
    }
    func rename(_ asset: AssetInfo, to name: String, at url: URL, revision: String) throws {
        try renameAsset(path: url.path, category: asset.category, oldName: asset.name, newName: name, expectedRevision: revision)
    }
    func delete(_ asset: AssetInfo, at url: URL, revision: String) throws {
        try deleteAsset(path: url.path, category: asset.category, name: asset.name, expectedRevision: revision)
    }
    func animation(_ name: String, at url: URL) throws -> TextResource { try readAnimation(path: url.path, name: name) }
    func saveAnimation(_ name: String, source: String, revision: String, at url: URL) throws {
        _ = try Ollaic.saveAnimation(path: url.path, name: name, source: source, expectedRevision: revision)
    }
    func importAsset(_ source: URL, category: String, at url: URL, name: String? = nil) throws {
        try DocumentAccess.withFile(source, limit: 512 * 1024 * 1024) { file in
            _ = try Ollaic.importAsset(path: url.path, sourcePath: file.path, category: category, name: name ?? source.lastPathComponent)
        }
    }
    func readText(_ source: URL) throws -> String {
        try DocumentAccess.withFile(source, limit: 32 * 1024 * 1024) { try String(contentsOf: $0, encoding: .utf8) }
    }
    func export(_ url: URL) throws -> ExportReport {
        let directory = FileManager.default.temporaryDirectory.appending(path: "OllaicExport-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        do { return try exportProject(path: url.path, archivePath: directory.appending(path: "project.zip").path) }
        catch { try? FileManager.default.removeItem(at: directory); throw error }
    }
}

enum DocumentAccess {
    static func withFile<T>(_ url: URL, limit: Int, body: (URL) throws -> T) throws -> T {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        var coordinationError: NSError?
        var result: Result<T, Error>?
        NSFileCoordinator().coordinate(readingItemAt: url, options: .withoutChanges, error: &coordinationError) { readable in
            result = Result {
                let size = try readable.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
                guard size.isRegularFile == true, let bytes = size.fileSize, bytes <= limit else {
                    throw NativeProjectError.invalid(String(localized: "The selected file is too large or unavailable."))
                }
                return try body(readable)
            }
        }
        if let coordinationError { throw coordinationError }
        guard let result else { throw NativeProjectError.invalid(String(localized: "The selected file could not be read.")) }
        return try result.get()
    }
}
