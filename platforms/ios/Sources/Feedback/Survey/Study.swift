import Foundation

/**
 Study definitions — the questions a research study asks.

 Swift mirror of `packages/core/src/study.ts` and `Study.kt`. A study is a
 contract between the host product (which authors it), the SDK (which renders
 it) and the dashboard (which aggregates it); all three must agree on what a
 question means. Aggregation depends on the type — an NPS score is not
 computable from a scale whose bounds the dashboard has to guess.
 */

public enum QuestionType: String, Codable {
    case nps
    case rating
    case singleChoice = "single_choice"
    case multiChoice = "multi_choice"
    case text
}

public enum Question {
    /// Net Promoter Score. Fixed 0–10 by definition, so the range is not
    /// configurable — a "0–7 NPS" is not an NPS and could not be compared to
    /// anything.
    case nps(id: String, prompt: String, help: String? = nil, required: Bool = false,
             labels: (String, String)? = nil)

    /// `scale` is the inclusive upper bound, 2–10. Lower bound is always 1.
    case rating(id: String, prompt: String, help: String? = nil, required: Bool = false,
                scale: Int = 5, labels: (String, String)? = nil)

    case choice(id: String, prompt: String, help: String? = nil, required: Bool = false,
                options: [String], multiple: Bool = false)

    case text(id: String, prompt: String, help: String? = nil, required: Bool = false,
              placeholder: String? = nil, maxLength: Int = 2000)

    public var id: String {
        switch self {
        case let .nps(id, _, _, _, _): return id
        case let .rating(id, _, _, _, _, _): return id
        case let .choice(id, _, _, _, _, _): return id
        case let .text(id, _, _, _, _, _): return id
        }
    }

    public var prompt: String {
        switch self {
        case let .nps(_, prompt, _, _, _): return prompt
        case let .rating(_, prompt, _, _, _, _): return prompt
        case let .choice(_, prompt, _, _, _, _): return prompt
        case let .text(_, prompt, _, _, _, _): return prompt
        }
    }

    public var help: String? {
        switch self {
        case let .nps(_, _, help, _, _): return help
        case let .rating(_, _, help, _, _, _): return help
        case let .choice(_, _, help, _, _, _): return help
        case let .text(_, _, help, _, _, _): return help
        }
    }

    public var isRequired: Bool {
        switch self {
        case let .nps(_, _, _, required, _): return required
        case let .rating(_, _, _, required, _, _): return required
        case let .choice(_, _, _, required, _, _): return required
        case let .text(_, _, _, required, _, _): return required
        }
    }
}

public struct Study {
    public let id: String
    public let name: String
    public let questions: [Question]
    public let intro: String?
    public let thanks: String?
    public let active: Bool

    public init(
        id: String,
        name: String,
        questions: [Question],
        intro: String? = nil,
        thanks: String? = nil,
        active: Bool = true
    ) {
        self.id = id
        self.name = name
        self.questions = questions
        self.intro = intro
        self.thanks = thanks
        self.active = active
    }
}

/**
 Validates a study before anything renders.

 A malformed study is far better caught as a log line at integration time than
 as a blank question shown to a real user.
 */
public func validateStudy(_ study: Study) -> [String] {
    var problems: [String] = []

    if study.id.isEmpty { problems.append("study.id is required") }
    if study.questions.isEmpty { problems.append("study must have at least one question") }

    var seen = Set<String>()

    for (index, question) in study.questions.enumerated() {
        let where_ = "question \(index + 1)"

        if question.id.isEmpty {
            problems.append("\(where_): id is required")
        } else if !seen.insert(question.id).inserted {
            // Duplicate ids silently overwrite each other in the answer map,
            // losing a response with no error anywhere.
            problems.append("\(where_): duplicate id \"\(question.id)\"")
        }

        if question.prompt.isEmpty { problems.append("\(where_): prompt is required") }

        switch question {
        case let .rating(_, _, _, _, scale, _):
            if scale < 2 || scale > 10 {
                problems.append("\(where_): scale must be between 2 and 10")
            }
        case let .choice(_, _, _, _, options, _):
            if options.isEmpty {
                problems.append("\(where_): options are required")
            } else if Set(options).count != options.count {
                // Duplicate labels make the choice breakdown ambiguous.
                problems.append("\(where_): options must be unique")
            }
        default:
            break
        }
    }

    return problems
}

/// An in-progress answer, before it becomes wire format.
public enum AnswerDraft: Equatable {
    case number(Int)
    case single(String)
    case multiple([String])
    case free(String)
}

/// Whether an answer satisfies its question, used to gate "Next".
public func isAnswered(_ question: Question, _ draft: AnswerDraft?) -> Bool {
    guard let draft else { return false }

    switch (question, draft) {
    case (.nps, .number), (.rating, .number):
        return true
    case let (.choice(_, _, _, _, _, multiple), .multiple(values)):
        return multiple && !values.isEmpty
    case let (.choice(_, _, _, _, _, multiple), .single(value)):
        return !multiple && !value.isEmpty
    case let (.text, .free(value)):
        return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    default:
        return false
    }
}

/**
 Converts one in-progress answer into wire format.

 Multi-choice becomes an array, never a joined string: the dashboard counts by
 matching exact option strings, so a joined value would aggregate to zero while
 looking perfectly valid on the wire.
 */
public func toAnswer(questionId: String, draft: AnswerDraft) -> Answer {
    switch draft {
    case let .number(value):
        return Answer(questionId: questionId, value: String(value))
    case let .single(value):
        return Answer(questionId: questionId, value: value)
    case let .free(value):
        return Answer(questionId: questionId, value: value)
    case let .multiple(values):
        return Answer(questionId: questionId, values: values)
    }
}
