import Foundation

struct User: Codable, Equatable, Sendable {
    let id: String
    let email: String
    let displayName: String
    let avatarUrl: String?
    let isSiteAdmin: Bool
    let preferences: Preferences?
}

/// How the person likes the map (set on the website's Preferences page).
struct Preferences: Codable, Equatable, Sendable {
    let mapColors: MapColors?
    let shadeComplete: Bool?
    let completeFill: StreetColor?
}

struct StreetColor: Codable, Equatable, Sendable {
    let color: String
    let opacity: Double
}

/// Streets driven (or marked done) and still to do.
struct MapColors: Codable, Equatable, Sendable {
    let driven: StreetColor
    let undriven: StreetColor

    /// The website's default ("Classic"): green done, blue to do.
    static let standard = MapColors(driven: StreetColor(color: "#16a34a", opacity: 1), undriven: StreetColor(color: "#1a6fd4", opacity: 0.9))
}

struct Team: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    /// "personal" (just you) or a shared team.
    let kind: String
    let role: String

    var isPersonal: Bool { kind == "personal" }
    var label: String { isPersonal ? "Just me" : name }
    var canEdit: Bool { role == "owner" || role == "admin" || isPersonal }
}

/// `GET /api/me`, and what device sign-in returns alongside the token.
struct MeSummary: Codable, Sendable {
    let user: User
    let teams: [Team]
}

struct DeviceSignIn: Codable, Sendable {
    let token: String
    let deviceId: String
    let user: User
    let teams: [Team]
}

struct DeviceSignInBody: Encodable {
    let email: String
    let password: String
    let deviceName: String
    let platform = "ios"
    let appVersion: String
}
