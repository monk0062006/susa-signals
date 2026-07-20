import XCTest
@testable import Feedback

/**
 Mirrors `AnnotationGeometryTest.kt` case for case.

 A letterboxing error does not crash — it silently places every redaction in the
 wrong spot, so a redaction that appears to cover a password covers empty space and
 the password ships. That makes this the highest-value suite in the composer.
 */
final class AnnotationGeometryTests: XCTestCase {

    private let tolerance = 0.0001

    func testImageWiderThanViewIsLetterboxedVertically() {
        // 1000x500 image into a 400x400 view: scale 0.4, drawn 400x200, centered.
        let rect = AnnotationGeometry.fitRect(viewWidth: 400, viewHeight: 400, imageWidth: 1000, imageHeight: 500)

        XCTAssertEqual(rect.left, 0, accuracy: tolerance)
        XCTAssertEqual(rect.top, 100, accuracy: tolerance)
        XCTAssertEqual(rect.width, 400, accuracy: tolerance)
        XCTAssertEqual(rect.height, 200, accuracy: tolerance)
    }

    func testImageTallerThanViewIsPillarboxedHorizontally() {
        let rect = AnnotationGeometry.fitRect(viewWidth: 400, viewHeight: 400, imageWidth: 500, imageHeight: 1000)

        XCTAssertEqual(rect.left, 100, accuracy: tolerance)
        XCTAssertEqual(rect.top, 0, accuracy: tolerance)
        XCTAssertEqual(rect.width, 200, accuracy: tolerance)
        XCTAssertEqual(rect.height, 400, accuracy: tolerance)
    }

    func testTouchInLetterboxBandMapsToImageEdge() {
        let rect = AnnotationGeometry.fitRect(viewWidth: 400, viewHeight: 400, imageWidth: 1000, imageHeight: 500)

        // y=10 is in the black band above the image.
        let point = AnnotationGeometry.toNormalized(touchX: 200, touchY: 10, rect: rect)

        XCTAssertEqual(point.x, 0.5, accuracy: tolerance)
        // Clamped to the top edge rather than going negative.
        XCTAssertEqual(point.y, 0, accuracy: tolerance)
    }

    func testTouchMapsThroughDrawnRectNotViewBounds() {
        let rect = AnnotationGeometry.fitRect(viewWidth: 400, viewHeight: 400, imageWidth: 1000, imageHeight: 500)

        let centre = AnnotationGeometry.toNormalized(touchX: 200, touchY: 200, rect: rect)
        XCTAssertEqual(centre.x, 0.5, accuracy: tolerance)
        XCTAssertEqual(centre.y, 0.5, accuracy: tolerance)

        let corner = AnnotationGeometry.toNormalized(touchX: 400, touchY: 300, rect: rect)
        XCTAssertEqual(corner.x, 1, accuracy: tolerance)
        XCTAssertEqual(corner.y, 1, accuracy: tolerance)
    }

    func testNormalizedToViewRoundTrips() {
        let rect = AnnotationGeometry.fitRect(viewWidth: 400, viewHeight: 400, imageWidth: 1000, imageHeight: 500)
        let original = Point(x: 0.25, y: 0.75)

        let view = AnnotationGeometry.toView(original, rect: rect)
        let back = AnnotationGeometry.toNormalized(touchX: view.x, touchY: view.y, rect: rect)

        XCTAssertEqual(original.x, back.x, accuracy: tolerance)
        XCTAssertEqual(original.y, back.y, accuracy: tolerance)
    }

    func testRectangleDraggedUpAndLeftStillHasPositiveExtents() {
        let annotation = AnnotationGeometry.build(
            tool: .rect,
            start: Point(x: 0.8, y: 0.9),
            end: Point(x: 0.2, y: 0.3),
            penPoints: [],
            color: "#FF3B30"
        )

        guard case let .rect(origin, width, height, _)? = annotation else {
            return XCTFail("expected a rect")
        }
        // Origin is the top-left corner regardless of drag direction; negative
        // width would make the redaction cover nothing at all.
        XCTAssertEqual(origin.x, 0.2, accuracy: tolerance)
        XCTAssertEqual(origin.y, 0.3, accuracy: tolerance)
        XCTAssertGreaterThan(width, 0)
        XCTAssertGreaterThan(height, 0)
    }

    func testRedactionDragProducesBlur() {
        let annotation = AnnotationGeometry.build(
            tool: .blur,
            start: Point(x: 0.1, y: 0.1),
            end: Point(x: 0.5, y: 0.5),
            penPoints: [],
            color: "#FF3B30"
        )

        guard case .blur? = annotation else {
            return XCTFail("expected a blur")
        }
    }

    func testStrayTapDoesNotCreateShape() {
        let annotation = AnnotationGeometry.build(
            tool: .rect,
            start: Point(x: 0.5, y: 0.5),
            end: Point(x: 0.5001, y: 0.5001),
            penPoints: [],
            color: "#FF3B30"
        )

        XCTAssertNil(annotation)
    }

    func testHorizontalArrowIsNotRejected() {
        let annotation = AnnotationGeometry.build(
            tool: .arrow,
            start: Point(x: 0.1, y: 0.5),
            end: Point(x: 0.9, y: 0.5),
            penPoints: [],
            color: "#FF3B30"
        )

        guard case .arrow? = annotation else {
            return XCTFail("expected an arrow")
        }
    }

    func testPenStrokeNeedsTwoPoints() {
        let single = AnnotationGeometry.build(
            tool: .pen,
            start: Point(x: 0.1, y: 0.1),
            end: Point(x: 0.1, y: 0.1),
            penPoints: [Point(x: 0.1, y: 0.1)],
            color: "#FF3B30"
        )
        XCTAssertNil(single)

        let stroke = AnnotationGeometry.build(
            tool: .pen,
            start: Point(x: 0.1, y: 0.1),
            end: Point(x: 0.2, y: 0.2),
            penPoints: [Point(x: 0.1, y: 0.1), Point(x: 0.2, y: 0.2)],
            color: "#FF3B30"
        )
        guard case .pen? = stroke else {
            return XCTFail("expected a pen stroke")
        }
    }

    func testDegenerateViewSizeDoesNotDivideByZero() {
        let rect = AnnotationGeometry.fitRect(viewWidth: 0, viewHeight: 0, imageWidth: 1000, imageHeight: 500)
        XCTAssertEqual(rect, ImageRect(left: 0, top: 0, width: 0, height: 0))

        // Must return a value rather than NaN, which would poison the payload.
        let point = AnnotationGeometry.toNormalized(touchX: 10, touchY: 10, rect: rect)
        XCTAssertEqual(point.x, 0, accuracy: tolerance)
        XCTAssertEqual(point.y, 0, accuracy: tolerance)
    }
}
