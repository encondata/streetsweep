import Foundation

struct User: Codable, Equatable, Sendable {
    let id: String
    let email: String
    let displayName: String
    let avatarUrl: String?
    let isSiteAdmin: Bool
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
