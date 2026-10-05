import CoreGraphics
import CoreLocation
import Foundation
import Observation

/// Marking streets done by drawing with the Pencil, two ways:
/// - Lasso: draw round them; the streets whose middle is inside count.
/// - Scribble: scribble along or back and forth over them, in as many strokes as you like;
///   a street counts once the scribbles cover at least half of it.
/// The streets it would mark flash (the server works out which, never ones already driven
/// or marked), then mark them, or redraw.
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

    enum Mode: String, CaseIterable, Identifiable {
        case lasso, scribble
        var id: String { rawValue }
        var label: String { rawValue.capitalized }
    }

    let teamId: String
    private let api: API
    var mode: Mode = .scribble { didSet { if mode != oldValue { clear() } } }
    /// Scribble strokes so far, and how far each side of them counts (metres, from the zoom
    /// when they were drawn: about a fingertip's width on screen).
    private(set) var scribbles: [[CLLocationCoordinate2D]] = []
    private var scribbleWidth: Double = 12

    private(set) var stroke: [CLLocationCoordinate2D] = []
    var strokeStyle: StrokeStyle { mode == .lasso ? .lasso : .scribble }
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
        if mode == .scribble {
            guard points.count >= 2 else { return }
            let line = Geometry.simplify(points, tolerance: 1.5).map { map.projection.toCoord(points[$0]) }
            guard line.count >= 2 else { return }
            scribbles.append(line)
            // 10 points on screen, in metres at this zoom.
            let a = map.projection.toCoord(p), b = map.projection.toCoord(CGPoint(x: p.x + 10, y: p.y))
            scribbleWidth = max(4, min(60, CLLocation(latitude: a.latitude, longitude: a.longitude)
                .distance(from: CLLocation(latitude: b.latitude, longitude: b.longitude))))
            fetchPreview()
            return
        }
        var length: CGFloat = 0
        for i in 1..<max(1, points.count) { length += Geometry.distance(points[i], points[i - 1]) }
        guard points.count >= 6, length >= 40 else {
            error = "Draw all the way round the streets in one stroke, then lift the Pencil."
            return
        }
        let ring = Geometry.dedupe(Geometry.simplify(points, tolerance: 2).map { map.projection.toCoord(points[$0]) })
        guard ring.count >= 3 else { return }
        outline = ring
        fetchPreview()
    }

    func cancelled() {
        points = []
        stroke = []
        onChange?()
    }

    func hovering(_ p: CGPoint?, _ map: MapFrame) {}

    /// Undo (two-finger tap): the last scribble, or the outline, to draw again.
    func undo() {
        guard mode == .scribble, !scribbles.isEmpty else { clear(); return }
        scribbles.removeLast()
        if scribbles.isEmpty { clear() } else { fetchPreview() }
        onChange?()
    }
    func redo() {}
    func swapTool() {}

    func clear() {
        request?.cancel()
        outline = nil
        scribbles = []
        preview = nil
        error = nil
        loading = false
        onChange?()
    }

    // MARK: - The server

    /// What's been drawn, as the server takes it: the outline, or the scribbles and their width.
    private var body: WithinBody? {
        if mode == .scribble, !scribbles.isEmpty {
            return WithinBody(geometry: .lines(scribbles), kind: "complete", preview: true, alongM: scribbleWidth)
        }
        if mode == .lasso, let ring = outline {
            return WithinBody(geometry: .outline(Outline(pieces: [ring])), kind: "complete", preview: true, alongM: nil)
        }
        return nil
    }

    /// Something's been drawn to mark.
    var hasDrawing: Bool { outline != nil || !scribbles.isEmpty }

    private func fetchPreview() {
        guard let body else { return }
        request?.cancel()
        loading = true
        error = nil
        request = Task {
            defer { if !Task.isCancelled { loading = false } }
            do {
                let r: WithinPreview = try await api.post("/api/teams/\(teamId)/marks/within", body)
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
        guard var b = body else { return nil }
        b.preview = nil
        loading = true
        defer { loading = false }
        do {
            let r: WithinMarked = try await api.post("/api/teams/\(teamId)/marks/within", b)
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
    enum Shape { case outline(Outline), lines([[CLLocationCoordinate2D]]) }
    let geometry: Shape
    let kind: String
    var preview: Bool?
    let alongM: Double?

    enum CodingKeys: String, CodingKey { case geometry, kind, preview, alongM = "along_m" }
    private struct Lines: Encodable { let type = "MultiLineString"; let coordinates: [[[Double]]] }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch geometry {
        case .outline(let o): try c.encode(o, forKey: .geometry)
        case .lines(let ls): try c.encode(Lines(coordinates: ls.map { $0.map { [$0.longitude, $0.latitude] } }), forKey: .geometry)
        }
        try c.encode(kind, forKey: .kind)
        try c.encodeIfPresent(preview, forKey: .preview)
        try c.encodeIfPresent(alongM, forKey: .alongM)
    }
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
