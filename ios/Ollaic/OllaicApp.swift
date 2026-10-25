import SwiftUI

@main
@MainActor
struct OllaicApp: App {
    @State private var library: ProjectLibrary
    private let preferences: UserDefaults

    init() {
        var fileURL = ProjectRepository.defaultFileURL
        var preferences = UserDefaults.standard
        #if DEBUG
        // Isolate real UI test writes from the user's project library.
        if let testID = ProcessInfo.processInfo.environment["OLLAIC_UI_TEST_LIBRARY"], UUID(uuidString: testID) != nil {
            fileURL = fileURL.deletingLastPathComponent()
                .appending(path: "UITests/\(testID)/projects.json")
            preferences = UserDefaults(suiteName: "com.ollaic.uitests.\(testID)") ?? .standard
        }
        #endif
        _library = State(initialValue: ProjectLibrary(repository: ProjectRepository(fileURL: fileURL)))
        self.preferences = preferences
    }

    var body: some Scene {
        WindowGroup {
            ProjectHomeView()
                .environment(library)
                .defaultAppStorage(preferences)
        }
    }
}
