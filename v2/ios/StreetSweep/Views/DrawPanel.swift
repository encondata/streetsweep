import SwiftUI

/// The sidebar while drawing: what the tool does, the name and kind, trimming, and saving.
struct DrawPanel: View {
    @Bindable var session: DrawingSession
    @Binding var fingerDraws: Bool
    @Environment(Workspace.self) private var ws
    @State private var confirmCancel = false

    var body: some View {
        Form {
            Section {
                Label(session.tool.label, systemImage: session.tool.symbol).font(.headline)
                Text(session.tool.hint).font(.callout).foregroundStyle(.secondary)
                if let note = session.note {
                    Text(note).font(.callout).foregroundStyle(.orange)
                }
                if session.snapping {
                    Text(ws.streetsTooFar
                         ? "Snap is on: zoom in closer to snap to streets too. City, county and state lines snap at any zoom."
                         : "Snap is on: points land on intersections, streets and city, county and state lines; lasso edges straighten and near-right angles square up.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } footer: {
                Text("Fingers move the map. Two-finger tap undoes, three-finger tap redoes. Double-tap or squeeze the Pencil to switch back to the last tool.")
            }

            Section("Area") {
                TextField("Name, e.g. Old Town", text: $session.name)
                    .textInputAutocapitalization(.words)
                Picker("Kind", selection: $session.level) {
                    ForEach(AreaLevel.drawable, id: \.self) { Text($0.label).tag($0) }
                }
                LabeledContent("Pieces", value: "\(session.pieces.count)")
                if session.cornerCount > 0 { LabeledContent("Corners", value: "\(session.cornerCount)") }
            }

            Section {
                Button {
                    Task { await ws.tidy() }
                } label: {
                    HStack {
                        Label("Tidy round the streets", systemImage: "wand.and.stars")
                        if ws.busy { Spacer(); ProgressView() }
                    }
                }
                .disabled(ws.busy || session.pieces.isEmpty && session.inProgress.count < 3)
            } footer: {
                Text("Draw roughly round a neighbourhood, then tidy: the outline wraps the streets inside 10 m out, or halfway to the next street outside where that's closer, so neighbours meet on one line.")
            }

            Section {
                Button {
                    Task { await ws.trimWater() }
                } label: {
                    HStack {
                        Label("Trim to shoreline", systemImage: "water.waves")
                        if ws.busy { Spacer(); ProgressView() }
                    }
                }
                .disabled(ws.busy || session.pieces.isEmpty)
            } footer: {
                Text("Draw out into the water, then trim: mapped lakes, ponds and rivers are cut off and the land stays as drawn.")
            }

            Section {
                Toggle("Draw with finger", isOn: $fingerDraws)
            } footer: {
                Text("For drawing without a Pencil. One finger draws; move the map with two.")
            }

            Section {
                Button {
                    Task { await ws.saveDrawing() }
                } label: {
                    Text(session.area == nil ? "Save area" : "Save outline").bold().frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(ws.busy || session.pieces.isEmpty && session.inProgress.count < 3)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            } footer: {
                Text(session.dirty ? "Kept on this iPad as you draw, until you save or cancel." : " ")
            }
        }
        .navigationTitle(session.area.map { "Redraw \($0.name)" } ?? "Draw an area")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") {
                    if session.dirty { confirmCancel = true } else { ws.cancelDrawing() }
                }
            }
        }
        .confirmationDialog("Discard this drawing? Your changes won't be kept.", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("Discard drawing", role: .destructive) { ws.cancelDrawing() }
            Button("Keep drawing", role: .cancel) {}
        }
    }
}

/// The floating tools over the map: Lasso, Corners, Edit, Eraser, then Snap, undo and redo.
struct ToolPalette: View {
    @Bindable var session: DrawingSession
    @Binding var snap: Bool

    var body: some View {
        HStack(spacing: 6) {
            ForEach(DrawingSession.Tool.allCases) { tool in
                Button { session.tool = tool } label: {
                    VStack(spacing: 3) {
                        Image(systemName: tool.symbol).font(.system(size: 22, weight: .medium))
                        Text(tool.label).font(.caption2.weight(.semibold))
                    }
                    .frame(width: 68, height: 56)
                    .foregroundStyle(session.tool == tool ? Color.white : Color.primary)
                    .background(session.tool == tool ? Color.brand : Color.clear, in: RoundedRectangle(cornerRadius: 14))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(session.tool == tool ? .isSelected : [])
            }
            Divider().frame(height: 40).padding(.horizontal, 4)
            Button { snap.toggle() } label: {
                VStack(spacing: 3) {
                    Image(systemName: "scope").font(.system(size: 22, weight: .medium))
                    Text("Snap").font(.caption2.weight(.semibold))
                }
                .frame(width: 60, height: 56)
                .foregroundStyle(snap ? Color.white : Color.primary)
                .background(snap ? Color.orange : Color.clear, in: RoundedRectangle(cornerRadius: 14))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Snap to streets and boundaries")
            .accessibilityAddTraits(snap ? .isSelected : [])
            iconButton("arrow.uturn.backward", "Undo", enabled: session.canUndo) { session.undo() }
            iconButton("arrow.uturn.forward", "Redo", enabled: session.canRedo) { session.redo() }
            if session.tool == .corners && session.inProgress.count >= 3 {
                iconButton("checkmark.circle.fill", "Close shape", enabled: true) { session.closeInProgress() }
            }
            if session.selected != nil {
                iconButton("trash", "Delete piece", enabled: true, role: .destructive) { session.deleteSelected() }
            }
        }
        .padding(8)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22))
        .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
    }

    private func iconButton(_ symbol: String, _ label: String, enabled: Bool, role: ButtonRole? = nil, action: @escaping () -> Void) -> some View {
        Button(role: role, action: action) {
            Image(systemName: symbol)
                .font(.system(size: 22, weight: .medium))
                .frame(width: 52, height: 56)
                .foregroundStyle(role == .destructive ? Color.red : Color.primary)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.35)
        .accessibilityLabel(label)
    }
}
