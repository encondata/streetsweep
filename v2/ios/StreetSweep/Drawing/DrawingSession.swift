import CoreGraphics
import CoreLocation
import Foundation
import Observation

/// Drawing or redrawing one area's outline: its pieces, the tools, and undo. The map and
/// the Pencil feed it screen points (with a projection); it keeps everything as coordinates.
@MainActor @Observable
final class DrawingSession {
    enum Tool: String, CaseIterable, Identifiable, Codable {
        case lasso, corners, edit, eraser
        var id: String { rawValue }
        var label: String { rawValue.capitalized }
        var symbol: String {
            switch self {
            case .lasso: "lasso"
            case .corners: "point.topleft.down.to.point.bottomright.curvepath"
            case .edit: "hand.point.up.left"
            case .eraser: "eraser"
            }
        }
        var hint: String {
            switch self {
            case .lasso: "Draw round the area in one stroke and lift to close it. Where you run along a neighbouring area or a shoreline, the outline follows it."
            case .corners: "Tap each corner. Tap the first corner again to close the shape."
            case .edit: "Drag a corner to move it, or the dot between two corners to add one. Tap a piece to select it."
            case .eraser: "Scribble over corners to delete them. Tap inside a piece to delete the whole piece."
            }
        }
    }

    struct Piece: Identifiable, Equatable {
        let id: UUID
        var ring: Ring
        init(id: UUID = UUID(), ring: Ring) { self.id = id; self.ring = ring }
    }

    // ---- what's drawn ----
    private(set) var pieces: [Piece] = []
    /// Corners tapped so far on a piece not yet closed (the Corners tool).
    private(set) var inProgress: Ring = []
    private(set) var selected: UUID?
    /// The Pencil's path right now (a lasso or the eraser), for the overlay to draw.
    private(set) var stroke: [CLLocationCoordinate2D] = []
    /// Where the hovering Pencil would land, and whether it would snap.
    private(set) var hover: (coord: CLLocationCoordinate2D, snapped: Bool)?
    var note: String?

    var tool: Tool = .lasso {
        didSet {
            guard tool != oldValue else { return }
            previousTool = oldValue
            if oldValue == .corners { closeInProgress(force: false) }
            cancelStroke()
            hover = nil
            if tool != .edit { selected = nil }
            changed(persist: false)
        }
    }
    private(set) var previousTool: Tool = .corners

    // ---- the area ----
    let area: Area?
    let teamId: String
    var name: String { didSet { if name != oldValue { dirty = true; schedulePersist() } } }
    var level: AreaLevel { didSet { if level != oldValue { dirty = true; schedulePersist(); onChange?() } } }
    /// Changed since the drawing began: worth keeping, and worth asking before dropping.
    private(set) var dirty = false

    // ---- snapping ----
    /// The team's other drawn areas, by kind; those of the kind being drawn are shown and
    /// snapped to while "Areas" is on.
    private let others: [(id: String, level: AreaLevel, rings: [Ring])]
    var showOthers = true { didSet { if showOthers != oldValue { onChange?() } } }
    private var neighbours: [SnapLine] {
        visibleOthers.flatMap { o in o.rings.map { SnapLine($0, closed: true) } }
    }
    /// Neighbourhoods and custom areas go together; sections with sections.
    static func sameKind(_ a: AreaLevel, _ b: AreaLevel) -> Bool { (a == .section) == (b == .section) }
    var visibleOthers: [(id: String, level: AreaLevel, rings: [Ring])] {
        showOthers ? others.filter { Self.sameKind($0.level, level) } : []
    }
    var visibleOtherIds: Set<String> { Set(visibleOthers.map(\.id)) }
    var shores: [SnapLine] = []
    /// Snap: also onto streets (intersections first) and state, county and city lines, with
    /// lasso strokes straightened and right angles squared. Neighbours and shores always snap.
    var snapping = false
    var streets: [SnapLine] = []
    var boundaries: [SnapLine] = []

    // ---- undo ----
    private var undoStack: [[Piece]] = []
    private var redoStack: [[Piece]] = []
    var canUndo: Bool { !inProgress.isEmpty || !undoStack.isEmpty }
    var canRedo: Bool { inProgress.isEmpty && !redoStack.isEmpty }

    /// Called after anything visible changes, so the map redraws.
    var onChange: (() -> Void)?

    static let snapRadius: CGFloat = 18
    static let hitRadius: CGFloat = 26
    static let lassoTolerance: CGFloat = 3
    private static let maxUndo = 80

    init(teamId: String, area: Area?, others: [Area], draft: Draft? = nil) {
        self.teamId = teamId
        self.area = area
        self.others = others.filter { $0.id != area?.id && $0.isDrawn }.compactMap { a in
            a.geometry.map { (a.id, a.level, $0.pieces) }
        }
        if let draft {
            name = draft.name
            level = draft.level
            pieces = draft.ringsAsCoords.filter { $0.count >= 3 }.map { Piece(ring: $0) }
            dirty = true
        } else {
            name = area?.name ?? ""
            level = area.map { AreaLevel.drawable.contains($0.level) ? $0.level : .neighborhood } ?? .neighborhood
            pieces = (area?.geometry?.pieces ?? []).filter { $0.count >= 3 }.map { Piece(ring: $0) }
        }
    }

    var outline: Outline? {
        let rings = pieces.map(\.ring).filter { $0.count >= 3 }
        return rings.isEmpty ? nil : Outline(pieces: rings)
    }

    var cornerCount: Int { pieces.reduce(0) { $0 + $1.ring.count } }

    // MARK: - Tools

    /// Pencil double-tap or squeeze: back to the tool before this one.
    func swapTool() { tool = previousTool }

    func undo() {
        if !inProgress.isEmpty {
            inProgress.removeLast()
            if !inProgressHits.isEmpty { inProgressHits.removeLast() }
            changed(persist: false)
            return
        }
        guard let prev = undoStack.popLast() else { return }
        redoStack.append(pieces)
        pieces = prev
        if let s = selected, !pieces.contains(where: { $0.id == s }) { selected = nil }
        changed()
    }

    func redo() {
        guard inProgress.isEmpty, let next = redoStack.popLast() else { return }
        undoStack.append(pieces)
        pieces = next
        changed()
    }

    func deleteSelected() {
        guard let s = selected else { return }
        checkpoint()
        pieces.removeAll { $0.id == s }
        selected = nil
        changed()
    }

    /// The whole outline swapped (trimmed to the shore, say), as one undoable change.
    func replaceAll(_ rings: [Ring]) {
        checkpoint()
        pieces = rings.filter { $0.count >= 3 }.map { Piece(ring: $0) }
        selected = nil
        inProgress = []
        inProgressHits = []
        changed()
    }

    /// Pull corners that land within a few points of a neighbouring area or a boundary line
    /// exactly onto it, so tidied outlines share edges instead of nearly meeting.
    func snapCornersToNeighbours(_ map: MapFrame) {
        let lines = neighbours + boundaries
        guard !lines.isEmpty else { return }
        var moved = false
        for i in pieces.indices {
            for k in pieces[i].ring.indices {
                let p = map.projection.toPoint(pieces[i].ring[k])
                if let s = Geometry.snap(p, lines: lines, radius: 8, view: map.view, project: map.projection), s.coord != pieces[i].ring[k] {
                    pieces[i].ring[k] = s.coord
                    moved = true
                }
            }
            pieces[i].ring = Geometry.dedupe(pieces[i].ring)
        }
        if moved { changed() }
    }

    /// Close the Corners tool's piece, if it has three corners.
    func closeInProgress(force: Bool = true) {
        guard !inProgress.isEmpty else { return }
        if inProgress.count >= 3 {
            checkpoint()
            var ring = inProgress
            // The last corner and the first on the same edge: follow it to close too.
            if let a = inProgressHits.last ?? nil, let b = inProgressHits.first ?? nil, a.line == b.line,
               a.line < followable, a.line < lastFollowLines.count, let f = lastFrame {
                ring += Geometry.follow(lastFollowLines[a.line], from: a, to: b, drawn: .infinity, radius: 0, project: f.projection)
            }
            pieces.append(Piece(ring: Geometry.dedupe(ring)))
            inProgress = []
            inProgressHits = []
            changed()
        } else if force {
            note = "A piece needs at least three corners."
        } else {
            inProgress = []
            inProgressHits = []
            changed(persist: false)
        }
    }

    // MARK: - Input (screen points, with the map's projection right now)

    private var strokePoints: [CGPoint] = []
    private var drag: (piece: Int, corner: Int, moved: Bool)?
    private var pressStart: CGPoint?
    private var erasedThisStroke = false

    func began(_ p: CGPoint, _ map: MapFrame) {
        note = nil
        hover = nil
        pressStart = p
        switch tool {
        case .lasso, .eraser:
            strokePoints = [p]
            stroke = [map.projection.toCoord(p)]
            erasedThisStroke = false
            if tool == .eraser { erase(at: p, map) }
        case .edit:
            drag = nil
            if let hit = nearestCorner(to: p, map) {
                drag = (hit.piece, hit.corner, false)
                selected = pieces[hit.piece].id
            } else if let mid = nearestMidpoint(to: p, map) {
                checkpoint()
                pieces[mid.piece].ring.insert(map.projection.toCoord(p), at: mid.corner)
                drag = (mid.piece, mid.corner, true)
                selected = pieces[mid.piece].id
            }
        case .corners:
            break
        }
        changed(persist: false)
    }

    func moved(_ points: [CGPoint], _ map: MapFrame) {
        switch tool {
        case .lasso, .eraser:
            for p in points where Geometry.distance(p, strokePoints.last ?? p) >= 1.5 || strokePoints.isEmpty {
                strokePoints.append(p)
                stroke.append(map.projection.toCoord(p))
                if tool == .eraser { erase(at: p, map) }
            }
        case .edit:
            guard var d = drag, let p = points.last else { return }
            if !d.moved {
                guard Geometry.distance(p, pressStart ?? p) > 3 else { return }
                checkpoint()
                d.moved = true
            }
            drag = d
            let snap = snapPoint(p, map, excluding: pieces[d.piece].id)
            pieces[d.piece].ring[d.corner] = snap?.coord ?? map.projection.toCoord(p)
        case .corners:
            break
        }
        changed(persist: false)
    }

    func ended(_ p: CGPoint, _ map: MapFrame) {
        let tap = Geometry.distance(p, pressStart ?? p) < 10
        switch tool {
        case .lasso:
            strokePoints.append(p)
            finishLasso(map)
        case .eraser:
            if tap && !erasedThisStroke, let i = pieceIndex(containing: p, map) {
                checkpoint()
                pieces.remove(at: i)
                selected = nil
            }
            cancelStroke()
        case .edit:
            if drag == nil, tap {
                selected = pieceIndex(containing: p, map).map { pieces[$0].id }
            }
            if drag?.moved == true { changed() }
            drag = nil
        case .corners:
            if tap { addCorner(at: p, map) }
        }
        pressStart = nil
        changed()
    }

    func cancelled() {
        cancelStroke()
        drag = nil
        pressStart = nil
        changed(persist: false)
    }

    func hovering(_ p: CGPoint?, _ map: MapFrame) {
        guard let p, tool == .lasso || tool == .corners else {
            if hover != nil { hover = nil; changed(persist: false) }
            return
        }
        let snap = snapPoint(p, map, excluding: nil)
        hover = (snap?.coord ?? map.projection.toCoord(p), snap != nil)
        changed(persist: false)
    }

    // MARK: - The tools' work

    private func finishLasso(_ map: MapFrame) {
        defer { cancelStroke() }
        var length: CGFloat = 0
        for i in 1..<max(1, strokePoints.count) { length += Geometry.distance(strokePoints[i], strokePoints[i - 1]) }
        guard strokePoints.count >= 6, length >= 40 else {
            note = "Draw all the way round the area in one stroke, then lift the Pencil to close it."
            return
        }
        let ring = snapping
            ? Geometry.snappedLasso(strokePoints, lines: snapLines(excluding: nil), radius: Self.snapRadius + 6,
                                    tolerance: 12, view: map.view, project: map.projection)
            : Geometry.lassoRing(strokePoints, lines: snapLines(excluding: nil), radius: Self.snapRadius,
                                 tolerance: Self.lassoTolerance, view: map.view, project: map.projection)
        guard ring.count >= 3 else { return }
        checkpoint()
        let piece = Piece(ring: ring)
        pieces.append(piece)
        selected = nil
    }

    private func addCorner(at p: CGPoint, _ map: MapFrame) {
        if inProgress.count >= 3, Geometry.distance(p, map.projection.toPoint(inProgress[0])) <= Self.hitRadius {
            closeInProgress()
            return
        }
        let lines = snapLines(excluding: nil)
        let snap = Geometry.snap(p, lines: lines, radius: Self.snapRadius, view: map.view, project: map.projection)
        let c = snap?.coord ?? map.projection.toCoord(p)
        guard inProgress.last != c else { return }
        // On the same area's edge (or boundary line) as the last corner: follow it between them.
        if let prev = inProgressHits.last ?? nil, let snap, prev.line == snap.line, snap.line < followable {
            let way = Geometry.follow(lines[snap.line], from: prev, to: snap, drawn: .infinity, radius: 0, project: map.projection)
            inProgress += way
            inProgressHits += way.map { _ in nil }
        }
        inProgress.append(c)
        inProgressHits.append(snap)
        lastFollowLines = lines
        lastFrame = map
    }

    /// The lines (and the map) the last corner was snapped against, so closing can follow too.
    private var lastFollowLines: [SnapLine] = []
    private var lastFrame: MapFrame?

    private func erase(at p: CGPoint, _ map: MapFrame) {
        var changedAny = false
        var next = pieces
        for i in next.indices.reversed() {
            let before = next[i].ring.count
            next[i].ring.removeAll { Geometry.distance(map.projection.toPoint($0), p) <= Self.snapRadius }
            if next[i].ring.count != before { changedAny = true }
            if next[i].ring.count < 3 { next.remove(at: i) }
        }
        guard changedAny else { return }
        if !erasedThisStroke { checkpoint(); erasedThisStroke = true }
        pieces = next
        if let s = selected, !pieces.contains(where: { $0.id == s }) { selected = nil }
    }

    private func cancelStroke() {
        strokePoints = []
        stroke = []
    }

    private func nearestCorner(to p: CGPoint, _ map: MapFrame) -> (piece: Int, corner: Int)? {
        var best: (piece: Int, corner: Int, d: CGFloat)?
        for (pi, piece) in pieces.enumerated() {
            for (ci, c) in piece.ring.enumerated() {
                let d = Geometry.distance(map.projection.toPoint(c), p)
                if d <= Self.hitRadius, best == nil || d < best!.d { best = (pi, ci, d) }
            }
        }
        return best.map { ($0.piece, $0.corner) }
    }

    /// The midpoint dot between two corners: dragging it adds a corner there (at `corner`).
    private func nearestMidpoint(to p: CGPoint, _ map: MapFrame) -> (piece: Int, corner: Int)? {
        var best: (piece: Int, corner: Int, d: CGFloat)?
        for (pi, piece) in pieces.enumerated() {
            let pts = piece.ring.map(map.projection.toPoint)
            for i in pts.indices {
                let a = pts[i], b = pts[(i + 1) % pts.count]
                let mid = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
                let d = Geometry.distance(mid, p)
                if d <= Self.hitRadius * 0.8, best == nil || d < best!.d { best = (pi, i + 1, d) }
            }
        }
        return best.map { ($0.piece, $0.corner) }
    }

    private func pieceIndex(containing p: CGPoint, _ map: MapFrame) -> Int? {
        pieces.indices.last { Geometry.contains(pieces[$0].ring.map(map.projection.toPoint), p) }
    }

    /// Neighbours, shorelines, and this drawing's other pieces (so pieces can share an edge too).
    /// What corners snap to. The ones an edge is followed along come first: the areas shown,
    /// then (with Snap) boundary lines.
    private func snapLines(excluding id: UUID?) -> [SnapLine] {
        neighbours + (snapping ? boundaries : []) + shores
            + pieces.filter { $0.id != id }.map { SnapLine($0.ring, closed: true) }
            + (snapping ? streets : [])
    }
    private var followable: Int { neighbours.count + (snapping ? boundaries.count : 0) }

    /// Where each corner of the piece being drawn snapped, for following an edge.
    private var inProgressHits: [Snap?] = []

    /// The Corners tool's line from the last corner to where the hovering Pencil would land.
    var rubberBand: (from: CLLocationCoordinate2D, to: CLLocationCoordinate2D)? {
        guard tool == .corners, let last = inProgress.last, let h = hover else { return nil }
        return (last, h.coord)
    }

    private func snapPoint(_ p: CGPoint, _ map: MapFrame, excluding id: UUID?) -> Snap? {
        Geometry.snap(p, lines: snapLines(excluding: id), radius: Self.snapRadius, view: map.view, project: map.projection)
    }

    private func checkpoint() {
        undoStack.append(pieces)
        if undoStack.count > Self.maxUndo { undoStack.removeFirst() }
        redoStack = []
    }

    private func changed(persist: Bool = true) {
        if persist { dirty = true; schedulePersist() }
        onChange?()
    }

    // MARK: - Drafts

    /// A drawing in progress, kept on the iPad until it's saved or dropped, so a crash or a
    /// closed app loses nothing.
    struct Draft: Codable {
        let teamId: String
        let areaId: String?
        let name: String
        let level: AreaLevel
        let rings: [[[Double]]]
        let at: Date

        var ringsAsCoords: [Ring] { rings.map { $0.map { CLLocationCoordinate2D(latitude: $0[1], longitude: $0[0]) } } }

        static var url: URL {
            let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            return dir.appendingPathComponent("area-draft.json")
        }

        static func load() -> Draft? {
            guard let data = try? Data(contentsOf: url) else { return nil }
            return try? JSONDecoder().decode(Draft.self, from: data)
        }

        static func clear() { try? FileManager.default.removeItem(at: url) }
    }

    private var persistTask: Task<Void, Never>?

    private func schedulePersist() {
        persistTask?.cancel()
        persistTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            self?.persistNow()
        }
    }

    func persistNow() {
        guard dirty else { return }
        let rings = (pieces.map(\.ring) + (inProgress.count >= 3 ? [inProgress] : []))
            .map { $0.map { [$0.longitude, $0.latitude] } }
        let draft = Draft(teamId: teamId, areaId: area?.id, name: name, level: level, rings: rings, at: .now)
        if let data = try? JSONEncoder().encode(draft) { try? data.write(to: Draft.url, options: .atomic) }
    }

    func discardDraft() {
        persistTask?.cancel()
        Draft.clear()
    }
}

/// The map as it is at one moment: screen ⇄ ground, and what's in view.
struct MapFrame {
    let projection: Projection
    let view: (south: Double, west: Double, north: Double, east: Double)
}
