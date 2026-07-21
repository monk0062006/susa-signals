package io.markerusa.feedback.survey

/**
 * Study definitions — the questions a research study asks.
 *
 * Kotlin mirror of `packages/core/src/study.ts`. A study is a contract between
 * the host product (which authors it), the SDK (which renders it) and the
 * dashboard (which aggregates it); all three must agree on what a question
 * means. Aggregation in particular depends on the type — an NPS score is not
 * computable from a scale whose bounds the dashboard has to guess.
 */

enum class QuestionType(val wire: String) {
    NPS("nps"),
    RATING("rating"),
    SINGLE_CHOICE("single_choice"),
    MULTI_CHOICE("multi_choice"),
    TEXT("text")
}

sealed class Question {
    abstract val id: String
    abstract val prompt: String
    abstract val help: String?
    abstract val required: Boolean

    /**
     * Net Promoter Score. Fixed 0–10 by definition, so the range is not
     * configurable — a "0–7 NPS" is not an NPS, and allowing it would produce
     * scores that cannot be compared to anything.
     */
    data class Nps(
        override val id: String,
        override val prompt: String,
        override val help: String? = null,
        override val required: Boolean = false,
        val labels: Pair<String, String>? = null
    ) : Question()

    data class Rating(
        override val id: String,
        override val prompt: String,
        override val help: String? = null,
        override val required: Boolean = false,
        /** Inclusive upper bound, 2–10. Lower bound is always 1. */
        val scale: Int = 5,
        val labels: Pair<String, String>? = null
    ) : Question()

    data class Choice(
        override val id: String,
        override val prompt: String,
        override val help: String? = null,
        override val required: Boolean = false,
        val options: List<String>,
        val multiple: Boolean = false
    ) : Question()

    data class Text(
        override val id: String,
        override val prompt: String,
        override val help: String? = null,
        override val required: Boolean = false,
        val placeholder: String? = null,
        val maxLength: Int = MAX_TEXT_ANSWER
    ) : Question()

    companion object {
        const val MAX_TEXT_ANSWER = 2000
    }
}

data class Study(
    val id: String,
    val name: String,
    val questions: List<Question>,
    val intro: String? = null,
    val thanks: String? = null,
    val active: Boolean = true
)

/**
 * Validates a study before anything renders.
 *
 * A malformed study is far better caught as a log line at integration time than
 * as a blank question shown to a real user.
 */
fun validateStudy(study: Study): List<String> {
    val problems = mutableListOf<String>()

    if (study.id.isBlank()) problems.add("study.id is required")
    if (study.questions.isEmpty()) problems.add("study must have at least one question")

    val seen = mutableSetOf<String>()

    study.questions.forEachIndexed { index, question ->
        val where = "question ${index + 1}"

        when {
            question.id.isBlank() -> problems.add("$where: id is required")
            // Duplicate ids silently overwrite each other in the answer map,
            // losing a response with no error anywhere.
            !seen.add(question.id) -> problems.add("$where: duplicate id \"${question.id}\"")
        }

        if (question.prompt.isBlank()) problems.add("$where: prompt is required")

        when (question) {
            is Question.Rating ->
                if (question.scale !in 2..10) problems.add("$where: scale must be between 2 and 10")
            is Question.Choice -> when {
                question.options.isEmpty() -> problems.add("$where: options are required")
                // Duplicate labels make the choice breakdown ambiguous.
                question.options.toSet().size != question.options.size ->
                    problems.add("$where: options must be unique")
                else -> {}
            }
            else -> {}
        }
    }

    return problems
}

/** Whether an answer satisfies its question, used to gate "Next". */
fun isAnswered(question: Question, value: Any?): Boolean = when (question) {
    is Question.Nps, is Question.Rating -> value is Int
    is Question.Choice ->
        if (question.multiple) value is List<*> && value.isNotEmpty()
        else value is String && value.isNotEmpty()
    is Question.Text -> value is String && value.isNotBlank()
}

/**
 * Converts one in-progress answer into wire format.
 *
 * Multi-choice becomes an array, never a joined string: the dashboard matches
 * exact option strings when counting, so a joined value would aggregate to zero
 * while looking perfectly valid on the wire.
 */
fun toAnswer(questionId: String, value: Any?): io.markerusa.feedback.Answer = when (value) {
    is List<*> -> io.markerusa.feedback.Answer(
        questionId = questionId,
        values = value.map { it.toString() }
    )
    null -> io.markerusa.feedback.Answer(questionId = questionId, value = "")
    else -> io.markerusa.feedback.Answer(questionId = questionId, value = value.toString())
}
