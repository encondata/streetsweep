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
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func area(_ id: String) -> Area? { areas.first { $0.id == id } }

    func color(_ id: String) -> Color { Color(hex: colors[id] ?? "#1e8a28") }

    /// Drawn areas first, then followed boundaries.
    var drawn: [Area] { areas.filter(\.isDrawn) }
    var followed: [Area] { areas.filter { !$0.isDrawn } }
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
