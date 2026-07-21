#if canImport(UIKit)
import UIKit

/**
 Microsurvey sheet.

 A bottom sheet rather than a full-screen takeover: a research survey interrupts
 someone who opened the app to do something else, and a takeover converts
 curiosity into dismissal. One question at a time keeps it small enough to
 answer without feeling like a form.

 Partial responses are returned, not discarded. Someone who answers two of four
 questions and closes has still told the researcher something, and dropping it
 would bias results toward people with time to finish.

 Mirrors `SurveyPanel.kt`.
 */
final class SurveyPanel: UIView {

    private let study: Study
    private let onDone: ([Answer], Bool, Int64) -> Void
    private let onDismiss: () -> Void

    private var index = 0
    private var drafts: [String: AnswerDraft] = [:]
    private let startedAt = Date()

    private let sheet = UIView()
    private let bodyStack = UIStackView()
    private let progressFill = UIView()
    private var progressWidth: NSLayoutConstraint?
    private let counter = UILabel()
    private let nextButton = UIButton(type: .system)
    private let skipButton = UIButton(type: .system)

    private let accent = UIColor(red: 0.31, green: 0.27, blue: 0.90, alpha: 1)
    private let border = UIColor(red: 0.89, green: 0.91, blue: 0.93, alpha: 1)
    private let muted = UIColor(red: 0.40, green: 0.44, blue: 0.52, alpha: 1)

    init(
        study: Study,
        onDone: @escaping ([Answer], Bool, Int64) -> Void,
        onDismiss: @escaping () -> Void
    ) {
        self.study = study
        self.onDone = onDone
        self.onDismiss = onDismiss
        super.init(frame: .zero)

        backgroundColor = UIColor.black.withAlphaComponent(0.4)
        buildLayout()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported; this view is created in code")
    }

    /// Presents the sheet, or reports a dismissal if the study is malformed.
    func present(in window: UIWindow) -> Bool {
        let problems = validateStudy(study)
        guard problems.isEmpty else {
            // Loudly at integration time, rather than a blank question shown to
            // a real user.
            print("[markerio] invalid study \"\(study.id)\":\n  \(problems.joined(separator: "\n  "))")
            onDismiss()
            return false
        }

        frame = window.bounds
        autoresizingMask = [.flexibleWidth, .flexibleHeight]
        window.addSubview(self)
        renderStep()
        return true
    }

    private func finish(completed: Bool) {
        let answers = study.questions.compactMap { question -> Answer? in
            guard let draft = drafts[question.id] else { return nil }
            return toAnswer(questionId: question.id, draft: draft)
        }

        removeFromSuperview()

        // Nothing answered and dismissed: a decline, not a response.
        if !completed && answers.isEmpty {
            onDismiss()
            return
        }
        onDone(answers, completed, Int64(Date().timeIntervalSince(startedAt) * 1000))
    }

    // MARK: - chrome

    private func buildLayout() {
        // Tapping the scrim dismisses, matching platform convention for a sheet
        // the user did not ask for.
        let scrimTap = UITapGestureRecognizer(target: self, action: #selector(scrimTapped))
        addGestureRecognizer(scrimTap)

        sheet.backgroundColor = .white
        sheet.layer.cornerRadius = 16
        sheet.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        sheet.translatesAutoresizingMaskIntoConstraints = false
        // Swallow taps so they do not reach the dismissing scrim behind.
        sheet.addGestureRecognizer(UITapGestureRecognizer(target: nil, action: nil))
        addSubview(sheet)

        let track = UIView()
        track.backgroundColor = UIColor(red: 0.95, green: 0.96, blue: 0.97, alpha: 1)
        track.layer.cornerRadius = 2
        track.translatesAutoresizingMaskIntoConstraints = false

        progressFill.backgroundColor = accent
        progressFill.layer.cornerRadius = 2
        progressFill.translatesAutoresizingMaskIntoConstraints = false
        track.addSubview(progressFill)

        let close = UIButton(type: .system)
        close.setTitle("✕", for: .normal)
        close.setTitleColor(muted, for: .normal)
        close.accessibilityIdentifier = "survey-close"
        close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        close.translatesAutoresizingMaskIntoConstraints = false

        bodyStack.axis = .vertical
        bodyStack.spacing = 10
        bodyStack.translatesAutoresizingMaskIntoConstraints = false

        counter.font = .systemFont(ofSize: 12)
        counter.textColor = UIColor(red: 0.60, green: 0.64, blue: 0.70, alpha: 1)

        skipButton.setTitle("Skip", for: .normal)
        skipButton.setTitleColor(muted, for: .normal)
        skipButton.titleLabel?.font = .systemFont(ofSize: 13, weight: .medium)
        skipButton.accessibilityIdentifier = "survey-skip"
        skipButton.addTarget(self, action: #selector(skipTapped), for: .touchUpInside)

        nextButton.setTitleColor(.white, for: .normal)
        nextButton.titleLabel?.font = .systemFont(ofSize: 13, weight: .semibold)
        nextButton.backgroundColor = accent
        nextButton.layer.cornerRadius = 7
        nextButton.contentEdgeInsets = UIEdgeInsets(top: 9, left: 18, bottom: 9, right: 18)
        nextButton.accessibilityIdentifier = "survey-next"
        nextButton.addTarget(self, action: #selector(nextTapped), for: .touchUpInside)

        let footer = UIStackView(arrangedSubviews: [counter, skipButton, nextButton])
        footer.axis = .horizontal
        footer.spacing = 8
        footer.alignment = .center
        footer.translatesAutoresizingMaskIntoConstraints = false

        sheet.addSubview(track)
        sheet.addSubview(close)
        sheet.addSubview(bodyStack)
        sheet.addSubview(footer)

        let fillWidth = progressFill.widthAnchor.constraint(equalToConstant: 0)
        progressWidth = fillWidth

        NSLayoutConstraint.activate([
            sheet.leadingAnchor.constraint(equalTo: leadingAnchor),
            sheet.trailingAnchor.constraint(equalTo: trailingAnchor),
            // safeAreaLayoutGuide, or the footer sits under the home indicator.
            sheet.bottomAnchor.constraint(equalTo: bottomAnchor),

            track.topAnchor.constraint(equalTo: sheet.topAnchor, constant: 14),
            track.leadingAnchor.constraint(equalTo: sheet.leadingAnchor, constant: 20),
            track.heightAnchor.constraint(equalToConstant: 3),
            track.trailingAnchor.constraint(equalTo: close.leadingAnchor, constant: -10),

            progressFill.leadingAnchor.constraint(equalTo: track.leadingAnchor),
            progressFill.topAnchor.constraint(equalTo: track.topAnchor),
            progressFill.bottomAnchor.constraint(equalTo: track.bottomAnchor),
            fillWidth,

            close.trailingAnchor.constraint(equalTo: sheet.trailingAnchor, constant: -16),
            close.centerYAnchor.constraint(equalTo: track.centerYAnchor),

            bodyStack.topAnchor.constraint(equalTo: track.bottomAnchor, constant: 18),
            bodyStack.leadingAnchor.constraint(equalTo: sheet.leadingAnchor, constant: 20),
            bodyStack.trailingAnchor.constraint(equalTo: sheet.trailingAnchor, constant: -20),

            footer.topAnchor.constraint(equalTo: bodyStack.bottomAnchor, constant: 18),
            footer.leadingAnchor.constraint(equalTo: sheet.leadingAnchor, constant: 20),
            footer.trailingAnchor.constraint(equalTo: sheet.trailingAnchor, constant: -20),
            footer.bottomAnchor.constraint(equalTo: safeAreaLayoutGuide.bottomAnchor, constant: -18),
        ])
    }

    @objc private func scrimTapped() { finish(completed: false) }
    @objc private func closeTapped() { finish(completed: false) }
    @objc private func skipTapped() { advance(skipped: true) }
    @objc private func nextTapped() { advance(skipped: false) }

    // MARK: - steps

    private func renderStep() {
        guard index < study.questions.count else { return }
        let question = study.questions[index]
        let total = study.questions.count

        counter.text = "\(index + 1) of \(total)"
        nextButton.setTitle(index == total - 1 ? "Submit" : "Next", for: .normal)
        // A required question cannot be skipped, so the affordance is removed
        // rather than left visible and inert.
        skipButton.isHidden = question.isRequired

        layoutIfNeeded()
        progressWidth?.constant = (bounds.width - 40) * CGFloat(index) / CGFloat(total)

        bodyStack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        let prompt = UILabel()
        prompt.text = question.prompt
        prompt.font = .systemFont(ofSize: 16, weight: .semibold)
        prompt.numberOfLines = 0
        bodyStack.addArrangedSubview(prompt)

        if let help = question.help {
            let label = UILabel()
            label.text = help
            label.font = .systemFont(ofSize: 13)
            label.textColor = muted
            label.numberOfLines = 0
            bodyStack.addArrangedSubview(label)
        }

        switch question {
        case let .nps(id, _, _, _, labels):
            bodyStack.addArrangedSubview(scaleView(id: id, from: 0, to: 10, labels: labels))
        case let .rating(id, _, _, _, scale, labels):
            bodyStack.addArrangedSubview(scaleView(id: id, from: 1, to: scale, labels: labels))
        case let .choice(id, _, _, _, options, multiple):
            bodyStack.addArrangedSubview(choiceView(id: id, options: options, multiple: multiple))
        case let .text(id, _, _, _, placeholder, maxLength):
            bodyStack.addArrangedSubview(textView(id: id, placeholder: placeholder, maxLength: maxLength))
        }

        syncNext()
    }

    private var scaleButtons: [Int: UIButton] = [:]

    private func scaleView(id: String, from: Int, to: Int, labels: (String, String)?) -> UIView {
        scaleButtons.removeAll()

        let row = UIStackView()
        row.axis = .horizontal
        row.distribution = .fillEqually
        row.spacing = 3

        for value in from...to {
            let button = UIButton(type: .system)
            button.setTitle(String(value), for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 13, weight: .medium)
            button.layer.cornerRadius = 7
            button.layer.borderWidth = 1
            button.accessibilityIdentifier = "survey-scale-\(value)"
            button.tag = value
            button.addTarget(self, action: #selector(scaleTapped(_:)), for: .touchUpInside)
            button.heightAnchor.constraint(equalToConstant: 40).isActive = true

            scaleButtons[value] = button
            row.addArrangedSubview(button)
        }

        scaleQuestionId = id
        styleScale()

        guard let labels else { return row }

        let low = UILabel()
        low.text = labels.0
        low.font = .systemFont(ofSize: 11)
        low.textColor = UIColor(red: 0.60, green: 0.64, blue: 0.70, alpha: 1)

        let high = UILabel()
        high.text = labels.1
        high.font = .systemFont(ofSize: 11)
        high.textColor = low.textColor
        high.textAlignment = .right

        let ends = UIStackView(arrangedSubviews: [low, high])
        ends.axis = .horizontal
        ends.distribution = .fillEqually

        let column = UIStackView(arrangedSubviews: [row, ends])
        column.axis = .vertical
        column.spacing = 6
        return column
    }

    private var scaleQuestionId = ""

    @objc private func scaleTapped(_ sender: UIButton) {
        drafts[scaleQuestionId] = .number(sender.tag)
        styleScale()
        syncNext()
    }

    private func styleScale() {
        let selected: Int? = {
            if case let .number(value)? = drafts[scaleQuestionId] { return value }
            return nil
        }()

        for (value, button) in scaleButtons {
            let on = value == selected
            button.backgroundColor = on ? accent : .clear
            button.layer.borderColor = (on ? accent : border).cgColor
            button.setTitleColor(on ? .white : UIColor(red: 0.28, green: 0.33, blue: 0.40, alpha: 1), for: .normal)
        }
    }

    private var choiceButtons: [String: UIButton] = [:]
    private var choiceQuestionId = ""
    private var choiceMultiple = false

    private func choiceView(id: String, options: [String], multiple: Bool) -> UIView {
        choiceButtons.removeAll()
        choiceQuestionId = id
        choiceMultiple = multiple

        let column = UIStackView()
        column.axis = .vertical
        column.spacing = 6

        for option in options {
            let button = UIButton(type: .system)
            button.setTitle(option, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 14)
            button.contentHorizontalAlignment = .left
            button.contentEdgeInsets = UIEdgeInsets(top: 11, left: 12, bottom: 11, right: 12)
            button.layer.cornerRadius = 8
            button.layer.borderWidth = 1
            button.accessibilityIdentifier = "survey-choice-\(option)"
            button.addTarget(self, action: #selector(choiceTapped(_:)), for: .touchUpInside)

            choiceButtons[option] = button
            column.addArrangedSubview(button)
        }

        styleChoices()
        return column
    }

    @objc private func choiceTapped(_ sender: UIButton) {
        guard let option = sender.title(for: .normal) else { return }

        if choiceMultiple {
            var current: [String] = {
                if case let .multiple(values)? = drafts[choiceQuestionId] { return values }
                return []
            }()

            if let at = current.firstIndex(of: option) { current.remove(at: at) } else { current.append(option) }
            if current.isEmpty { drafts.removeValue(forKey: choiceQuestionId) }
            else { drafts[choiceQuestionId] = .multiple(current) }
        } else {
            drafts[choiceQuestionId] = .single(option)
        }

        styleChoices()
        syncNext()
    }

    private func styleChoices() {
        let selected: Set<String> = {
            switch drafts[choiceQuestionId] {
            case let .multiple(values): return Set(values)
            case let .single(value): return [value]
            default: return []
            }
        }()

        for (option, button) in choiceButtons {
            let on = selected.contains(option)
            button.backgroundColor = on ? UIColor(red: 0.93, green: 0.95, blue: 1, alpha: 1) : .clear
            button.layer.borderColor = (on ? accent : border).cgColor
            button.setTitleColor(on ? UIColor(red: 0.21, green: 0.19, blue: 0.64, alpha: 1)
                                    : UIColor(red: 0.20, green: 0.25, blue: 0.33, alpha: 1), for: .normal)
        }
    }

    private var textQuestionId = ""

    private func textView(id: String, placeholder: String?, maxLength: Int) -> UIView {
        textQuestionId = id

        let field = UITextView()
        field.font = .systemFont(ofSize: 14)
        field.backgroundColor = UIColor(red: 0.98, green: 0.98, blue: 0.98, alpha: 1)
        field.layer.cornerRadius = 8
        field.layer.borderWidth = 1
        field.layer.borderColor = border.cgColor
        field.textContainerInset = UIEdgeInsets(top: 10, left: 8, bottom: 10, right: 8)
        field.accessibilityIdentifier = "survey-text"
        field.delegate = self
        field.heightAnchor.constraint(equalToConstant: 84).isActive = true

        if case let .free(existing)? = drafts[id] { field.text = existing }
        return field
    }

    private func syncNext() {
        guard index < study.questions.count else { return }
        let question = study.questions[index]
        let ok = !question.isRequired || isAnswered(question, drafts[question.id])

        nextButton.isEnabled = ok
        nextButton.alpha = ok ? 1 : 0.45
    }

    private func advance(skipped: Bool) {
        if skipped, index < study.questions.count {
            drafts.removeValue(forKey: study.questions[index].id)
        }

        guard index < study.questions.count - 1 else {
            showThanks()
            return
        }
        index += 1
        renderStep()
    }

    private func showThanks() {
        bodyStack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        let label = UILabel()
        label.text = study.thanks ?? "Thanks — that helps."
        label.font = .systemFont(ofSize: 15)
        label.textColor = muted
        label.textAlignment = .center
        label.numberOfLines = 0
        bodyStack.addArrangedSubview(label)

        counter.isHidden = true
        skipButton.isHidden = true
        nextButton.isHidden = true

        // Resolve now so the host records the response immediately; the sheet
        // lingers only as an acknowledgement.
        let answers = study.questions.compactMap { question -> Answer? in
            guard let draft = drafts[question.id] else { return nil }
            return toAnswer(questionId: question.id, draft: draft)
        }
        onDone(answers, true, Int64(Date().timeIntervalSince(startedAt) * 1000))

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
            self?.removeFromSuperview()
        }
    }
}

extension SurveyPanel: UITextViewDelegate {
    func textViewDidChange(_ textView: UITextView) {
        let value = textView.text ?? ""
        if value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            drafts.removeValue(forKey: textQuestionId)
        } else {
            drafts[textQuestionId] = .free(value)
        }
        syncNext()
    }
}
#endif
