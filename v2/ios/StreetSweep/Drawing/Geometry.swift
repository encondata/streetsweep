import CoreGraphics
import CoreLocation

extension CLLocationCoordinate2D: @retroactive Equatable {
    public static func == (a: Self, b: Self) -> Bool { a.latitude == b.latitude && a.longitude == b.longitude }
}

/// Screen ⇄ ground, from the map as it is right now.
struct Projection {
    let toPoint: (CLLocationCoordinate2D) -> CGPoint
    let toCoord: (CGPoint) -> CLLocationCoordinate2D
}

/// A line drawing snaps to: another area's outline (closed) or a shoreline (open).
struct SnapLine {
    let ring: Ring
    let closed: Bool
    /// Bounding box, to skip lines nowhere near.
    let south: Double, west: Double, north: Double, east: Double

    init(_ ring: Ring, closed: Bool) {
        self.ring = ring
        self.closed = closed
        var s = 90.0, w = 180.0, n = -90.0, e = -180.0
        for c in ring { s = min(s, c.latitude); n = max(n, c.latitude); w = min(w, c.longitude); e = max(e, c.longitude) }
        south = s; west = w; north = n; east = e
    }
}

/// Where a point snapped to: the spot, how far it moved (points), and how far along which
/// line (segment index + fraction), so a lasso can follow that line between two snaps.
struct Snap {
    let coord: CLLocationCoordinate2D
    let distance: CGFloat
    let line: Int
    let position: Double
}

enum Geometry {
    static func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat { hypot(a.x - b.x, a.y - b.y) }

    /// The nearest corner of another area or shoreline within `radius` points; failing that
    /// the nearest point on one of their lines. Corners win: where two neighbours meet,
    /// aiming near the meeting point means the meeting point.
    static func snap(_ at: CGPoint, lines: [SnapLine], radius: CGFloat, view: (south: Double, west: Double, north: Double, east: Double), project: Projection) -> Snap? {
        var corner: Snap?
        var best: Snap?
        for (li, line) in lines.enumerated() {
            if line.north < view.south || line.south > view.north || line.east < view.west || line.west > view.east { continue }
            let r = line.ring
            let n = r.count
            guard n >= 2 else { continue }
            let pts = r.map(project.toPoint)
            for i in 0..<n {
                let a = pts[i]
                let toA = distance(at, a)
                if toA <= radius, corner == nil || toA < corner!.distance {
                    corner = Snap(coord: r[i], distance: toA, line: li, position: Double(i))
                }
                if i == n - 1 && !line.closed { break }
                let j = (i + 1) % n
                let c = pts[j]
                let dx = c.x - a.x, dy = c.y - a.y, span = dx * dx + dy * dy
                let t = span > 0 ? max(0, min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / span)) : 0
                let d = distance(at, CGPoint(x: a.x + dx * t, y: a.y + dy * t))
                guard d <= radius, best == nil || d < best!.distance else { continue }
                let coord = CLLocationCoordinate2D(latitude: r[i].latitude + (r[j].latitude - r[i].latitude) * t,
                                                   longitude: r[i].longitude + (r[j].longitude - r[i].longitude) * t)
                best = Snap(coord: coord, distance: d, line: li, position: Double(i) + Double(t))
            }
        }
        return corner ?? best
    }

    /// Ramer–Douglas–Peucker: the indices of the points worth keeping, in order.
    static func simplify(_ pts: [CGPoint], tolerance: CGFloat) -> [Int] {
        guard pts.count > 3 else { return Array(pts.indices) }
        var keep = [Bool](repeating: false, count: pts.count)
        keep[0] = true
        keep[pts.count - 1] = true
        var stack = [(0, pts.count - 1)]
        while let (s, e) = stack.popLast() {
            let a = pts[s], b = pts[e]
            let dx = b.x - a.x, dy = b.y - a.y, len = hypot(dx, dy)
            var worst = -1
            var far: CGFloat = 0
            if e - s > 1 {
                for i in (s + 1)..<e {
                    let p = pts[i]
                    let d = len > 0 ? abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len : distance(p, a)
                    if d > far { far = d; worst = i }
                }
            }
            if worst > 0 && far > tolerance {
                keep[worst] = true
                stack.append((s, worst))
                stack.append((worst, e))
            }
        }
        return keep.indices.filter { keep[$0] }
    }

    /// A finished lasso: corners where the stroke turns, snapped to neighbours, and where
    /// it ran along one neighbour's line between two snaps, that line's own corners too.
    static func lassoRing(_ stroke: [CGPoint], lines: [SnapLine], radius: CGFloat, tolerance: CGFloat,
                          view: (south: Double, west: Double, north: Double, east: Double), project: Projection) -> Ring {
        var keep = simplify(stroke, tolerance: tolerance)
        // The stroke usually ends just short of (or a little past) where it began: one corner there, not two.
        if keep.count > 3, distance(stroke[keep.last!], stroke[0]) < 14 { keep.removeLast() }
        let hits = keep.map { snap(stroke[$0], lines: lines, radius: radius, view: view, project: project) }
        var along: [CGFloat] = [0]
        for i in 1..<stroke.count { along.append(along[i - 1] + distance(stroke[i], stroke[i - 1])) }
        let total = along.last! + distance(stroke.last!, stroke[0])

        var out: Ring = []
        for k in keep.indices {
            let a = hits[k]
            out.append(a?.coord ?? project.toCoord(stroke[keep[k]]))
            let n = (k + 1) % keep.count
            guard let a, let b = hits[n], a.line == b.line else { continue }
            let drawn = n > k ? along[keep[n]] - along[keep[k]] : total - along[keep[k]] + along[keep[n]]
            out += follow(lines[a.line], from: a, to: b, drawn: drawn, radius: radius, project: project)
        }
        return dedupe(out)
    }

    /// The corners of a line between two points snapped to it, going whichever way round is
    /// shorter, if that way is about as long as what was drawn (a stroke that only touched a
    /// neighbour at two places shouldn't suddenly trace its whole outline).
    static func follow(_ line: SnapLine, from a: Snap, to b: Snap, drawn: CGFloat, radius: CGFloat, project: Projection) -> Ring {
        let r = line.ring, n = r.count
        var ways: [Ring] = []
        let hiF: Double? = b.position >= a.position ? b.position : (line.closed ? b.position + Double(n) : nil)
        if let hi = hiF {
            var way: Ring = []
            var k = Int(a.position.rounded(.down)) + 1
            while Double(k) < hi { way.append(r[k % n]); k += 1 }
            ways.append(way)
        }
        let loB: Double? = b.position <= a.position ? b.position : (line.closed ? b.position - Double(n) : nil)
        if let lo = loB {
            var way: Ring = []
            var k = Int(a.position.rounded(.up)) - 1
            while Double(k) > lo { way.append(r[((k % n) + n) % n]); k -= 1 }
            ways.append(way)
        }
        var best: (way: Ring, length: CGFloat)?
        for way in ways {
            let path = ([a.coord] + way + [b.coord]).map(project.toPoint)
            var length: CGFloat = 0
            for i in 1..<path.count { length += distance(path[i], path[i - 1]) }
            if best == nil || length < best!.length { best = (way, length) }
        }
        guard let best, best.length <= drawn * 1.6 + 2 * radius else { return [] }
        return best.way
    }

    static func dedupe(_ ring: Ring) -> Ring {
        var out: Ring = []
        for c in ring where out.last != c { out.append(c) }
        while out.count > 1, out.first == out.last { out.removeLast() }
        return out
    }

    /// Distance from a point to the segment a–b, on screen.
    static func distance(_ p: CGPoint, toSegment a: CGPoint, _ b: CGPoint) -> CGFloat {
        let dx = b.x - a.x, dy = b.y - a.y, span = dx * dx + dy * dy
        let t = span > 0 ? max(0, min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / span)) : 0
        return distance(p, CGPoint(x: a.x + dx * t, y: a.y + dy * t))
    }

    /// Is the point inside the ring (on screen)? Even–odd rule.
    static func contains(_ ring: [CGPoint], _ p: CGPoint) -> Bool {
        var inside = false
        var j = ring.count - 1
        for i in ring.indices {
            let a = ring[i], b = ring[j]
            if (a.y > p.y) != (b.y > p.y), p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x { inside.toggle() }
            j = i
        }
        return inside
    }
}
