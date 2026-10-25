import Foundation
import Observation

enum ProjectTint: String, Codable, CaseIterable, Identifiable, Sendable {
    case rose, blue, green, gold, coral, graphite

    var id: String { rawValue }
}

struct LocalProject: Codable, Identifiable, Hashable, Sendable {
    let id: UUID
    var name: String
    var synopsis: String
    var tint: ProjectTint
    let createdAt: Date
    var modifiedAt: Date
    var lastOpenedAt: Date?
    var isFavorite: Bool
    var deletedAt: Date?
    var workspace: WorkspaceDraft?

    var lastActivity: Date { max(modifiedAt, lastOpenedAt ?? modifiedAt) }
    var isDeleted: Bool { deletedAt != nil }
}

enum ProjectLibraryError: LocalizedError {
    case unsupportedVersion, invalidLibrary, notReady, busy, missingProject, emptyName

    var errorDescription: String? {
        switch self {
        case .unsupportedVersion: String(localized: "This project library requires a newer version of Ollaic.")
        case .invalidLibrary: String(localized: "The project library could not be read.")
        case .notReady: String(localized: "The project library is not ready.")
        case .busy: String(localized: "Another change is being saved.")
        case .missingProject: String(localized: "This project is no longer available.")
        case .emptyName: String(localized: "Enter a project name.")
        }
    }
}

actor ProjectRepository {
    private struct Document: Codable {
        var version = 1
        var projects: [LocalProject]
    }

    static var defaultFileURL: URL {
        URL.applicationSupportDirectory
            .appending(path: "ProjectLibrary", directoryHint: .isDirectory)
            .appending(path: "projects.json")
    }

    private let fileURL: URL

    init(fileURL: URL = ProjectRepository.defaultFileURL) {
        self.fileURL = fileURL
    }

    func load() throws -> [LocalProject] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let document = try decoder.decode(Document.self, from: Data(contentsOf: fileURL))
        guard (1...2).contains(document.version) else { throw ProjectLibraryError.unsupportedVersion }
        guard Set(document.projects.map(\.id)).count == document.projects.count else {
            throw ProjectLibraryError.invalidLibrary
        }
        for project in document.projects { try project.workspace?.validate() }
        return document.projects
    }

    func save(_ projects: [LocalProject]) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        // Version 2 prevents older apps from rewriting a library without its editor content.
        let version = projects.contains { $0.workspace != nil } ? 2 : 1
        let data = try encoder.encode(Document(version: version, projects: projects))
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: fileURL, options: .atomic)
    }
}

@MainActor
@Observable
final class ProjectLibrary {
    private struct WorkspaceHistory {
        var past: [WorkspaceDraft] = []
        var future: [WorkspaceDraft] = []
    }

    private(set) var projects: [LocalProject] = []
    private(set) var isLoading = false
    private(set) var isLoaded = false
    private(set) var isSaving = false
    private(set) var loadError: String?
    private let repository: ProjectRepository
    private var workspaceHistories: [UUID: WorkspaceHistory] = [:]

    init(repository: ProjectRepository = ProjectRepository()) {
        self.repository = repository
    }

    func load() async {
        guard !isLoading, !isLoaded else { return }
        isLoading = true
        loadError = nil
        defer { isLoading = false }
        do {
            projects = try await repository.load()
            isLoaded = true
        } catch {
            loadError = error.localizedDescription
        }
    }

    func project(_ id: UUID) -> LocalProject? {
        projects.first { $0.id == id }
    }

    @discardableResult
    func saveProject(id: UUID?, name: String, synopsis: String, tint: ProjectTint, favorite: Bool) async throws -> UUID {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw ProjectLibraryError.emptyName }
        let isNew = id == nil
        let id = id ?? UUID()
        try await change { projects in
            if let index = projects.firstIndex(where: { $0.id == id }) {
                guard !projects[index].isDeleted else { throw ProjectLibraryError.missingProject }
                projects[index].name = name
                projects[index].synopsis = synopsis.trimmingCharacters(in: .whitespacesAndNewlines)
                projects[index].tint = tint
                projects[index].isFavorite = favorite
                projects[index].modifiedAt = .now
            } else {
                guard isNew else { throw ProjectLibraryError.missingProject }
                projects.append(LocalProject(
                    id: id, name: name, synopsis: synopsis.trimmingCharacters(in: .whitespacesAndNewlines),
                    tint: tint, createdAt: .now, modifiedAt: .now, isFavorite: favorite
                ))
            }
        }
        return id
    }

    func markOpened(_ id: UUID) async throws {
        try await update(id) { $0.lastOpenedAt = .now }
    }

    func openWorkspace(_ id: UUID) async throws {
        try await update(id) { project in
            guard !project.isDeleted else { throw ProjectLibraryError.missingProject }
            if project.workspace == nil { project.workspace = .initial() }
            project.lastOpenedAt = .now
        }
    }

    @discardableResult
    func editWorkspace(_ id: UUID, mutation: (inout WorkspaceDraft) throws -> Void) async throws -> WorkspaceDraft {
        var previous: WorkspaceDraft?
        var updatedHistory: WorkspaceHistory?
        try await update(id) { project in
            guard !project.isDeleted else { throw ProjectLibraryError.missingProject }
            guard var draft = project.workspace else { throw WorkspaceError.notReady }
            let original = draft
            previous = original
            try mutation(&draft)
            try draft.validate()
            if draft != original {
                var history = self.workspaceHistories[id] ?? WorkspaceHistory()
                history.past.append(original)
                if history.past.count > 50 { history.past.removeFirst(history.past.count - 50) }
                history.future.removeAll()
                updatedHistory = history
            }
            project.workspace = draft
            project.modifiedAt = .now
        } onCommit: {
            if let updatedHistory { self.workspaceHistories[id] = updatedHistory }
        }
        guard let previous else { throw WorkspaceError.notReady }
        return previous
    }

    func canUndoWorkspace(_ id: UUID) -> Bool { workspaceHistories[id]?.past.isEmpty == false }
    func canRedoWorkspace(_ id: UUID) -> Bool { workspaceHistories[id]?.future.isEmpty == false }

    func undoWorkspace(_ id: UUID) async throws { try await restoreWorkspaceHistory(id, undo: true) }
    func redoWorkspace(_ id: UUID) async throws { try await restoreWorkspaceHistory(id, undo: false) }

    private func restoreWorkspaceHistory(_ id: UUID, undo: Bool) async throws {
        var updatedHistory: WorkspaceHistory?
        try await update(id) { project in
            guard !project.isDeleted else { throw ProjectLibraryError.missingProject }
            guard let draft = project.workspace else { throw WorkspaceError.notReady }
            var history = self.workspaceHistories[id] ?? WorkspaceHistory()
            guard let target = undo ? history.past.last : history.future.last else { return }
            if undo {
                history.past.removeLast()
                history.future.append(draft)
            } else {
                history.future.removeLast()
                history.past.append(draft)
            }
            project.workspace = target
            project.modifiedAt = .now
            updatedHistory = history
        } onCommit: {
            if let updatedHistory { self.workspaceHistories[id] = updatedHistory }
        }
    }

    func toggleFavorite(_ id: UUID) async throws {
        try await update(id) { $0.isFavorite.toggle() }
    }

    func moveToTrash(_ id: UUID) async throws {
        try await update(id) { $0.deletedAt = .now }
    }

    func restore(_ id: UUID) async throws {
        try await update(id) { $0.deletedAt = nil }
    }

    func deletePermanently(_ id: UUID) async throws {
        try await change { projects in
            guard let index = projects.firstIndex(where: { $0.id == id }), projects[index].isDeleted else {
                throw ProjectLibraryError.missingProject
            }
            projects.remove(at: index)
        } onCommit: {
            self.workspaceHistories.removeValue(forKey: id)
        }
    }

    func emptyTrash() async throws {
        try await change { $0.removeAll(where: \.isDeleted) } onCommit: {
            self.workspaceHistories = self.workspaceHistories.filter { self.project($0.key) != nil }
        }
    }

    private func update(_ id: UUID, mutation: (inout LocalProject) throws -> Void, onCommit: () -> Void = {}) async throws {
        try await change { projects in
            guard let index = projects.firstIndex(where: { $0.id == id }) else {
                throw ProjectLibraryError.missingProject
            }
            try mutation(&projects[index])
        } onCommit: { onCommit() }
    }

    private func change(_ mutation: (inout [LocalProject]) throws -> Void, onCommit: () -> Void = {}) async throws {
        guard isLoaded else { throw ProjectLibraryError.notReady }
        guard !isSaving else { throw ProjectLibraryError.busy }
        isSaving = true
        defer { isSaving = false }
        var updated = projects
        try mutation(&updated)
        // Publish only after the atomic write succeeds, keeping failed saves reversible.
        try await repository.save(updated)
        projects = updated
        onCommit()
    }
}
