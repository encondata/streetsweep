import CoreGraphics
import CoreLocation
import Foundation
import Observation

/// Marking streets done by drawing round them: draw an outline with the Pencil, see the
/// streets it would mark flashing (the server works out which: those whose middle is inside
/// and that aren't driven or marked yet), then mark them, or redraw.
@MainActor @Observable
final class MarkSession: PencilTarget {
    struct Preview: Equatable {
        let streets: Int
        let pieces: Int
        let meters: Int
        let lines: [[CLLocationCoordinate2D]]
        static func == (a: Preview, b: Preview) -> Bool { a.pieces == b.pieces && a.meters == b.meters && a.streets == b.streets }
    }

    /// What one marking did, kept so it can be undone.
    struct Marked: Equatable {
        let streets: Int
        let meters: Int
        let segmentIds: [Int]
    }

    let teamId: String
    private let api: API

    private(set) var stroke: [CLLocationCoordinate2D] = []
    var strokeStyle: StrokeStyle { .lasso }
    var hover: (coord: CLLocationCoordinate2D, snapped: Bool)? { nil }
    var rubberBand: (from: CLLocationCoordinate2D, to: CLLocationCoordinate2D)? { nil }
    var onChange: (() -> Void)?

    /// The outline drawn, once the Pencil lifts.
    private(set) var outline: Ring?
    private(set) var preview: Preview?
    private(set) var loading = false
    var error: String?

    private var points: [CGPoint] = []
    private var request: Task<Void, Never>?

    init(teamId: String, api: API) {
        self.teamId = teamId
        self.api = api
    }

    // MARK: - The Pencil

    func began(_ p: CGPoint, _ map: MapFrame) {
        clear()
        points = [p]
        stroke = [map.projection.toCoord(p)]
        onChange?()
    }

    func moved(_ pts: [CGPoint], _ map: MapFrame) {
        for p in pts where Geometry.distance(p, points.last ?? p) >= 1.5 {
            points.append(p)
            stroke.append(map.projection.toCoord(p))
        }
        onChange?()
    }

    func ended(_ p: CGPoint, _ map: MapFrame) {
        points.append(p)
        defer { points = []; stroke = []; onChange?() }
        var length: CGFloat = 0
        for i in 1..<max(1, points.count) { length += Geometry.distance(points[i], points[i - 1]) }
        guard points.count >= 6, length >= 40 else {
            error = "Draw all the way round the streets in one stroke, then lift the Pencil."
            return
        }
        let ring = Geometry.dedupe(Geometry.simplify(points, tolerance: 2).map { map.projection.toCoord(points[$0]) })
        guard ring.count >= 3 else { return }
        outline = ring
        fetchPreview(ring)
    }

    func cancelled() {
        points = []
        stroke = []
        onChange?()
    }

    func hovering(_ p: CGPoint?, _ map: MapFrame) {}

    /// Undo (two-finger tap): take the outline away to draw again.
    func undo() { clear() }
    func redo() {}
    func swapTool() {}

    func clear() {
        request?.cancel()
        outline = nil
        preview = nil
        error = nil
        loading = false
        onChange?()
    }

    // MARK: - The server

    private func fetchPreview(_ ring: Ring) {
        request?.cancel()
        loading = true
        error = nil
        request = Task {
            defer { if !Task.isCancelled { loading = false } }
            do {
                let r: WithinPreview = try await api.post("/api/teams/\(teamId)/marks/within",
                                                          WithinBody(geometry: Outline(pieces: [ring]), kind: "complete", preview: true))
                guard !Task.isCancelled else { return }
                let lines = (r.lines?.coordinates ?? []).map { $0.map { CLLocationCoordinate2D(latitude: $0[1], longitude: $0[0]) } }
                preview = Preview(streets: r.streets, pieces: r.pieces, meters: r.meters, lines: lines)
            } catch {
                guard !Task.isCancelled else { return }
                self.error = error.localizedDescription
            }
            onChange?()
        }
    }

    /// Mark the previewed streets done. The server works it out again from the outline, so
    /// what's marked is always what's true now.
    func confirm() async -> Marked? {
        guard let ring = outline else { return nil }
        loading = true
        defer { loading = false }
        do {
            let r: WithinMarked = try await api.post("/api/teams/\(teamId)/marks/within",
                                                     WithinBody(geometry: Outline(pieces: [ring]), kind: "complete", preview: nil))
            clear()
            return Marked(streets: r.streets, meters: r.meters, segmentIds: r.segmentIds)
        } catch {
            self.error = error.localizedDescription
            return nil
        }
    }

    /// Take back exactly what one marking did.
    static func undo(_ m: Marked, team: String, api: API) async throws {
        // The server takes up to 5,000 at a time; one marking is never more than that.
        for chunk in stride(from: 0, to: m.segmentIds.count, by: 5000).map({ Array(m.segmentIds[$0..<min($0 + 5000, m.segmentIds.count)]) }) {
            let _: Empty = try await api.post("/api/teams/\(team)/marks/bulk", BulkBody(segmentIds: chunk, kind: "clear"))
        }
    }
}

private struct WithinBody: Encodable {
    let geometry: Outline
    let kind: String
    let preview: Bool?
}

private struct BulkBody: Encodable {
    let segmentIds: [Int]
    let kind: String
    enum CodingKeys: String, CodingKey { case segmentIds = "segment_ids", kind }
}

private struct WithinPreview: Decodable {
    let streets: Int
    let pieces: Int
    let meters: Int
    let lines: Lines?
    struct Lines: Decodable { let coordinates: [[[Double]]] }
}

private struct WithinMarked: Decodable {
    let streets: Int
    let pieces: Int
    let meters: Int
    let segmentIds: [Int]
}
