import CoreLocation
import Foundation
import Observation

/// The Areas screen's state: the team's areas, which one is open, the map, and a drawing
/// in progress. Views read it; the map controller draws it.
@MainActor @Observable
final class Workspace {
    let store = AreasStore()
    let map = MapController(mode: .areas)
    private(set) var openArea: Area?
    private(set) var openCanEdit = false
    private(set) var session: DrawingSession?
    /// A drawing left unsaved last time (the app closed, crashed, or the iPad died).
    private(set) var draft: DrawingSession.Draft? = DrawingSession.Draft.load()
    var busy = false
    var error: String?
    /// What the map shows right now: the list keeps to the areas in it.
    private(set) var view: GeoBounds?
    /// Snap drawings to streets and boundary lines too (the palette's magnet).
    private(set) var snapping = false
    /// Zoomed too far out to fetch the streets to snap to.
    private(set) var streetsTooFar = false

    private weak var app: AppModel?

    init() {
        map.onAreaTap = { [weak self] id in Task { await self?.open(id) } }
        map.onSettle = { [weak self] frame in self?.settled(frame) }
    }

    func attach(_ app: AppModel) { self.app = app }

    private var api: API? { app?.api }
    private var teamId: String? { app?.team?.id }

    // MARK: - Areas

    func reload() async {
        guard let api, let teamId else { return }
        await store.load(api, team: teamId)
        redrawAreas()
    }

    private func redrawAreas() {
        // An area opened from search that the team doesn't follow yet still shows its outline.
        var shown = store.areas
        if let a = openArea, store.area(a.id) == nil, a.geometry != nil { shown.append(a) }
        map.setAreas(shown, colors: store.colors, selected: openArea?.id)
    }

    func open(_ id: String, fit: Bool = true) async {
        guard session == nil, let api else { return }
        if let known = store.area(id) {
            openArea = known
            openCanEdit = store.canEdit && known.isDrawn
            redrawAreas()
            if fit { map.fit(known.geometry, bbox: known.bbox) }
        }
        do {
            let d: AreaDetail = try await api.get("/api/areas/\(id)")
            // Progress comes with the team's list, not the single area: keep what the list had.
            var a = d.area
            if let known = store.area(id), a.totalM == nil { a = known.merging(detail: a) }
            openArea = a
            openCanEdit = d.canEdit
            redrawAreas()
            if fit && store.area(id) == nil { map.fit(a.geometry, bbox: a.bbox) }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func close() {
        openArea = nil
        redrawAreas()
    }

    func follow(_ area: Area) async {
        guard let api, let teamId else { return }
        busy = true
        defer { busy = false }
        do {
            let _: Empty = try await api.post("/api/teams/\(teamId)/follows", ["area_id": area.id])
        } catch let e as APIError where e.status == 409 {
            // Followed already (a tap that went through before): that's what was wanted.
        } catch {
            self.error = error.localizedDescription
            return
        }
        // Show it as followed straight away; the full list (with progress) catches up.
        store.insert(area)
        redrawAreas()
        await reload()
        if openArea?.id == area.id { await open(area.id, fit: false) }
    }

    func unfollow(_ area: Area) async {
        guard let api, let teamId else { return }
        busy = true
        defer { busy = false }
        do {
            try await api.delete("/api/teams/\(teamId)/follows/\(area.id)")
        } catch let e as APIError where e.status == 404 {
            // Not followed any more already: that's what was wanted.
        } catch {
            self.error = error.localizedDescription
            return
        }
        close()
        await reload()
    }

    func save(_ area: Area, name: String, level: AreaLevel, notes: String) async -> Bool {
        guard let api else { return false }
        let body = AreaPatch(name: name.trimmingCharacters(in: .whitespaces), level: level.rawValue, notes: notes.isEmpty ? nil : notes, geometry: nil)
        let ok = await run { let _: Empty = try await api.patch("/api/areas/\(area.id)", body) }
        if ok { await reload(); await open(area.id, fit: false) }
        return ok
    }

    func delete(_ area: Area) async {
        guard let api else { return }
        if await run({ try await api.delete("/api/areas/\(area.id)") }) {
            close()
            await reload()
        }
    }

    func searchBoundaries(_ q: String) async -> [Area] {
        guard let api, q.count >= 2 else { return [] }
        let enc = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q
        return (try? await api.get("/api/areas/search?q=\(enc)", as: AreaSearch.self).areas) ?? []
    }

    func geocode(_ q: String) async -> [Address] {
        guard let api else { return [] }
        let enc = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q
        var path = "/api/geocode?q=\(enc)"
        if let f = map.frame() {
            path += "&near=\((f.view.west + f.view.east) / 2),\((f.view.south + f.view.north) / 2)"
        }
        do { return try await api.get(path, as: Geocode.self).results }
        catch { self.error = error.localizedDescription; return [] }
    }

    func show(_ address: Address) {
        map.setSearchPin(CLLocationCoordinate2D(latitude: address.lat, longitude: address.lon))
        map.fit(nil, bbox: address.bbox ?? [address.lon - 0.004, address.lat - 0.003, address.lon + 0.004, address.lat + 0.003])
    }

    // MARK: - Drawing

    /// Start drawing a new area, redrawing `area`, or carrying on with the saved draft.
    func startDrawing(_ area: Area?, from draft: DrawingSession.Draft? = nil) {
        guard let teamId = draft?.teamId ?? teamId else { return }
        if draft == nil { DrawingSession.Draft.clear(); self.draft = nil }
        let neighbours = store.areas.filter { $0.id != area?.id }.flatMap { $0.geometry?.pieces ?? [] }
        let s = DrawingSession(teamId: teamId, area: area, neighbours: neighbours, draft: draft)
        s.snapping = snapping
        session = s
        map.startDrawing(s)
        if draft != nil, let o = s.outline { map.fit(o) }
        if let f = map.frame() { loadShores(f); loadSnapLines(f) }
    }

    func resumeDraft() async {
        guard let d = draft else { return }
        if d.teamId != teamId, app?.teams.contains(where: { $0.id == d.teamId }) == true {
            app?.teamId = d.teamId
            await reload()
        }
        startDrawing(d.areaId.flatMap { store.area($0) }, from: d)
    }

    func discardDraft() {
        DrawingSession.Draft.clear()
        draft = nil
    }

    func cancelDrawing() {
        session?.discardDraft()
        let redrawn = session?.area
        endDrawing()
        if let redrawn { Task { await open(redrawn.id, fit: false) } }
    }

    private func endDrawing() {
        map.setSnapLines([])
        snapTask?.cancel()
        map.stopDrawing()
        session = nil
        draft = nil
        shoreTask?.cancel()
    }

    /// Save the drawing as a new area, or as the area's new outline.
    func saveDrawing() async {
        guard let s = session, let api else { return }
        session?.closeInProgress()
        guard let outline = s.outline else {
            error = "Draw the outline first."
            return
        }
        let name = s.name.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else {
            error = "Give the area a name."
            return
        }
        var id = s.area?.id
        let ok = await run {
            let body = AreaPatch(name: name, level: s.level.rawValue, notes: nil, geometry: outline)
            if let existing = s.area {
                let _: Empty = try await api.patch("/api/areas/\(existing.id)", body.withoutNotes)
            } else {
                let made: Created = try await api.post("/api/teams/\(s.teamId)/areas", body.withoutNotes)
                id = made.id
            }
        }
        guard ok else { return }
        s.discardDraft()
        endDrawing()
        await reload()
        if let id { await open(id, fit: false) }
    }

    /// Cut mapped water out of the outline, keeping the land as drawn. Undo puts it back.
    func trimWater() async {
        guard let s = session, let api, let outline = s.outline else {
            error = "Draw the outline first, running it out into the water; then trim to the shoreline."
            return
        }
        busy = true
        defer { busy = false }
        do {
            let r: Trimmed = try await api.post("/api/water/trim", ["geometry": outline])
            guard let g = r.geometry else { s.note = r.note ?? "Nothing to trim."; return }
            s.replaceAll(g.pieces)
            let acres = r.removedM2 / 4046.86
            s.note = "Trimmed \(acres < 10 ? String(format: "%.1f", acres) : Int(acres.rounded()).formatted()) acres of water. Undo puts it back."
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: - Shorelines, for snapping while drawing

    private var shoreTask: Task<Void, Never>?

    private func settled(_ frame: MapFrame) {
        view = GeoBounds(south: frame.view.south, west: frame.view.west, north: frame.view.north, east: frame.view.east)
        guard session != nil else { return }
        loadShores(frame)
        loadSnapLines(frame)
    }

    func setSnapping(_ on: Bool) {
        snapping = on
        session?.snapping = on
        if on, session != nil, let f = map.frame() { loadSnapLines(f) }
        if !on { map.setSnapLines([]) }
    }

    // MARK: - Streets and boundary lines, for Snap

    private var snapTask: Task<Void, Never>?

    private func loadSnapLines(_ f: MapFrame) {
        guard snapping, let api else { return }
        snapTask?.cancel()
        let w = f.view.west, s = f.view.south, e = f.view.east, n = f.view.north
        let bbox = [w, s, e, n].map { String(format: "%.5f", $0) }.joined(separator: ",")
        let streetsFit = e - w <= 0.2 && n - s <= 0.2
        streetsTooFar = !streetsFit
        snapTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            async let bounds = try? api.get("/api/areas/lines?bbox=\(bbox)", as: Shores.self)
            async let streets: [SnapLine]? = streetsFit ? Self.streetLines(api, box: bbox) : []
            let (b, st) = await (bounds, streets)
            guard !Task.isCancelled, let session = self?.session else { return }
            if let b {
                let rings = b.lines.map { $0.map { CLLocationCoordinate2D(latitude: $0[1], longitude: $0[0]) } }
                session.boundaries = rings.map { SnapLine($0, closed: false) }
                self?.map.setSnapLines(rings)
            }
            if let st { session.streets = st }
        }
    }

    /// The street pieces in a box (`/api/segments`, as the phone uses), as lines to snap to.
    private static func streetLines(_ api: API, box bbox: String) async -> [SnapLine]? {
        guard let data = try? await api.raw("/api/segments?bbox=\(bbox)"),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let segs = obj["segments"] as? [[Any]] else { return nil }
        return segs.compactMap { row in
            guard let line = row.last as? String else { return nil }
            let pts = Polyline.decode(line)
            return pts.count >= 2 ? SnapLine(pts, closed: false, endsOnly: true) : nil
        }
    }

    private func loadShores(_ f: MapFrame) {
        guard let api else { return }
        shoreTask?.cancel()
        shoreTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            let bbox = [f.view.west, f.view.south, f.view.east, f.view.north].map { String(format: "%.5f", $0) }.joined(separator: ",")
            guard let r = try? await api.get("/api/water/shores?bbox=\(bbox)", as: Shores.self), !Task.isCancelled else { return }
            self?.session?.shores = r.lines.map { line in
                SnapLine(line.map { CLLocationCoordinate2D(latitude: $0[1], longitude: $0[0]) }, closed: false)
            }
        }
    }

    // MARK: -

    /// Runs a server call, keeping its error for the screen. True if it worked.
    @discardableResult
    private func run(_ work: () async throws -> Void) async -> Bool {
        busy = true
        defer { busy = false }
        do {
            try await work()
            error = nil
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
}

private struct AreaPatch: Encodable {
    let name: String
    let level: String
    let notes: String?
    let geometry: Outline?
    var withoutNotes: AreaPatchNoNotes { AreaPatchNoNotes(name: name, level: level, geometry: geometry) }

    // `notes: null` clears notes, so it's always sent from the edit form.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(level, forKey: .level)
        try c.encode(notes, forKey: .notes)
        try c.encodeIfPresent(geometry, forKey: .geometry)
    }
    private enum CodingKeys: String, CodingKey { case name, level, notes, geometry }
}

private struct AreaPatchNoNotes: Encodable {
    let name: String
    let level: String
    let geometry: Outline?
}

private struct Created: Decodable { let id: String }
private struct Trimmed: Decodable { let geometry: Outline?; let removedM2: Double; let note: String? }
private struct Shores: Decodable { let lines: [[[Double]]] }

extension Area {
    /// A single area's details, keeping the progress figures the team's list had.
    func merging(detail d: Area) -> Area {
        var a = self
        a.name = d.name
        a.level = d.level
        a.notes = d.notes
        a.teamName = d.teamName
        if let g = d.geometry { a.geometry = g }
        return a
    }
}
