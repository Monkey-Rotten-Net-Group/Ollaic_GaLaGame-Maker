import Foundation
import XCTest
@testable import Ollaic

final class NativeEditorRegressionTests: XCTestCase {
    @MainActor
    func testMultilineTextSavesAllParagraphsWithEveryLineEnding() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        _ = try createProject(path: directory.path, name: "Paragraphs")
        let workspace = NativeWorkspace(projectID: UUID(), directory: directory)
        try await workspace.load()
        let sceneID = try XCTUnwrap(workspace.activeScene?.id)
        for source in ["Alice:Original -future=keep; trailing", "Original; trailing", "; Original"] {
            for ending in ["", "\n", "\r\n"] {
                let original = source + ending
                try await workspace.edit { $0.scenes[0].lines = [NativeLine(source: original)] }
                let lineID = try XCTUnwrap(workspace.activeScene?.lines.first?.id)
                var edit = try readCommand(source: original)
                edit.content = "First\n\nSecond"
                let rendered = try edit.renderedSource(original: original)
                try await workspace.saveLine(sceneID: sceneID, lineID: lineID, source: rendered)
                let saved = try loadWorkspace(path: directory.path).scenes[0].source
                XCTAssertEqual(saved, rendered)
                XCTAssertEqual(decodeLines(source: saved).filter { !$0.text.isEmpty }.map(\.text), ["First", "Second"])
                if ending == "\r\n" { XCTAssertTrue(saved.contains("\r\n\r\n")) }
                try await workspace.restore(undo: true)
                XCTAssertEqual(try loadWorkspace(path: directory.path).scenes[0].source, original)
            }
        }
    }

    @MainActor
    func testNativeActivityPersistsEditsHistoryResourcesAndCachedOpens() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let repository = ProjectRepository(fileURL: directory.appending(path: "projects.json"))
        var date = Date(timeIntervalSince1970: 100)
        let library = ProjectLibrary(repository: repository, now: { date })
        await library.load()
        let id = try await library.saveProject(id: nil, name: "Activity", synopsis: "", tint: .rose, favorite: false)
        date = Date(timeIntervalSince1970: 200)
        let workspace = try await library.nativeWorkspace(id)
        let sceneID = try XCTUnwrap(workspace.activeScene?.id)
        date = Date(timeIntervalSince1970: 300)
        let reopened = try await library.nativeWorkspace(id)
        XCTAssertTrue(workspace === reopened)
        XCTAssertEqual(library.project(id)?.lastOpenedAt, date)
        let openedProjects = try await repository.load()
        XCTAssertEqual(openedProjects.first?.lastOpenedAt, date)
        XCTAssertEqual(library.project(id)?.modifiedAt, Date(timeIntervalSince1970: 100))

        for (index, operation) in [
            { try await workspace.saveLine(sceneID: sceneID, lineID: nil, source: "Alice:Saved;\n") },
            { try await workspace.restore(undo: true) },
            { try await workspace.restore(undo: false) },
            { try await workspace.resourceChange {
                try await NativeProjectStore.shared.saveAnimation("fade.json", source: "[{\"alpha\":1,\"duration\":300}]", revision: "", at: workspace.directory)
            } },
        ].enumerated() {
            date = Date(timeIntervalSince1970: Double(400 + index * 100))
            try await operation()
            XCTAssertEqual(library.project(id)?.modifiedAt, date)
            let saved = try await repository.load()
            XCTAssertEqual(saved.first?.modifiedAt, date)
            XCTAssertNil(workspace.error)
        }

        let modifiedAt = library.project(id)?.modifiedAt
        date = Date(timeIntervalSince1970: 800)
        try await workspace.edit { _ in }
        XCTAssertEqual(library.project(id)?.modifiedAt, modifiedAt)
        do {
            try await workspace.resourceChange { throw WorkspaceError.missingEntry }
            XCTFail("Expected a failed resource operation")
        } catch {}
        XCTAssertEqual(library.project(id)?.modifiedAt, modifiedAt)
        try Data("External;\n".utf8).write(to: workspace.directory.appending(path: "game/scene/start.txt"))
        do {
            try await workspace.saveLine(sceneID: sceneID, lineID: nil, source: "Failed;\n")
            XCTFail("Expected a revision conflict")
        } catch {}
        XCTAssertEqual(library.project(id)?.modifiedAt, modifiedAt)
    }

    @MainActor
    func testIndexFailureDoesNotTurnCommittedContentIntoFailedSave() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appending(path: "projects.json")
        let repository = ProjectRepository(fileURL: fileURL)
        var date = Date(timeIntervalSince1970: 100)
        let library = ProjectLibrary(repository: repository, now: { date })
        await library.load()
        let id = try await library.saveProject(id: nil, name: "Index failure", synopsis: "", tint: .rose, favorite: false)
        let workspace = try await library.nativeWorkspace(id)
        let sceneID = try XCTUnwrap(workspace.activeScene?.id)
        let backup = directory.appending(path: "projects-backup.json")
        try FileManager.default.moveItem(at: fileURL, to: backup)
        try FileManager.default.createDirectory(at: fileURL, withIntermediateDirectories: false)
        date = Date(timeIntervalSince1970: 200)
        try await workspace.saveLine(sceneID: sceneID, lineID: nil, source: "Alice:Saved once;\n")
        XCTAssertNotNil(workspace.error)
        XCTAssertFalse(workspace.isBusy)
        XCTAssertEqual(workspace.past.count, 1)
        XCTAssertEqual(try loadWorkspace(path: workspace.directory.path).scenes[0].source, "Alice:Saved once;\n")
        XCTAssertEqual(library.project(id)?.modifiedAt, Date(timeIntervalSince1970: 100))
        try FileManager.default.removeItem(at: fileURL)
        try FileManager.default.moveItem(at: backup, to: fileURL)
        workspace.error = nil
        date = Date(timeIntervalSince1970: 300)
        try await workspace.saveLine(sceneID: sceneID, lineID: nil, source: "Alice:Next edit;\n")
        XCTAssertEqual(library.project(id)?.modifiedAt, date)
        XCTAssertNil(workspace.error)
        XCTAssertEqual(decodeLines(source: workspace.activeScene!.source).map(\.text), ["Saved once", "Next edit"])
    }

    @MainActor
    func testNativeActivityCoexistsWithAnotherLibraryWrite() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let repository = ProjectRepository(fileURL: directory.appending(path: "projects.json"))
        var date = Date(timeIntervalSince1970: 100)
        let library = ProjectLibrary(repository: repository, now: { date })
        await library.load()
        let id = try await library.saveProject(id: nil, name: "Concurrent", synopsis: "", tint: .rose, favorite: false)
        let workspace = try await library.nativeWorkspace(id)
        date = Date(timeIntervalSince1970: 200)
        async let favorite: Void = library.toggleFavorite(id)
        async let edit: Void = workspace.saveLine(sceneID: workspace.activeScene!.id, lineID: nil, source: "Saved;\n")
        _ = try await (favorite, edit)
        let saved = try await repository.load()
        XCTAssertEqual(saved.first?.isFavorite, true)
        XCTAssertEqual(saved.first?.modifiedAt, date)
        XCTAssertNil(workspace.error)
    }

    @MainActor
    func testAssetUsageSelectsItsSceneAndScriptTab() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        _ = try createProject(path: directory.path, name: "Usage navigation")
        let workspace = NativeWorkspace(projectID: UUID(), directory: directory)
        try await workspace.load()
        try await workspace.saveScene(id: nil, name: "chapter")
        let chapter = try XCTUnwrap(workspace.document?.scenes.first { $0.fileName == "chapter.txt" })
        try await workspace.saveLine(sceneID: chapter.id, lineID: nil, source: "changeBg:park.svg;\n")
        let usages = try assetUsages(path: directory.path, category: "background", name: "park.svg")
        let usage = try XCTUnwrap(usages.first)
        var navigation = NativeEditorNavigation(tab: .assets)
        XCTAssertTrue(navigation.showUsage(usage, in: workspace))
        XCTAssertEqual(navigation.tab, .script)
        XCTAssertEqual(workspace.activeScene?.id, chapter.id)

        navigation.tab = .assets
        let missing = AssetUsage(fileName: "missing.txt", lineNumber: 1, command: "changeBg", content: "park.svg")
        XCTAssertFalse(navigation.showUsage(missing, in: workspace))
        XCTAssertEqual(navigation.tab, .assets)
        XCTAssertEqual(workspace.activeScene?.id, chapter.id)
    }

    @MainActor
    func testPreviewResumesOnlyAfterBackgroundAndReleasesStoppedSessions() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let repository = PreviewRepository(directory: directory.appending(path: "runtime"))
        let engine = await repository.engineURL
        try FileManager.default.createDirectory(at: engine.appending(path: "assets"), withIntermediateDirectories: true)
        try Data("<!doctype html><html><body>Offline preview</body></html>".utf8).write(to: engine.appending(path: "index.html"))
        try Data("{\"webgalVersion\":\"\(previewEngineVersion())\"}".utf8).write(to: engine.appending(path: "webgal-engine.json"))
        let project = directory.appending(path: "project")
        _ = try createProject(path: project.path, name: "Lifecycle")
        let model = RuntimePreviewModel(repository: repository)
        defer { model.stop() }
        model.start(project)
        try await waitUntil { model.url != nil || model.error != nil }
        let url = try XCTUnwrap(model.url, model.error ?? "Missing preview URL")
        let session = try XCTUnwrap(model.session)
        model.pageFinished()
        model.resume(project)
        XCTAssertEqual(model.url, url)
        XCTAssertTrue(model.session === session)
        XCTAssertTrue(model.pageLoaded)

        model.suspend()
        XCTAssertNil(model.url)
        let client = URLSession(configuration: .ephemeral)
        defer { client.invalidateAndCancel() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while true {
            var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
            request.timeoutInterval = 1
            do { _ = try await client.data(for: request) } catch { break }
            guard ContinuousClock.now < deadline else { XCTFail("Stopped preview port is still open"); return }
            try await Task.sleep(for: .milliseconds(25))
        }
        model.resume(project)
        try await waitUntil { model.url != nil || model.error != nil }
        XCTAssertNil(model.error)
        XCTAssertNotEqual(model.url, url)
        XCTAssertFalse(model.session === session)
        XCTAssertFalse(model.pageLoaded)
        let resumed = model.url
        model.resume(project)
        XCTAssertEqual(model.url, resumed)
        model.suspend()
        model.stop()
        model.resume(project)
        XCTAssertNil(model.url)
        XCTAssertFalse(model.busy)
    }

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory.appending(path: "ollaic-regression-\(UUID())")
    }

    @MainActor
    private func waitUntil(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while !predicate() {
            guard ContinuousClock.now < deadline else { throw NativeProjectError.invalid("Timed out waiting for preview") }
            try await Task.sleep(for: .milliseconds(25))
        }
    }
}
