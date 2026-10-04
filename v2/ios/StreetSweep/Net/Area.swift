import CoreLocation
import Foundation

/// A ring of corners as the app keeps it: no repeat of the first corner at the end.
typealias Ring = [CLLocationCoordinate2D]

/// An area's outline: polygons, each an outer ring then any holes. Decoded from GeoJSON
/// Polygon or MultiPolygon ([lng, lat] pairs, rings closed).
struct Outline: Codable, Sendable, Equatable {
    var polygons: [[Ring]]

    /// Each polygon's outer ring: the pieces an outline is drawn and edited as.
    var pieces: [Ring] { polygons.compactMap(\.first) }

    init(polygons: [[Ring]]) { self.polygons = polygons }
    init(pieces: [Ring]) { polygons = pieces.map { [$0] } }

    private struct Raw: Codable { let type: String; let coordinates: AnyCoords }

    init(from decoder: Decoder) throws {
        let raw = try Raw(from: decoder)
        let toRing: ([[Double]]) -> Ring = { pts in
            var r = pts.compactMap { $0.count >= 2 ? CLLocationCoordinate2D(latitude: $0[1], longitude: $0[0]) : nil }
            if r.count > 1, let f = r.first, let l = r.last, f.latitude == l.latitude, f.longitude == l.longitude { r.removeLast() }
            return r
        }
        switch (raw.type, raw.coordinates) {
        case ("Polygon", .polygon(let p)): polygons = [p.map(toRing)]
        case ("MultiPolygon", .multi(let m)): polygons = m.map { $0.map(toRing) }
        default: polygons = []
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode("MultiPolygon", forKey: .type)
        try c.encode(geoJSONCoordinates, forKey: .coordinates)
    }
    private enum CodingKeys: String, CodingKey { case type, coordinates }

    /// [[[[lng, lat]]]], rings closed, as GeoJSON wants.
    var geoJSONCoordinates: [[[[Double]]]] {
        polygons.map { poly in poly.map { ring in (ring + ring.prefix(1)).map { [$0.longitude, $0.latitude] } } }
    }

    var bounds: (sw: CLLocationCoordinate2D, ne: CLLocationCoordinate2D)? {
        let all = polygons.flatMap { $0.flatMap { $0 } }
        guard let first = all.first else { return nil }
        var s = first.latitude, n = first.latitude, w = first.longitude, e = first.longitude
        for c in all { s = min(s, c.latitude); n = max(n, c.latitude); w = min(w, c.longitude); e = max(e, c.longitude) }
        return (CLLocationCoordinate2D(latitude: s, longitude: w), CLLocationCoordinate2D(latitude: n, longitude: e))
    }
}

/// GeoJSON coordinates nest differently for Polygon and MultiPolygon.
private enum AnyCoords: Codable {
    case polygon([[[Double]]])
    case multi([[[[Double]]]])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let m = try? c.decode([[[[Double]]]].self) { self = .multi(m) }
        else { self = .polygon(try c.decode([[[Double]]].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .polygon(let p): try c.encode(p)
        case .multi(let m): try c.encode(m)
        }
    }
}

enum AreaLevel: String, Codable, CaseIterable, Sendable {
    case state, county, city, neighborhood, section, custom

    var label: String {
        switch self {
        case .state: "State"
        case .county: "County"
        case .city: "City"
        case .neighborhood: "Neighborhood"
        case .section: "Section"
        case .custom: "Custom area"
        }
    }

    /// The kinds someone can give an area they draw.
    static let drawable: [AreaLevel] = [.neighborhood, .section, .custom]
}

struct Area: Codable, Identifiable, Sendable, Equatable {
    let id: String
    var name: String
    var level: AreaLevel
    /// "drawn" by a team, or an "osm_boundary" (county, city…) that teams follow.
    let source: String
    let teamId: String?
    var teamName: String?
    let parentName: String?
    var notes: String?
    let version: Int?
    let buildStatus: String?
    let segmentCount: Int?
    let streetM: Double?
    let km2: Double?
    let bbox: [Double]?
    var geometry: Outline?
    let followed: Bool?
    let totalM: Double?
    let drivenM: Double?
    let totalStreets: Int?
    let drivenStreets: Int?
    let neighbors: [String]?

    var isDrawn: Bool { source == "drawn" }
    var isBuilt: Bool { buildStatus == "built" && (totalM ?? 0) > 0 }
    /// Every street driven or marked done (as the web decides it).
    var isComplete: Bool { isBuilt && (drivenM ?? 0) >= (totalM ?? 0) * 0.9999 }
    /// How much of its streets the team has swept, 0…1, once its street list is made.
    var progress: Double? { isBuilt ? min(1, (drivenM ?? 0) / totalM!) : nil }

    var kindLabel: String { parentName.map { "\(level.label) in \($0)" } ?? level.label }

    var statusLabel: String {
        switch buildStatus {
        case "queued": return "Waiting to list its streets"
        case "building": return "Listing its streets…"
        case "failed": return "Couldn't list its streets"
        case "built": return Format.miles(streetM ?? 0) + " of streets"
        default: return km2.map(Format.size) ?? ""
        }
    }
}

struct TeamAreas: Decodable, Sendable {
    let canEdit: Bool
    let areas: [Area]
}

struct AreaDetail: Decodable, Sendable {
    let area: Area
    let canEdit: Bool
}

struct AreaSearch: Decodable, Sendable { let areas: [Area] }

struct Address: Decodable, Identifiable, Sendable {
    let label: String
    let lon: Double
    let lat: Double
    let bbox: [Double]?
    var id: String { "\(label)|\(lon)|\(lat)" }
}

struct Geocode: Decodable, Sendable { let results: [Address] }

enum Format {
    static func miles(_ meters: Double) -> String {
        let mi = meters / 1609.344
        return mi < 10 ? String(format: "%.1f mi", mi) : "\(Int(mi.rounded()).formatted()) mi"
    }

    /// Small areas in acres, bigger ones in square miles (as the web does).
    static func size(_ km2: Double) -> String {
        let sqmi = km2 * 0.386102
        if sqmi < 1 { return "\(max(1, Int((sqmi * 640).rounded())).formatted()) acres" }
        return sqmi < 10 ? String(format: "%.1f sq mi", sqmi) : "\(Int(sqmi.rounded()).formatted()) sq mi"
    }

    static func percent(_ p: Double) -> String { "\(Int((p * 100).rounded(.down)))%" }
}
