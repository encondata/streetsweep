import SwiftUI

/// Drives: yours (driven, uploaded, or from your loggers), or a team's for its admins,
/// newest first and grouped by day. Each opens to its map, figures and settings.
struct DrivesView: View {
    @Environment(AppModel.self) private var model
    @State private var scope: String? // nil: yours; a team id: that team's
    @State private var drives: [Drive] = []
    @State private var more = true
    @State private var loading = false
    @State private var error: String?

    private var adminTeams: [Team] { model.teams.filter { !$0.isPersonal && $0.canEdit } }

    var body: some View {
        NavigationStack {
            List {
                if !adminTeams.isEmpty {
                    Picker("Drives", selection: $scope) {
                        Text("Yours").tag(String?.none)
                        ForEach(adminTeams) { Text($0.name).tag(Optional($0.id)) }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                }
                if let error { Text(error).foregroundStyle(.red) }
                ForEach(days, id: \.day) { group in
                    Section(group.day) {
                        ForEach(group.drives) { d in
                            NavigationLink(value: d) { DriveRow(drive: d) }
                        }
                    }
                }
                if more && !drives.isEmpty {
                    HStack { Spacer(); ProgressView(); Spacer() }
                        .task { await loadMore() }
                }
            }
            .overlay {
                if drives.isEmpty && !loading {
                    ContentUnavailableView("No drives yet", systemImage: "car",
                                           description: Text("Drives recorded with the StreetSweep phone app, or uploaded by your loggers, show here."))
                }
            }
            .readableWidth()
            .navigationTitle(scope == nil ? "Drives" : adminTeams.first { $0.id == scope }?.name ?? "Drives")
            .navigationDestination(for: Drive.self) { DriveDetailView(driveId: $0.id) }
            .refreshable { await reload() }
            .task(id: scope) { await reload() }
            .contentMargins(.bottom, 90, for: .scrollContent)
        }
    }

    private var days: [(day: String, drives: [Drive])] {
        var out: [(String, [Drive])] = []
        for d in drives {
            let day = d.start.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
            if out.last?.0 == day { out[out.count - 1].1.append(d) } else { out.append((day, [d])) }
        }
        return out.map { (day: $0.0, drives: $0.1) }
    }

    private func path(before: String?) -> String {
        let base = scope.map { "/api/teams/\($0)/drives" } ?? "/api/drives"
        return base + "?limit=40" + (before.map { "&before=\($0.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? $0)" } ?? "")
    }

    private func reload() async {
        guard let api = model.api else { return }
        loading = true
        defer { loading = false }
        do {
            let r: DriveList = try await api.get(path(before: nil))
            drives = r.drives
            more = r.drives.count == 40
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func loadMore() async {
        guard let api = model.api, more, !loading, let last = drives.last else { return }
        loading = true
        defer { loading = false }
        if let r: DriveList = try? await api.get(path(before: last.startedAt)) {
            drives += r.drives
            more = r.drives.count == 40
        } else {
            more = false
        }
    }
}

/// One drive in a list: when, how far, how many streets, the type and car.
struct DriveRow: View {
    let drive: Drive

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: drive.source == "logger" ? "antenna.radiowaves.left.and.right" : "car.fill")
                .foregroundStyle(Color.brand)
                .frame(width: 34, height: 34)
                .background(Color.brand.opacity(0.12), in: RoundedRectangle(cornerRadius: 9))
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(drive.start.formatted(date: .omitted, time: .shortened)).font(.body.weight(.semibold))
                    Text("· \(Format.miles(drive.distanceM ?? 0)) · \(Format.duration(drive.start, drive.end))").foregroundStyle(.secondary)
                    if let t = drive.driveTypeLabel {
                        Text(t).font(.caption.weight(.semibold)).padding(.horizontal, 7).padding(.vertical, 2)
                            .background(Color(.tertiarySystemFill), in: Capsule())
                    }
                }
                Text(sub).font(.footnote).foregroundStyle(drive.status == "failed" ? .red : .secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
    }

    private var sub: String {
        var parts: [String] = []
        if let v = drive.vehicleName ?? drive.loggerName { parts.append(v) }
        if !drive.statusLabel.isEmpty { parts.append(drive.statusLabel) }
        else if let n = drive.streetCount { parts.append("\(n) street\(n == 1 ? "" : "s")") }
        return parts.joined(separator: " · ")
    }
}

/// One drive: its track and the streets it was matched to, the figures, which teams it
/// counts for, and (for whoever can edit it) its type, or deleting it.
struct DriveDetailView: View {
    let driveId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var detail: DriveDetail?
    @State private var types: [DriveType] = []
    @State private var error: String?
    @State private var busy = false
    @State private var confirmDelete = false

    var body: some View {
        Group {
            if let d = detail {
                HStack(alignment: .top, spacing: 0) {
                    MiniMap(streets: d.streets?.lines ?? [], track: d.track?.lines ?? [])
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    Form {
                        Section {
                            LabeledContent("When", value: d.drive.start.formatted(date: .abbreviated, time: .shortened))
                            LabeledContent("Took", value: Format.duration(d.drive.start, d.drive.end))
                            LabeledContent("Distance", value: Format.miles(d.drive.distanceM ?? 0))
                            if let n = d.drive.streetCount { LabeledContent("Streets", value: "\(n)") }
                            if let u = d.drive.userName { LabeledContent("Driver", value: u) }
                            if let v = d.drive.vehicleName { LabeledContent("Vehicle", value: v) }
                            if let l = d.drive.loggerName { LabeledContent("Logger", value: l) }
                            if !d.drive.statusLabel.isEmpty {
                                Text(d.drive.matchError ?? d.drive.statusLabel).foregroundStyle(d.drive.status == "failed" ? .red : .secondary)
                            }
                        }
                        Section("Type") {
                            if d.canEdit {
                                Picker("Drive type", selection: Binding(get: { d.drive.driveTypeKey ?? "" }, set: { k in Task { await setType(k) } })) {
                                    ForEach(types.filter { $0.archivedAt == nil || $0.key == d.drive.driveTypeKey }) { Text($0.label).tag($0.key) }
                                }
                                .disabled(busy)
                            } else {
                                Text(d.drive.driveTypeLabel ?? "—")
                            }
                        }
                        Section {
                            if d.countsFor.isEmpty { Text("No team counts this drive.").foregroundStyle(.secondary) }
                            ForEach(d.countsFor) { Text($0.kind == "personal" ? "Just me" : $0.name) }
                        } header: {
                            Text("Counts for")
                        } footer: {
                            Text("Each team decides which drive types count for it.")
                        }
                        if d.canEdit {
                            Section {
                                Button("Match again") { Task { await rematch() } }.disabled(busy)
                                Button("Delete drive", role: .destructive) { confirmDelete = true }.disabled(busy)
                            }
                        }
                        if let error { Text(error).foregroundStyle(.red) }
                    }
                    .frame(width: 400)
                }
            } else if let error {
                ContentUnavailableView("Couldn't load the drive", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .navigationTitle(detail.map { $0.drive.start.formatted(date: .abbreviated, time: .shortened) } ?? "Drive")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .confirmationDialog("Delete this drive? Its streets stop counting. This can't be undone.", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete drive", role: .destructive) { Task { await delete() } }
        }
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            async let d: DriveDetail = api.get("/api/drives/\(driveId)")
            async let t: DriveTypes? = try? api.get("/api/drive-types")
            detail = try await d
            types = await t?.driveTypes ?? []
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func setType(_ key: String) async {
        guard let api = model.api, key != detail?.drive.driveTypeKey else { return }
        busy = true
        defer { busy = false }
        do {
            let _: Empty = try await api.patch("/api/drives/\(driveId)", ["drive_type": key])
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func rematch() async {
        guard let api = model.api else { return }
        busy = true
        defer { busy = false }
        do {
            let _: Empty = try await api.post("/api/drives/\(driveId)/rematch", Empty())
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func delete() async {
        guard let api = model.api else { return }
        busy = true
        defer { busy = false }
        do {
            try await api.delete("/api/drives/\(driveId)")
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

struct DriveTypes: Decodable, Sendable { let driveTypes: [DriveType] }
