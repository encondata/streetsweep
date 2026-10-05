import Foundation
import Observation

/// The Map tab: the team's streets coloured by coverage, its areas (finished ones shaded),
/// and marking streets done by drawing round them.
@MainActor @Observable
final class CoverageWorkspace {
    let map = MapController(mode: .coverage)
    let store = AreasStore()
    private(set) var mark: MarkSession?
    /// The last marking, offered for undo until the next one (or a while passes).
    private(set) var lastMarked: MarkSession.Marked?
    var busy = false
    var error: String?

    private weak var app: AppModel?
    private var api: API? { app?.api }
    private var teamId: String? { app?.team?.id }

    func attach(_ app: AppModel) {
        self.app = app
        map.setPreferences(app.user?.preferences)
    }

    func reload() async {
        guard let api, let teamId else { return }
        map.setTeam(teamId)
        map.setPreferences(app?.user?.preferences)
        await store.load(api, team: teamId)
        map.setAreas(store.areas, colors: store.colors, selected: nil)
    }

    /// Can this person mark streets for the team? (Viewers can't.)
    var canMark: Bool { app?.team.map { $0.role != "viewer" } ?? false }

    // MARK: - Marking by outline

    func startMarking(_ mode: MarkSession.Mode) {
        guard let api, let teamId else { return }
        lastMarked = nil
        let s = MarkSession(teamId: teamId, api: api)
        s.mode = mode
        let render = { [weak self, weak s] in
            guard let self, let s else { return }
            self.map.setMarkPreview(outline: s.mode == .lasso ? s.outline : nil, lines: s.preview?.lines ?? [],
                                    scribbles: s.mode == .scribble ? s.scribbles : [])
        }
        mark = s
        map.startInk(s)
        // The map draws the stroke itself; the outline and preview follow the session.
        let draw = s.onChange
        s.onChange = { draw?(); render() }
    }

    func cancelMarking() {
        map.setMarkPreview(outline: nil, lines: [])
        map.stopInk()
        mark = nil
    }

    func confirmMarking() async {
        guard let s = mark else { return }
        guard let done = await s.confirm() else { return }
        cancelMarking()
        lastMarked = done
        map.reloadStreets()
        await reloadAreas()
        // The offer to undo fades after a while.
        let shown = done
        Task {
            try? await Task.sleep(for: .seconds(30))
            if self.lastMarked == shown { self.lastMarked = nil }
        }
    }

    func undoLast() async {
        guard let m = lastMarked, let api, let teamId else { return }
        busy = true
        defer { busy = false }
        do {
            try await MarkSession.undo(m, team: teamId, api: api)
            lastMarked = nil
            map.reloadStreets()
            await reloadAreas()
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Progress (and finished shading) changes as streets are marked.
    private func reloadAreas() async {
        guard let api, let teamId else { return }
        // Counting is done by the server shortly after a mark; give it a moment.
        try? await Task.sleep(for: .milliseconds(800))
        await store.load(api, team: teamId)
        map.setAreas(store.areas, colors: store.colors, selected: nil)
    }
}
