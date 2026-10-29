import XCTest

final class ProjectHomeTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testProjectLibraryLifecycle() throws {
        let app = XCUIApplication()
        app.launchEnvironment["OLLAIC_UI_TEST_LIBRARY"] = UUID().uuidString
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        XCTAssertTrue(app.buttons["new-project"].waitForExistence(timeout: 15))

        create("Moonlit Letters", synopsis: "A quiet seaside story.", color: "rose", in: app)
        actions(for: "Moonlit Letters", in: app).tap()
        app.buttons["Favorite"].tap()
        select("favorites", title: "Favorites", in: app)
        XCTAssertTrue(actions(for: "Moonlit Letters", in: app).waitForExistence(timeout: 5))

        app.terminate()
        app.launch()
        XCTAssertTrue(actions(for: "Moonlit Letters", in: app).waitForExistence(timeout: 15))
        select("favorites", title: "Favorites", in: app)
        XCTAssertTrue(actions(for: "Moonlit Letters", in: app).exists)

        actions(for: "Moonlit Letters", in: app).tap()
        app.buttons["Edit Project"].tap()
        let name = app.descendants(matching: .any)["project-name"].firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "Moonlit Letters".count) + "Moonlit Letters Revised")
        app.buttons["cover-blue"].tap()
        app.buttons["save-project"].tap()
        XCTAssertTrue(actions(for: "Moonlit Letters Revised", in: app).waitForExistence(timeout: 10))

        let search = app.searchFields.firstMatch
        search.tap()
        search.typeText("unmatched-title")
        XCTAssertTrue(app.staticTexts["No Results"].waitForExistence(timeout: 5))
        app.buttons["Clear Search"].tap()
        if app.buttons["Close"].exists {
            app.buttons["Close"].tap()
        } else if app.buttons["Cancel"].exists {
            app.buttons["Cancel"].tap()
        }
        XCTAssertTrue(actions(for: "Moonlit Letters Revised", in: app).waitForExistence(timeout: 5))

        actions(for: "Moonlit Letters Revised", in: app).tap()
        app.buttons["Move to Trash"].tap()
        app.buttons["Move to Trash"].tap()
        select("trash", title: "Trash", in: app)
        XCTAssertTrue(actions(for: "Moonlit Letters Revised", in: app).waitForExistence(timeout: 5))
        actions(for: "Moonlit Letters Revised", in: app).tap()
        app.buttons["Restore"].tap()
        select("all", title: "All", in: app)
        XCTAssertTrue(actions(for: "Moonlit Letters Revised", in: app).waitForExistence(timeout: 5))

        create("A Summer in the City", synopsis: "Two friends, one last train home.", color: "green", in: app)
        create("The Observatory", synopsis: "Signals from a forgotten constellation.", color: "gold", in: app)

        app.buttons["view-options"].tap()
        app.buttons["List"].tap()
        XCTAssertTrue(app.collectionViews["project-list"].exists || app.tables["project-list"].exists || app.descendants(matching: .any)["project-list"].exists)
        app.buttons["view-options"].tap()
        app.buttons["Grid"].tap()

        app.terminate()
        app.launch()
        XCTAssertTrue(actions(for: "The Observatory", in: app).waitForExistence(timeout: 15))
        select("favorites", title: "Favorites", in: app)
        XCTAssertTrue(actions(for: "Moonlit Letters Revised", in: app).waitForExistence(timeout: 5))
        XCTAssertFalse(actions(for: "The Observatory", in: app).exists)
        actions(for: "Moonlit Letters Revised", in: app).tap()
        app.buttons["Move to Trash"].tap()
        app.buttons["Move to Trash"].tap()
        select("trash", title: "Trash", in: app)
        actions(for: "Moonlit Letters Revised", in: app).tap()
        app.buttons["Delete Permanently"].tap()
        app.buttons["Delete Permanently"].tap()
        XCTAssertTrue(app.staticTexts["Trash Is Empty"].waitForExistence(timeout: 5))
        app.terminate()
        app.launch()
        select("trash", title: "Trash", in: app)
        XCTAssertTrue(app.staticTexts["Trash Is Empty"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testWorkspaceDraftLifecycle() throws {
        let app = XCUIApplication()
        app.launchEnvironment["OLLAIC_UI_TEST_LIBRARY"] = UUID().uuidString
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        XCTAssertTrue(app.buttons["new-project"].waitForExistence(timeout: 15))
        create("The Last Train", synopsis: "A letter left on the last platform.", color: "blue", in: app)
        openWorkspace("The Last Train", in: app)

        let opening = "The last train had already left the station."
        let revised = "Only one platform light was still on."
        addEntry("narration", text: opening, in: app)
        addEntry("dialogue", text: "I thought you would be here.", speaker: "Mira", in: app)
        addEntry("note", text: "Hold the silence before the reply.", in: app)

        entry(opening, in: app).tap()
        let body = app.descendants(matching: .any)["entry-text"].firstMatch
        XCTAssertTrue(body.waitForExistence(timeout: 5))
        body.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.9)).tap()
        body.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: opening.count) + revised)
        app.buttons["save-entry"].tap()
        XCTAssertTrue(entry(revised, in: app).waitForExistence(timeout: 10))
        app.buttons["workspace-undo"].tap()
        XCTAssertTrue(entry(opening, in: app).waitForExistence(timeout: 5))
        app.buttons["workspace-redo"].tap()
        XCTAssertTrue(entry(revised, in: app).waitForExistence(timeout: 5))

        entry(revised, in: app).tap()
        let mode = app.segmentedControls["command-mode"]
        XCTAssertTrue(mode.waitForExistence(timeout: 5))
        mode.buttons["Source"].tap()
        let source = app.textViews["entry-text"]
        XCTAssertTrue(source.waitForExistence(timeout: 5))
        source.tap()
        source.typeKey("a", modifierFlags: .command)
        source.typeText(":\(revised) -future=preserved; keep\n")
        mode.buttons["Form"].tap()
        app.buttons["save-entry"].tap()
        XCTAssertTrue(entry(revised, in: app).waitForExistence(timeout: 5))
        entry(revised, in: app).tap()
        XCTAssertTrue(mode.waitForExistence(timeout: 5))
        mode.buttons["Source"].tap()
        XCTAssertTrue(source.waitForExistence(timeout: 5))
        XCTAssertTrue((source.value as? String)?.contains("-future=preserved") == true)
        XCTAssertTrue((source.value as? String)?.contains("; keep") == true)
        app.buttons["Cancel"].tap()

        workspaceTab("Scenes", in: app)
        app.buttons["new-scene"].tap()
        let sceneName = app.descendants(matching: .any)["scene-name"].firstMatch
        XCTAssertTrue(sceneName.waitForExistence(timeout: 5))
        sceneName.tap()
        sceneName.typeText("Platform Two")
        app.buttons["save-scene"].tap()
        XCTAssertTrue(app.buttons["Platform Two"].waitForExistence(timeout: 10))
        app.buttons["Platform Two"].tap()
        XCTAssertTrue(workspaceControl("new-entry", in: app).waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(entry(revised, in: app).exists)
        addEntry("dialogue", text: "Let us start again from here.", speaker: "Ren", in: app)
        workspaceControl("scene-picker", in: app).tap()
        sceneChoice("Opening Scene", in: app).tap()
        XCTAssertTrue(entry(revised, in: app).waitForExistence(timeout: 5))

        workspaceTab("Project", in: app)
        XCTAssertTrue(app.buttons["Characters"].waitForExistence(timeout: 5))
        workspaceTab("Script", in: app)

        app.terminate()
        app.launch()
        XCTAssertTrue(actions(for: "The Last Train", in: app).waitForExistence(timeout: 15))
        openWorkspace("The Last Train", in: app)
        XCTAssertTrue(entry(revised, in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(entry("I thought you would be here.", in: app).exists)
        workspaceControl("scene-picker", in: app).tap()
        sceneChoice("Platform Two", in: app).tap()
        XCTAssertTrue(entry("Let us start again from here.", in: app).waitForExistence(timeout: 5))
        workspaceTab("Project", in: app)
        XCTAssertTrue(app.buttons["Characters"].waitForExistence(timeout: 5))
        app.navigationBars.buttons["BackButton"].tap()
        XCTAssertTrue(app.buttons["new-project"].waitForExistence(timeout: 10))
    }

    @MainActor
    private func openWorkspace(_ title: String, in app: XCUIApplication) {
        let item = app.descendants(matching: .any).matching(NSPredicate(
            format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "project-item-", title
        )).firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 10))
        item.tap()
        XCTAssertTrue(workspaceControl("new-entry", in: app).waitForExistence(timeout: 15), app.debugDescription)
    }

    @MainActor
    private func addEntry(_ kind: String, text: String, speaker: String = "", in app: XCUIApplication) {
        workspaceControl("new-entry", in: app).tap()
        app.buttons["new-\(kind)"].tap()
        let body = app.descendants(matching: .any)["entry-text"].firstMatch
        XCTAssertTrue(body.waitForExistence(timeout: 5))
        if !speaker.isEmpty {
            let field = app.descendants(matching: .any)["entry-speaker"].firstMatch
            field.tap()
            field.typeText(speaker)
        }
        body.tap()
        body.typeText(text)
        app.buttons["save-entry"].tap()
        XCTAssertTrue(entry(text, in: app).waitForExistence(timeout: 10))
    }

    @MainActor
    private func entry(_ text: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "entry-content-", text
        )).firstMatch
    }

    @MainActor
    private func workspaceControl(_ id: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    @MainActor
    private func sceneChoice(_ title: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "scene-choice-", title)).firstMatch
    }

    @MainActor
    private func workspaceTab(_ title: String, in app: XCUIApplication) {
        let picker = app.segmentedControls["workspace-tabs"]
        if picker.exists { picker.buttons[title].tap() }
        else { app.tabBars.buttons[title].tap() }
    }

    @MainActor
    private func create(_ title: String, synopsis: String, color: String, in app: XCUIApplication) {
        app.buttons["new-project"].tap()
        let name = app.descendants(matching: .any)["project-name"].firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.tap()
        name.typeText(title)
        let description = app.descendants(matching: .any)["project-synopsis"].firstMatch
        description.tap()
        description.typeText(synopsis)
        app.buttons["cover-\(color)"].tap()
        app.buttons["save-project"].tap()
        XCTAssertTrue(actions(for: title, in: app).waitForExistence(timeout: 10))
    }

    @MainActor
    private func actions(for title: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons["project-actions-\(title)"]
    }

    @MainActor
    private func select(_ id: String, title: String, in app: XCUIApplication) {
        let segments = app.segmentedControls["library-filter"]
        if segments.exists {
            segments.buttons[title].tap()
        } else {
            app.descendants(matching: .any)["filter-\(id)"].firstMatch.tap()
        }
    }

}
