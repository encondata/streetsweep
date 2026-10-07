import SwiftUI

/// A street tapped on the Map tab: what it is, whether the team has swept it, and (for the
/// team's drivers) marking it done, gated or left out by hand, this piece or the whole
/// street. The same as the website's street popup.
struct StreetCard: View {
    let tap: StreetTap
    let teamId: String
    var onChange: () -> Void
    var onClose: () -> Void
    @Environment(AppModel.self) private var model
    @State private var info: SegmentInfo?
    @State private var whole = true
    @State private var busy = false
    @State private var error: String?
    @State private var done: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(tap.name ?? "Unnamed \(kind.lowercased())").font(.title3.bold())
                    Text(kind).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
                Button { onClose() } label: { Image(systemName: "xmark.circle.fill").font(.title2).foregroundStyle(.secondary) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Close")
            }

            if let info {
                Label(status(info), systemImage: statusSymbol(info.segment))
                    .font(.subheadline)
                    .foregroundStyle(info.segment.mark == "excluded" ? Color.secondary : info.segment.firstDrivenAt != nil || info.segment.mark == "complete" ? Color.brand : Color.primary)
                if let n = info.segment.markNote, !n.isEmpty { Text("“\(n)”").font(.footnote).foregroundStyle(.secondary) }

                if info.canMark {
                    if let st = info.street, st.pieces > 1 {
                        Picker("Mark", selection: $whole) {
                            Text("Whole street · \(Format.miles(Double(st.meters)))").tag(true)
                            Text("This piece · \(Format.length(tap.lengthM))").tag(false)
                        }
                        .pickerStyle(.segmented)
                    }
                    HStack(spacing: 10) {
                        if info.segment.mark != nil && !(whole && (info.street?.pieces ?? 1) > 1) || whole && ((info.street?.markedDone ?? 0) > 0 || (info.street?.leftOut ?? 0) > 0) {
                            Button("Unmark") { Task { await mark(nil) } }.buttonStyle(.bordered)
                        }
                        Spacer(minLength: 0)
                        Button { Task { await mark("excluded", note: "Gated") } } label: { Label("Gated", systemImage: "lock") }
                            .buttonStyle(.bordered)
                        Button { Task { await mark("excluded", note: nil) } } label: { Label("Leave out", systemImage: "minus.circle") }
                            .buttonStyle(.bordered)
                        Button { Task { await mark("complete", note: nil) } } label: { Label("Mark done", systemImage: "checkmark") }
                            .buttonStyle(.borderedProminent)
                    }
                    .controlSize(.large)
                    .disabled(busy)
                }
            } else if error == nil {
                ProgressView()
            }
            if let done { Text(done).font(.footnote).foregroundStyle(Color.brand) }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
        }
        .padding(16)
        .frame(width: 640)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22))
        .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
        .task(id: tap.id) {
            done = nil
            error = nil
            info = nil
            whole = true
            await load()
        }
    }

    private static let kinds = ["primary": "Main road", "secondary": "Secondary road", "tertiary": "Minor through road",
                                "unclassified": "Minor road", "residential": "Residential street", "living_street": "Living street",
                                "service": "Service road", "trunk": "Highway", "motorway": "Freeway"]
    private var kind: String {
        let base = tap.highway.replacingOccurrences(of: "_link", with: "")
        return (Self.kinds[base] ?? base.replacingOccurrences(of: "_", with: " ").capitalized) + (tap.highway.hasSuffix("_link") ? " (ramp)" : "")
    }

    private func status(_ i: SegmentInfo) -> String {
        let s = i.segment
        if s.mark == "complete" { return "Marked done\(s.markedBy.map { " by \($0)" } ?? "")" }
        if s.mark == "excluded" { return "Left out\(s.markedBy.map { " by \($0)" } ?? "")" }
        if let d = s.firstDrivenAt { return "Driven \(Format.day(d))\(s.firstDriver.map { " by \($0)" } ?? "")" }
        if let st = i.street, st.pieces > 1, st.leftM < st.meters { return "Not driven yet · \(Format.miles(Double(st.leftM))) of the street left" }
        return "Not driven yet"
    }

    private func statusSymbol(_ s: SegmentInfo.Segment) -> String {
        s.mark == "excluded" ? "minus.circle" : s.mark == "complete" || s.firstDrivenAt != nil ? "checkmark.circle.fill" : "circle"
    }

    private func load() async {
        guard let api = model.api else { return }
        do { info = try await api.get("/api/segments/\(tap.id)?team=\(teamId)") }
        catch { self.error = error.localizedDescription }
    }

    private func mark(_ kind: String?, note: String? = nil) async {
        guard let api = model.api, let info else { return }
        busy = true
        defer { busy = false }
        error = nil
        do {
            let all = whole && (info.street?.pieces ?? 1) > 1
            let name = tap.name ?? "the street"
            if all {
                let body = StreetMarkBody(segmentId: tap.id, kind: kind ?? "clear", clear: kind == nil ? (info.segment.mark ?? "complete") : nil, note: note)
                let r: Changed = try await api.post("/api/teams/\(teamId)/marks/street", body)
                done = "\(kind == "complete" ? "Marked done" : kind == "excluded" ? (note == "Gated" ? "Marked gated" : "Left out") : "Unmarked") \(Format.miles(Double(r.meters))) of \(name)."
                // Unmarking the whole street clears one kind at a time: take the other too.
                if kind == nil, (info.street?.markedDone ?? 0) > 0, (info.street?.leftOut ?? 0) > 0 {
                    let other = info.segment.mark == "excluded" ? "complete" : "excluded"
                    let _: Changed = try await api.post("/api/teams/\(teamId)/marks/street", StreetMarkBody(segmentId: tap.id, kind: "clear", clear: other, note: nil))
                }
            } else if let kind {
                let _: Empty = try await api.put("/api/teams/\(teamId)/marks/\(tap.id)", PieceMarkBody(kind: kind, note: note))
                done = kind == "complete" ? "Marked this piece done." : note == "Gated" ? "Marked this piece gated." : "Left this piece out."
            } else {
                try await api.delete("/api/teams/\(teamId)/marks/\(tap.id)")
                done = "Unmarked this piece."
            }
            await load()
            onChange()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct SegmentInfo: Decodable, Sendable {
    struct Segment: Decodable, Sendable {
        let firstDrivenAt: String?
        let firstDriver: String?
        let mark: String?
        let markNote: String?
        let markedBy: String?
    }
    struct Street: Decodable, Sendable {
        let pieces: Int
        let meters: Int
        let leftM: Int
        let markedDone: Int
        let leftOut: Int
    }
    let segment: Segment
    let street: Street?
    let canMark: Bool
}

private struct StreetMarkBody: Encodable {
    let segmentId: Int
    let kind: String
    let clear: String?
    let note: String?
    enum CodingKeys: String, CodingKey { case segmentId = "segment_id", kind, clear, note }
}

private struct PieceMarkBody: Encodable { let kind: String; let note: String? }
private struct Changed: Decodable { let pieces: Int; let meters: Int }
