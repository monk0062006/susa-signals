#if canImport(UIKit)
import UIKit

/// The drawable screenshot surface. Holds annotations in normalized 0..1
/// coordinates so what the user draws over a scaled preview lands correctly on the
/// full-resolution original.
final class AnnotationCanvasView: UIView {

    private let screenshot: UIImage
    private let color: String

    private(set) var annotations: [Annotation] = []
    var tool: Tool = .rect

    private var dragStart: Point?
    private var dragCurrent: Point?
    private var penPoints: [Point] = []

    init(screenshot: UIImage, color: String) {
        self.screenshot = screenshot
        self.color = color
        super.init(frame: .zero)
        backgroundColor = .clear
        isMultipleTouchEnabled = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported; this view is created in code")
    }

    func undo() {
        guard !annotations.isEmpty else { return }
        annotations.removeLast()
        setNeedsDisplay()
    }

    private var imageRect: ImageRect {
        AnnotationGeometry.fitRect(
            viewWidth: Double(bounds.width),
            viewHeight: Double(bounds.height),
            imageWidth: Double(screenshot.size.width),
            imageHeight: Double(screenshot.size.height)
        )
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        let imageRect = self.imageRect
        guard imageRect.width > 0 else { return }

        screenshot.draw(in: CGRect(
            x: imageRect.left,
            y: imageRect.top,
            width: imageRect.width,
            height: imageRect.height
        ))

        AnnotationRenderer.draw(annotations, in: context, rect: imageRect)

        // Render the in-progress shape without committing it.
        if let preview = inProgress() {
            AnnotationRenderer.draw([preview], in: context, rect: imageRect)
        }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let point = normalized(touches) else { return }
        dragStart = point
        dragCurrent = point
        penPoints = tool == .pen ? [point] : []
        setNeedsDisplay()
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let point = normalized(touches) else { return }
        dragCurrent = point
        if tool == .pen { penPoints.append(point) }
        setNeedsDisplay()
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        if let annotation = inProgress() {
            annotations.append(annotation)
        }
        clearDrag()
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        // Do NOT commit on cancel: a system gesture taking over (a back-swipe, a
        // notification pull) would otherwise create shapes the user never drew.
        clearDrag()
    }

    private func clearDrag() {
        dragStart = nil
        dragCurrent = nil
        penPoints = []
        setNeedsDisplay()
    }

    private func normalized(_ touches: Set<UITouch>) -> Point? {
        guard let location = touches.first?.location(in: self) else { return nil }
        return AnnotationGeometry.toNormalized(
            touchX: Double(location.x),
            touchY: Double(location.y),
            rect: imageRect
        )
    }

    private func inProgress() -> Annotation? {
        guard let start = dragStart, let current = dragCurrent else { return nil }
        return AnnotationGeometry.build(
            tool: tool,
            start: start,
            end: current,
            penPoints: penPoints,
            color: color
        )
    }

    /// Burns the committed annotations into the screenshot for upload.
    func flatten() -> Data? {
        AnnotationRenderer.flatten(image: screenshot, annotations: annotations)
    }
}

/**
 The report composer: annotate the screenshot, describe the problem, send.

 Built in code rather than from a storyboard so the package stays self-contained,
 and added to the key window rather than presented as a view controller so
 integrating the SDK requires nothing from the host app's navigation stack.
 */
final class AnnotationComposerView: UIView {

    private let onSend: (String, String?, [Annotation], Data?) -> Void
    private let onCancel: () -> Void

    private let canvas: AnnotationCanvasView
    private let titleField = UITextField()
    private let descriptionField = UITextView()
    private var toolButtons: [(tool: Tool, button: UIButton)] = []

    private let accent = UIColor(red: 0.23, green: 0.51, blue: 0.96, alpha: 1)
    private let panelText = UIColor(white: 0.96, alpha: 1)
    private let muted = UIColor(red: 0.55, green: 0.58, blue: 0.63, alpha: 1)
    private let fieldBorder = UIColor(red: 0.21, green: 0.23, blue: 0.27, alpha: 1)

    init(
        screenshot: UIImage,
        onSend: @escaping (String, String?, [Annotation], Data?) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.canvas = AnnotationCanvasView(screenshot: screenshot, color: "#FF3B30")
        self.onSend = onSend
        self.onCancel = onCancel
        super.init(frame: .zero)

        backgroundColor = UIColor(white: 0.06, alpha: 0.82)
        buildLayout()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported; this view is created in code")
    }

    func present(in window: UIWindow) {
        frame = window.bounds
        autoresizingMask = [.flexibleWidth, .flexibleHeight]
        window.addSubview(self)
    }

    func dismiss() {
        removeFromSuperview()
    }

    // --- layout ---------------------------------------------------------------

    private func buildLayout() {
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false

        canvas.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(canvas)
        stack.addArrangedSubview(buildToolbar())
        stack.addArrangedSubview(buildTitleField())
        stack.addArrangedSubview(buildDescriptionField())
        stack.addArrangedSubview(buildHint())
        stack.addArrangedSubview(buildActions())

        addSubview(stack)

        NSLayoutConstraint.activate([
            // safeAreaLayoutGuide, not bounds: on a notched device the composer
            // would otherwise put its send button under the home indicator.
            stack.topAnchor.constraint(equalTo: safeAreaLayoutGuide.topAnchor, constant: 16),
            stack.leadingAnchor.constraint(equalTo: safeAreaLayoutGuide.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: safeAreaLayoutGuide.trailingAnchor, constant: -16),
            stack.bottomAnchor.constraint(equalTo: safeAreaLayoutGuide.bottomAnchor, constant: -16),
            descriptionField.heightAnchor.constraint(equalToConstant: 72)
        ])
    }

    private func buildToolbar() -> UIView {
        let row = UIStackView()
        row.axis = .horizontal
        row.distribution = .fillEqually
        row.spacing = 6

        let tools: [(Tool, String)] = [(.rect, "Box"), (.arrow, "Arrow"), (.pen, "Pen"), (.blur, "Redact")]

        // Target-action rather than UIAction closures: UIButton.addAction is
        // iOS 14+, and this package declares iOS 13. The tool is carried on the
        // button's tag so one selector serves all four.
        for (index, entry) in tools.enumerated() {
            let button = UIButton(type: .system)
            button.setTitle(entry.1, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 13, weight: .medium)
            button.layer.cornerRadius = 6
            button.layer.borderWidth = 1
            button.tag = index
            button.addTarget(self, action: #selector(toolTapped(_:)), for: .touchUpInside)

            toolButtons.append((entry.0, button))
            row.addArrangedSubview(button)
        }

        let undo = UIButton(type: .system)
        undo.setTitle("Undo", for: .normal)
        undo.titleLabel?.font = .systemFont(ofSize: 13, weight: .medium)
        undo.setTitleColor(panelText, for: .normal)
        undo.layer.cornerRadius = 6
        undo.layer.borderWidth = 1
        undo.layer.borderColor = fieldBorder.cgColor
        undo.addTarget(self, action: #selector(undoTapped), for: .touchUpInside)
        row.addArrangedSubview(undo)

        select(tool: .rect)
        return row
    }

    private func select(tool: Tool) {
        canvas.tool = tool
        for entry in toolButtons {
            let active = entry.tool == tool
            entry.button.backgroundColor = active ? accent : .clear
            entry.button.setTitleColor(active ? .white : panelText, for: .normal)
            entry.button.layer.borderColor = (active ? accent : fieldBorder).cgColor
        }
    }

    private func buildTitleField() -> UIView {
        titleField.placeholder = "Brief summary of the issue"
        titleField.textColor = panelText
        titleField.backgroundColor = UIColor(red: 0.07, green: 0.08, blue: 0.11, alpha: 1)
        titleField.layer.cornerRadius = 6
        titleField.layer.borderWidth = 1
        titleField.layer.borderColor = fieldBorder.cgColor
        titleField.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 10, height: 1))
        titleField.leftViewMode = .always
        titleField.heightAnchor.constraint(equalToConstant: 42).isActive = true
        return titleField
    }

    private func buildDescriptionField() -> UIView {
        descriptionField.textColor = panelText
        descriptionField.backgroundColor = UIColor(red: 0.07, green: 0.08, blue: 0.11, alpha: 1)
        descriptionField.font = .systemFont(ofSize: 15)
        descriptionField.layer.cornerRadius = 6
        descriptionField.layer.borderWidth = 1
        descriptionField.layer.borderColor = fieldBorder.cgColor
        descriptionField.textContainerInset = UIEdgeInsets(top: 8, left: 6, bottom: 8, right: 6)
        return descriptionField
    }

    private func buildHint() -> UIView {
        let label = UILabel()
        label.text = "Use Redact to cover sensitive data before sending."
        label.textColor = muted
        label.font = .systemFont(ofSize: 12)
        return label
    }

    private func buildActions() -> UIView {
        let row = UIStackView()
        row.axis = .horizontal
        row.spacing = 8
        row.distribution = .fillProportionally

        let send = UIButton(type: .system)
        send.setTitle("Send report", for: .normal)
        send.setTitleColor(.white, for: .normal)
        send.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        send.backgroundColor = accent
        send.layer.cornerRadius = 6
        send.heightAnchor.constraint(equalToConstant: 46).isActive = true
        send.addTarget(self, action: #selector(sendTapped), for: .touchUpInside)

        let cancel = UIButton(type: .system)
        cancel.setTitle("Cancel", for: .normal)
        cancel.setTitleColor(panelText, for: .normal)
        cancel.layer.cornerRadius = 6
        cancel.layer.borderWidth = 1
        cancel.layer.borderColor = fieldBorder.cgColor
        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)

        row.addArrangedSubview(send)
        row.addArrangedSubview(cancel)
        return row
    }

    // --- actions --------------------------------------------------------------

    @objc private func toolTapped(_ sender: UIButton) {
        guard sender.tag >= 0, sender.tag < toolButtons.count else { return }
        select(tool: toolButtons[sender.tag].tool)
    }

    @objc private func undoTapped() {
        canvas.undo()
    }

    @objc private func sendTapped() {
        attemptSend()
    }

    @objc private func cancelTapped() {
        dismiss()
        onCancel()
    }

    private func attemptSend() {
        let title = titleField.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !title.isEmpty else {
            // An untitled report is unusable in a triage queue; block rather than guess.
            titleField.layer.borderColor = UIColor.systemRed.cgColor
            titleField.becomeFirstResponder()
            return
        }

        let description = descriptionField.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let annotations = canvas.annotations

        // Flatten before dismissing: the canvas owns the image, and tearing it down
        // first would race the encode.
        let flattened = canvas.flatten()

        dismiss()
        onSend(title, description.isEmpty ? nil : description, annotations, flattened)
    }
}
#endif
