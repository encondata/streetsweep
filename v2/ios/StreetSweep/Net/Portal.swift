import Foundation

// What the rest of the portal sends: Home's figures and achievements, drives, places,
// fleet and teams. Field names follow the server (snake_case, decoded to camelCase).

// MARK: - Home

struct Stats: Decodable, Sendable {
    struct Totals: Decodable, Sendable { let drives: Int; let driveM: Double; let streets: Int; let streetM: Double }
    struct Week: Decodable, Sendable, Identifiable { let week: String; let streetM: Double; let driveM: Double; var id: String { week } }
    let total: Totals
    let month: Totals
    let weeks: [Week]
}

struct AchievementStep: Decodable, Sendable { let name: String; let art: String; let tier: String }

struct Ladder: Decodable, Sendable, Identifiable {
    let code: String
    let name: String
    let blurb: String?
    let unit: String?
    let level: Int
    let top: Int
    let value: Double
    let next: Double?
    let progress: Double
    let earnedAt: String?
    let steps: [AchievementStep]
    var id: String { code }
    var step: AchievementStep? { steps.isEmpty ? nil : steps[max(0, min(steps.count - 1, level - 1))] }
}

struct Badge: Decodable, Sendable, Identifiable {
    struct Progress: Decodable, Sendable { let value: Double; let need: Double }
    let code: String
    let name: String
    let blurb: String?
    let art: String
    let tier: String
    let earned: Bool
    let earnedAt: String?
    let progress: Progress?
    var id: String { code }
}

struct AchievementSet: Decodable, Sendable {
    let ladders: [Ladder]
    let badges: [Badge]
    let earnedCount: Int
    let total: Int
}

struct LeaderRow: Decodable, Sendable, Identifiable {
    let userId: String
    let displayName: String
    let avatarUrl: String?
    let value: Double
    let extra: Double?
    let rank: Int
    var id: String { userId }
}

// MARK: - Drives

struct Drive: Decodable, Sendable, Identifiable, Hashable {
    let id: String
    let source: String
    let status: String
    let matchError: String?
    let startedAt: String
    let endedAt: String
    let distanceM: Double?
    let streetCount: Int?
    let driveTypeKey: String?
    let driveTypeLabel: String?
    let userId: String?
    let userName: String?
    let vehicleId: String?
    let vehicleName: String?
    let loggerName: String?

    var start: Date { ISO.date(startedAt) ?? .distantPast }
    var end: Date { ISO.date(endedAt) ?? start }
    var statusLabel: String {
        switch status {
        case "received": "Waiting to be matched"
        case "matching": "Matching to streets…"
        case "failed": "Couldn't match"
        default: ""
        }
    }
}

struct LineGeometry: Decodable, Sendable {
    let type: String
    let coordinates: AnyLine
    /// Every line as [lng, lat] pairs.
    var lines: [[[Double]]] {
        switch coordinates {
        case .line(let l): [l]
        case .multi(let m): m
        }
    }
    enum AnyLine: Decodable, Sendable {
        case line([[Double]]), multi([[[Double]]])
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let m = try? c.decode([[[Double]]].self) { self = .multi(m) } else { self = .line(try c.decode([[Double]].self)) }
        }
    }
}

struct TeamRef: Decodable, Sendable, Hashable, Identifiable { let id: String; let name: String; let kind: String }

struct DriveDetail: Decodable, Sendable {
    let drive: Drive
    let track: LineGeometry?
    let streets: LineGeometry?
    let countsFor: [TeamRef]
    let canEdit: Bool
}

struct DriveType: Decodable, Sendable, Identifiable, Hashable {
    let key: String
    let label: String
    let archivedAt: String?
    var id: String { key }
}

// MARK: - Places

struct PlacePhoto: Decodable, Sendable, Identifiable, Hashable { let id: String; let width: Int?; let height: Int? }

struct Place: Decodable, Sendable, Identifiable, Hashable {
    let id: String
    var name: String
    var note: String?
    let lon: Double
    let lat: Double
    let createdAt: String
    let userName: String?
    let mine: Bool
    var sharedWith: [TeamRef]
    var photos: [PlacePhoto]
}

struct PlaceBody: Encodable {
    var id: String?
    var name: String?
    var note: String??
    var lon: Double?
    var lat: Double?
    var teamIds: [String]?
    enum CodingKeys: String, CodingKey { case id, name, note, lon, lat, teamIds = "team_ids" }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(id, forKey: .id)
        try c.encodeIfPresent(name, forKey: .name)
        if let note { try c.encode(note, forKey: .note) }
        try c.encodeIfPresent(lon, forKey: .lon)
        try c.encodeIfPresent(lat, forKey: .lat)
        try c.encodeIfPresent(teamIds, forKey: .teamIds)
    }
}

// MARK: - Fleet

struct Person: Decodable, Sendable, Hashable, Identifiable {
    let userId: String
    let displayName: String
    let avatarUrl: String?
    var id: String { userId }
}

struct Vehicle: Decodable, Sendable, Identifiable, Hashable {
    struct Checkout: Decodable, Sendable, Hashable { let userId: String; let displayName: String; let since: String? }
    let id: String
    let name: String
    let kind: String
    let make: String?
    let model: String?
    let year: Int?
    let color: String?
    let plate: String?
    let checkoutPolicy: String
    let teamId: String
    let teamName: String?
    let teamKind: String?
    let myRole: String?
    let photoUrl: String?
    let checkout: Checkout?
    let assigned: [Person]?

    var subtitle: String {
        [year.map(String.init), make, model].compactMap { $0 }.joined(separator: " ")
    }
}

struct VehicleHistory: Decodable, Sendable, Identifiable {
    let id: String
    let kind: String
    let startedAt: String
    let endedAt: String?
    let displayName: String
}

struct VehicleDetail: Decodable, Sendable {
    let vehicle: Vehicle
    let canAdmin: Bool
    let canDrive: Bool
    let history: [VehicleHistory]
}

struct Device: Decodable, Sendable, Identifiable {
    let id: String
    let name: String
    let platform: String?
    let appVersion: String?
    let createdAt: String
    let lastSeenAt: String?
    let revokedAt: String?
    let thisDevice: Bool
}

// MARK: - Teams

struct TeamListing: Decodable, Sendable, Identifiable {
    let id: String
    let name: String
    let memberCount: Int
    let myRole: String?
    let requested: Bool
}

struct Member: Decodable, Sendable, Identifiable {
    let userId: String
    let displayName: String
    let email: String?
    let avatarUrl: String?
    let role: String
    var id: String { userId }
}

struct TeamDriveType: Decodable, Sendable, Identifiable { let key: String; let label: String; let counts: Bool; var id: String { key } }

struct JoinRequest: Decodable, Sendable, Identifiable {
    let id: String
    let userId: String?
    let displayName: String?
    let email: String?
    let message: String?
    let teamId: String?
    let teamName: String?
    let status: String?
    let createdAt: String?
}

struct TeamDetail: Decodable, Sendable {
    struct Info: Decodable, Sendable { let id: String; let name: String; let kind: String; let listed: Bool?; let joinCode: String? }
    let team: Info
    let myRole: String?
    let canAdmin: Bool
    let members: [Member]
    let driveTypes: [TeamDriveType]
    let requests: [JoinRequest]
}

// MARK: - Dates

enum ISO {
    nonisolated(unsafe) private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) private static let plain = ISO8601DateFormatter()

    static func date(_ s: String?) -> Date? {
        guard let s else { return nil }
        return withFraction.date(from: s) ?? plain.date(from: s)
    }
}

extension Format {
    static func duration(_ from: Date, _ to: Date) -> String {
        let mins = Int((to.timeIntervalSince(from) / 60).rounded())
        return mins < 60 ? "\(max(1, mins)) min" : "\(mins / 60) h \(mins % 60) min"
    }

    /// Feet for short lengths (under 1,000 ft), miles past that, as the website shows them.
    static func length(_ meters: Double) -> String {
        let ft = Int((meters * 3.28084).rounded())
        return ft < 1000 ? "\(max(1, ft).formatted()) ft" : miles(meters)
    }

    static func day(_ s: String?) -> String {
        ISO.date(s)?.formatted(date: .abbreviated, time: .omitted) ?? ""
    }
}
