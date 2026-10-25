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
        guard document.version == 1 else { throw ProjectLibraryError.unsupportedVersion }
        guard Set(document.projects.map(\.id)).count == document.projects.count else {
            throw ProjectLibraryError.invalidLibrary
        }
        return document.projects
    }

    func save(_ projects: [LocalProject]) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(Document(projects: projects))
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: fileURL, options: .atomic)
    }
}

@MainActor
@Observable
final class ProjectLibrary {
    private(set) var projects: [LocalProject] = []
    private(set) var isLoading = false
    private(set) var isLoaded = false
    private(set) var isSaving = false
    private(set) var loadError: String?
    private let repository: ProjectRepository

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
        }
    }

    func emptyTrash() async throws {
        try await change { $0.removeAll(where: \.isDeleted) }
    }

    private func update(_ id: UUID, mutation: (inout LocalProject) -> Void) async throws {
        try await change { projects in
            guard let index = projects.firstIndex(where: { $0.id == id }) else {
                throw ProjectLibraryError.missingProject
            }
            mutation(&projects[index])
        }
    }

    private func change(_ mutation: (inout [LocalProject]) throws -> Void) async throws {
        guard isLoaded else { throw ProjectLibraryError.notReady }
        guard !isSaving else { throw ProjectLibraryError.busy }
        isSaving = true
        defer { isSaving = false }
        var updated = projects
        try mutation(&updated)
        // Publish only after the atomic write succeeds, keeping failed saves reversible.
        try await repository.save(updated)
        projects = updated
    }
}
