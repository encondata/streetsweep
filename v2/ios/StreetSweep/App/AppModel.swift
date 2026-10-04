import Foundation
import Observation
import UIKit

/// Who's signed in, to which server, and which team the app is looking at.
@MainActor @Observable
final class AppModel {
    private(set) var server: URL?
    private(set) var token: String?
    private(set) var deviceId: String?
    private(set) var user: User?
    private(set) var teams: [Team] = []
    /// Set when the server said the token is no good any more.
    var signedOutReason: String?

    var teamId: String? {
        didSet { UserDefaults.standard.set(teamId, forKey: Keys.team) }
    }
    var team: Team? { teams.first { $0.id == teamId } ?? teams.first }

    var signedIn: Bool { token != nil && server != nil }
    var api: API? { server.map { API(server: $0, token: token) } }

    /// The address last signed in to, offered again on the sign-in screen.
    var lastServer: String { UserDefaults.standard.string(forKey: Keys.server) ?? Self.defaultServer }
    static let defaultServer = "https://streetsweep.net"

    private enum Keys {
        static let server = "server", team = "team", token = "token", device = "deviceId"
    }

    init() {
        if let s = UserDefaults.standard.string(forKey: Keys.server) { server = URL(string: s) }
        token = Keychain.read(Keys.token)
        deviceId = Keychain.read(Keys.device)
        teamId = UserDefaults.standard.string(forKey: Keys.team)
    }

    /// Turns what someone typed ("10.0.0.5:8430", "streetsweep.net") into a server address.
    static func serverURL(from typed: String) -> URL? {
        var s = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        guard !s.isEmpty else { return nil }
        if !s.contains("://") {
            // A bare address on the local network is almost always plain http; a domain, https.
            let host = s.split(separator: ":").first.map(String.init) ?? s
            let local = host == "localhost" || host.hasSuffix(".local") || host.allSatisfy { $0.isNumber || $0 == "." }
            s = (local ? "http://" : "https://") + s
        }
        guard let url = URL(string: s), url.host != nil else { return nil }
        return url
    }

    func signIn(server typed: String, email: String, password: String) async throws {
        guard let url = Self.serverURL(from: typed) else {
            throw APIError(status: 0, message: "Enter the server's address, like streetsweep.net.", code: nil)
        }
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let body = DeviceSignInBody(email: email.trimmingCharacters(in: .whitespaces), password: password,
                                    deviceName: "\(UIDevice.current.model) (StreetSweep for iPad)", appVersion: version)
        let r: DeviceSignIn = try await API(server: url, token: nil).post("/api/auth/device", body)
        UserDefaults.standard.set(url.absoluteString, forKey: Keys.server)
        Keychain.write(Keys.token, r.token)
        Keychain.write(Keys.device, r.deviceId)
        server = url
        token = r.token
        deviceId = r.deviceId
        signedOutReason = nil
        apply(MeSummary(user: r.user, teams: r.teams))
    }

    #if DEBUG
    /// Development only: sign in from the launch environment (SS_DEV_SERVER, SS_DEV_EMAIL,
    /// SS_DEV_PASSWORD), so a simulator can be driven from the command line. Not in release builds.
    func devSignIn() async {
        let env = ProcessInfo.processInfo.environment
        guard !signedIn, let s = env["SS_DEV_SERVER"], let e = env["SS_DEV_EMAIL"], let p = env["SS_DEV_PASSWORD"] else { return }
        try? await signIn(server: s, email: e, password: p)
    }
    #endif

    /// Fresh user and teams from the server (on launch, and when coming back to the app).
    func refresh() async {
        guard let api, signedIn else { return }
        do {
            apply(try await api.get("/api/me", as: MeSummary.self))
        } catch let e as APIError where e.isSignedOut {
            forget(reason: "You were signed out on the server. Sign in again.")
        } catch {
            // Offline or the server's down: keep what we had.
        }
    }

    /// Sign out here, and tell the server to forget this iPad's token.
    func signOut() async {
        if let api, let deviceId { try? await api.delete("/api/devices/\(deviceId)") }
        forget(reason: nil)
    }

    private func forget(reason: String?) {
        Keychain.write(Keys.token, nil)
        Keychain.write(Keys.device, nil)
        token = nil
        deviceId = nil
        user = nil
        teams = []
        signedOutReason = reason
    }

    private func apply(_ me: MeSummary) {
        user = me.user
        teams = me.teams
        if teamId == nil || !teams.contains(where: { $0.id == teamId }) { teamId = teams.first?.id }
    }
}
