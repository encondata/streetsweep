import Foundation

/// An error the server explained (`{ "error": "...", "code"?: "..." }`), or one of ours.
struct APIError: LocalizedError {
    let status: Int
    let message: String
    let code: String?

    var errorDescription: String? { message }
    /// The token was revoked or the account changed: sign in again.
    var isSignedOut: Bool { status == 401 }
}

/// Talks to a StreetSweep server with the device token, as the Android app does
/// (see v2/docs/APP-API.md).
struct API: Sendable {
    let server: URL
    let token: String?

    private static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 30
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    func get<T: Decodable>(_ path: String, as: T.Type = T.self) async throws -> T {
        try await send("GET", path, body: Optional<Empty>.none)
    }

    func post<T: Decodable, B: Encodable>(_ path: String, _ body: B, as: T.Type = T.self) async throws -> T {
        try await send("POST", path, body: body)
    }

    func patch<T: Decodable, B: Encodable>(_ path: String, _ body: B, as: T.Type = T.self) async throws -> T {
        try await send("PATCH", path, body: body)
    }

    func delete(_ path: String) async throws {
        let _: Empty = try await send("DELETE", path, body: Optional<Empty>.none)
    }

    private func send<T: Decodable, B: Encodable>(_ method: String, _ path: String, body: B?) async throws -> T {
        guard let url = URL(string: path, relativeTo: server) else {
            throw APIError(status: 0, message: "That server address doesn't look right.", code: nil)
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(body)
        }
        let data: Data, response: URLResponse
        do {
            (data, response) = try await Self.session.data(for: req)
        } catch let e as URLError {
            throw APIError(status: 0, message: Self.describe(e), code: nil)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let said = try? Self.decoder.decode(ServerError.self, from: data)
            throw APIError(status: status, message: said?.error ?? "The server answered \(status).", code: said?.code)
        }
        if T.self == Empty.self { return Empty() as! T }
        do {
            return try Self.decoder.decode(T.self, from: data)
        } catch {
            throw APIError(status: status, message: "The server's answer didn't make sense (\(error.localizedDescription)).", code: nil)
        }
    }

    private static func describe(_ e: URLError) -> String {
        switch e.code {
        case .notConnectedToInternet: return "This iPad is offline."
        case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed:
            return "Couldn't reach the server. Check the address, and that this iPad is on the same network."
        case .timedOut: return "The server took too long to answer."
        case .secureConnectionFailed, .serverCertificateUntrusted: return "The server's secure connection failed."
        default: return e.localizedDescription
        }
    }
}

struct Empty: Codable {}
private struct ServerError: Decodable { let error: String; let code: String? }
