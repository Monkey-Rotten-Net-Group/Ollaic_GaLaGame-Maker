import UIKit
import XCTest

final class AppConfigurationTests: XCTestCase {
    @MainActor
    func testApplicationRestrictsIndependentWindowScenes() throws {
        let manifest = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "UIApplicationSceneManifest") as? [String: Any])
        let multipleScenes = try XCTUnwrap(manifest["UIApplicationSupportsMultipleScenes"] as? Bool)
        XCTAssertFalse(multipleScenes)
        XCTAssertFalse(UIApplication.shared.supportsMultipleScenes)
    }
}
