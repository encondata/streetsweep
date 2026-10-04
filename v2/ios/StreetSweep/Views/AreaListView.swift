import SwiftUI

/// The team's areas: what it drew and what it follows. Search finds them by name, public
/// boundaries (counties, cities) to follow, and, on Return, addresses.
struct AreaListView: View {
    @Environment(AppModel.self) private var model
    @Environment(Workspace.self) private var ws
    @State private var query = ""
    @State private var boundaries: [Area] = []
    @State private var addresses: [Address]?
    @State private var lookingUp = false

    var body: some View {
        @Bindable var model = model
        List {
            Section {
                Picker("Areas for", selection: $model.teamId) {
                    ForEach(model.teams) { Text($0.label).tag(Optional($0.id)) }
                }
                .pickerStyle(.menu)
                if ws.store.canEdit {
                    Button { ws.startDrawing(nil) } label: {
                        Label("Draw a new area", systemImage: "pencil.and.outline")
                            .font(.headline)
                    }
                }
            }

            if let e = ws.store.error {
                Section {
                    Label(e, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                    Button("Try again") { Task { await ws.reload() } }
                }
            }

            if let d = ws.draft {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Unsaved drawing\(d.name.isEmpty ? "" : ": \(d.name)")").font(.headline)
                        Text("\(d.areaId == nil ? "A new area" : "Redrawing an area") · \(d.rings.count) piece\(d.rings.count == 1 ? "" : "s") · kept \(d.at.formatted(.relative(presentation: .named)))")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    HStack {
                        Button("Resume") { Task { await ws.resumeDraft() } }.buttonStyle(.borderedProminent)
                        Button("Discard", role: .destructive) { ws.discardDraft() }.buttonStyle(.bordered)
                    }
                }
                .listRowBackground(Color.orange.opacity(0.12))
            }

            if searching {
                searchResults
            } else {
                areaSections
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Areas")
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Areas, counties, cities or an address")
        .onSubmit(of: .search) { Task { await lookUpAddress() } }
        .task(id: query) {
            addresses = nil
            try? await Task.sleep(for: .milliseconds(250))
            boundaries = await ws.searchBoundaries(query.trimmingCharacters(in: .whitespaces))
        }
        .refreshable { await ws.reload() }
        .overlay {
            if ws.store.areas.isEmpty && !ws.store.loading && !searching {
                ContentUnavailableView {
                    Label("No areas yet", systemImage: "map")
                } description: {
                    Text(ws.store.canEdit ? "Draw one with the Pencil, or search for a county or city to follow." : "Search for a county or city to follow.")
                }
            }
        }
    }

    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    @ViewBuilder private var areaSections: some View {
        if !ws.store.drawn.isEmpty {
            Section("Drawn") { ForEach(ws.store.drawn) { row($0) } }
        }
        if !ws.store.followed.isEmpty {
            Section("Following") { ForEach(ws.store.followed) { row($0) } }
        }
        if ws.store.loading && ws.store.areas.isEmpty {
            Section { ProgressView().frame(maxWidth: .infinity) }
        }
    }

    @ViewBuilder private var searchResults: some View {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let mine = ws.store.areas.filter { $0.name.lowercased().contains(q) }
        if !mine.isEmpty {
            Section("Your areas") { ForEach(mine) { row($0) } }
        }
        let others = boundaries.filter { b in !ws.store.areas.contains { $0.id == b.id } }
        if !others.isEmpty {
            Section("Counties and cities") {
                ForEach(others) { a in
                    Button { Task { await ws.open(a.id) } } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(a.name).foregroundStyle(.primary)
                            Text(a.kindLabel).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        Section("Addresses") {
            if let addresses {
                if addresses.isEmpty { Text("No address found.").foregroundStyle(.secondary) }
                ForEach(addresses) { a in
                    Button { ws.show(a) } label: {
                        Label(a.label, systemImage: "mappin.and.ellipse").foregroundStyle(.primary)
                    }
                }
            } else {
                Button { Task { await lookUpAddress() } } label: {
                    HStack {
                        Label("Find “\(query)” as an address", systemImage: "magnifyingglass")
                        if lookingUp { Spacer(); ProgressView() }
                    }
                }
                .disabled(lookingUp || query.count < 3)
            }
        }
    }

    private func row(_ a: Area) -> some View {
        Button { Task { await ws.open(a.id) } } label: {
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(ws.store.color(a.id))
                    .frame(width: 14, height: 14)
                VStack(alignment: .leading, spacing: 3) {
                    Text(a.name).font(.body.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
                    Text("\(a.level.label) · \(a.statusLabel)").font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                    if let p = a.progress {
                        ProgressView(value: p).tint(ws.store.color(a.id))
                    }
                }
                Spacer(minLength: 4)
                if let p = a.progress {
                    Text(Format.percent(p)).font(.footnote.bold()).foregroundStyle(.secondary).monospacedDigit()
                }
                if a.buildStatus == "queued" || a.buildStatus == "building" { ProgressView() }
            }
            .padding(.vertical, 2)
        }
        .tint(.primary)
    }

    private func lookUpAddress() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.count >= 3 else { return }
        lookingUp = true
        addresses = await ws.geocode(q)
        lookingUp = false
        if let first = addresses?.first, addresses?.count == 1 { ws.show(first) }
    }
}
