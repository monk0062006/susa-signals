#if canImport(UIKit)
import UIKit
import XCTest
@testable import SusaSignals

/**
 Redaction, verified by reading pixels back.

 Guarded on `canImport(UIKit)` so the macOS `swift test` job still compiles;
 these only run on the simulator. That guard is also the reason this file is
 necessary: everything inside it was invisible to every check that existed
 before, because the macOS job excludes UIKit sources entirely.

 Mirrors `AnnotationRendererInstrumentedTest.kt`. Divergence between the two is
 the earliest signal that the platforms have drifted on the guarantee that
 matters most — that a redaction actually obscures what it covers.
 */
final class AnnotationRendererTests: XCTestCase {

    private func redImage(width: Int = 400, height: Int = 200) -> UIImage {
        let size = CGSize(width: width, height: height)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true

        return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            UIColor.red.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
        }
    }

    /// Reads a single pixel out of a UIImage as RGBA bytes.
    private func pixel(_ image: UIImage, x: Int, y: Int) -> (r: UInt8, g: UInt8, b: UInt8, a: UInt8) {
        guard let cg = image.cgImage else { return (0, 0, 0, 0) }

        var data = [UInt8](repeating: 0, count: 4)
        let space = CGColorSpaceCreateDeviceRGB()
        let info = CGImageAlphaInfo.premultipliedLast.rawValue

        guard let ctx = CGContext(
            data: &data, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
            space: space, bitmapInfo: info
        ) else { return (0, 0, 0, 0) }

        // Translate so the target pixel lands at the origin of the 1x1 context.
        ctx.translateBy(x: CGFloat(-x), y: CGFloat(y - cg.height + 1))
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))

        return (data[0], data[1], data[2], data[3])
    }

    private func flatten(_ image: UIImage, _ annotations: [Annotation]) -> UIImage? {
        guard let data = AnnotationRenderer.flatten(image: image, annotations: annotations) else {
            return nil
        }
        return UIImage(data: data)
    }

    func testRedactionActuallyCoversPixels() throws {
        let source = redImage()

        // Cover the left half.
        let result = try XCTUnwrap(
            flatten(source, [.blur(origin: Point(x: 0, y: 0), width: 0.5, height: 1)])
        )

        let covered = pixel(result, x: 100, y: 100)
        let untouched = pixel(result, x: 300, y: 100)

        XCTAssertFalse(
            covered.r > 200 && covered.g < 60 && covered.b < 60,
            "redaction did not change the covered pixels (got \(covered))"
        )
        XCTAssertTrue(
            untouched.r > 200 && untouched.g < 60 && untouched.b < 60,
            "redaction bled outside its bounds (got \(untouched))"
        )
    }

    func testRedactionIsOpaque() throws {
        let source = redImage()
        let result = try XCTUnwrap(
            flatten(source, [.blur(origin: Point(x: 0.25, y: 0.25), width: 0.5, height: 0.5)])
        )

        let covered = pixel(result, x: 200, y: 100)

        // A translucent fill leaves the underlying content recoverable by anyone
        // who adjusts levels on the delivered PNG.
        XCTAssertEqual(covered.a, 255, "redaction is not fully opaque")
        XCTAssertTrue(
            covered.r < 60 && covered.g < 60 && covered.b < 60,
            "redaction is not dark enough to obscure content (got \(covered))"
        )
    }

    func testFlattenPreservesFullResolution() throws {
        // Deliberately not square, and far larger than any preview.
        let source = redImage(width: 1080, height: 2400)

        let result = try XCTUnwrap(
            flatten(source, [.blur(origin: Point(x: 0.5, y: 0.5), width: 0.5, height: 0.5)])
        )

        XCTAssertEqual(result.size.width * result.scale, 1080)
        XCTAssertEqual(result.size.height * result.scale, 2400)

        // Rendering at preview scale rather than full resolution would leave the
        // bottom-right corner exposed.
        let coveredCorner = pixel(result, x: 1000, y: 2300)
        XCTAssertFalse(
            coveredCorner.r > 200 && coveredCorner.g < 60,
            "bottom-right was not covered — annotations mapped at the wrong scale"
        )
    }

    func testAllAnnotationKindsRenderWithoutCrashing() throws {
        let source = redImage()

        let data = try XCTUnwrap(AnnotationRenderer.flatten(image: source, annotations: [
            .rect(origin: Point(x: 0.1, y: 0.1), width: 0.3, height: 0.3, color: "#FF3B30"),
            .arrow(from: Point(x: 0.1, y: 0.9), to: Point(x: 0.9, y: 0.1), color: "#FF3B30"),
            .pen(points: [Point(x: 0.2, y: 0.2), Point(x: 0.4, y: 0.5), Point(x: 0.6, y: 0.3)],
                 color: "#FF3B30", strokeWidth: 3),
            .blur(origin: Point(x: 0.7, y: 0.7), width: 0.2, height: 0.2),
        ]))

        XCTAssertGreaterThan(data.count, 100)
        // PNG magic number: proves a real image, not an empty buffer.
        XCTAssertEqual(Array(data.prefix(4)), [0x89, 0x50, 0x4E, 0x47])
    }

    func testInvalidColourFallsBackInsteadOfCrashing() throws {
        let source = redImage()

        let data = AnnotationRenderer.flatten(image: source, annotations: [
            .rect(origin: Point(x: 0.1, y: 0.1), width: 0.5, height: 0.5, color: "not-a-colour"),
        ])

        // A malformed colour must not lose the report.
        XCTAssertNotNil(data)
    }
}
#endif
