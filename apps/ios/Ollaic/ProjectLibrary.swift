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
    var nativeProjectID: UUID?

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

    let fileURL: URL

    init(fileURL: URL = ProjectRepository.defaultFileURL) {
        self.fileURL = fileURL
    }

    func load() throws -> [LocalProject] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let document = try decoder.decode(Document.self, from: Data(contentsOf: fileURL))
        guard (1...3).contains(document.version) else { throw ProjectLibraryError.unsupportedVersion }
        guard Set(document.projects.map(\.id)).count == document.projects.count else {
            throw ProjectLibraryError.invalidLibrary
        }
        for project in document.projects { try project.workspace?.validate() }
        return try document.projects.map { project in
            var project = project
            if let nativeID = project.nativeProjectID {
                let summary = try openProject(path: managedURL(nativeID).path)
                project.name = summary.name
                project.synopsis = summary.description
            }
            return project
        }
    }

    func save(_ projects: [LocalProject]) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        // Version 2 prevents older apps from rewriting a library without its editor content.
        let version = projects.contains { $0.nativeProjectID != nil } ? 3 : (projects.contains { $0.workspace != nil } ? 2 : 1)
        let data = try encoder.encode(Document(version: version, projects: projects))
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        var originals: [ProjectSummary] = []
        do {
            for project in projects {
                guard let nativeID = project.nativeProjectID else { continue }
                let path = managedURL(nativeID).path
                let original = try openProject(path: path)
                if original.name != project.name || original.description != project.synopsis {
                    originals.append(original)
                    try updateProjectMetadata(path: path, name: project.name, description: project.synopsis)
                }
            }
            try data.write(to: fileURL, options: .atomic)
        } catch {
            for original in originals {
                try? updateProjectMetadata(path: original.path, name: original.name, description: original.description)
            }
            throw error
        }
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
    private let now: () -> Date
    private var saveWaiters: [CheckedContinuation<Void, Never>] = []
    private var workspaceHistories: [UUID: WorkspaceHistory] = [:]
    private var nativeWorkspaces: [UUID: NativeWorkspace] = [:]
    private var nativeOpenings: [UUID: Task<NativeWorkspace, Error>] = [:]

    init(repository: ProjectRepository = ProjectRepository(), now: @escaping () -> Date = Date.init) {
        self.repository = repository
        self.now = now
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

    func nativeWorkspace(_ id: UUID) async throws -> NativeWorkspace {
        if let workspace = nativeWorkspaces[id] {
            try await markOpened(id)
            return workspace
        }
        if let opening = nativeOpenings[id] { return try await opening.value }
        let opening = Task { [self] in
            let directory = try await self.openNativeProject(id)
            let workspace = NativeWorkspace(projectID: id, directory: directory) { [weak self] in
                guard let self else { return }
                try await self.recordNativeChange(id)
            }
            try await workspace.load()
            self.nativeWorkspaces[id] = workspace
            return workspace
        }
        nativeOpenings[id] = opening
        defer { nativeOpenings.removeValue(forKey: id) }
        return try await opening.value
    }

    @discardableResult
    func saveProject(id: UUID?, name: String, synopsis: String, tint: ProjectTint, favorite: Bool) async throws -> UUID {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw ProjectLibraryError.emptyName }
        let isNew = id == nil
        let id = id ?? UUID()
        if isNew {
            guard isLoaded else { throw ProjectLibraryError.notReady }
            guard !isSaving else { throw ProjectLibraryError.busy }
            isSaving = true
            defer { finishSaving() }
            let date = now()
            var project = LocalProject(id: id, name: name, synopsis: synopsis.trimmingCharacters(in: .whitespacesAndNewlines),
                                       tint: tint, createdAt: date, modifiedAt: date, isFavorite: favorite, workspace: .initial())
            let nativeID = try await repository.prepareNative(project)
            project.nativeProjectID = nativeID
            do {
                let updated = projects + [project]
                try await repository.save(updated)
                projects = updated
            } catch {
                await repository.removeManaged(nativeID)
                throw error
            }
            return id
        }
        try await change { projects in
            if let index = projects.firstIndex(where: { $0.id == id }) {
                guard !projects[index].isDeleted else { throw ProjectLibraryError.missingProject }
                projects[index].name = name
                projects[index].synopsis = synopsis.trimmingCharacters(in: .whitespacesAndNewlines)
                projects[index].tint = tint
                projects[index].isFavorite = favorite
                projects[index].modifiedAt = self.now()
            } else {
                throw ProjectLibraryError.missingProject
            }
        }
        return id
    }

    func markOpened(_ id: UUID) async throws {
        await waitForSave()
        try await update(id) {
            guard !$0.isDeleted else { throw ProjectLibraryError.missingProject }
            $0.lastOpenedAt = self.now()
        }
    }

    func openWorkspace(_ id: UUID) async throws {
        try await update(id) { project in
            guard !project.isDeleted else { throw ProjectLibraryError.missingProject }
            if project.workspace == nil { project.workspace = .initial() }
            project.lastOpenedAt = self.now()
        }
    }

    func openNativeProject(_ id: UUID) async throws -> URL {
        guard isLoaded else { throw ProjectLibraryError.notReady }
        guard !isSaving else { throw ProjectLibraryError.busy }
        guard let project = project(id), !project.isDeleted else { throw ProjectLibraryError.missingProject }
        isSaving = true
        defer { finishSaving() }
        let nativeID = try await repository.prepareNative(project)
        do {
            var updated = projects
            guard let index = updated.firstIndex(where: { $0.id == id }) else { throw ProjectLibraryError.missingProject }
            updated[index].nativeProjectID = nativeID
            updated[index].lastOpenedAt = now()
            try await repository.save(updated)
            projects = updated
        } catch {
            if project.nativeProjectID == nil { await repository.removeManaged(nativeID) }
            throw error
        }
        return await repository.managedURL(nativeID)
    }

    func importArchive(_ source: URL) async throws {
        guard isLoaded else { throw ProjectLibraryError.notReady }
        guard !isSaving else { throw ProjectLibraryError.busy }
        isSaving = true
        defer { finishSaving() }
        let imported = try await repository.importNative(source)
        do {
            var updated = projects
            updated.append(imported)
            try await repository.save(updated)
            projects = updated
        } catch {
            if let nativeID = imported.nativeProjectID { await repository.removeManaged(nativeID) }
            throw error
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
            project.modifiedAt = self.now()
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
            project.modifiedAt = self.now()
            updatedHistory = history
        } onCommit: {
            if let updatedHistory { self.workspaceHistories[id] = updatedHistory }
        }
    }

    func toggleFavorite(_ id: UUID) async throws {
        try await update(id) { $0.isFavorite.toggle() }
    }

    func moveToTrash(_ id: UUID) async throws {
        guard nativeWorkspaces[id]?.isBusy != true else { throw ProjectLibraryError.busy }
        try await update(id) { $0.deletedAt = self.now() }
    }

    func restore(_ id: UUID) async throws {
        try await update(id) { $0.deletedAt = nil }
    }

    func deletePermanently(_ id: UUID) async throws {
        guard nativeWorkspaces[id]?.isBusy != true else { throw ProjectLibraryError.busy }
        let nativeID = project(id)?.nativeProjectID
        try await change { projects in
            guard let index = projects.firstIndex(where: { $0.id == id }), projects[index].isDeleted else {
                throw ProjectLibraryError.missingProject
            }
            projects.remove(at: index)
        } onCommit: {
            self.workspaceHistories.removeValue(forKey: id)
            self.nativeWorkspaces.removeValue(forKey: id)
        }
        if let nativeID { await repository.removeManaged(nativeID) }
    }

    func emptyTrash() async throws {
        guard !projects.filter(\.isDeleted).contains(where: { nativeWorkspaces[$0.id]?.isBusy == true }) else { throw ProjectLibraryError.busy }
        let nativeIDs = projects.filter(\.isDeleted).compactMap(\.nativeProjectID)
        try await change { $0.removeAll(where: \.isDeleted) } onCommit: {
            self.workspaceHistories = self.workspaceHistories.filter { self.project($0.key) != nil }
            self.nativeWorkspaces = self.nativeWorkspaces.filter { self.project($0.key) != nil }
        }
        for nativeID in nativeIDs { await repository.removeManaged(nativeID) }
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
        defer { finishSaving() }
        var updated = projects
        try mutation(&updated)
        // Publish only after the atomic write succeeds, keeping failed saves reversible.
        try await repository.save(updated)
        projects = updated
        onCommit()
    }

    private func recordNativeChange(_ id: UUID) async throws {
        let date = now()
        // A library update may be writing the index when a native save finishes.
        await waitForSave()
        try await update(id) { $0.modifiedAt = max($0.modifiedAt, date) }
    }

    private func waitForSave() async {
        while isSaving { await withCheckedContinuation { saveWaiters.append($0) } }
    }

    private func finishSaving() {
        isSaving = false
        let waiters = saveWaiters
        saveWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }
}
