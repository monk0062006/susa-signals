#if canImport(UIKit)
import UIKit
#endif
import Foundation

/// Bump when consent copy changes materially; prior grants stop counting.
private let consentPolicyVersion = "1"
private let sdkVersion = "0.0.0"

public struct FeedbackConfig {
    public let projectId: String
    public let endpoint: String
    public var reporter: Reporter?
    public var customData: [String: String]?
    public var silent: Bool

    public init(
        projectId: String,
        endpoint: String,
        reporter: Reporter? = nil,
        customData: [String: String]? = nil,
        silent: Bool = false
    ) {
        self.projectId = projectId
        self.endpoint = endpoint
        self.reporter = reporter
        self.customData = customData
        self.silent = silent
    }
}

/**
 Public entry point, the iOS counterpart to web's `loadWidget` and Android's
 `FeedbackSdk`.

 All network and storage work runs on one serial queue. The SDK never blocks the
 caller and never assumes it may use the host app's concurrency.
 */
public final class FeedbackSDK {
    private let config: FeedbackConfig
    private let consent: ConsentManager
    private let queue: SubmissionQueue
    private let client: IngestClient
    private let worker = DispatchQueue(label: "io.markerusa.feedback", qos: .utility)

    private var reporter: Reporter?
    private var customData: [String: String]?
    /// Guards against a second composer opening over a live one.
    private var overlayVisible = false

    private static var instance: FeedbackSDK?
    private static let lock = NSLock()

    /// Initializes the SDK. Safe to call more than once; later calls return the
    /// existing instance rather than starting a second queue over the same storage,
    /// which would double-send.
    @discardableResult
    public static func start(config: FeedbackConfig) -> FeedbackSDK {
        lock.lock()
        defer { lock.unlock() }

        if let instance { return instance }

        let sdk = FeedbackSDK(config: config)
        instance = sdk
        sdk.onInit()
        return sdk
    }

    public static func shared() -> FeedbackSDK? {
        lock.lock()
        defer { lock.unlock() }
        return instance
    }

    private init(config: FeedbackConfig) {
        self.config = config
        self.reporter = config.reporter
        self.customData = config.customData

        let storage = UserDefaultsStore()
        let client = IngestClient(endpoint: config.endpoint, projectId: config.projectId)
        self.client = client
        self.consent = ConsentManager(storage: storage, policyVersion: consentPolicyVersion)
        self.queue = SubmissionQueue(storage: storage, client: client)
    }

    private func onInit() {
        // Filing a report is itself the consent act for screenshot and diagnostics:
        // the user opened the reporter, sees what will be sent, and can redact it.
        // Session replay has no such moment and is excluded here by design.
        if consent.load() == nil {
            consent.grant([.screenshot, .diagnostics], source: "host_app")
        }

        // Deliver anything stranded by a previous launch's network failure.
        worker.async { [weak self] in
            guard let self else { return }
            let result = self.queue.flush()
            if result.sent > 0 { self.log("delivered \(result.sent) queued submission(s)") }
        }
    }

    public func setReporter(_ next: Reporter) { reporter = next }

    public func setCustomData(_ data: [String: String]) { customData = data }

    public func grantConsent(_ scopes: [ConsentScope]) {
        consent.grant(scopes, source: "explicit_prompt")
        log("consent granted: \(scopes.map(\.rawValue).joined(separator: ","))")
    }

    public func revokeConsent() {
        consent.revoke()
        log("consent revoked")
    }

    #if canImport(UIKit)
    /**
     Captures the screen and presents the annotation composer.

     The counterpart to web's `widget.capture()` and Android's `capture()`, and the
     path that gives the user a chance to redact before anything leaves the device.
     Must be called on the main thread — it builds views.
     */
    public func capture(
        kind: ReportKind = .bug,
        route: String? = nil,
        completion: @escaping (Bool) -> Void = { _ in }
    ) {
        guard consent.has(.screenshot) else {
            log("capture skipped: no screenshot consent")
            completion(false)
            return
        }

        // A second composer over a live one would double-submit.
        guard !overlayVisible else {
            log("capture ignored: composer already open")
            return
        }

        guard
            let image = ScreenCapture.captureImage(),
            let window = ScreenCapture.activeWindow()
        else {
            log("capture failed: no screenshot")
            completion(false)
            return
        }

        overlayVisible = true
        let overlay = FeedbackOverlayView(
            screenshot: image,
            onSend: { [weak self] title, description, annotations, flattened in
                guard let self else { return }
                self.overlayVisible = false
                self.submit(
                    title: title,
                    description: description,
                    kind: kind,
                    route: route,
                    annotations: annotations,
                    screenshotData: flattened,
                    completion: completion
                )
            },
            onCancel: { [weak self] in
                self?.overlayVisible = false
                self?.log("capture cancelled")
                completion(false)
            }
        )
        overlay.present(in: window)
    }

    /// Submits a report without any UI. For programmatic reporting — crash
    /// handlers, automated test failures — where no user is present to annotate.
    public func report(
        title: String,
        description: String? = nil,
        kind: ReportKind = .bug,
        route: String? = nil,
        completion: @escaping (Bool) -> Void = { _ in }
    ) {
        guard consent.has(.screenshot) else {
            log("report skipped: no screenshot consent")
            completion(false)
            return
        }

        // Capture must happen on the main thread; everything after it must not.
        let capture: (data: Data, width: Int, height: Int)? = Thread.isMainThread
            ? ScreenCapture.capture()
            : DispatchQueue.main.sync { ScreenCapture.capture() }

        submit(
            title: title,
            description: description,
            kind: kind,
            route: route,
            annotations: [],
            screenshotData: capture?.data,
            completion: completion,
            width: capture?.width ?? 0,
            height: capture?.height ?? 0
        )
    }
    #endif

    private func submit(
        title: String,
        description: String?,
        kind: ReportKind,
        route: String?,
        annotations: [Annotation],
        screenshotData: Data?,
        completion: @escaping (Bool) -> Void,
        width: Int = 0,
        height: Int = 0
    ) {
        worker.async { [weak self] in
            guard let self else { return }

            var attachments: [Attachment] = []
            if let screenshotData {
                // Upload failure must not lose the user's written text, which is
                // the part that cannot be recreated.
                do {
                    attachments.append(
                        try self.uploadScreenshot((data: screenshotData, width: width, height: height))
                    )
                } catch {
                    self.log("screenshot upload failed; sending without it")
                }
            }

            let submission = Submission(
                projectId: self.config.projectId,
                payload: .bugReport(
                    kind: kind,
                    title: title,
                    description: description,
                    annotations: annotations,
                    logs: []
                ),
                device: DeviceInfo.collect(sdkVersion: sdkVersion, route: route),
                reporter: self.reporter,
                attachments: attachments,
                customData: self.customData,
                consent: self.consent.load()
            )

            do {
                let data = try submission.toJSONData()
                self.queue.enqueue(id: submission.id, submissionJSON: data)
                self.log("submission \(submission.id) queued")
                completion(true)
            } catch {
                self.log("report failed: \(error.localizedDescription)")
                completion(false)
            }
        }
    }

    /// Submits a research response. No screenshot, so no capture step.
    public func submitResearchResponse(
        studyId: String,
        answers: [Answer],
        completed: Bool,
        durationMs: Int64? = nil,
        route: String? = nil
    ) {
        worker.async { [weak self] in
            guard let self else { return }

            let submission = Submission(
                projectId: self.config.projectId,
                payload: .researchResponse(
                    studyId: studyId,
                    answers: answers,
                    completed: completed,
                    durationMs: durationMs
                ),
                device: DeviceInfo.collect(sdkVersion: sdkVersion, route: route),
                reporter: self.reporter,
                customData: self.customData,
                consent: self.consent.load()
            )

            if let data = try? submission.toJSONData() {
                self.queue.enqueue(id: submission.id, submissionJSON: data)
                self.log("research response \(submission.id) queued")
            }
        }
    }

    /// Retry anything stranded by an earlier network failure.
    public func flush(completion: @escaping (SubmissionQueue.FlushResult) -> Void = { _ in }) {
        worker.async { [weak self] in
            guard let self else { return }
            completion(self.queue.flush())
        }
    }

    private func uploadScreenshot(_ capture: (data: Data, width: Int, height: Int)) throws -> Attachment {
        let uploader = MultipartUploader(endpoint: config.endpoint, projectId: config.projectId)
        let id = try uploader.upload(pngData: capture.data, filename: "screenshot.png")
        return Attachment(
            id: id,
            kind: "screenshot",
            mimeType: "image/png",
            byteSize: capture.data.count,
            width: capture.width,
            height: capture.height
        )
    }

    private func log(_ message: String) {
        if !config.silent { print("[markerio] \(message)") }
    }
}
