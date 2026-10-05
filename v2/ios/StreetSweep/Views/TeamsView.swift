import SwiftUI

/// Teams: the teams you're in, your requests to join others, finding a team (or joining
/// with a code), and starting one. Each team opens to its members, join requests, and
/// which drive types count for it.
struct TeamsView: View {
    @Environment(AppModel.self) private var model
    @State private var listed: [TeamListing] = []
    @State private var mine: [JoinRequest] = []
    @State private var query = ""
    @State private var code = ""
    @State private var newName = ""
    @State private var creating = false
    @State private var error: String?
    @State private var note: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            List {
                if let error { Text(error).foregroundStyle(.red) }
                if let note { Text(note).foregroundStyle(Color.brand) }
                Section("Your teams") {
                    ForEach(model.teams) { t in
                        NavigationLink(value: t.id) {
                            HStack {
                                Image(systemName: t.isPersonal ? "person" : "person.3").frame(width: 28)
                                VStack(alignment: .leading) {
                                    Text(t.isPersonal ? "Just me" : t.name).font(.body.weight(.semibold))
                                    Text(t.role.capitalized).font(.footnote).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                let pending = mine.filter { $0.status == "pending" }
                if !pending.isEmpty {
                    Section("Waiting to join") {
                        ForEach(pending) { r in
                            HStack {
                                Text(r.teamName ?? "A team")
                                Spacer()
                                Button("Withdraw") { Task { await act("/api/join-requests/\(r.id)/withdraw", done: "Request withdrawn.") } }
                                    .buttonStyle(.bordered)
                            }
                        }
                    }
                }
                Section {
                    TextField("Search teams by name", text: $query)
                    ForEach(listed.filter { $0.myRole == nil }) { t in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(t.name).font(.body.weight(.semibold))
                                Text("\(t.memberCount) member\(t.memberCount == 1 ? "" : "s")").font(.footnote).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if t.requested {
                                Text("Requested").font(.footnote).foregroundStyle(.secondary)
                            } else {
                                Button("Ask to join") { Task { await join(t.id, code: nil, name: t.name) } }
                                    .buttonStyle(.bordered)
                                    .disabled(busy)
                            }
                        }
                    }
                } header: {
                    Text("Find a team")
                } footer: {
                    Text("A team's admins approve requests to join.")
                }
                Section("Join with a code") {
                    HStack {
                        TextField("Join code, e.g. 2AC9ALS6", text: $code)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                        Button("Join") { Task { await joinWithCode() } }
                            .buttonStyle(.bordered)
                            .disabled(busy || code.trimmingCharacters(in: .whitespaces).count < 4)
                    }
                }
                Section("Start a team") {
                    HStack {
                        TextField("Team name", text: $newName)
                        Button("Create") { Task { await create() } }
                            .buttonStyle(.borderedProminent)
                            .disabled(busy || newName.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .readableWidth()
            .navigationTitle("Teams")
            .navigationDestination(for: String.self) { TeamDetailView(teamId: $0) }
            .task(id: query) {
                try? await Task.sleep(for: .milliseconds(250))
                await loadListed()
            }
            .task { await loadMine() }
            .refreshable { await model.refresh(); await loadListed(); await loadMine() }
            .contentMargins(.bottom, 90, for: .scrollContent)
        }
    }

    private func loadListed() async {
        guard let api = model.api else { return }
        let q = query.trimmingCharacters(in: .whitespaces).addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        listed = (try? await api.get("/api/teams?q=\(q)", as: Listed.self))?.teams ?? []
    }

    private func loadMine() async {
        guard let api = model.api else { return }
        mine = (try? await api.get("/api/me/join-requests", as: Requests.self))?.requests ?? []
    }

    private func run(_ done: String?, _ work: (API) async throws -> Void) async {
        guard let api = model.api else { return }
        busy = true
        defer { busy = false }
        do {
            try await work(api)
            error = nil
            note = done
            await model.refresh()
            await loadListed()
            await loadMine()
        } catch {
            self.error = error.localizedDescription
            note = nil
        }
    }

    private func act(_ path: String, done: String) async {
        await run(done) { api in let _: Empty = try await api.post(path, Empty()) }
    }

    private func join(_ id: String, code: String?, name: String) async {
        await run("Asked to join \(name). Its admins will let you in.") { api in
            let _: Empty = try await api.post("/api/teams/\(id)/join-requests", JoinBody(code: code))
        }
    }

    private func joinWithCode() async {
        let c = code.trimmingCharacters(in: .whitespaces).uppercased()
        guard let api = model.api else { return }
        do {
            let p: Preview = try await api.get("/api/join/\(c)")
            if p.myRole != nil { note = "You're already in \(p.team.name)."; return }
            await join(p.team.id, code: c, name: p.team.name)
            if error == nil { code = "" }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func create() async {
        let name = newName.trimmingCharacters(in: .whitespaces)
        await run("Started \(name). Share its join code from the team's page.") { api in
            let _: Empty = try await api.post("/api/teams", ["name": name])
        }
        if error == nil { newName = "" }
    }
}

private struct Listed: Decodable, Sendable { let teams: [TeamListing] }
private struct Requests: Decodable, Sendable { let requests: [JoinRequest] }
private struct JoinBody: Encodable { let code: String? }
private struct Preview: Decodable, Sendable {
    struct T: Decodable, Sendable { let id: String; let name: String }
    let team: T
    let myRole: String?
}

/// One team: who's in it (and their roles), people asking to join, which drive types count,
/// and its join code. Admins can change roles, approve or decline, and toggle drive types.
struct TeamDetailView: View {
    let teamId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var detail: TeamDetail?
    @State private var error: String?
    @State private var busy = false
    @State private var confirmLeave = false

    var body: some View {
        Group {
            if let d = detail {
                Form {
                    if let error { Text(error).foregroundStyle(.red) }
                    if d.canAdmin && !d.requests.isEmpty {
                        Section("Asking to join") {
                            ForEach(d.requests) { r in
                                HStack {
                                    VStack(alignment: .leading) {
                                        Text(r.displayName ?? "Someone").font(.body.weight(.semibold))
                                        Text([r.email, r.message].compactMap { $0 }.joined(separator: " · ")).font(.footnote).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Button("Decline") { Task { await post("/api/join-requests/\(r.id)/decline") } }.buttonStyle(.bordered)
                                    Button("Approve") { Task { await post("/api/join-requests/\(r.id)/approve") } }.buttonStyle(.borderedProminent)
                                }
                                .disabled(busy)
                            }
                        }
                    }
                    Section("Members · \(d.members.count)") {
                        ForEach(d.members) { m in
                            HStack(spacing: 10) {
                                PersonAvatar(id: m.userId, name: m.displayName, url: m.avatarUrl, size: 32)
                                VStack(alignment: .leading) {
                                    Text(m.displayName + (m.userId == model.user?.id ? " (you)" : "")).font(.body.weight(.semibold))
                                    if let e = m.email { Text(e).font(.footnote).foregroundStyle(.secondary) }
                                }
                                Spacer()
                                if d.canAdmin && d.team.kind != "personal" && m.userId != model.user?.id {
                                    Menu(m.role.capitalized) {
                                        ForEach(["viewer", "driver", "admin", "owner"], id: \.self) { role in
                                            Button(role.capitalized) { Task { await setRole(m, role) } }
                                        }
                                        Divider()
                                        Button("Remove from team", role: .destructive) { Task { await remove(m) } }
                                    }
                                } else {
                                    Text(m.role.capitalized).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    Section {
                        ForEach(d.driveTypes) { t in
                            Toggle(t.label, isOn: Binding(get: { t.counts }, set: { on in Task { await setCounts(t.key, on) } }))
                                .disabled(!d.canAdmin || busy)
                        }
                    } header: {
                        Text("Drive types that count")
                    } footer: {
                        Text("Drives of these types count towards this team's coverage.")
                    }
                    if d.team.kind != "personal" {
                        if let code = d.team.joinCode {
                            Section("Join code") {
                                LabeledContent("Code", value: code).textSelection(.enabled)
                                if let server = model.server, let url = URL(string: "/join/\(code)", relativeTo: server) {
                                    ShareLink("Share join link", item: url.absoluteURL)
                                }
                            }
                        }
                        Section {
                            Button("Leave team", role: .destructive) { confirmLeave = true }.disabled(busy)
                        }
                    }
                }
                .readableWidth(760)
            } else if let error {
                ContentUnavailableView("Couldn't load the team", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .navigationTitle(detail.map { $0.team.kind == "personal" ? "Just me" : $0.team.name } ?? "Team")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .confirmationDialog("Leave \(detail?.team.name ?? "this team")?", isPresented: $confirmLeave, titleVisibility: .visible) {
            Button("Leave team", role: .destructive) { Task { await leave() } }
        }
    }

    private func load() async {
        guard let api = model.api else { return }
        do { detail = try await api.get("/api/teams/\(teamId)") }
        catch { self.error = error.localizedDescription }
    }

    private func run(_ work: (API) async throws -> Void) async {
        guard let api = model.api else { return }
        busy = true
        defer { busy = false }
        do {
            try await work(api)
            error = nil
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func post(_ path: String) async { await run { api in let _: Empty = try await api.post(path, Empty()) } }

    private func setRole(_ m: Member, _ role: String) async {
        await run { api in let _: Empty = try await api.patch("/api/teams/\(teamId)/members/\(m.userId)", ["role": role]) }
    }

    private func remove(_ m: Member) async {
        await run { api in try await api.delete("/api/teams/\(teamId)/members/\(m.userId)") }
    }

    private func setCounts(_ key: String, _ on: Bool) async {
        await run { api in let _: Empty = try await api.put("/api/teams/\(teamId)/drive-types/\(key)", ["counts": on]) }
    }

    private func leave() async {
        guard let me = model.user?.id else { return }
        await run { api in try await api.delete("/api/teams/\(teamId)/members/\(me)") }
        if error == nil {
            await model.refresh()
            dismiss()
        }
    }
}
