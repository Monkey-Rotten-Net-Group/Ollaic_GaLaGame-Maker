import SwiftUI
import WebKit

@MainActor
struct RuntimePreviewView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    let projectURL: URL
    @State private var model = RuntimePreviewModel()
    @State private var importing = false
    @State private var fullscreen = false
    var body: some View {
        NavigationStack {
            ZStack {
                Color.black
                if let url = model.url {
                    RuntimeWebView(url: url, model: model).id(url).accessibilityIdentifier("runtime-webview")
                } else if model.missingEngine || model.error != nil {
                    ContentUnavailableView {
                        Label(model.error == nil ? String(localized: "WebGAL Engine Required") : String(localized: "Preview Unavailable"), systemImage: "play.slash")
                    } description: { if let error = model.error { Text(error) } } actions: {
                        Button("Download Engine") { model.prepare(projectURL) }.disabled(model.busy)
                        Button("Import Engine ZIP") { importing = true }.disabled(model.busy)
                        Button("Retry") { model.start(projectURL) }.disabled(model.busy)
                    }.background(Color(uiColor: .systemBackground))
                }
                if model.busy {
                    ProgressView(value: model.progress).progressViewStyle(.circular)
                        .padding(16).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
                        .accessibilityLabel("Loading Preview").allowsHitTesting(false)
                }
                if fullscreen {
                    VStack { HStack { Spacer(); Button("Exit Fullscreen", systemImage: "arrow.down.right.and.arrow.up.left") { fullscreen = false }.labelStyle(.iconOnly).padding(16).background(.regularMaterial) }; Spacer() }
                }
            }
            .navigationTitle("Preview").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { model.stop(); dismiss() } }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button("Restart", systemImage: "arrow.clockwise") { model.start(projectURL) }.disabled(model.busy)
                    Button("Fullscreen", systemImage: "arrow.up.left.and.arrow.down.right") { fullscreen = true }
                }
            }
            .toolbar(fullscreen ? .hidden : .visible, for: .navigationBar)
            .statusBarHidden(fullscreen)
        }
        .task { model.start(projectURL) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.resume(projectURL) }
            else if phase == .background { model.suspend() }
        }
        .onDisappear { model.stop() }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.zip]) { result in
            do { model.prepare(projectURL, archive: try result.get()) } catch { model.error = error.localizedDescription }
        }
    }
}

struct RuntimeWebView: UIViewRepresentable {
    let url: URL
    let model: RuntimePreviewModel
    func makeCoordinator() -> Coordinator { Coordinator(url: url, model: model) }
    func makeUIView(context: Context) -> WKWebView {
        Self.makeView(coordinator: context.coordinator)
    }
    static func makeView(coordinator: Coordinator) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = coordinator
        view.scrollView.isScrollEnabled = false
        view.isOpaque = false
        view.backgroundColor = .black
        view.load(URLRequest(url: coordinator.url))
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {}
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.stopLoading()
        view.navigationDelegate = nil
        view.loadHTMLString("", baseURL: nil)
    }
    final class Coordinator: NSObject, WKNavigationDelegate {
        let url: URL
        let model: RuntimePreviewModel
        init(url: URL, model: RuntimePreviewModel) { self.url = url; self.model = model }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let destination = navigationAction.request.url
            decisionHandler(destination?.scheme == url.scheme && destination?.host == url.host && destination?.port == url.port && navigationAction.targetFrame != nil ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { model.pageFinished() }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { model.fail(error.localizedDescription) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { model.fail(error.localizedDescription) }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { model.fail(String(localized: "The preview process stopped. Restart to try again.")) }
    }
}
