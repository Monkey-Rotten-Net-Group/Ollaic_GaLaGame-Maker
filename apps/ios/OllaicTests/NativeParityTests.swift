import Foundation
import XCTest
@testable import Ollaic

final class NativeParityTests: XCTestCase {
    @MainActor
    func testSceneImportAddsSelectsAndPreservesExistingScenes() async throws {
        let (workspace, directory) = try await makeWorkspace()
        defer { try? FileManager.default.removeItem(at: directory) }
        let original = workspace.activeScene!
        let file = directory.appending(path: "chapter2.txt")
        try Data("Alice:Imported;\r\n".utf8).write(to: file)
        try await workspace.importScene(file)
        XCTAssertEqual(workspace.document?.scenes.count, 2)
        XCTAssertEqual(workspace.document?.scenes.first, original)
        XCTAssertEqual(workspace.activeScene?.fileName, "chapter2.txt")
        XCTAssertEqual(workspace.activeScene?.source, "Alice:Imported;\r\n")
        let before = workspace.document
        let revision = workspace.revision
        for (index, name) in ["chapter2.txt", "CHAPTER2.txt"].enumerated() {
            let inputs = directory.appending(path: "duplicate-\(index)")
            try FileManager.default.createDirectory(at: inputs, withIntermediateDirectories: true)
            let duplicate = inputs.appending(path: name)
            try Data("Must not overwrite;\n".utf8).write(to: duplicate)
            do { try await workspace.importScene(duplicate); XCTFail("Duplicate scenes must fail") } catch {}
        }
        let invalid = directory.appending(path: "invalid.txt")
        try Data([0xFF]).write(to: invalid)
        do { try await workspace.importScene(invalid); XCTFail("Malformed UTF-8 must fail") } catch {}
        XCTAssertEqual(workspace.document, before)
        XCTAssertEqual(workspace.revision, revision)
        let saved = try loadWorkspace(path: workspace.directory.path)
        XCTAssertEqual(saved.scenes.first { $0.fileName == "start.txt" }?.source, original.source)
        try await workspace.restore(undo: true)
        XCTAssertEqual(workspace.document?.scenes, [original])
    }

    @MainActor
    func testCommandDraftMergesOtherWindowAndChecksItsBaseline() async throws {
        let (workspace, directory) = try await makeWorkspace()
        defer { try? FileManager.default.removeItem(at: directory) }
        let sceneID = workspace.activeScene!.id
        let source = "Alice:Original -future=keep; trailing\r\n"
        try await workspace.saveLine(sceneID: sceneID, lineID: nil, source: source)
        let line = workspace.activeScene!.lines.last!
        var first = CommandDraft(source: source)
        var second = first
        first.edit.next = true
        second.edit.content = "Second window"
        try await workspace.saveLine(sceneID: sceneID, lineID: line.id, source: first.renderedSource(), expectedSource: source)
        let incoming = workspace.activeScene!.lines.last!.source
        do {
            try await workspace.saveLine(sceneID: sceneID, lineID: line.id, source: second.renderedSource(), expectedSource: source)
            XCTFail("A stale baseline must fail before writing")
        } catch {}
        XCTAssertEqual(workspace.activeScene!.lines.last!.source, incoming)
        XCTAssertTrue(second.synchronize(with: incoming))
        try await workspace.saveLine(sceneID: sceneID, lineID: line.id, source: second.renderedSource(), expectedSource: second.observedSource)
        let saved = workspace.activeScene!.lines.last!.source
        let command = try readCommand(source: saved)
        XCTAssertTrue(command.next)
        XCTAssertEqual(command.content, "Second window")
        XCTAssertTrue(saved.contains("-future=keep"))
        XCTAssertTrue(saved.hasSuffix("; trailing\r\n"))
    }

    func testCommandConflictsRequireAnExplicitResolution() throws {
        let original = "Alice:Original;\n"
        var draft = CommandDraft(source: original)
        draft.edit.content = "My draft"
        XCTAssertFalse(draft.synchronize(with: "Alice:Project update;\n"))
        XCTAssertTrue(draft.hasConflict)
        XCTAssertEqual(draft.edit.content, "My draft")
        draft.useProjectVersion("Alice:Project update;\n")
        XCTAssertFalse(draft.hasConflict)
        XCTAssertEqual(draft.edit.content, "Project update")
        draft.edit.content = "My replacement"
        XCTAssertFalse(draft.synchronize(with: "Alice:Another update;\n"))
        draft.keepMyChanges(over: "Alice:Another update;\n")
        XCTAssertFalse(draft.hasConflict)
        XCTAssertEqual(draft.observedSource, "Alice:Another update;\n")
        XCTAssertEqual(try readCommand(source: draft.renderedSource()).content, "My replacement")
    }

    func testSourceDraftMergesUnicodeEditsAndRejectsOverlaps() throws {
        let original = "Alice:Hello; keep\r\n"
        var draft = CommandDraft(source: original)
        try draft.switchMode(true)
        draft.raw = "Alice:Updated; keep\r\n"
        XCTAssertTrue(draft.synchronize(with: "Alice:Hello -next; keep\r\n"))
        XCTAssertEqual(draft.raw, "Alice:Updated -next; keep\r\n")
        try draft.switchMode(false)
        XCTAssertTrue(draft.edit.next)
        XCTAssertEqual(draft.edit.content, "Updated")
        let unicode = "\u{4f60}\u{597d}:Original;\r\n"
        XCTAssertEqual(try mergeScriptSource(before: unicode, draft: unicode.replacingOccurrences(of: "Original", with: "Local"),
                                             incoming: unicode.replacingOccurrences(of: ";", with: " -next;")),
                       "\u{4f60}\u{597d}:Local -next;\r\n")
        XCTAssertThrowsError(try mergeScriptSource(before: original, draft: "Alice:Mine; keep\r\n", incoming: "Alice:Theirs; keep\r\n"))
        var raw = CommandDraft(source: nil)
        raw.raw = "Alice:From source;\n"
        try raw.switchMode(false)
        XCTAssertEqual(raw.edit.content, "From source")
    }

    @MainActor
    func testSceneSourceEditorDoesNotOverwriteConcurrentEdits() async throws {
        let (workspace, directory) = try await makeWorkspace()
        defer { try? FileManager.default.removeItem(at: directory) }
        let sceneID = workspace.activeScene!.id
        let original = workspace.activeScene!.source
        try await workspace.saveSceneSource(sceneID: sceneID, source: "Alice:Window A;\n", original: original)
        let saved = workspace.activeScene!.source
        do {
            try await workspace.saveSceneSource(sceneID: sceneID, source: "Alice:Window B;\n", original: original)
            XCTFail("Overlapping source changes must fail")
        } catch {}
        XCTAssertEqual(workspace.activeScene?.source, saved)
    }

    @MainActor
    func testResourceRefreshKeepsOpenDraftIdentityAndIncomingReferences() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        _ = try createProject(path: directory.path, name: "Resource draft")
        try Data("changeBg:park.svg;\r\n".utf8).write(to: directory.appending(path: "game/scene/start.txt"))
        let workspace = NativeWorkspace(projectID: UUID(), directory: directory)
        try await workspace.load()
        let sceneID = workspace.activeScene!.id
        let lineID = workspace.activeScene!.lines[0].id
        var draft = CommandDraft(source: workspace.activeScene!.lines[0].source)
        draft.edit.when = "score>1"
        let file = directory.appending(path: "park.svg")
        try Data("<svg xmlns=\"http://www.w3.org/2000/svg\"/>".utf8).write(to: file)
        try await workspace.importAssets([file], category: "background")
        XCTAssertEqual(workspace.activeScene?.id, sceneID)
        XCTAssertEqual(workspace.activeScene?.lines[0].id, lineID)
        let asset = workspace.assets.first!
        try await workspace.resourceChange {
            try await NativeProjectStore.shared.rename(asset, to: "woods.svg", at: directory, revision: workspace.revision)
        }
        XCTAssertEqual(workspace.activeScene?.lines[0].id, lineID)
        XCTAssertTrue(draft.synchronize(with: workspace.activeScene!.lines[0].source))
        XCTAssertEqual(draft.edit.asset, "woods.svg")
        XCTAssertEqual(draft.edit.when, "score>1")
        try await workspace.saveLine(sceneID: sceneID, lineID: lineID, source: draft.renderedSource(), expectedSource: draft.observedSource)
        XCTAssertEqual(try readCommand(source: loadWorkspace(path: directory.path).scenes[0].source).asset, "woods.svg")
    }

    @MainActor
    func testReferenceMetadataNormalizesLegacyPrefixesAndSurvivesZIP() async throws {
        let (workspace, directory) = try await makeWorkspace()
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appending(path: "park.svg")
        try Data("<svg xmlns=\"http://www.w3.org/2000/svg\"/>".utf8).write(to: file)
        try await workspace.importAssets([file], category: "background")
        let asset = workspace.assets.first!
        let layout = try NativeAssetReferences(asset: asset)
        let reference = directory.appending(path: "reference.svg")
        try Data("<svg/>".utf8).write(to: reference)
        try await workspace.importAssets([reference], category: "reference", prefix: layout.prefix)
        var details = try assetDetails(path: directory.path, category: asset.category, name: asset.name)
        details.references = [layout.prefix + "reference.svg", "reference/" + layout.prefix + "reference.svg", "reference.svg"]
        try saveAssetDetails(path: directory.path, category: asset.category, name: asset.name, details: details)
        let normalized = try await NativeProjectStore.shared.details(asset, at: directory)
        XCTAssertEqual(normalized.references, ["reference.svg"])
        try await NativeProjectStore.shared.saveDetails(normalized, asset: asset, at: directory)
        XCTAssertEqual(try assetDetails(path: directory.path, category: asset.category, name: asset.name).references, ["reference.svg"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appending(path: "game/reference/" + layout.assetName(normalized.references[0])).path))
        let report = try await workspace.export()
        defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: report.outputPath).deletingLastPathComponent()) }
        let imported = directory.appending(path: "round-trip")
        _ = try importProject(archivePath: report.outputPath, targetPath: imported.path)
        XCTAssertEqual(try assetDetails(path: imported.path, category: asset.category, name: asset.name).references, ["reference.svg"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: imported.appending(path: "game/reference/" + layout.prefix + "reference.svg").path))
    }

    func testAssetPickerSearchesAliasesAndScopesReferenceOwners() {
        let own = AssetInfo(category: "reference", name: "backgrounds/park.svg/ref.png", size: 1, alias: "Portrait")
        let other = AssetInfo(category: "reference", name: "backgrounds/other.svg/ref.png", size: 1, alias: "Portrait")
        let background = AssetInfo(category: "background", name: "park.svg", size: 1, alias: "Park")
        XCTAssertEqual(matchingNativeAssets([own, other, background], category: "reference", prefix: "backgrounds/park.svg/", query: "portrait"), [own])
        XCTAssertEqual(matchingNativeAssets([own, other, background], category: "background", query: "PARK"), [background])
        XCTAssertTrue(matchingNativeAssets([own], category: "reference", query: "missing").isEmpty)
    }

    func testCharacterLinksAcceptNamesIDsAliasesAndPreserveCustomVoice() throws {
        var character = newCharacter()
        character.id = "char_alice"
        character.name = "Alice"
        character.aliases = ["Ally"]
        character.defaultVoice = "alice.ogg"
        character.sprites = [CharacterSprite(emotion: "happy", file: "happy.png", prompt: nil, extraJson: "{}"),
                             CharacterSprite(emotion: "sad", file: "sad.png", prompt: nil, extraJson: "{}")]
        let assets = ["happy.png", "sad.png"].map { AssetInfo(category: "figure", name: $0, size: 1, alias: "") }
        for key in [character.id, character.name, "ally"] {
            XCTAssertEqual(findNativeCharacter(key, in: [character])?.id, character.id)
            var figure = newCommand(kind: .changeFigure)
            figure.selectFigureCharacter(key, characters: [character], assets: assets)
            XCTAssertEqual(figure.figureCharacter, "Alice")
            XCTAssertEqual(figure.figureEmotion, "happy")
            XCTAssertEqual(figure.asset, "happy.png")
            XCTAssertEqual(try readCommand(source: figure.renderedSource(original: "")).figureCharacter, "Alice")
            figure.selectFigureEmotion("sad", characters: [character], assets: assets)
            XCTAssertEqual(figure.asset, "sad.png")
            figure.selectFigureAsset("happy.png", characters: [character], assets: assets)
            XCTAssertEqual(figure.figureEmotion, "happy")
            figure.selectFigureAsset("none", characters: [character], assets: assets)
            XCTAssertTrue(figure.figureCharacter.isEmpty)
        }
        var dialogue = newCommand(kind: .dialogue)
        dialogue.selectSpeaker("Ally", characters: [character])
        XCTAssertEqual(dialogue.speaker, "Ally")
        XCTAssertEqual(dialogue.voice, "alice.ogg")
        dialogue.voice = "custom.ogg"
        dialogue.selectSpeaker("Alice", characters: [character])
        XCTAssertEqual(dialogue.voice, "custom.ogg")
        character.sprites = [CharacterSprite(emotion: "missing", file: "", prompt: nil, extraJson: "{}")]
        var cleared = newCommand(kind: .changeFigure)
        cleared.figureCharacter = character.name
        cleared.selectFigureAsset("", characters: [character], assets: [])
        XCTAssertTrue(cleared.figureCharacter.isEmpty)
        XCTAssertTrue(cleared.figureEmotion.isEmpty)
    }

    func testSpriteObjectSelectionUsesExactVariantAndPreservesInstanceID() throws {
        var character = newCharacter()
        character.id = "char_alice"
        character.name = "Alice"
        character.sprites = [CharacterSprite(emotion: "default", file: "alice-day.png", prompt: nil, extraJson: "{}"),
                             CharacterSprite(emotion: "default", file: "alice-night.png", prompt: nil, extraJson: "{}")]
        let assets = character.sprites.map { AssetInfo(category: "figure", name: $0.file, size: 1, alias: "") }
        let original = "changeFigure:old.png -left -id=actor_left -next -future=keep; comment\r\n"
        var edit = try readCommand(source: original)
        try edit.selectFigureSprite(character.sprites[1], character: character, assets: assets)
        let rendered = try edit.renderedSource(original: original)
        let saved = try readCommand(source: rendered)
        XCTAssertEqual(saved.figureCharacter, "Alice")
        XCTAssertEqual(saved.figureEmotion, "default")
        XCTAssertEqual(saved.asset, "alice-night.png")
        XCTAssertEqual(saved.figureId, "actor_left")
        XCTAssertEqual(saved.figurePosition, "left")
        XCTAssertTrue(saved.next)
        XCTAssertTrue(rendered.contains("-future=keep"))
        XCTAssertTrue(rendered.hasSuffix("; comment\r\n"))
        let before = edit
        let missing = CharacterSprite(emotion: "missing", file: "", prompt: nil, extraJson: "{}")
        XCTAssertThrowsError(try edit.selectFigureSprite(missing, character: character, assets: []))
        XCTAssertEqual(edit, before)
    }

    @MainActor
    func testUsageNavigationLocatesMultilineCommandsAndCharacters() async throws {
        let (workspace, directory) = try await makeWorkspace()
        defer { try? FileManager.default.removeItem(at: directory) }
        try await workspace.edit {
            $0.scenes[0].lines = [NativeLine(source: "custom:line1\\\r\n line2;\r\n"), NativeLine(source: "\r\n"), NativeLine(source: "bgm:theme.ogg;")]
        }
        let scene = workspace.activeScene!
        var navigation = NativeEditorNavigation(tab: .assets)
        XCTAssertTrue(navigation.showUsage(AssetUsage(fileName: "start.txt", lineNumber: 2, command: "custom", content: ""), in: workspace))
        XCTAssertEqual(navigation.usageTarget, .command(sceneID: scene.id, lineID: scene.lines[0].id))
        XCTAssertTrue(navigation.showUsage(AssetUsage(fileName: "start.txt", lineNumber: 4, command: "bgm", content: ""), in: workspace))
        XCTAssertEqual(navigation.usageTarget, .command(sceneID: scene.id, lineID: scene.lines[2].id))
        var character = newCharacter()
        character.name = "Alice"
        try await workspace.resourceChange {
            _ = try await NativeProjectStore.shared.saveCharacter(character, at: directory, revision: workspace.characters!.revision)
        }
        let saved = workspace.characters!.characters[0]
        XCTAssertTrue(navigation.showUsage(AssetUsage(fileName: "game/config/characters.json", lineNumber: 0, command: "character", content: "Alice"), in: workspace))
        XCTAssertEqual(navigation.usageTarget, .character(saved.id))
        XCTAssertNil(NativeEditorNavigation.target(for: AssetUsage(fileName: "game/config.txt", lineNumber: 1, command: "config", content: ""), in: workspace))
    }

    @MainActor
    func testCharacterDraftProtectsUnsavedChangesAndTracksSuccessfulSave() async throws {
        let (workspace, directory) = try await makeWorkspace()
        defer { try? FileManager.default.removeItem(at: directory) }
        var draft = CharacterDraft(character: newCharacter(), revision: workspace.characters!.revision)
        XCTAssertTrue(draft.requestDismiss())
        draft.character.name = "Alice"
        draft.character.notes = "My notes"
        XCTAssertFalse(draft.requestDismiss())
        XCTAssertTrue(draft.confirmingDiscard)
        draft.keepEditing()
        XCTAssertFalse(draft.confirmingDiscard)
        XCTAssertEqual(draft.character.notes, "My notes")
        let saved = try await NativeProjectStore.shared.saveCharacter(draft.character, at: directory, revision: draft.revision)
        try draft.saved(saved)
        XCTAssertFalse(draft.character.id.isEmpty)
        XCTAssertFalse(draft.isDirty)
        XCTAssertTrue(draft.requestDismiss())
        draft.character.description = "Uncommitted description"
        var other = saved.characters[0]
        other.notes = "Other editor"
        let incoming = try await NativeProjectStore.shared.saveCharacter(other, at: directory, revision: saved.revision)
        draft.synchronize(with: incoming)
        do {
            _ = try await NativeProjectStore.shared.saveCharacter(draft.character, at: directory, revision: draft.revision)
            XCTFail("Concurrent character changes must not overwrite")
        } catch {}
        XCTAssertTrue(draft.isDirty)
        XCTAssertEqual(draft.character.description, "Uncommitted description")
        XCTAssertEqual(try loadCharacters(path: directory.path).characters[0].notes, "Other editor")
    }

    @MainActor
    func testFormSynchronizationPreservesSourceOnlyEditsAfterResourceRename() async throws {
        let (workspace, directory) = try await makeWorkspace()
        defer { try? FileManager.default.removeItem(at: directory) }
        let image = directory.appending(path: "park.svg")
        try Data("<svg/>".utf8).write(to: image)
        try await workspace.importAssets([image], category: "background")
        let sceneID = workspace.activeScene!.id
        let original = "changeBg:park.svg; original\r\n"
        try await workspace.edit { $0.scenes[0].lines = [NativeLine(source: original)] }
        let lineID = workspace.activeScene!.lines[0].id
        var draft = CommandDraft(source: original)
        try draft.switchMode(true)
        draft.raw = "changeBg:park.svg -duration=900 -custom=keep; local comment\r\n"
        try draft.switchMode(false)
        draft.edit.when = "score>1"
        for name in ["woods.svg", "forest.svg"] {
            let asset = workspace.assets.first { $0.category == "background" }!
            try await workspace.resourceChange {
                try await NativeProjectStore.shared.rename(asset, to: name, at: directory, revision: workspace.revision)
            }
            XCTAssertTrue(draft.synchronize(with: workspace.activeScene!.lines[0].source))
            XCTAssertEqual(draft.edit.asset, name)
            XCTAssertEqual(draft.edit.when, "score>1")
            XCTAssertTrue(try draft.renderedSource().contains("-custom=keep"))
            XCTAssertTrue(try draft.renderedSource().hasSuffix("; local comment\r\n"))
        }
        try await workspace.saveLine(sceneID: sceneID, lineID: lineID, source: draft.renderedSource(), expectedSource: draft.observedSource)
        let saved = try loadWorkspace(path: directory.path).scenes.first { $0.fileName == "start.txt" }!.source
        XCTAssertTrue(saved.contains("forest.svg"))
        XCTAssertTrue(saved.contains("-duration=900"))
        XCTAssertTrue(saved.contains("-custom=keep"))
        XCTAssertTrue(saved.contains("-when=score>1"))
        XCTAssertTrue(saved.hasSuffix("; local comment\r\n"))
    }

    func testConflictingSourceTemplatesKeepTheEntireFormDraft() throws {
        let original = "Alice:Original; shared\r\n"
        var draft = CommandDraft(source: original)
        try draft.switchMode(true)
        draft.raw = "Alice:Mine -future=keep; local\r\n"
        try draft.switchMode(false)
        draft.edit.next = true
        let before = try draft.renderedSource()
        let edit = draft.edit
        XCTAssertFalse(draft.synchronize(with: "Alice:Theirs; incoming\r\n"))
        XCTAssertTrue(draft.hasConflict)
        XCTAssertEqual(draft.edit, edit)
        XCTAssertEqual(draft.observedSource, original)
        XCTAssertEqual(try draft.renderedSource(), before)
    }

    @MainActor
    func testResourceRenamePreservesScenePresentationAndRepairsExportedCache() async throws {
        let (workspace, directory) = try await makeWorkspace()
        defer { try? FileManager.default.removeItem(at: directory) }
        let image = directory.appending(path: "park.svg")
        try Data("<svg/>".utf8).write(to: image)
        try await workspace.importAssets([image], category: "background")
        let startID = workspace.activeScene!.id
        try await workspace.saveScene(id: startID, name: "Opening alias")
        try await workspace.saveScene(id: nil, name: "Zeta")
        try await workspace.saveScene(id: nil, name: "Alpha")
        let zetaID = workspace.document!.scenes.first { $0.fileName == "Zeta.txt" }!.id
        try await workspace.saveLine(sceneID: zetaID, lineID: nil, source: "Alice:First paragraph;\r\nAlice:Second paragraph;\r\n")
        try await workspace.saveLine(sceneID: startID, lineID: nil, source: "changeBg:park.svg;\n")
        let names = workspace.document!.scenes.map(\.name)
        let ids = workspace.document!.scenes.map(\.id)
        let asset = workspace.assets.first { $0.category == "background" }!
        try await workspace.resourceChange {
            try await NativeProjectStore.shared.rename(asset, to: "woods.svg", at: directory, revision: workspace.revision)
        }
        XCTAssertEqual(workspace.document?.scenes.map(\.name), names)
        XCTAssertEqual(workspace.document?.scenes.map(\.id), ids)
        let reopened = NativeWorkspace(projectID: workspace.projectID, directory: directory)
        try await reopened.load()
        XCTAssertEqual(reopened.document?.scenes.map(\.name), names)
        XCTAssertEqual(reopened.document?.scenes.map(\.id), ids)
        XCTAssertTrue(reopened.activeScene!.source.contains("woods.svg"))

        let report = try await workspace.export()
        defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: report.outputPath).deletingLastPathComponent()) }
        let imported = directory.appending(path: "round-trip")
        _ = try importProject(archivePath: report.outputPath, targetPath: imported.path)
        let snapshot = try loadWorkspace(path: imported.path)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(snapshot.editorState.utf8)) as? [String: Any])
        let scenes = try XCTUnwrap(root["scenes"] as? [[String: Any]])
        XCTAssertEqual(scenes.compactMap { $0["name"] as? String }, names)
        let sources = Dictionary(uniqueKeysWithValues: snapshot.scenes.map { ($0.fileName, $0.source) })
        for scene in scenes {
            let fileName = try XCTUnwrap(scene["fileName"] as? String)
            let blocks = try XCTUnwrap(scene["blocks"] as? [[String: Any]])
            let cachedSource = assembleLines(lines: try blocks.map {
                try editLine(original: $0["source"] as? String ?? "", kind: $0["kind"] as? String ?? "Command",
                             speaker: $0["speaker"] as? String ?? "", text: $0["text"] as? String ?? "")
            })
            XCTAssertEqual(cachedSource, sources[fileName], "Cached sources must satisfy Android's reconstruction check")
        }

        try FileManager.default.removeItem(at: directory.appending(path: "game/scene/Zeta.txt"))
        try Data("External scene;\n".utf8).write(to: directory.appending(path: "game/scene/extra.txt"))
        try await reopened.load()
        XCTAssertEqual(reopened.document?.scenes.map(\.name), ["Opening alias", "Alpha", "extra"])
        XCTAssertEqual(reopened.document?.scenes.last?.source, "External scene;\n")
    }

    @MainActor
    func testLineActionsSkipBlankLinesAndPreserveUndoAndIdentity() async throws {
        let (workspace, directory) = try await makeWorkspace()
        defer { try? FileManager.default.removeItem(at: directory) }
        let original = "Alice:A -future=one; first\r\n\n \t\r\nAlice:B; second\n"
        try await workspace.edit { $0.scenes[0].lines = decodeLines(source: original).map { NativeLine(source: $0.source) } }
        let sceneID = workspace.activeScene!.id
        let ids = workspace.activeScene!.lines.map(\.id)
        let aID = ids[0]
        let bID = ids.last!
        try await workspace.changeLine(sceneID: sceneID, lineID: aID, action: .moveDown)
        let moved = "\n \t\r\nAlice:B; second\nAlice:A -future=one; first\r\n"
        XCTAssertEqual(workspace.activeScene?.source, moved)
        XCTAssertEqual(workspace.activeScene!.lines.filter { !$0.isBlank }.map { $0.decoded.text }, ["B", "A"])
        XCTAssertEqual(Set(workspace.activeScene!.lines.map(\.id)), Set(ids))
        let revision = workspace.revision
        let history = workspace.past.count
        try await workspace.changeLine(sceneID: sceneID, lineID: bID, action: .moveUp)
        XCTAssertEqual(workspace.revision, revision)
        XCTAssertEqual(workspace.past.count, history)
        try await workspace.restore(undo: true)
        XCTAssertEqual(workspace.activeScene?.source, original)
        try await workspace.restore(undo: false)
        XCTAssertEqual(try loadWorkspace(path: directory.path).scenes.first { $0.fileName == "start.txt" }?.source, moved)
        try await workspace.changeLine(sceneID: sceneID, lineID: aID, action: .moveUp)
        XCTAssertEqual(workspace.activeScene!.lines.filter { !$0.isBlank }.map { $0.id }, [aID, bID])
        let beforeDuplicate = workspace.activeScene!.source
        try await workspace.changeLine(sceneID: sceneID, lineID: aID, action: .duplicate)
        let copies = workspace.activeScene!.lines.filter { !$0.isBlank }
        XCTAssertEqual(copies[0].source, copies[1].source)
        XCTAssertNotEqual(copies[0].id, copies[1].id)
        try await workspace.changeLine(sceneID: sceneID, lineID: copies[1].id, action: .delete)
        XCTAssertEqual(workspace.activeScene?.source, beforeDuplicate)
    }

    func testCharacterSearchMatchesAndroidFieldsWithoutChangingOrder() {
        var alice = newCharacter()
        alice.id = "alice"; alice.name = "Alice"; alice.aliases = ["Ally"]
        alice.description = "Companion"; alice.personality = "Calm"; alice.keywords = ["mountain"]
        var bob = newCharacter()
        bob.id = "bob"; bob.name = "Bob"
        let characters = [bob, alice]
        for query in ["alice", "ALLY", "companion", "CALM", "mountain", "  Ally  "] {
            XCTAssertEqual(matchingNativeCharacters(characters, query: query).map(\.id), [alice.id])
        }
        XCTAssertEqual(matchingNativeCharacters(characters, query: "  ").map(\.id), [bob.id, alice.id])
        XCTAssertTrue(matchingNativeCharacters(characters, query: "missing").isEmpty)
    }

    @MainActor
    func testSpriteReorderingPersistsExtensionsAndChangesTheDefaultSelection() async throws {
        let (workspace, directory) = try await makeWorkspace()
        defer { try? FileManager.default.removeItem(at: directory) }
        let day = CharacterSprite(emotion: "default", file: "day.png", prompt: "Day", extraJson: "{\"variant\":\"day\"}")
        let night = CharacterSprite(emotion: "default", file: "night.png", prompt: "Night", extraJson: "{\"variant\":\"night\"}")
        var character = newCharacter()
        character.name = "Alice"; character.sprites = [day, night]; character.extraJson = "{\"keep\":true}"
        let store = NativeProjectStore.shared
        let initial = try await store.saveCharacter(character, at: directory, revision: workspace.characters!.revision)
        var draft = CharacterDraft(character: initial.characters[0], revision: initial.revision)
        draft.moveSprite(from: 1, to: 0)
        XCTAssertTrue(draft.isDirty)
        XCTAssertFalse(draft.requestDismiss())
        draft.keepEditing()
        let saved = try await store.saveCharacter(draft.character, at: directory, revision: draft.revision)
        try draft.saved(saved)
        XCTAssertFalse(draft.isDirty)
        let restored = try loadCharacters(path: directory.path).characters[0]
        XCTAssertEqual(restored.sprites, [night, day])
        XCTAssertEqual(restored.extraJson, "{\"keep\":true}")
        let assets = [day, night].map { AssetInfo(category: "figure", name: $0.file, size: 1, alias: "") }
        var figure = newCommand(kind: .changeFigure)
        figure.selectFigureCharacter(restored.name, characters: [restored], assets: assets)
        XCTAssertEqual(figure.asset, "night.png")
        let before = draft.character
        draft.moveSprite(from: 0, to: -1)
        draft.moveSprite(from: 1, to: 2)
        XCTAssertEqual(draft.character, before)
        XCTAssertFalse(draft.isDirty)
    }

    @MainActor
    private func makeWorkspace() async throws -> (NativeWorkspace, URL) {
        let directory = temporaryDirectory()
        _ = try createProject(path: directory.path, name: "Parity regression")
        let workspace = NativeWorkspace(projectID: UUID(), directory: directory)
        try await workspace.load()
        return (workspace, directory)
    }

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory.appending(path: "ollaic-parity-\(UUID())")
    }
}
