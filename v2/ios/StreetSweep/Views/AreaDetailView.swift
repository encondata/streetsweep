import SwiftUI

/// One area: how much is swept, its details, and what can be done with it.
struct AreaDetailView: View {
    let area: Area
    @Environment(AppModel.self) private var model
    @Environment(Workspace.self) private var ws
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var confirmUnfollow = false

    private var following: Bool { ws.store.area(area.id) != nil }
    private var mine: Bool { area.isDrawn && area.teamId == model.team?.id }

    var body: some View {
        List {
            Section {
                HStack(alignment: .top, spacing: 12) {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(ws.store.color(area.id))
                        .frame(width: 22, height: 22)
                        .padding(.top, 4)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(area.name).font(.title2.bold())
                        Text(area.kindLabel).foregroundStyle(.secondary)
                        if area.isDrawn, !mine, let t = area.teamName {
                            Text("Drawn by \(t)").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(.vertical, 4)
            }

            if let p = area.progress {
                Section("Swept") {
                    HStack {
                        ProgressView(value: p).tint(ws.store.color(area.id)).scaleEffect(y: 1.6)
                        Text(Format.percent(p)).font(.headline).monospacedDigit()
                    }
                    if let d = area.drivenStreets, let t = area.totalStreets {
                        LabeledContent("Streets", value: "\(d.formatted()) of \(t.formatted())")
                    }
                    LabeledContent("Distance", value: "\(Format.miles(area.drivenM ?? 0)) of \(Format.miles(area.totalM ?? 0))")
                }
            }

            Section("Details") {
                LabeledContent("Streets", value: area.statusLabel)
                if let km2 = area.km2 { LabeledContent("Size", value: Format.size(km2)) }
                if let n = area.notes, !n.isEmpty {
                    Text(n).font(.callout)
                }
            }

            Section {
                if area.isDrawn {
                    if ws.openCanEdit {
                        Button { editing = true } label: { Label("Edit name, kind and notes", systemImage: "pencil") }
                        Button { ws.startDrawing(area) } label: { Label("Redraw outline", systemImage: "pencil.and.outline") }
                        Button(role: .destructive) { confirmDelete = true } label: { Label("Delete area", systemImage: "trash") }
                    }
                } else if following {
                    Button(role: .destructive) { confirmUnfollow = true } label: {
                        Label("Unfollow", systemImage: "star.slash")
                    }
                } else if ws.store.canEdit {
                    Button { Task { await ws.follow(area) } } label: {
                        Label("Follow for \(model.team?.isPersonal == true ? "me" : model.team?.name ?? "the team")", systemImage: "star")
                    }
                }
            }
            .disabled(ws.busy)
        }
        .listStyle(.insetGrouped)
        .navigationTitle(area.name)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $editing) { AreaEditSheet(area: area) }
        .confirmationDialog("Delete \(area.name)? This can't be undone.", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await ws.delete(area) } }
        }
        .confirmationDialog("Stop following \(area.name)?", isPresented: $confirmUnfollow, titleVisibility: .visible) {
            Button("Unfollow", role: .destructive) { Task { await ws.unfollow(area) } }
        }
    }
}

struct AreaEditSheet: View {
    let area: Area
    @Environment(Workspace.self) private var ws
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var level: AreaLevel = .neighborhood
    @State private var notes = ""

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name)
                Picker("Kind", selection: $level) {
                    ForEach(AreaLevel.drawable, id: \.self) { Text($0.label).tag($0) }
                }
                Section("Notes") {
                    TextField("Anything worth knowing about this area", text: $notes, axis: .vertical)
                        .lineLimit(4...10)
                }
            }
            .navigationTitle("Edit \(area.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task { if await ws.save(area, name: name, level: level, notes: notes) { dismiss() } }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || ws.busy)
                }
            }
            .onAppear {
                name = area.name
                level = AreaLevel.drawable.contains(area.level) ? area.level : .neighborhood
                notes = area.notes ?? ""
            }
        }
    }
}
