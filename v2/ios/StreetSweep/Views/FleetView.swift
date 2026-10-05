import SwiftUI

/// Fleet: the vehicles you can drive (check one out, return it), your phones and tablets
/// (sign one out), and your loggers. Adding vehicles and setting up loggers stay on the
/// website and the phone app.
struct FleetView: View {
    enum Tab: String, CaseIterable, Identifiable { case vehicles, phones, loggers; var id: String { rawValue } }
    @Environment(AppModel.self) private var model
    @State private var tab: Tab = .vehicles
    @State private var vehicles: [Vehicle] = []
    @State private var devices: [Device] = []
    @State private var loggers: [LoggerRow] = []
    @State private var error: String?
    @State private var loading = true

    var body: some View {
        NavigationStack {
            List {
                Picker("Show", selection: $tab) {
                    Text("Vehicles").tag(Tab.vehicles)
                    Text("Phones & tablets").tag(Tab.phones)
                    Text("Loggers").tag(Tab.loggers)
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                if let error { Text(error).foregroundStyle(.red) }
                switch tab {
                case .vehicles: vehicleRows
                case .phones: deviceRows
                case .loggers: loggerRows
                }
            }
            .readableWidth()
            .navigationTitle("Fleet")
            .navigationDestination(for: Vehicle.self) { VehicleDetailView(vehicleId: $0.id) { Task { await load() } } }
            .refreshable { await load() }
            .task { await load() }
            .contentMargins(.bottom, 90, for: .scrollContent)
        }
    }

    @ViewBuilder private var vehicleRows: some View {
        if vehicles.isEmpty && !loading {
            Text("No vehicles yet. Add one on the website (Fleet → Vehicles).").foregroundStyle(.secondary)
        }
        let byTeam = Dictionary(grouping: vehicles) { $0.teamKind == "personal" ? "Yours" : ($0.teamName ?? "Team") }
        ForEach(byTeam.keys.sorted { $0 == "Yours" ? true : $1 == "Yours" ? false : $0 < $1 }, id: \.self) { team in
            Section(team) {
                ForEach(byTeam[team] ?? []) { v in
                    NavigationLink(value: v) { VehicleRow(vehicle: v, me: model.user?.id) }
                }
            }
        }
    }

    @ViewBuilder private var deviceRows: some View {
        Section {
            ForEach(devices.filter { $0.revokedAt == nil }) { d in
                HStack(spacing: 12) {
                    Image(systemName: d.platform == "ios" ? "ipad.landscape" : d.platform == "android" ? "iphone" : "laptopcomputer")
                        .font(.title3).frame(width: 30)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(d.name + (d.thisDevice ? " (this iPad)" : "")).font(.body.weight(.semibold))
                        Text("Signed in \(Format.day(d.createdAt)) · last seen \(Format.day(d.lastSeenAt))\(d.appVersion.map { " · v\($0)" } ?? "")")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if !d.thisDevice {
                        Button("Sign out", role: .destructive) { Task { await revoke(d) } }
                            .buttonStyle(.bordered)
                    }
                }
            }
        } footer: {
            Text("Phones and tablets signed in to your account. Signing one out ends its session; it can sign in again.")
        }
    }

    @ViewBuilder private var loggerRows: some View {
        Section {
            if loggers.isEmpty && !loading { Text("No loggers. Set one up with the StreetSweep phone app.").foregroundStyle(.secondary) }
            ForEach(loggers) { l in
                VStack(alignment: .leading, spacing: 2) {
                    Text(l.name).font(.body.weight(.semibold))
                    Text([l.vehicleName.map { "In \($0)" } ?? "Not installed", l.lastSeenAt.map { "last upload \(Format.day($0))" }]
                        .compactMap { $0 }.joined(separator: " · "))
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        } footer: {
            Text("GPS loggers you've built. Install, move and reset them from the phone app or the website.")
        }
    }

    private func load() async {
        guard let api = model.api else { return }
        defer { loading = false }
        async let v: VehicleList? = try? api.get("/api/vehicles")
        async let d: DeviceList? = try? api.get("/api/devices")
        async let l: LoggerList? = try? api.get("/api/loggers")
        let (vs, ds, ls) = await (v, d, l)
        vehicles = vs?.vehicles ?? []
        devices = ds?.devices ?? []
        loggers = ls?.loggers ?? []
        error = vs == nil ? "Couldn't load the fleet. Pull to try again." : nil
    }

    private func revoke(_ d: Device) async {
        guard let api = model.api else { return }
        do {
            try await api.delete("/api/devices/\(d.id)")
            await load()
        } catch { self.error = error.localizedDescription }
    }
}

private struct VehicleList: Decodable, Sendable { let vehicles: [Vehicle] }
private struct DeviceList: Decodable, Sendable { let devices: [Device] }
private struct LoggerList: Decodable, Sendable { let loggers: [LoggerRow] }

struct LoggerRow: Decodable, Sendable, Identifiable {
    let id: String
    let name: String
    let vehicleName: String?
    let lastSeenAt: String?
}

/// One vehicle in the list: its picture, name, and who has it.
struct VehicleRow: View {
    let vehicle: Vehicle
    let me: String?

    var body: some View {
        HStack(spacing: 12) {
            VehiclePicture(vehicle: vehicle).frame(width: 64, height: 44)
            VStack(alignment: .leading, spacing: 3) {
                Text(vehicle.name).font(.body.weight(.semibold))
                Text([vehicle.subtitle.isEmpty ? nil : vehicle.subtitle, status].compactMap { $0 }.joined(separator: " · "))
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    private var status: String {
        if let c = vehicle.checkout { return c.userId == me ? "Checked out to you" : "Out with \(c.displayName)" }
        if let a = vehicle.assigned, !a.isEmpty { return "Driven by \(a.map(\.displayName).joined(separator: ", "))" }
        return vehicle.checkoutPolicy == "admin_only" ? "Handed out by an admin" : "Available"
    }
}

/// A vehicle's photo, or the drawing for its kind.
struct VehiclePicture: View {
    let vehicle: Vehicle
    var body: some View {
        RemoteImage(path: vehicle.photoUrl) {
            RemoteImage(path: vehicle.kind == "other" ? nil : "/vehicle-\(vehicle.kind).png", contentMode: .fit) {
                Image(systemName: "car.side").font(.title2).foregroundStyle(.secondary)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

/// One vehicle: who drives it, checking it out or returning it, and its history.
struct VehicleDetailView: View {
    let vehicleId: String
    var onChange: () -> Void = {}
    @Environment(AppModel.self) private var model
    @State private var detail: VehicleDetail?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        Group {
            if let d = detail {
                let v = d.vehicle
                Form {
                    Section {
                        HStack(spacing: 16) {
                            VehiclePicture(vehicle: v).frame(width: 160, height: 100)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(v.name).font(.title2.bold())
                                if !v.subtitle.isEmpty { Text(v.subtitle).foregroundStyle(.secondary) }
                                Text([v.color, v.plate].compactMap { $0 }.joined(separator: " · ")).font(.footnote).foregroundStyle(.secondary)
                                Text(v.teamKind == "personal" ? "Your vehicle" : "Managed by \(v.teamName ?? "a team")").font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                    Section("Who has it") {
                        if let c = v.checkout {
                            LabeledContent("Checked out", value: c.userId == model.user?.id ? "To you" : c.displayName)
                            if let since = c.since { LabeledContent("Since", value: Format.day(since)) }
                            if c.userId == model.user?.id || d.canAdmin {
                                Button("Return it") { Task { await act("/api/vehicles/\(vehicleId)/return") } }.disabled(busy)
                            }
                        } else {
                            if let a = v.assigned, !a.isEmpty {
                                ForEach(a) { p in
                                    HStack { PersonAvatar(id: p.userId, name: p.displayName, url: p.avatarUrl, size: 28); Text(p.displayName) }
                                }
                            } else {
                                Text("Nobody drives it permanently.").foregroundStyle(.secondary)
                            }
                            if d.canDrive && (v.checkoutPolicy != "admin_only" || d.canAdmin) {
                                Button("Check it out to me") { Task { await act("/api/vehicles/\(vehicleId)/checkout") } }.disabled(busy)
                            } else if v.checkoutPolicy == "admin_only" {
                                Text("A team admin hands this vehicle out.").font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                    Section("History") {
                        if d.history.isEmpty { Text("No history yet.").foregroundStyle(.secondary) }
                        ForEach(d.history) { h in
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(h.displayName) · \(h.kind == "checkout" ? "checked out" : "permanent driver")").font(.body.weight(.semibold))
                                Text("\(Format.day(h.startedAt)) – \(h.endedAt.map { Format.day($0) } ?? "now")").font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                    if let error { Text(error).foregroundStyle(.red) }
                }
                .readableWidth(760)
            } else if let error {
                ContentUnavailableView("Couldn't load the vehicle", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .navigationTitle(detail?.vehicle.name ?? "Vehicle")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        guard let api = model.api else { return }
        do { detail = try await api.get("/api/vehicles/\(vehicleId)") }
        catch { self.error = error.localizedDescription }
    }

    private func act(_ path: String) async {
        guard let api = model.api else { return }
        busy = true
        defer { busy = false }
        do {
            detail = try await api.post(path, Empty())
            error = nil
            onChange()
        } catch { self.error = error.localizedDescription }
    }
}
