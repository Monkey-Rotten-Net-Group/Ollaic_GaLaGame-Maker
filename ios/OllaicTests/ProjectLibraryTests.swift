import XCTest
@testable import Ollaic

final class ProjectLibraryTests: XCTestCase {
    @MainActor
    private func makeLibrary() async -> (ProjectLibrary, URL) {
        let directory = FileManager.default.temporaryDirectory.appending(path: "ollaic-history-test-\(UUID())")
        let fileURL = directory.appending(path: "library/projects.json")
        let library = ProjectLibrary(repository: ProjectRepository(fileURL: fileURL))
        await library.load()
        XCTAssertTrue(library.isLoaded)
        return (library, directory)
    }

    @MainActor
    private func createProject(in library: ProjectLibrary) async throws -> UUID {
        let id = try await library.saveProject(id: nil, name: "Story", synopsis: "", tint: .rose, favorite: false)
        try await library.openWorkspace(id)
        return id
    }

    @MainActor
    func testInterleavedEditorsShareUndoOrderAndPersistence() async throws {
        let (library, directory) = await makeLibrary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let id = try await createProject(in: library)
        try await library.editWorkspace(id) {
            $0.scenes[0].entries.append(ScriptEntry(kind: .narration, text: "Window A"))
        }
        try await library.openWorkspace(id)
        try await library.editWorkspace(id) {
            $0.scenes[0].entries.append(ScriptEntry(kind: .narration, text: "Window B"))
        }

        try await library.undoWorkspace(id)
        XCTAssertEqual(library.project(id)?.workspace?.scenes[0].entries.map(\.text), ["Window A"])
        let saved = try await ProjectRepository(fileURL: directory.appending(path: "library/projects.json")).load()
        XCTAssertEqual(saved.first?.workspace?.scenes[0].entries.map(\.text), ["Window A"])
        try await library.undoWorkspace(id)
        XCTAssertEqual(library.project(id)?.workspace?.scenes[0].entries.count, 0)
        XCTAssertFalse(library.canUndoWorkspace(id))
        try await library.redoWorkspace(id)
        try await library.redoWorkspace(id)
        XCTAssertEqual(library.project(id)?.workspace?.scenes[0].entries.map(\.text), ["Window A", "Window B"])
        XCTAssertFalse(library.canRedoWorkspace(id))
    }

    @MainActor
    func testBranchingAndTrashKeepProjectHistoriesIsolated() async throws {
        let (library, directory) = await makeLibrary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = try await createProject(in: library)
        let second = try await createProject(in: library)
        try await library.editWorkspace(first) { $0.notes = "First" }
        try await library.editWorkspace(second) { $0.notes = "Second" }
        try await library.undoWorkspace(first)
        XCTAssertEqual(library.project(second)?.workspace?.notes, "Second")
        try await library.editWorkspace(first) { _ in }
        XCTAssertTrue(library.canRedoWorkspace(first))
        try await library.editWorkspace(first) { $0.notes = "New branch" }
        XCTAssertFalse(library.canRedoWorkspace(first))
        try await library.undoWorkspace(second)
        XCTAssertEqual(library.project(first)?.workspace?.notes, "New branch")
        try await library.moveToTrash(second)
        try await library.emptyTrash()
        XCTAssertFalse(library.canRedoWorkspace(second))
        XCTAssertTrue(library.canUndoWorkspace(first))
    }

    @MainActor
    func testFailedWritesDoNotAdvanceHistory() async throws {
        let (library, directory) = await makeLibrary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let id = try await createProject(in: library)
        try await library.editWorkspace(id) { $0.notes = "Saved" }
        let parent = directory.appending(path: "library")
        let backup = directory.appending(path: "library-backup")
        try FileManager.default.moveItem(at: parent, to: backup)
        try Data("Blocked directory".utf8).write(to: parent)
        do {
            try await library.editWorkspace(id) { $0.notes = "Failed edit" }
            XCTFail("Expected the edit to fail")
        } catch {}
        do {
            try await library.undoWorkspace(id)
            XCTFail("Expected undo to fail")
        } catch {}
        XCTAssertEqual(library.project(id)?.workspace?.notes, "Saved")
        XCTAssertTrue(library.canUndoWorkspace(id))
        XCTAssertFalse(library.canRedoWorkspace(id))
        try FileManager.default.removeItem(at: parent)
        try FileManager.default.moveItem(at: backup, to: parent)
        try await library.undoWorkspace(id)
        XCTAssertEqual(library.project(id)?.workspace?.notes, "")
        try await library.redoWorkspace(id)
        XCTAssertEqual(library.project(id)?.workspace?.notes, "Saved")
    }

    @MainActor
    func testHistoryIsBoundedAndPermanentDeletionClearsIt() async throws {
        let (library, directory) = await makeLibrary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let id = try await createProject(in: library)
        for index in 1...51 { try await library.editWorkspace(id) { $0.notes = "\(index)" } }
        for _ in 0..<50 { try await library.undoWorkspace(id) }
        XCTAssertEqual(library.project(id)?.workspace?.notes, "1")
        XCTAssertFalse(library.canUndoWorkspace(id))
        XCTAssertTrue(library.canRedoWorkspace(id))
        try await library.moveToTrash(id)
        try await library.deletePermanently(id)
        XCTAssertFalse(library.canUndoWorkspace(id))
        XCTAssertFalse(library.canRedoWorkspace(id))
    }
}
