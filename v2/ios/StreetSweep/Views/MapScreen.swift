import SwiftUI

/// The Map tab: the team's streets in your colours (driven, still to do, left out), its
/// areas with finished ones shaded, and "Mark by outline": draw round streets with the
/// Pencil to mark them done.
struct MapScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(CoverageWorkspace.self) private var cw
    @AppStorage("map.base") private var base: Basemap = .map
    @AppStorage("draw.finger") private var fingerDraws = false
    @AppStorage("mark.mode") private var markMode: MarkSession.Mode = .scribble

    var body: some View {
        @Bindable var model = model
        ZStack(alignment: .topLeading) {
            if let server = model.server, let token = model.token {
                MapView(controller: cw.map, server: server, token: token)
                    .ignoresSafeArea()
            }

            // The team, and what the colours mean.
            VStack(alignment: .leading, spacing: 10) {
                Picker("Team", selection: $model.teamId) {
                    ForEach(model.teams) { Text($0.label).tag(Optional($0.id)) }
                }
                .pickerStyle(.menu)
                .font(.headline)
                HStack(spacing: 14) {
                    legend(colors.driven.color, "Driven or done")
                    legend(colors.undriven.color, "To do")
                    legend("#9aa7b4", "Left out")
                }
                .font(.caption)
            }
            .padding(12)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
            .padding(16)
        }
        .overlay(alignment: .topTrailing) {
            Picker("Basemap", selection: $base) {
                ForEach(Basemap.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .frame(width: 260)
            .padding(6)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            .padding(16)
        }
        .overlay(alignment: .bottomTrailing) {
            if cw.mark == nil && cw.canMark {
                Button { cw.startMarking(markMode) } label: {
                    Label("Mark streets", systemImage: markMode == .scribble ? "scribble" : "lasso")
                        .font(.headline)
                        .padding(.horizontal, 18)
                        .frame(height: 50)
                        .background(Color.brand, in: Capsule())
                        .foregroundStyle(.white)
                        .shadow(color: .black.opacity(0.2), radius: 8, y: 3)
                }
                .buttonStyle(.plain)
                .padding(.trailing, 20)
                .padding(.bottom, 92)
            }
        }
        .overlay(alignment: .bottom) {
            if let s = cw.mark {
                MarkPanel(session: s, fingerDraws: $fingerDraws, mode: $markMode)
                    .padding(.bottom, 20)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            } else if let m = cw.lastMarked {
                UndoToast(marked: m)
                    .padding(.bottom, 92)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.spring(duration: 0.3), value: cw.mark == nil)
        .animation(.spring(duration: 0.3), value: cw.lastMarked)
        .onAppear {
            cw.map.base = base
            cw.map.fingerDraws = fingerDraws
        }
        .onChange(of: base) { _, b in cw.map.base = b }
        .onChange(of: fingerDraws) { _, on in cw.map.fingerDraws = on }
        .onChange(of: model.user?.preferences) { _, p in cw.map.setPreferences(p) }
    }

    private var colors: MapColors { model.user?.preferences?.mapColors ?? .standard }

    private func legend(_ hex: String, _ label: String) -> some View {
        HStack(spacing: 5) {
            Capsule().fill(Color(hex: hex)).frame(width: 18, height: 5)
            Text(label).foregroundStyle(.secondary)
        }
    }
}

/// While marking by outline: what to do, then what will be marked, and the buttons.
struct MarkPanel: View {
    let session: MarkSession
    @Binding var fingerDraws: Bool
    @Binding var mode: MarkSession.Mode
    @Environment(CoverageWorkspace.self) private var cw

    var body: some View {
        HStack(spacing: 16) {
            Picker("How", selection: $mode) {
                Label("Scribble", systemImage: "scribble").tag(MarkSession.Mode.scribble)
                Label("Lasso", systemImage: "lasso").tag(MarkSession.Mode.lasso)
            }
            .pickerStyle(.segmented)
            .frame(width: 200)
            .onChange(of: mode) { _, m in session.mode = m }
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.headline)
                Text(detail).font(.subheadline).foregroundStyle(session.error != nil ? .red : .secondary)
            }
            .frame(minWidth: 320, alignment: .leading)

            if session.loading { ProgressView() }

            Spacer(minLength: 8)

            Toggle(isOn: $fingerDraws) { Image(systemName: "hand.draw") }
                .toggleStyle(.button)
                .accessibilityLabel("Draw with finger")
                .help("Draw with finger")
            if session.mode == .scribble && session.scribbles.count > 0 {
                Button { session.undo() } label: { Image(systemName: "arrow.uturn.backward") }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                    .accessibilityLabel("Undo the last scribble")
            }
            if session.hasDrawing {
                Button(session.mode == .scribble ? "Clear" : "Redraw") { session.clear() }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
            }
            Button("Cancel") { cw.cancelMarking() }
                .buttonStyle(.bordered)
                .controlSize(.large)
            if let p = session.preview, p.pieces > 0 {
                Button {
                    Task { await cw.confirmMarking() }
                } label: {
                    Text("Mark done").bold()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(session.loading)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .frame(maxWidth: 980)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22))
        .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
    }

    private var title: String {
        if let p = session.preview {
            if p.pieces == 0 { return "Nothing to mark here" }
            return "\(p.streets) street\(p.streets == 1 ? "" : "s") · \(Format.miles(Double(p.meters)))"
        }
        if session.hasDrawing { return "Finding the streets…" }
        return session.mode == .scribble ? "Scribble over streets" : "Draw round streets"
    }

    private var detail: String {
        if let e = session.error { return e }
        if let p = session.preview {
            return p.pieces == 0
                ? "Every street inside is already driven or marked. Draw somewhere else, or cancel."
                : session.mode == .scribble
                    ? "Flashing streets will be marked done. Keep scribbling to add more; two-finger tap undoes the last stroke."
                    : "Flashing streets will be marked done. Streets already driven or marked stay as they are."
        }
        if session.hasDrawing { return " " }
        return session.mode == .scribble
            ? "Scribble along or back and forth over streets with the Pencil, as many strokes as you like. Fingers move the map."
            : "Draw round the streets with the Pencil and lift to finish. Fingers move the map."
    }
}

/// "Marked 12 streets done · Undo", for a little while after marking.
struct UndoToast: View {
    let marked: MarkSession.Marked
    @Environment(CoverageWorkspace.self) private var cw

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.brand).font(.title3)
            Text("Marked \(marked.streets) street\(marked.streets == 1 ? "" : "s") done · \(Format.miles(Double(marked.meters)))")
                .font(.headline)
            Button("Undo") { Task { await cw.undoLast() } }
                .buttonStyle(.bordered)
                .disabled(cw.busy)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(.regularMaterial, in: Capsule())
        .shadow(color: .black.opacity(0.15), radius: 10, y: 3)
    }
}
