import XCTest
import UIKit
@testable import Ollaic

final class CommandEditingTests: XCTestCase {
    @MainActor
    func testCommandSymbolsResolveToSystemImages() {
        for kind in CommandKind.editorKinds {
            XCTAssertNotNil(UIImage(systemName: kind.editorSymbol), "Missing symbol for \(kind)")
        }
    }

    func testTextConversionsKeepContentSpeakerAndExecutionOptions() throws {
        let original = try readCommand(source: "Alice:Hello -next -when=score>1;\r\n")
        for kind: CommandKind in [.narrator, .comment] {
            let converted = original.changingKind(to: kind, sceneNames: [])
            XCTAssertEqual(converted.kind, kind)
            XCTAssertEqual(converted.content, "Hello")
            XCTAssertEqual(converted.speaker, "Alice")
            XCTAssertEqual(converted.next, original.next)
            XCTAssertEqual(converted.when, original.when)
        }
        XCTAssertEqual(original.kind, .dialogue)
    }

    func testChangingToMediaInitializesNewFieldsAndRemovesOldManagedFlags() throws {
        let source = "bgm:theme.mp3 -volume=75 -next -when=score>1 -future=keep; trailing\r\n"
        let original = try readCommand(source: source)
        let converted = original.changingKind(to: .changeFigure, sceneNames: [])
        XCTAssertEqual(converted.asset, "none")
        XCTAssertEqual(converted.figurePosition, "center")
        XCTAssertNil(converted.volume)
        let rendered = try editCommand(original: source, edit: converted)
        let restored = try readCommand(source: rendered)
        XCTAssertEqual(restored.kind, .changeFigure)
        XCTAssertEqual(restored.asset, "none")
        XCTAssertEqual(restored.next, original.next)
        XCTAssertEqual(restored.when, original.when)
        XCTAssertFalse(rendered.contains("-volume="))
        XCTAssertTrue(rendered.contains("-future=keep"))
        XCTAssertTrue(rendered.hasSuffix("; trailing\r\n"))
    }

    func testSceneTypesUseAvailableSceneAndKeepValidationForMissingTargets() throws {
        let original = try readCommand(source: "Alice:Hello;\n")
        for kind: CommandKind in [.changeScene, .callScene] {
            let converted = original.changingKind(to: kind, sceneNames: ["start.txt", "chapter.txt"])
            XCTAssertEqual(converted.scene, "start.txt")
            let source = try editCommand(original: "Alice:Hello;\n", edit: converted)
            XCTAssertEqual(try readCommand(source: source).kind, kind)
            XCTAssertEqual(try readCommand(source: source).scene, "start.txt")
        }
        let missingTarget = original.changingKind(to: .changeScene, sceneNames: [])
        XCTAssertThrowsError(try editCommand(original: "Alice:Hello;\n", edit: missingTarget))
    }

    func testSelectingCurrentKindDoesNotResetTypeSpecificFields() throws {
        let original = try readCommand(source: "choose:Next:chapter.txt|Stay: -when=score>1; keep\r\n")
        XCTAssertEqual(original.changingKind(to: .choose, sceneNames: ["start.txt"]), original)
        let scene = try readCommand(source: "callScene:custom-scene.txt -next;\n")
        XCTAssertEqual(scene.changingKind(to: .callScene, sceneNames: ["start.txt"]), scene)
    }

    @MainActor
    func testSavedTypeChangePreservesIdentitySourceDetailsAndUndo() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "command-kind-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        _ = try createProject(path: directory.path, name: "Kind conversion")
        let workspace = NativeWorkspace(projectID: UUID(), directory: directory)
        try await workspace.load()
        let sceneID = try XCTUnwrap(workspace.activeScene?.id)
        let original = "Alice:Hello -next -when=score>1 -future=keep; trailing\r\n"
        try await workspace.edit { document in
            document.scenes[0].lines = [NativeLine(source: original)]
        }
        let lineID = try XCTUnwrap(workspace.activeScene?.lines.first?.id)
        let edit = try readCommand(source: original).changingKind(to: .narrator, sceneNames: [])
        XCTAssertEqual(try loadWorkspace(path: directory.path).scenes[0].source, original)
        let converted = try editCommand(original: original, edit: edit)
        try await workspace.saveLine(sceneID: sceneID, lineID: lineID, source: converted)
        let saved = NativeDocument(snapshot: try loadWorkspace(path: directory.path))
        XCTAssertEqual(saved.scenes[0].lines[0].id, lineID)
        XCTAssertEqual(try readCommand(source: saved.scenes[0].source).kind, .narrator)
        XCTAssertTrue(saved.scenes[0].source.contains("-future=keep"))
        XCTAssertTrue(saved.scenes[0].source.hasSuffix("; trailing\r\n"))
        try await workspace.restore(undo: true)
        XCTAssertEqual(workspace.activeScene?.source, original)
        XCTAssertEqual(try loadWorkspace(path: directory.path).scenes[0].source, original)
        try await workspace.restore(undo: false)
        XCTAssertEqual(workspace.activeScene?.source, converted)
    }
}
