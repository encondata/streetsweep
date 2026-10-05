import Foundation
import Observation
import SwiftUI

/// The chosen team's areas (drawn and followed), with the automatic colours.
@MainActor @Observable
final class AreasStore {
    private(set) var areas: [Area] = []
    private(set) var canEdit = false
    private(set) var colors: [String: String] = [:]
    private(set) var loading = false
    var error: String?
    private(set) var teamId: String?
    /// What each area sits inside, among the team's own areas (worked out from the outlines).
    private(set) var parentOf: [String: String] = [:]

    func load(_ api: API, team: String) async {
        if team != teamId { areas = []; colors = [:] }
        teamId = team
        loading = true
        defer { loading = false }
        do {
            let r: TeamAreas = try await api.get("/api/teams/\(team)/areas")
            guard team == teamId else { return }
            areas = r.areas
            canEdit = r.canEdit
            colors = AreaColors.assign(r.areas)
            parentOf = Self.nest(r.areas)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func area(_ id: String) -> Area? { areas.first { $0.id == id } }

    func color(_ id: String) -> Color { Color(hex: colors[id] ?? "#1e8a28") }

    /// Add an area straight away (just followed, say) while the full list reloads.
    func insert(_ a: Area) {
        guard area(a.id) == nil else { return }
        areas.append(a)
        colors = AreaColors.assign(areas)
        parentOf = Self.nest(areas)
    }

    /// State › county › city › neighbourhood › section, as far as the team has them. Each
    /// area goes under the nearest bigger kind whose outline it sits inside, so a
    /// neighbourhood nests under the county when the team doesn't follow the city.
    static func nest(_ areas: [Area]) -> [String: String] {
        var out: [String: String] = [:]
        for child in areas {
            guard let g = child.geometry else { continue }
            let samples = g.samplePoints
            guard !samples.isEmpty else { continue }
            let parent = areas
                .filter { $0.level.rank < child.level.rank && $0.geometry != nil && $0.id != child.id }
                .filter { p in
                    guard let b = p.bbox, b.count == 4, let s = samples.first,
                          s.longitude >= b[0], s.longitude <= b[2], s.latitude >= b[1], s.latitude <= b[3] else { return false }
                    return samples.filter { p.geometry!.contains($0) }.count * 2 > samples.count
                }
                .max { a, b in a.level.rank != b.level.rank ? a.level.rank < b.level.rank : (a.km2 ?? 0) > (b.km2 ?? 0) }
            if let parent { out[child.id] = parent.id }
        }
        return out
    }

    struct Node: Identifiable {
        let area: Area
        var children: [Node]
        var id: String { area.id }
    }

    /// The nested list, keeping only what's in `view` (and the areas holding it); and how
    /// many areas that leaves out. With no view, everything.
    func tree(in view: GeoBounds?) -> (roots: [Node], hidden: Int) {
        var kids: [String: [Area]] = [:]
        var roots: [Area] = []
        for a in areas {
            if let p = parentOf[a.id] { kids[p, default: []].append(a) } else { roots.append(a) }
        }
        var shown = 0
        func build(_ a: Area) -> Node? {
            let children = (kids[a.id] ?? []).sorted(by: Self.order).compactMap(build)
            let here = view.map { v in a.bbox.map(v.intersects) ?? true } ?? true
            guard here || !children.isEmpty else { return nil }
            shown += 1
            return Node(area: a, children: children)
        }
        let nodes = roots.sorted(by: Self.order).compactMap(build)
        return (nodes, areas.count - shown)
    }

    private static func order(_ a: Area, _ b: Area) -> Bool {
        a.level.rank != b.level.rank ? a.level.rank < b.level.rank : a.name.localizedStandardCompare(b.name) == .orderedAscending
    }
}

/// A box on the map (what's in view), in degrees.
struct GeoBounds: Equatable {
    let south: Double, west: Double, north: Double, east: Double

    /// Does an area's [west, south, east, north] box overlap this one?
    func intersects(_ bbox: [Double]) -> Bool {
        guard bbox.count == 4 else { return true }
        return bbox[0] <= east && bbox[2] >= west && bbox[1] <= north && bbox[3] >= south
    }
}

/// No area shares a colour with one it touches. The same greedy colouring as the web
/// (`lib/areaColors.ts`), so an area is the same colour on both.
enum AreaColors {
    static let palette = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#21b8d8", "#f032e6", "#d4a017"]

    static func assign(_ areas: [Area]) -> [String: String] {
        let present = Set(areas.map(\.id))
        let near = { (a: Area) in (a.neighbors ?? []).filter { present.contains($0) } }
        let order = areas.sorted {
            let x = near($0).count, y = near($1).count
            return x != y ? x > y : $0.id < $1.id
        }
        var out: [String: String] = [:]
        for a in order {
            let taken = Set(near(a).compactMap { out[$0] })
            let start = Int(hash(a.id) % UInt32(palette.count))
            var pick = palette[start]
            for i in 0..<palette.count where !taken.contains(palette[(start + i) % palette.count]) {
                pick = palette[(start + i) % palette.count]
                break
            }
            out[a.id] = pick
        }
        return out
    }

    /// The web's `(h * 31 + code) >>> 0` over UTF-16 code units.
    private static func hash(_ s: String) -> UInt32 {
        var h: UInt32 = 0
        for u in s.utf16 { h = h &* 31 &+ UInt32(u) }
        return h
    }
}

extension Color {
    init(hex: String) {
        var v: UInt64 = 0
        Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&v)
        self.init(red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }
}
