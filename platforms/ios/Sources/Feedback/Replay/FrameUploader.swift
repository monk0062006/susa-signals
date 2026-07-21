#if canImport(UIKit)
import Foundation

/**
 Ships frames to the ingest service.

 Each frame goes to the existing attachments endpoint as a JPEG, and the replay
 chunk carries only references and timestamps. Embedding images in the chunk
 JSON would mean base64, inflating every frame by a third for no benefit and
 pushing chunks past any sane request size.

 Reusing `/v1/uploads` also means native frames inherit the same storage,
 retention and erasure paths as screenshots rather than needing their own.

 Mirrors `FrameUploader.kt`.
 */
final class HTTPFrameUploader: FrameRecorder.FrameUploading {

    private let endpoint: String
    private let projectId: String
    private let client: IngestClient

    init(endpoint: String, projectId: String, client: IngestClient) {
        self.endpoint = endpoint
        self.projectId = projectId
        self.client = client
    }

    private struct FrameEvent: Encodable {
        /// Mirrors the web recorder's event envelope so the dashboard can branch
        /// on one field rather than sniffing shape.
        let type = "frame"
        let timestamp: Int64
        let attachmentId: String
        let width: Int
        let height: Int
    }

    private struct Chunk: Encodable {
        let sessionId: String
        let projectId: String
        let seq: Int
        let events: [FrameEvent]
        let startedAt: Int64
        let endedAt: Int64
        let final: Bool
    }

    func upload(
        sessionId: String,
        seq: Int,
        frames: [FrameRecorder.Frame],
        final: Bool
    ) throws {
        let uploader = MultipartUploader(endpoint: endpoint, projectId: projectId)

        // Upload images first: a chunk referencing an attachment that failed to
        // store would point at nothing, which is worse than a missing frame.
        var events: [FrameEvent] = []
        for frame in frames {
            do {
                let id = try uploader.upload(
                    pngData: frame.jpeg,
                    filename: "frame-\(frame.id).jpg",
                    mimeType: "image/jpeg"
                )
                events.append(FrameEvent(
                    timestamp: frame.timestampMs,
                    attachmentId: id,
                    width: frame.width,
                    height: frame.height
                ))
            } catch {
                // Skip this frame; the recording keeps its shape with a gap.
                continue
            }
        }

        guard !events.isEmpty || final else { return }

        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let chunk = Chunk(
            sessionId: sessionId,
            projectId: projectId,
            seq: seq,
            events: events,
            startedAt: frames.first?.timestampMs ?? now,
            endedAt: frames.last?.timestampMs ?? now,
            final: final
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try client.sendReplayChunk(try encoder.encode(chunk))
    }
}
#endif
