import Foundation

precondition(coreVersion() == "0.1.0")
let commandLine = decodeLines(source: "callScene:chapter.txt -next;\r\n")[0]
precondition(commandLine.command == "callScene" && commandLine.preview == "chapter.txt")
precondition(commandLine.text == "callScene:chapter.txt -next;")
let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
defer { try? FileManager.default.removeItem(at: temporary) }
try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
let projectPath = temporary.appendingPathComponent("project").path
let project = try createProject(path: projectPath, name: "Swift binding smoke")
precondition(project.scenes == ["start.txt"])
try updateProjectMetadata(path: projectPath, name: project.name, description: "Swift synopsis")
let metadata = try openProject(path: projectPath)
precondition(metadata.description == "Swift synopsis")
let workspace = try loadWorkspace(path: projectPath)
let edited = try editLine(original: "", kind: "Dialogue", speaker: "Alice", text: "Hello from Swift")
var branch = newCommand(kind: .choose)
branch.choices = [CommandChoice(text: "Next", target: "chapter.txt"), CommandChoice(text: "Stay", target: "")]
branch.when = "score > 1"
let branchSource = try editCommand(original: "", edit: branch)
let restoredBranch = try readCommand(source: branchSource)
precondition(restoredBranch.choices[1].target.isEmpty && restoredBranch.when == branch.when)
var input = try readCommand(source: "getUserInput:name -title=Your name -future=some value; keep\r\n")
input.title = "New title"
let inputSource = try editCommand(original: "getUserInput:name -title=Your name -future=some value; keep\r\n", edit: input)
precondition(inputSource.contains("-future=some value") && inputSource.hasSuffix("; keep\r\n"))
let script = assembleLines(lines: [edited, branchSource, inputSource])
let revision = try saveWorkspace(path: projectPath, scenes: [SceneSource(fileName: "start.txt", source: script)], notes: "Swift notes", editorState: "", expectedRevision: workspace.revision)
precondition(!revision.isEmpty)
let report = try exportProject(path: projectPath, archivePath: temporary.appendingPathComponent("project.zip").path)
let imported = try importProject(archivePath: report.outputPath, targetPath: temporary.appendingPathComponent("imported").path)
let restored = try loadWorkspace(path: imported.path)
precondition(restored.notes == "Swift notes")
precondition(decodeLines(source: restored.scenes[0].source)[0].text == "Hello from Swift")
precondition(restored.scenes[0].source == script)
let characters = try loadCharacters(path: imported.path)
let referencePrefix = try assetReferencePrefix(category: "background", name: "park.png")
precondition(referencePrefix == "backgrounds/park.png/")
var character = newCharacter()
character.name = "Alice"
character.extraJson = "{\"future\":true}"
character.sprites = [CharacterSprite(emotion: "happy", file: "hero.png", prompt: "A smile", extraJson: "{\"keep\":1}")]
let characterSource = try encodeCharacter(character: character)
let decodedCharacter = try decodeCharacter(source: characterSource)
precondition(decodedCharacter.sprites[0].emotion == "happy")
let savedCharacters = try saveCharacter(path: imported.path, character: character, expectedRevision: characters.revision)
precondition(savedCharacters.characters[0].extraJson.contains("future"))
let animation = try saveAnimation(path: imported.path, name: "fade.json", source: "[{\"alpha\":1,\"duration\":300}]", expectedRevision: "")
let animationDetails = try assetDetails(path: imported.path, category: "animation", name: "fade.json")
var namedAnimation = animationDetails
namedAnimation.alias = "Fade"
try saveAssetDetails(path: imported.path, category: "animation", name: "fade.json", details: namedAnimation)
let current = try loadWorkspace(path: imported.path)
try renameAsset(path: imported.path, category: "animation", oldName: "fade.json", newName: "fade-in.json", expectedRevision: current.revision)
let renamedAnimation = try readAnimation(path: imported.path, name: "fade-in.json")
precondition(renamedAnimation.source == animation.source)
let namedAssets = try listAssets(path: imported.path)
precondition(namedAssets.first(where: { $0.name == "fade-in.json" })?.alias == "Fade")
print("Swift UniFFI structured edit/save/export/import PASS")
