import XCTest
@testable import SusaSignals

/**
 Study validation and answer serialization.

 Mirrors `SurveyTest.kt` case for case; divergence is the first sign the
 platforms have drifted on what a question means.
 */
final class SurveyTests: XCTestCase {

    private func study(_ questions: Question...) -> Study {
        Study(id: "s1", name: "Study", questions: questions)
    }

    func testWellFormedStudyValidates() {
        let problems = validateStudy(study(
            .nps(id: "nps", prompt: "How likely?"),
            .text(id: "why", prompt: "Why?")
        ))
        XCTAssertTrue(problems.isEmpty, "\(problems)")
    }

    func testStudyWithNoQuestionsIsRejected() {
        let problems = validateStudy(Study(id: "s1", name: "Empty", questions: []))
        XCTAssertTrue(problems.contains { $0.contains("at least one question") })
    }

    func testDuplicateQuestionIdsAreRejected() {
        let problems = validateStudy(study(
            .nps(id: "same", prompt: "First"),
            .text(id: "same", prompt: "Second")
        ))
        // Duplicates silently overwrite in the answer map, losing a response
        // with no error anywhere.
        XCTAssertTrue(problems.contains { $0.contains("duplicate") })
    }

    func testRatingScaleOutsideRangeIsRejected() {
        XCTAssertTrue(validateStudy(study(.rating(id: "r", prompt: "Rate", scale: 1)))
            .contains { $0.contains("scale") })
        XCTAssertTrue(validateStudy(study(.rating(id: "r", prompt: "Rate", scale: 50)))
            .contains { $0.contains("scale") })
    }

    func testDuplicateChoiceOptionsAreRejected() {
        let problems = validateStudy(study(
            .choice(id: "c", prompt: "Pick", options: ["A", "B", "A"])
        ))
        // Duplicate labels make the choice breakdown ambiguous.
        XCTAssertTrue(problems.contains { $0.contains("unique") })
    }

    func testRequiredQuestionsGateOnBeingAnswered() {
        let nps = Question.nps(id: "nps", prompt: "How likely?", required: true)
        XCTAssertFalse(isAnswered(nps, nil))
        XCTAssertTrue(isAnswered(nps, .number(9)))

        let text = Question.text(id: "t", prompt: "Why?", required: true)
        XCTAssertFalse(isAnswered(text, .free("   ")))
        XCTAssertTrue(isAnswered(text, .free("because")))

        let multi = Question.choice(id: "c", prompt: "Pick", options: ["A"], multiple: true)
        XCTAssertFalse(isAnswered(multi, .multiple([])))
        XCTAssertTrue(isAnswered(multi, .multiple(["A"])))
    }

    func testMultiChoiceSerializesAsArrayNotJoinedString() throws {
        let answer = toAnswer(questionId: "blocker", draft: .multiple(["Payment failed", "Confusing pricing"]))

        // The one that matters. The dashboard counts by matching exact option
        // strings, so "Payment failed, Confusing pricing" would match neither
        // option and aggregate to zero while looking valid on the wire.
        XCTAssertNil(answer.value, "multi-choice must not use the scalar field")
        XCTAssertEqual(answer.values, ["Payment failed", "Confusing pricing"])

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let json = String(data: try encoder.encode(answer), encoding: .utf8)!
        XCTAssertTrue(json.contains(#"["Payment failed","Confusing pricing"]"#), json)
    }

    func testSingleChoiceSerializesAsScalar() throws {
        let answer = toAnswer(questionId: "blocker", draft: .single("Payment failed"))
        XCTAssertEqual(answer.value, "Payment failed")
        XCTAssertNil(answer.values)

        let json = String(data: try JSONEncoder().encode(answer), encoding: .utf8)!
        XCTAssertTrue(json.contains(#""value":"Payment failed""#), json)
    }

    func testNumericAnswersSerializeAsTheirValue() {
        XCTAssertEqual(toAnswer(questionId: "nps", draft: .number(9)).value, "9")
    }

    func testMultiChoiceSurvivesTheFullSubmissionPayload() throws {
        let submission = Submission(
            projectId: "proj",
            payload: .researchResponse(
                studyId: "s1",
                answers: [
                    toAnswer(questionId: "blocker", draft: .multiple(["Payment failed", "Missing feature"])),
                    toAnswer(questionId: "nps", draft: .number(9)),
                ],
                completed: true,
                durationMs: nil
            ),
            device: DeviceContext(sdkVersion: "0.0.0")
        )

        let json = String(data: try submission.toJSONData(), encoding: .utf8)!
        // Array form on the wire, matching web and Android.
        XCTAssertTrue(json.contains(#"["Payment failed","Missing feature"]"#), json)
        XCTAssertTrue(json.contains(#""value":"9""#), json)
    }
}
