import XCTest
import WebKit
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

extension ProjectLibraryTests {
    @MainActor
    func testLegacyMigrationPreservesNotesAndLibraryAndSharesWorkspace() async throws {
        let (library, directory) = await makeLibrary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let id = try await createProject(in: library)
        try await library.editWorkspace(id) {
            $0.notes = "Preserved legacy notes"
            $0.scenes[0].entries = [ScriptEntry(kind: .dialogue, speaker: "Alice", text: "Hello; world")]
            $0.scenes.append(DraftScene(name: "Chapter 2", entries: [ScriptEntry(kind: .note, text: "Direction")]))
        }
        let repository = ProjectRepository(fileURL: directory.appending(path: "library/projects.json"))
        var legacy = try await repository.load()
        legacy[0].nativeProjectID = nil
        try await repository.save(legacy)
        let migratingLibrary = ProjectLibrary(repository: repository)
        await migratingLibrary.load()
        let workspace = try await migratingLibrary.nativeWorkspace(id)
        let otherWindow = try await migratingLibrary.nativeWorkspace(id)
        XCTAssertTrue(workspace === otherWindow)
        let snapshot = try loadWorkspace(path: workspace.directory.path)
        XCTAssertEqual(snapshot.notes, "Preserved legacy notes")
        XCTAssertEqual(decodeLines(source: snapshot.scenes.first { $0.fileName == "start.txt" }!.source)[0].text, "Hello; world")
        XCTAssertEqual(library.project(id)?.workspace?.notes, "Preserved legacy notes")
        let restored = ProjectLibrary(repository: ProjectRepository(fileURL: directory.appending(path: "library/projects.json")))
        await restored.load()
        let reopened = try await restored.nativeWorkspace(id)
        XCTAssertEqual(reopened.document?.scenes.map(\.name), [String(localized: "Opening Scene"), "Chapter 2"])
        XCTAssertEqual(reopened.document?.notes, snapshot.notes)
    }

    @MainActor
    func testSceneCreationKeepsSelectionAndRenameUpdatesReferences() async throws {
        let (library, directory) = await makeLibrary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let id = try await createProject(in: library)
        let workspace = try await library.nativeWorkspace(id)
        let opening = workspace.activeScene!.id
        try await workspace.saveScene(id: nil, name: "chapter")
        XCTAssertEqual(workspace.activeScene?.id, opening)
        try await workspace.saveLine(sceneID: opening, lineID: nil, source: "choose:Next:chapter.txt|Stay:; keep\r\n")
        let chapter = workspace.document!.scenes.first { $0.fileName == "chapter.txt" }!
        try await workspace.saveScene(id: chapter.id, name: "finale")
        XCTAssertTrue(workspace.activeScene!.source.contains("finale.txt"))
        XCTAssertTrue(workspace.activeScene!.source.hasSuffix("; keep\r\n"))
        do { try await workspace.deleteScene(opening); XCTFail("Entry scene deletion must fail") } catch {}
        try await workspace.restore(undo: true)
        XCTAssertTrue(workspace.activeScene!.source.contains("chapter.txt"))
        try await workspace.restore(undo: false)
        XCTAssertTrue(workspace.activeScene!.source.contains("finale.txt"))
    }

    @MainActor
    func testExternalConflictDoesNotAdvanceNativeHistoryOrOverwriteSource() async throws {
        let (library, directory) = await makeLibrary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let id = try await createProject(in: library)
        let workspace = try await library.nativeWorkspace(id)
        let scene = workspace.activeScene!.id
        try await workspace.saveLine(sceneID: scene, lineID: nil, source: "Alice:Saved -future=value; comment\r\n")
        let previous = workspace.document
        let historyCount = workspace.past.count
        let file = workspace.directory.appending(path: "game/scene/start.txt")
        try Data("External change;\n".utf8).write(to: file)
        do { try await workspace.saveLine(sceneID: scene, lineID: nil, source: "Overwritten;\n"); XCTFail("Expected revision conflict") } catch {}
        XCTAssertEqual(workspace.document, previous)
        XCTAssertEqual(workspace.past.count, historyCount)
        XCTAssertEqual(try String(contentsOf: file), "External change;\n")
        try await workspace.load()
        XCTAssertEqual(workspace.activeScene!.source, "External change;\n")
        XCTAssertTrue(workspace.past.isEmpty)
    }

    @MainActor
    func testNativeZIPRoundTripRetainsMetadataOpaqueFilesAndAssets() async throws {
        let (library, directory) = await makeLibrary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let id = try await createProject(in: library)
        let workspace = try await library.nativeWorkspace(id)
        _ = try await library.saveProject(id: id, name: "Revised", synopsis: "Synopsis", tint: .blue, favorite: true)
        let opaque = workspace.directory.appending(path: "game/custom.bin")
        try Data([0, 1, 2, 255]).write(to: opaque)
        let file = directory.appending(path: "park image.svg")
        try Data("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\"><rect width=\"20\" height=\"20\" fill=\"red\"/></svg>".utf8).write(to: file)
        try await workspace.importAssets([file], category: "background")
        let asset = workspace.assets.first!
        var details = try await NativeProjectStore.shared.details(asset, at: workspace.directory)
        details.alias = "Park"
        try await workspace.resourceChange { try await NativeProjectStore.shared.saveDetails(details, asset: asset, at: workspace.directory) }
        try await workspace.saveScene(id: nil, name: "Zeta")
        try await workspace.saveScene(id: nil, name: "Alpha")
        let savedSceneIDs = workspace.document!.scenes.map(\.id)
        let report = try await workspace.export()
        defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: report.outputPath).deletingLastPathComponent()) }
        try await library.importArchive(URL(fileURLWithPath: report.outputPath))
        let importedID = library.projects.last!.id
        let imported = try await library.nativeWorkspace(importedID)
        XCTAssertEqual(library.project(importedID)?.name, "Revised")
        XCTAssertEqual(library.project(importedID)?.synopsis, "Synopsis")
        XCTAssertEqual(imported.assets.first?.alias, "Park")
        XCTAssertEqual(imported.document?.scenes.map(\.name), [String(localized: "Opening Scene"), "Zeta", "Alpha"])
        XCTAssertEqual(imported.document?.scenes.map(\.id), savedSceneIDs)
        XCTAssertEqual(try Data(contentsOf: imported.directory.appending(path: "game/custom.bin")), Data([0, 1, 2, 255]))
        try await library.moveToTrash(importedID)
        try await library.deletePermanently(importedID)
        XCTAssertFalse(FileManager.default.fileExists(atPath: imported.directory.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: workspace.directory.path))
    }

    @MainActor
    func testNativeCatalogRoundTripKeepsExtensionsAndAnimationReferences() async throws {
        let (library, directory) = await makeLibrary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let id = try await createProject(in: library)
        let workspace = try await library.nativeWorkspace(id)
        let store = NativeProjectStore.shared
        var character = newCharacter()
        character.name = "Alice"
        character.extraJson = "{\"future\":true}"
        character.sprites = [CharacterSprite(emotion: "happy", file: "hero.png", prompt: "Smile", extraJson: "{\"keep\":1}")]
        try await workspace.resourceChange { _ = try await store.saveCharacter(character, at: workspace.directory, revision: workspace.characters!.revision) }
        let saved = try XCTUnwrap(workspace.characters?.characters.first)
        XCTAssertTrue(saved.extraJson.contains("future"))
        XCTAssertTrue(saved.sprites[0].extraJson.contains("keep"))
        try await workspace.resourceChange { try await store.saveAnimation("fade.json", source: "[{\"alpha\":1,\"duration\":300}]", revision: "", at: workspace.directory) }
        let scene = workspace.activeScene!.id
        try await workspace.saveLine(sceneID: scene, lineID: nil, source: "setAnimation:fade -target=fig-left; keep\r\n")
        let asset = workspace.assets.first { $0.category == "animation" }!
        try await workspace.resourceChange { try await store.rename(asset, to: "fade-in.json", at: workspace.directory, revision: workspace.revision) }
        XCTAssertTrue(workspace.activeScene!.source.contains("setAnimation:fade-in"))
        XCTAssertTrue(workspace.activeScene!.source.hasSuffix("; keep\r\n"))
        XCTAssertTrue(workspace.past.isEmpty)
        let renamed = workspace.assets.first { $0.category == "animation" }!
        do {
            try await workspace.resourceChange { try await store.delete(renamed, at: workspace.directory, revision: workspace.revision) }
            XCTFail("Used animations must not be deleted")
        } catch {}
        XCTAssertEqual(workspace.assets.first { $0.category == "animation" }?.name, "fade-in.json")
    }

    @MainActor
    func testNativeHistoryIsBoundedAndNoOpKeepsSourceBytes() async throws {
        let (library, directory) = await makeLibrary()
        defer { try? FileManager.default.removeItem(at: directory) }
        let id = try await createProject(in: library)
        let workspace = try await library.nativeWorkspace(id)
        let scene = workspace.activeScene!.id
        let source = "Alice:Hello -future=value; keep\r\n\r\n"
        try await workspace.saveLine(sceneID: scene, lineID: nil, source: source)
        for index in 1...51 { try await workspace.edit { $0.notes = "\(index)" } }
        for _ in 0..<50 { try await workspace.restore(undo: true) }
        XCTAssertEqual(workspace.document?.notes, "1")
        XCTAssertTrue(workspace.past.isEmpty)
        XCTAssertEqual(workspace.activeScene?.source, source)
        let currentRevision = workspace.revision
        try await workspace.edit { _ in }
        XCTAssertEqual(workspace.revision, currentRevision)
        XCTAssertEqual(workspace.future.count, 50)
    }
}

final class NativePreviewTests: XCTestCase {
    @MainActor
    func testWKWebViewSessionReadinessRestartAndCleanup() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "preview-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let repository = PreviewRepository(directory: directory.appending(path: "runtime"))
        let engine = await repository.engineURL
        try FileManager.default.createDirectory(at: engine.appending(path: "assets"), withIntermediateDirectories: true)
        let index = """
        <!doctype html><html><body style="margin:0"><button id="entry" style="width:200px;height:100px">Entry</button>
        <script>const ws = new WebSocket('ws://' + location.host + '/api/webgalsync');
        ws.onopen = () => ws.send(JSON.stringify({data:{command:1}}));</script></body></html>
        """
        try Data(index.utf8).write(to: engine.appending(path: "index.html"))
        try Data("{\"webgalVersion\":\"\(previewEngineVersion())\"}".utf8).write(to: engine.appending(path: "webgal-engine.json"))
        let project = directory.appending(path: "project")
        _ = try createProject(path: project.path, name: "Preview")
        try await verifyPreview(repository: repository, project: project, realEngine: false)
    }

    @MainActor
    func testRealWebGALReadinessRestartAndCleanup() async throws {
        guard let zip = Bundle.main.url(forResource: "WebGALTestEngine", withExtension: "zip") else {
            throw XCTSkip("Use WEBGAL_TEST_RUNTIME_ZIP with pnpm ios:test:preview")
        }
        let directory = FileManager.default.temporaryDirectory.appending(path: "webgal-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let repository = PreviewRepository(directory: directory.appending(path: "runtime"))
        do { try await repository.install(zip) }
        catch { XCTFail("Install real engine: \(String(reflecting: error))"); return }
        let project = directory.appending(path: "project")
        _ = try createProject(path: project.path, name: "WebGAL native test")
        let snapshot = try loadWorkspace(path: project.path)
        _ = try saveWorkspace(path: project.path, scenes: [SceneSource(fileName: "start.txt", source: "choose:Continue:chapter.txt;\n"),
                                                          SceneSource(fileName: "chapter.txt", source: "Alice:Native preview reached chapter;\n")],
                              notes: "Preserve", editorState: "", expectedRevision: snapshot.revision)
        do { try await verifyPreview(repository: repository, project: project, realEngine: true) }
        catch { XCTFail("Run real engine: \(String(reflecting: error))") }
    }

    @MainActor
    private func verifyPreview(repository: PreviewRepository, project: URL, realEngine: Bool) async throws {
        let original = try loadWorkspace(path: project.path)
        let model = RuntimePreviewModel(repository: repository)
        defer { model.stop() }
        model.start(project)
        try await waitUntil { model.url != nil || model.error != nil }
        let url = try XCTUnwrap(model.url, model.error ?? "Missing preview URL")
        let coordinator = RuntimeWebView.Coordinator(url: url, model: model)
        defer { withExtendedLifetime(coordinator) {} }
        let webView = RuntimeWebView.makeView(coordinator: coordinator)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        let controller = UIViewController()
        window.rootViewController = controller
        controller.view.addSubview(webView)
        webView.frame = controller.view.bounds
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        window.makeKeyAndVisible()
        defer { webView.stopLoading(); webView.navigationDelegate = nil; webView.removeFromSuperview(); window.isHidden = true }
        try await waitUntil { model.ready || model.error != nil }
        XCTAssertNil(model.error)
        XCTAssertTrue(model.ready)
        XCTAssertFalse(webView.configuration.websiteDataStore.isPersistent)
        let height = try await webView.evaluateJavaScript("document.documentElement.clientHeight") as? Double ?? 0
        XCTAssertGreaterThan(height, 100)
        let storage = try await webView.evaluateJavaScript("localStorage.setItem('native-test', 'saved'); true") as? Bool
        XCTAssertEqual(storage, true)
        if realEngine {
            try await waitForScript(webView, script: interactive(".html-body__title-enter"))
        }
        model.stop()
        var request = URLRequest(url: url)
        request.timeoutInterval = 1
        let closeDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while true {
            do { _ = try await URLSession.shared.data(for: request) } catch { break }
            guard ContinuousClock.now < closeDeadline else {
                XCTFail("Stopped preview port is still open")
                return
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        model.start(project)
        try await waitUntil { model.url != nil || model.error != nil }
        XCTAssertNotEqual(model.url, url)
        let restartedURL = try XCTUnwrap(model.url)
        let restartedCoordinator = RuntimeWebView.Coordinator(url: restartedURL, model: model)
        defer { withExtendedLifetime(restartedCoordinator) {} }
        let restartedWebView = RuntimeWebView.makeView(coordinator: restartedCoordinator)
        webView.removeFromSuperview()
        controller.view.addSubview(restartedWebView)
        restartedWebView.frame = controller.view.bounds
        defer { restartedWebView.stopLoading(); restartedWebView.navigationDelegate = nil; restartedWebView.removeFromSuperview() }
        try await waitUntil { model.ready || model.error != nil }
        XCTAssertNil(model.error)
        XCTAssertTrue(model.ready)
        let clearedStorage = try await restartedWebView.evaluateJavaScript("localStorage.getItem('native-test') === null") as? Bool
        XCTAssertEqual(clearedStorage, true)
        if realEngine { try await waitForScript(restartedWebView, script: interactive(".html-body__title-enter")) }
        let after = try loadWorkspace(path: project.path)
        XCTAssertEqual(after.scenes, original.scenes)
        XCTAssertEqual(after.notes, original.notes)
    }

    @MainActor
    private func waitUntil(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(35))
        while !predicate() {
            guard ContinuousClock.now < deadline else { throw NativeProjectError.invalid("Timed out waiting for native preview") }
            try await Task.sleep(for: .milliseconds(100))
        }
    }

    @MainActor
    private func waitForScript(_ webView: WKWebView, script: String) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(20))
        while try await webView.evaluateJavaScript(script) as? Bool != true {
            guard ContinuousClock.now < deadline else {
                let body = try? await webView.evaluateJavaScript("document.body.innerText")
                throw NativeProjectError.invalid("Timed out waiting for engine interaction: \(String(describing: body))")
            }
            try await Task.sleep(for: .milliseconds(100))
        }
    }

    private func interactive(_ selector: String) -> String {
        let literal = String(decoding: try! JSONEncoder().encode(selector), as: UTF8.self)
        return """
        (() => {
          const target = document.querySelector(\(literal));
          if (!target) return false;
          for (let node = target; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) <= 0) return false;
          }
          const rect = target.getBoundingClientRect();
          const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
          const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
          if (right <= left || bottom <= top) return false;
          const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
          return hit === target || target.contains(hit);
        })()
        """
    }
}
