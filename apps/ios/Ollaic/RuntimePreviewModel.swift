import Foundation
import Observation

actor PreviewRepository {
    static let shared = PreviewRepository()
    let engineURL: URL
    nonisolated let version = previewEngineVersion()

    init(directory: URL = URL.applicationSupportDirectory.appending(path: "Runtime")) {
        engineURL = directory.appending(path: "webgal-\(previewEngineVersion())")
    }
    func installed() throws -> Bool { try previewEngineInfo(path: engineURL.path).installed }
    func install(_ archive: URL) throws {
        try DocumentAccess.withFile(archive, limit: 256 * 1024 * 1024) {
            _ = try installPreviewEngine(archivePath: $0.path, targetPath: engineURL.path)
        }
    }
    func start(_ project: URL) throws -> NativePreviewSession {
        try startPreviewSession(enginePath: engineURL.path, projectPath: project.path)
    }
    func download(progress: @escaping @Sendable (Double?) -> Void) async throws {
        let delegate = EngineDownloadDelegate(progress: progress)
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 180
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let url = URL(string: "https://github.com/OpenWebGAL/WebGAL/releases/download/\(version)/WebGAL-\(version)-web.zip")!
        let (temporary, response) = try await session.download(from: url)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try Task.checkCancellation()
        guard let response = response as? HTTPURLResponse, response.statusCode == 200 else {
            throw NativeProjectError.invalid(String(localized: "The engine download failed."))
        }
        try install(temporary)
    }
}

private final class EngineDownloadDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    let progress: @Sendable (Double?) -> Void
    init(progress: @escaping @Sendable (Double?) -> Void) { self.progress = progress }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        let host = request.url?.host ?? ""
        completionHandler(request.url?.scheme == "https" && (host == "github.com" || host.hasSuffix(".githubusercontent.com")) ? request : nil)
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        if max(totalBytesWritten, totalBytesExpectedToWrite) > 256 * 1024 * 1024 { downloadTask.cancel(); return }
        progress(totalBytesExpectedToWrite > 0 ? Double(totalBytesWritten) / Double(totalBytesExpectedToWrite) : nil)
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {}
}

@MainActor
@Observable
final class RuntimePreviewModel {
    private(set) var session: NativePreviewSession?
    private(set) var url: URL?
    private(set) var missingEngine = false
    private(set) var busy = false
    private(set) var ready = false
    private(set) var pageLoaded = false
    var progress: Double?
    var error: String?
    private var operation: Task<Void, Never>?
    private var generation = UUID()
    private var resumeAfterBackground = false
    let repository: PreviewRepository

    init(repository: PreviewRepository = .shared) { self.repository = repository }

    func start(_ project: URL) {
        stop()
        let generation = generation
        busy = true
        error = nil
        operation = Task { [self] in
            do {
                let missingEngine = try await !repository.installed()
                guard !Task.isCancelled, self.generation == generation else { return }
                self.missingEngine = missingEngine
                guard !missingEngine else { busy = false; return }
                let session = try await repository.start(project)
                guard !Task.isCancelled, self.generation == generation else {
                    await Task.detached { session.stop() }.value
                    return
                }
                self.session = session
                guard let url = URL(string: session.url()) else { throw URLError(.badURL) }
                self.url = url
                let deadline = ContinuousClock.now.advanced(by: .seconds(30))
                while !Task.isCancelled, self.generation == generation {
                    if pageLoaded && session.isReady() { ready = true; busy = false; return }
                    guard ContinuousClock.now < deadline else { throw NativeProjectError.invalid(String(localized: "The preview did not become ready in time.")) }
                    try await Task.sleep(for: .milliseconds(100))
                }
            } catch {
                if !Task.isCancelled, self.generation == generation { fail(error.localizedDescription) }
            }
        }
    }

    func prepare(_ project: URL, archive: URL? = nil) {
        stop()
        let generation = generation
        busy = true
        error = nil
        operation = Task { [self] in
            do {
                if let archive { try await repository.install(archive) }
                else {
                    try await repository.download { [weak self] value in
                        Task { @MainActor in
                            guard self?.generation == generation else { return }
                            self?.progress = value
                        }
                    }
                }
                guard !Task.isCancelled, self.generation == generation else { return }
                start(project)
            } catch {
                if !Task.isCancelled, self.generation == generation { fail(error.localizedDescription) }
            }
        }
    }

    func suspend() {
        stop()
        resumeAfterBackground = true
    }

    func resume(_ project: URL) {
        guard resumeAfterBackground else { return }
        start(project)
    }

    func pageFinished() { pageLoaded = true }
    func fail(_ message: String) { stop(); error = message }
    func stop() {
        resumeAfterBackground = false
        generation = UUID()
        operation?.cancel()
        operation = nil
        if let session { Task.detached { session.stop() } }
        session = nil
        url = nil
        ready = false
        pageLoaded = false
        busy = false
        progress = nil
    }
}
