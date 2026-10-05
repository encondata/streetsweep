import PhotosUI
import SwiftUI

/// Places: spots worth remembering (a gate code, a dead end, low branches), yours and the
/// ones shared with your teams. Add one from the Map tab or here.
struct PlacesView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.goToSection) private var goTo
    @Environment(CoverageWorkspace.self) private var cw
    @State private var places: [Place] = []
    @State private var loading = true
    @State private var error: String?
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                if let error { Text(error).foregroundStyle(.red) }
                let mine = filtered.filter(\.mine), shared = filtered.filter { !$0.mine }
                if !mine.isEmpty { Section("Yours") { ForEach(mine) { row($0) } } }
                if !shared.isEmpty { Section("Shared with you") { ForEach(shared) { row($0) } } }
            }
            .readableWidth()
            .searchable(text: $query, prompt: "Find a place")
            .overlay {
                if places.isEmpty && !loading {
                    ContentUnavailableView {
                        Label("No places yet", systemImage: "mappin.and.ellipse")
                    } description: {
                        Text("Mark a spot worth remembering: a gate, a dead end, low branches.")
                    } actions: {
                        Button("Add a place") { addPlace() }.buttonStyle(.borderedProminent)
                    }
                }
            }
            .navigationTitle("Places")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { addPlace() } label: { Label("Add place", systemImage: "plus") }
                }
            }
            .navigationDestination(for: Place.self) { PlaceDetailView(placeId: $0.id) { Task { await load() } } }
            .refreshable { await load() }
            .task { await load() }
            .contentMargins(.bottom, 90, for: .scrollContent)
        }
    }

    private var filtered: [Place] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return q.isEmpty ? places : places.filter { $0.name.lowercased().contains(q) || ($0.note ?? "").lowercased().contains(q) }
    }

    private func row(_ p: Place) -> some View {
        NavigationLink(value: p) {
            HStack(spacing: 12) {
                RemoteImage(path: p.photos.first.map { "/api/places/\(p.id)/photos/\($0.id)" }) {
                    Image(systemName: "mappin.circle.fill").font(.title).foregroundStyle(Color(red: 0.761, green: 0.094, blue: 0.357))
                }
                .frame(width: 48, height: 48)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 3) {
                    Text(p.name).font(.body.weight(.semibold))
                    Text([p.note, p.mine ? nil : p.userName.map { "From \($0)" }].compactMap { $0 }.joined(separator: " · "))
                        .font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }
    }

    private func addPlace() {
        goTo(.map)
        cw.startAddingPlace()
    }

    private func load() async {
        guard let api = model.api else { return }
        defer { loading = false }
        do {
            places = (try await api.get("/api/places", as: PlaceList.self)).places
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct PlaceList: Decodable, Sendable { let places: [Place] }
struct PlaceOne: Decodable, Sendable { let place: Place }

/// One place: where it is, its photos, its note, and who it's shared with. Only the person
/// who marked it can change it.
struct PlaceDetailView: View {
    let placeId: String
    var onChange: () -> Void = {}
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var place: Place?
    @State private var name = ""
    @State private var note = ""
    @State private var picks: [PhotosPickerItem] = []
    @State private var busy = false
    @State private var error: String?
    @State private var confirmDelete = false
    @State private var bigPhoto: PlacePhoto?

    var body: some View {
        Group {
            if let p = place {
                HStack(alignment: .top, spacing: 0) {
                    MiniMap(pin: CLLocationCoordinate2D(latitude: p.lat, longitude: p.lon))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    Form {
                        Section("Place") {
                            if p.mine {
                                TextField("Name", text: $name).font(.headline)
                                TextField("Note, e.g. gate code 1234", text: $note, axis: .vertical).lineLimit(2...6)
                                if name != p.name || note != (p.note ?? "") {
                                    Button("Save changes") { Task { await save() } }.disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
                                }
                            } else {
                                Text(p.name).font(.headline)
                                if let n = p.note { Text(n) }
                                if let u = p.userName { LabeledContent("Marked by", value: u) }
                            }
                            LabeledContent("Added", value: Format.day(p.createdAt))
                        }
                        Section("Photos") {
                            if p.photos.isEmpty && !p.mine { Text("No photos.").foregroundStyle(.secondary) }
                            if !p.photos.isEmpty {
                                ScrollView(.horizontal, showsIndicators: false) {
                                    HStack(spacing: 8) {
                                        ForEach(p.photos) { ph in
                                            RemoteImage(path: "/api/places/\(p.id)/photos/\(ph.id)") { Color(.tertiarySystemFill) }
                                                .frame(width: 110, height: 110)
                                                .clipShape(RoundedRectangle(cornerRadius: 10))
                                                .onTapGesture { bigPhoto = ph }
                                                .contextMenu {
                                                    if p.mine { Button("Delete photo", role: .destructive) { Task { await deletePhoto(ph) } } }
                                                }
                                        }
                                    }
                                }
                            }
                            if p.mine && p.photos.count < 6 {
                                PhotosPicker(selection: $picks, maxSelectionCount: 6 - p.photos.count, matching: .images) {
                                    Label("Add photos", systemImage: "photo.on.rectangle.angled")
                                }
                                .disabled(busy)
                            }
                        }
                        if p.mine {
                            Section {
                                ForEach(model.teams.filter { !$0.isPersonal }) { t in
                                    Toggle(t.name, isOn: Binding(get: { p.sharedWith.contains { $0.id == t.id } },
                                                                 set: { on in Task { await share(t.id, on) } }))
                                }
                                if model.teams.allSatisfy(\.isPersonal) { Text("Join a team to share places with it.").foregroundStyle(.secondary) }
                            } header: {
                                Text("Shared with")
                            } footer: {
                                Text("Everyone in a team you share with can see this place.")
                            }
                            Section {
                                Button("Delete place", role: .destructive) { confirmDelete = true }.disabled(busy)
                            }
                        } else if !p.sharedWith.isEmpty {
                            Section("Shared with") { ForEach(p.sharedWith) { Text($0.name) } }
                        }
                        if let error { Text(error).foregroundStyle(.red) }
                    }
                    .frame(width: 400)
                }
            } else if let error {
                ContentUnavailableView("Couldn't load the place", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .navigationTitle(place?.name ?? "Place")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onChange(of: picks) { _, items in
            guard !items.isEmpty else { return }
            Task { await upload(items) }
        }
        .confirmationDialog("Delete this place? This can't be undone.", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete place", role: .destructive) { Task { await delete() } }
        }
        .sheet(item: $bigPhoto) { ph in
            RemoteImage(path: "/api/places/\(placeId)/photos/\(ph.id)", contentMode: .fit) { ProgressView() }
                .padding()
                .presentationDetents([.large])
        }
    }

    private func apply(_ p: Place) {
        place = p
        name = p.name
        note = p.note ?? ""
    }

    private func load() async {
        guard let api = model.api else { return }
        do { apply(try await api.get("/api/places/\(placeId)", as: PlaceOne.self).place) }
        catch { self.error = error.localizedDescription }
    }

    private func run(_ work: (API) async throws -> Void) async {
        guard let api = model.api else { return }
        busy = true
        defer { busy = false }
        do {
            try await work(api)
            error = nil
            onChange()
        } catch { self.error = error.localizedDescription }
    }

    private func save() async {
        await run { api in
            let body = PlaceBody(name: name.trimmingCharacters(in: .whitespaces), note: .some(note.isEmpty ? nil : note))
            apply(try await api.patch("/api/places/\(placeId)", body, as: PlaceOne.self).place)
        }
    }

    private func share(_ team: String, _ on: Bool) async {
        guard let p = place else { return }
        var ids = p.sharedWith.map(\.id).filter { $0 != team }
        if on { ids.append(team) }
        await run { api in apply(try await api.patch("/api/places/\(placeId)", PlaceBody(teamIds: ids), as: PlaceOne.self).place) }
    }

    private func upload(_ items: [PhotosPickerItem]) async {
        await run { api in
            for item in items {
                guard let data = try await item.loadTransferable(type: Data.self), let (jpeg, w, h) = PhotoPrep.jpeg(data) else {
                    throw APIError(status: 0, message: "Couldn't read that photo.", code: nil)
                }
                apply(try await api.upload("/api/places/\(placeId)/photos?w=\(w)&h=\(h)", data: jpeg, contentType: "image/jpeg", as: PlaceOne.self).place)
            }
        }
        picks = []
    }

    private func deletePhoto(_ ph: PlacePhoto) async {
        await run { api in
            try await api.delete("/api/places/\(placeId)/photos/\(ph.id)")
            await load()
        }
    }

    private func delete() async {
        await run { api in try await api.delete("/api/places/\(placeId)") }
        if error == nil { dismiss() }
    }
}

/// Photos go up as JPEG, at most 2000 points on the long side (the server takes up to 6 MB).
enum PhotoPrep {
    static func jpeg(_ data: Data) -> (Data, Int, Int)? {
        guard let img = UIImage(data: data) else { return nil }
        let long = max(img.size.width, img.size.height)
        let scale = min(1, 2000 / max(long, 1))
        let size = CGSize(width: (img.size.width * scale).rounded(), height: (img.size.height * scale).rounded())
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1
        let out = UIGraphicsImageRenderer(size: size, format: fmt).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
        guard let jpeg = out.jpegData(compressionQuality: 0.82) else { return nil }
        return (jpeg, Int(size.width), Int(size.height))
    }
}

/// Adding a place on the Map tab: a pin fixed in the middle of the map (move the map to put
/// it on the spot), and this card for the name, note, sharing and photos.
struct AddPlaceCard: View {
    @Environment(AppModel.self) private var model
    @Environment(CoverageWorkspace.self) private var cw
    @State private var name = ""
    @State private var note = ""
    @State private var shareTo: Set<String> = []
    @State private var picks: [PhotosPickerItem] = []
    @State private var photos: [Data] = []
    @State private var busy = false
    @State private var error: String?
    @FocusState private var nameFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("Add a place", systemImage: "mappin.and.ellipse").font(.headline)
                Spacer()
                Text("Move the map to put the pin on the spot.").font(.subheadline).foregroundStyle(.secondary)
            }
            HStack(spacing: 10) {
                TextField("Name, e.g. Locked gate", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .focused($nameFocused)
                TextField("Note (optional)", text: $note)
                    .textFieldStyle(.roundedBorder)
            }
            HStack(spacing: 10) {
                let shared = model.teams.filter { !$0.isPersonal }
                if !shared.isEmpty {
                    Menu {
                        ForEach(shared) { t in
                            Button { if shareTo.contains(t.id) { shareTo.remove(t.id) } else { shareTo.insert(t.id) } } label: {
                                Label(t.name, systemImage: shareTo.contains(t.id) ? "checkmark.circle.fill" : "circle")
                            }
                        }
                    } label: {
                        Label(shareTo.isEmpty ? "Just me" : "Shared with \(shareTo.count) team\(shareTo.count == 1 ? "" : "s")", systemImage: "person.2")
                    }
                    .buttonStyle(.bordered)
                }
                PhotosPicker(selection: $picks, maxSelectionCount: 6, matching: .images) {
                    Label(photos.isEmpty ? "Photos" : "\(photos.count) photo\(photos.count == 1 ? "" : "s")", systemImage: "photo")
                }
                .buttonStyle(.bordered)
                Spacer()
                if let error { Text(error).font(.footnote).foregroundStyle(.red).lineLimit(2) }
                Button("Cancel") { cw.stopAddingPlace() }.buttonStyle(.bordered)
                Button {
                    Task { await save() }
                } label: {
                    if busy { ProgressView() } else { Text("Save place").bold() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .controlSize(.large)
        }
        .padding(16)
        .frame(width: 720)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22))
        .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
        .onAppear {
            nameFocused = true
            if let t = model.team, !t.isPersonal { shareTo = [t.id] }
        }
        .onChange(of: picks) { _, items in
            Task {
                var out: [Data] = []
                for i in items { if let d = try? await i.loadTransferable(type: Data.self) { out.append(d) } }
                photos = out
            }
        }
    }

    private func save() async {
        guard let api = model.api, let at = cw.map.centerCoordinate else { return }
        busy = true
        defer { busy = false }
        do {
            let body = PlaceBody(id: UUID().uuidString.lowercased(), name: name.trimmingCharacters(in: .whitespaces),
                                 note: .some(note.isEmpty ? nil : note), lon: at.longitude, lat: at.latitude, teamIds: Array(shareTo))
            let made: PlaceOne = try await api.post("/api/places", body)
            for d in photos {
                guard let (jpeg, w, h) = PhotoPrep.jpeg(d) else { continue }
                let _: PlaceOne = try await api.upload("/api/places/\(made.place.id)/photos?w=\(w)&h=\(h)", data: jpeg, contentType: "image/jpeg")
            }
            cw.placeAdded(made.place)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: - Switching sections from inside one

private struct GoToSectionKey: EnvironmentKey {
    static let defaultValue: (AppSection) -> Void = { _ in }
}

extension EnvironmentValues {
    /// Switch the app to another section (the bottom bar's job, for a button elsewhere).
    var goToSection: (AppSection) -> Void {
        get { self[GoToSectionKey.self] }
        set { self[GoToSectionKey.self] = newValue }
    }
}
