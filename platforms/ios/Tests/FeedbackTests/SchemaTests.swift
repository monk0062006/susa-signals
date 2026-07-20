import XCTest
@testable import Feedback

/// Mirrors `SchemaTest.kt`. The schema is hand-copied across three languages, so
/// serialization is where drift shows up first.
final class SchemaTests: XCTestCase {

    private func submission(_ payload: SubmissionPayload) -> Submission {
        var device = DeviceContext(sdkVersion: "0.0.0")
        device.osVersion = "17.0"
        device.deviceModel = "iPhone15,2"

        return Submission(
            id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
            projectId: "proj_test",
            payload: payload,
            device: device,
            createdAt: 1_750_000_000_000
        )
    }

    private func jsonString(_ submission: Submission) throws -> String {
        String(data: try submission.toJSONData(), encoding: .utf8)!
    }

    func testBugReportSerializesWithDiscriminatedPayloadType() throws {
        let json = try jsonString(
            submission(.bugReport(
                kind: .bug,
                title: "Checkout fails",
                description: "Tapping Pay does nothing",
                annotations: [],
                logs: []
            ))
        )

        XCTAssertTrue(json.contains(#""type":"bug_report""#))
        XCTAssertTrue(json.contains(#""title":"Checkout fails""#))
        XCTAssertTrue(json.contains(#""platform":"ios""#))
        XCTAssertTrue(json.contains(#""deviceModel":"iPhone15,2""#))
    }

    func testResearchResponseSerializesWithItsOwnPayloadType() throws {
        let json = try jsonString(
            submission(.researchResponse(
                studyId: "study_1",
                answers: [Answer(questionId: "q1", value: "Very easy")],
                completed: true,
                durationMs: 45_000
            ))
        )

        XCTAssertTrue(json.contains(#""type":"research_response""#))
        XCTAssertTrue(json.contains(#""studyId":"study_1""#))
        XCTAssertTrue(json.contains(#""completed":true"#))
        XCTAssertTrue(json.contains(#""questionId":"q1""#))
    }

    func testNilOptionalFieldsAreOmittedNotEmittedAsNull() throws {
        let json = try jsonString(
            submission(.bugReport(kind: .bug, title: "No description", description: nil, annotations: [], logs: []))
        )

        // Absent and null mean different things to the validator.
        XCTAssertFalse(json.contains(#""description""#))
        XCTAssertFalse(json.contains(#""reporter""#))
        XCTAssertFalse(json.contains("null"))
    }

    func testHostileTextIsEscaped() throws {
        // A title like this is exactly what a user reporting a JSON bug would type.
        let hostile = "He said \"hi\"\nthen \\ left"
        let json = try jsonString(
            submission(.bugReport(kind: .bug, title: hostile, description: nil, annotations: [], logs: []))
        )

        XCTAssertTrue(json.contains(#"\"hi\""#))
        XCTAssertTrue(json.contains(#"\n"#))
        // The raw newline must not survive into the payload.
        XCTAssertFalse(json.contains("hi\"\nthen"))
    }

    func testAnnotationsSerializeInNormalizedCoordinates() throws {
        let json = try jsonString(
            submission(.bugReport(
                kind: .bug,
                title: "Annotated",
                description: nil,
                annotations: [
                    .blur(origin: Point(x: 0.1, y: 0.2), width: 0.3, height: 0.4),
                    .arrow(from: Point(x: 0, y: 0), to: Point(x: 1, y: 1), color: "#ff3b30")
                ],
                logs: []
            ))
        )

        XCTAssertTrue(json.contains(#""type":"blur""#))
        XCTAssertTrue(json.contains(#""type":"arrow""#))
        // Escaped rather than raw: `"#` inside a #"..."# literal closes it early.
        XCTAssertTrue(json.contains("\"color\":\"#ff3b30\""))
    }
}
