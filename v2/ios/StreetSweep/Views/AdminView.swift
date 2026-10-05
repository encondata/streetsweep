import SwiftUI

/// Admin (site admins only): everyone's accounts (search, make admin, disable, reset a
/// password) and every team. Drive types and deletion requests stay on the website.
struct AdminView: View {
    @Environment(AppModel.self) private var model
    @State private var tab = "users"
    @State private var users: [AdminUserRow] = []
    @State private var teams: [AdminTeamRow] = []
    @State private var query = ""
    @State private var error: String?
    @State private var newPassword: (name: String, password: String)?

    var body: some View {
        NavigationStack {
            List {
                Picker("Show", selection: $tab) {
                    Text("Users").tag("users")
                    Text("Teams").tag("teams")
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                if let error { Text(error).foregroundStyle(.red) }
                if tab == "users" {
                    TextField("Search by name or email", text: $query)
                    ForEach(users) { u in userRow(u) }
                } else {
                    ForEach(teams) { t in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(t.name).font(.body.weight(.semibold))
                            Text("\(t.kind.capitalized) · \(t.memberCount ?? 0) member\(t.memberCount == 1 ? "" : "s")").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                Section {
                    if let server = model.server, let url = URL(string: "/admin", relativeTo: server) {
                        Link("Drive types and deletion requests on the website", destination: url)
                    }
                }
            }
            .readableWidth()
            .navigationTitle("Admin")
            .task(id: query) {
                try? await Task.sleep(for: .milliseconds(250))
                await loadUsers()
            }
            .task { await loadTeams() }
            .refreshable { await loadUsers(); await loadTeams() }
            .alert("New password for \(newPassword?.name ?? "")", isPresented: Binding(get: { newPassword != nil }, set: { if !$0 { newPassword = nil } })) {
                Button("Copy") { UIPasteboard.general.string = newPassword?.password; newPassword = nil }
                Button("Done", role: .cancel) { newPassword = nil }
            } message: {
                Text("\(newPassword?.password ?? "")\n\nShown once. Pass it on; they can change it after signing in.")
            }
            .contentMargins(.bottom, 90, for: .scrollContent)
        }
    }

    private func userRow(_ u: AdminUserRow) -> some View {
        HStack(spacing: 10) {
            PersonAvatar(id: u.id, name: u.displayName, url: u.avatarUrl, size: 32)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(u.displayName).font(.body.weight(.semibold))
                    if u.isSiteAdmin { Text("Admin").font(.caption.bold()).foregroundStyle(Color.brand) }
                    if u.disabledAt != nil { Text("Disabled").font(.caption.bold()).foregroundStyle(.red) }
                }
                Text(u.email).font(.footnote).foregroundStyle(.secondary)
            }
            Spacer()
            if u.id != model.user?.id {
                Menu("Manage") {
                    Button(u.isSiteAdmin ? "Remove site admin" : "Make site admin") { Task { await patch(u, ["is_site_admin": !u.isSiteAdmin]) } }
                    Button(u.disabledAt == nil ? "Disable account" : "Enable account", role: u.disabledAt == nil ? .destructive : nil) {
                        Task { await patch(u, ["disabled": u.disabledAt == nil]) }
                    }
                    Button("Reset password") { Task { await reset(u) } }
                }
            }
        }
    }

    private func loadUsers() async {
        guard let api = model.api else { return }
        let q = query.trimmingCharacters(in: .whitespaces).addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        do {
            users = (try await api.get("/api/admin/users?q=\(q)", as: Users.self)).users
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func loadTeams() async {
        guard let api = model.api else { return }
        teams = (try? await api.get("/api/admin/teams", as: Teams.self))?.teams ?? []
    }

    private func patch(_ u: AdminUserRow, _ body: [String: Bool]) async {
        guard let api = model.api else { return }
        do {
            let _: Empty = try await api.patch("/api/admin/users/\(u.id)", body)
            await loadUsers()
        } catch { self.error = error.localizedDescription }
    }

    private func reset(_ u: AdminUserRow) async {
        guard let api = model.api else { return }
        do {
            let r: Reset = try await api.post("/api/admin/users/\(u.id)/reset-password", Empty())
            newPassword = (u.displayName, r.password)
        } catch { self.error = error.localizedDescription }
    }
}

struct AdminUserRow: Decodable, Sendable, Identifiable {
    let id: String
    let email: String
    let displayName: String
    let avatarUrl: String?
    let isSiteAdmin: Bool
    let disabledAt: String?
}

struct AdminTeamRow: Decodable, Sendable, Identifiable {
    let id: String
    let name: String
    let kind: String
    let memberCount: Int?
}

private struct Users: Decodable, Sendable { let users: [AdminUserRow] }
private struct Teams: Decodable, Sendable { let teams: [AdminTeamRow] }
private struct Reset: Decodable, Sendable { let password: String }
