import Foundation

/**
 Swift mirror of the wire format in `packages/core`.

 Third hand-maintained copy of one schema. The drift risk is real and called out
 in the README — generating all three from a single source is the correct fix.

 Deliberately free of UIKit so schema tests run on any platform.
 */

public enum Platform: String, Codable {
    case web, ios, android
}

public enum ReportKind: String, Codable {
    case bug, feedback, question
}

public struct Reporter: Codable, Equatable {
    public var email: String?
    public var fullName: String?
    public var externalId: String?

    public init(email: String? = nil, fullName: String? = nil, externalId: String? = nil) {
        self.email = email
        self.fullName = fullName
        self.externalId = externalId
    }
}

public struct ScreenInfo: Codable, Equatable {
    public let width: Int
    public let height: Int
    public let pixelRatio: Double
}

public struct DeviceContext: Codable, Equatable {
    public var platform: Platform = .ios
    public var sdkVersion: String
    public var osName: String? = "iOS"
    public var osVersion: String?
    public var deviceModel: String?
    public var locale: String?
    public var timezone: String?
    public var screen: ScreenInfo?
    /// The screen/route the user was on. The native analogue of a URL.
    public var route: String?
    public var appVersion: String?
    public var appBuild: String?
    public var networkType: String?

    public init(sdkVersion: String) {
        self.sdkVersion = sdkVersion
    }
}

public struct LogEntry: Codable, Equatable {
    public let level: String
    public let message: String
    public let timestamp: Int64
}

public struct Attachment: Codable, Equatable {
    public let id: String
    public let kind: String
    public let mimeType: String
    public let byteSize: Int
    public var width: Int?
    public var height: Int?
}

/// Normalized 0..1 so annotations survive any rescale, exactly as on web.
public struct Point: Codable, Equatable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

public enum Annotation: Equatable {
    case rect(origin: Point, width: Double, height: Double, color: String)
    case arrow(from: Point, to: Point, color: String)
    case pen(points: [Point], color: String, strokeWidth: Double)
    /// Must be burned into the image, never merely overlaid.
    case blur(origin: Point, width: Double, height: Double)
}

extension Annotation: Encodable {
    private enum CodingKeys: String, CodingKey {
        case type, origin, width, height, color, from, to, points, strokeWidth
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .rect(origin, width, height, color):
            try container.encode("rect", forKey: .type)
            try container.encode(origin, forKey: .origin)
            try container.encode(width, forKey: .width)
            try container.encode(height, forKey: .height)
            try container.encode(color, forKey: .color)
        case let .arrow(from, to, color):
            try container.encode("arrow", forKey: .type)
            try container.encode(from, forKey: .from)
            try container.encode(to, forKey: .to)
            try container.encode(color, forKey: .color)
        case let .pen(points, color, strokeWidth):
            try container.encode("pen", forKey: .type)
            try container.encode(points, forKey: .points)
            try container.encode(color, forKey: .color)
            try container.encode(strokeWidth, forKey: .strokeWidth)
        case let .blur(origin, width, height):
            try container.encode("blur", forKey: .type)
            try container.encode(origin, forKey: .origin)
            try container.encode(width, forKey: .width)
            try container.encode(height, forKey: .height)
        }
    }
}

public struct Answer: Codable, Equatable {
    public let questionId: String
    public let value: String

    public init(questionId: String, value: String) {
        self.questionId = questionId
        self.value = value
    }
}

public enum SubmissionPayload: Equatable {
    case bugReport(kind: ReportKind, title: String, description: String?, annotations: [Annotation], logs: [LogEntry])
    case researchResponse(studyId: String, answers: [Answer], completed: Bool, durationMs: Int64?)
}

extension SubmissionPayload: Encodable {
    private enum CodingKeys: String, CodingKey {
        case type, kind, title, description, annotations, consoleLogs
        case studyId, answers, completed, durationMs
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .bugReport(kind, title, description, annotations, logs):
            try container.encode("bug_report", forKey: .type)
            try container.encode(kind, forKey: .kind)
            try container.encode(title, forKey: .title)
            // encodeIfPresent, not encode: absent and null are different on the
            // wire, and the validator treats them differently.
            try container.encodeIfPresent(description, forKey: .description)
            try container.encode(annotations, forKey: .annotations)
            try container.encode(logs, forKey: .consoleLogs)
        case let .researchResponse(studyId, answers, completed, durationMs):
            try container.encode("research_response", forKey: .type)
            try container.encode(studyId, forKey: .studyId)
            try container.encode(answers, forKey: .answers)
            try container.encode(completed, forKey: .completed)
            try container.encodeIfPresent(durationMs, forKey: .durationMs)
        }
    }
}

public struct Submission: Encodable {
    public let id: String
    public let projectId: String
    public let payload: SubmissionPayload
    public let device: DeviceContext
    public var reporter: Reporter?
    public var attachments: [Attachment]
    public var customData: [String: String]?
    public var sessionId: String?
    public var consent: ConsentRecord?
    public let createdAt: Int64

    public init(
        id: String = UUID().uuidString.lowercased(),
        projectId: String,
        payload: SubmissionPayload,
        device: DeviceContext,
        reporter: Reporter? = nil,
        attachments: [Attachment] = [],
        customData: [String: String]? = nil,
        sessionId: String? = nil,
        consent: ConsentRecord? = nil,
        createdAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    ) {
        self.id = id
        self.projectId = projectId
        self.payload = payload
        self.device = device
        self.reporter = reporter
        self.attachments = attachments
        self.customData = customData
        self.sessionId = sessionId
        self.consent = consent
        self.createdAt = createdAt
    }

    /// Serialized form the outbox stores and replays verbatim.
    public func toJSONData() throws -> Data {
        let encoder = JSONEncoder()
        // Stable key order makes the wire format diffable against the other two
        // platforms when chasing schema drift.
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(self)
    }
}
