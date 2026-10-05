import Charts
import SwiftUI

/// Home: how you (or one of your teams) are doing. The figures, the last twelve weeks,
/// area progress, recent drives, achievements and, for a shared team, the leaderboards.
/// The same as the website's Home.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var teamId: String?
    @State private var stats: Stats?
    @State private var areas: [Area] = []
    @State private var drives: [Drive]?
    @State private var ach: AchievementSet?
    @State private var board = "new"
    @State private var period = "week"
    @State private var rows: [LeaderRow]?
    @State private var error: String?

    private var team: Team? { model.teams.first { $0.id == teamId } ?? model.teams.first }
    private var personal: Bool { team?.isPersonal ?? true }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    header
                    if let error { Text(error).foregroundStyle(.red) }
                    figures
                    weekChart
                    HStack(alignment: .top, spacing: 22) {
                        VStack(alignment: .leading, spacing: 22) {
                            areaProgress
                            recentDrives
                        }
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                        VStack(alignment: .leading, spacing: 22) {
                            achievements
                            if !personal { leaderboard }
                        }
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                    }
                }
                .padding(.horizontal, 28)
                .padding(.top, 20)
                .padding(.bottom, 110)
                .frame(maxWidth: 1100)
                .frame(maxWidth: .infinity)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Home")
            .toolbar(.hidden, for: .navigationBar)
            .refreshable { await load() }
            .task(id: team?.id) { await load() }
            .task(id: "\(team?.id ?? "")|\(board)|\(period)") { await loadBoard() }
            .navigationDestination(for: Drive.self) { DriveDetailView(driveId: $0.id) }
        }
    }

    // MARK: - Sections

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
                Text(personal ? "Hi, \(model.user?.displayName.split(separator: " ").first.map(String.init) ?? "there")" : team?.name ?? "")
                    .font(.largeTitle.bold())
                Text(personal ? "Here's how your sweeping is going." : "How the team is doing.").foregroundStyle(.secondary)
            }
            Spacer()
            Picker("Team", selection: Binding(get: { team?.id }, set: { teamId = $0 })) {
                ForEach(model.teams) { Text($0.label).tag(Optional($0.id)) }
            }
            .pickerStyle(.menu)
        }
    }

    private var figures: some View {
        HStack(spacing: 14) {
            tile("Streets swept", stats.map { "\($0.total.streets.formatted())" }, stats.map { "\($0.month.streets) this month" })
            tile("Street miles", stats.map { Format.miles($0.total.streetM) }, stats.map { "\(Format.miles($0.month.streetM)) this month" })
            tile("Drives", stats.map { "\($0.total.drives.formatted())" }, stats.map { "\($0.month.drives) this month" })
            tile("Miles driven", stats.map { Format.miles($0.total.driveM) }, stats.map { "\(Format.miles($0.month.driveM)) this month" })
        }
    }

    private func tile(_ label: String, _ value: String?, _ sub: String?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.subheadline).foregroundStyle(.secondary)
            Text(value ?? "—").font(.title.bold()).monospacedDigit()
            Text(sub ?? " ").font(.caption).foregroundStyle(.secondary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
    }

    private var weekChart: some View {
        card("Street miles, last 12 weeks") {
            if let weeks = stats?.weeks, !weeks.isEmpty {
                Chart(weeks) { w in
                    BarMark(x: .value("Week", ISO.date(w.week + "T00:00:00Z") ?? .now, unit: .weekOfYear),
                            y: .value("Miles", w.streetM / 1609.344))
                        .foregroundStyle(Color.brand.gradient)
                        .cornerRadius(4)
                }
                .chartYAxisLabel("mi")
                .frame(height: 160)
            } else {
                Text(stats == nil ? "Loading…" : "No drives yet.").foregroundStyle(.secondary).frame(height: 60)
            }
        }
    }

    private var areaProgress: some View {
        let colors = AreaColors.assign(areas)
        let list = areas.filter { $0.progress != nil }.sorted { ($0.progress ?? 0) > ($1.progress ?? 0) }.prefix(6)
        return card("Areas") {
            if list.isEmpty {
                Text("Follow or draw an area to see its progress here.").foregroundStyle(.secondary)
            }
            ForEach(Array(list)) { a in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        RoundedRectangle(cornerRadius: 3).fill(Color(hex: colors[a.id] ?? "#1e8a28")).frame(width: 12, height: 12)
                        Text(a.name).font(.body.weight(.semibold)).lineLimit(1)
                        Spacer()
                        Text(Format.percent(a.progress ?? 0)).font(.footnote.bold()).monospacedDigit().foregroundStyle(.secondary)
                    }
                    ProgressView(value: a.progress ?? 0).tint(Color(hex: colors[a.id] ?? "#1e8a28"))
                }
            }
        }
    }

    private var recentDrives: some View {
        card("Recent drives") {
            if let drives {
                if drives.isEmpty {
                    Text(personal ? "No drives yet. Record one with the StreetSweep phone app." : "Team drives show here for the team's admins.")
                        .foregroundStyle(.secondary)
                }
                ForEach(drives) { d in
                    NavigationLink(value: d) { DriveRow(drive: d) }
                        .buttonStyle(.plain)
                }
            } else {
                ProgressView()
            }
        }
    }

    private var achievements: some View {
        card("Achievements") {
            if let ach {
                Text("\(ach.earnedCount) of \(ach.total) earned").font(.subheadline).foregroundStyle(.secondary)
                let latest = latestEarned(ach)
                if !latest.isEmpty {
                    Text("Latest").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    ForEach(latest, id: \.code) { AchievementRow(item: $0) }
                }
                let next = nextUp(ach)
                if !next.isEmpty {
                    Text("Next up").font(.caption.weight(.semibold)).foregroundStyle(.secondary).padding(.top, 4)
                    ForEach(next, id: \.code) { AchievementRow(item: $0) }
                }
                NavigationLink("See all achievements") { AchievementsView(set: ach) }
                    .font(.subheadline.weight(.semibold))
                    .padding(.top, 4)
            } else {
                ProgressView()
            }
        }
    }

    private var leaderboard: some View {
        card("Leaderboard") {
            Picker("Board", selection: $board) {
                Text("New streets").tag("new")
                Text("Miles").tag("miles")
                Text("Drives").tag("drives")
            }
            .pickerStyle(.segmented)
            Picker("Period", selection: $period) {
                Text("Week").tag("week")
                Text("Month").tag("month")
                Text("All time").tag("all")
            }
            .pickerStyle(.segmented)
            if let rows {
                if rows.isEmpty { Text("Nobody yet this \(period == "all" ? "time" : period).").foregroundStyle(.secondary) }
                ForEach(rows) { r in
                    HStack(spacing: 10) {
                        Text("\(r.rank)").font(.headline.monospacedDigit()).frame(width: 24)
                        PersonAvatar(id: r.userId, name: r.displayName, url: r.avatarUrl, size: 30)
                        Text(r.displayName).lineLimit(1)
                        Spacer()
                        Text(boardValue(r)).font(.subheadline.bold()).monospacedDigit()
                    }
                }
            } else {
                ProgressView()
            }
        }
    }

    private func boardValue(_ r: LeaderRow) -> String {
        switch board {
        case "drives": "\(Int(r.value)) drives"
        case "miles": Format.miles(r.value)
        default: "\(Int(r.extra ?? 0)) streets"
        }
    }

    private func card<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline)
            content()
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
    }

    // MARK: - Data

    private func load() async {
        guard let api = model.api, let t = team else { return }
        error = nil
        let own = t.isPersonal
        async let s: Stats? = try? api.get(own ? "/api/stats" : "/api/teams/\(t.id)/stats")
        async let a: TeamAreas? = try? api.get("/api/teams/\(t.id)/areas")
        async let ac: AchievementSet? = try? api.get(own ? "/api/achievements" : "/api/teams/\(t.id)/achievements")
        let drivesPath: String? = own ? "/api/drives?limit=5" : (t.canEdit ? "/api/teams/\(t.id)/drives?limit=5" : nil)
        async let d: DriveList? = drivesPath == nil ? DriveList(drives: []) : try? api.get(drivesPath!)
        let (st, ar, ach2, dr) = await (s, a, ac, d)
        stats = st
        areas = ar?.areas ?? []
        ach = ach2
        drives = dr?.drives ?? []
        if st == nil { error = "Couldn't load the figures. Pull to try again." }
    }

    private func loadBoard() async {
        guard let api = model.api, let t = team, !t.isPersonal else { return }
        rows = nil
        rows = (try? await api.get("/api/teams/\(t.id)/leaderboard?board=\(board)&period=\(period)", as: Board.self))?.rows ?? []
    }

    private func latestEarned(_ a: AchievementSet) -> [AnyAchievement] {
        let all = a.ladders.filter { $0.level > 0 }.map(AnyAchievement.ladder) + a.badges.filter(\.earned).map(AnyAchievement.badge)
        return Array(all.sorted { ($0.earnedAt ?? "") > ($1.earnedAt ?? "") }.prefix(3))
    }

    private func nextUp(_ a: AchievementSet) -> [AnyAchievement] {
        let shown = Set(latestEarned(a).map(\.code))
        let all = a.ladders.map(AnyAchievement.ladder) + a.badges.map(AnyAchievement.badge)
        return Array(all.filter { !shown.contains($0.code) && $0.percent >= 0 && $0.percent < 100 }.sorted { $0.percent > $1.percent }.prefix(3))
    }
}

struct DriveList: Decodable, Sendable { let drives: [Drive] }
private struct Board: Decodable, Sendable { let rows: [LeaderRow] }

/// A ladder or a badge, for showing either the same way.
enum AnyAchievement {
    case ladder(Ladder), badge(Badge)

    var code: String { switch self { case .ladder(let l): l.code; case .badge(let b): b.code } }
    var earnedAt: String? { switch self { case .ladder(let l): l.earnedAt; case .badge(let b): b.earnedAt } }
    var earned: Bool { switch self { case .ladder(let l): l.level > 0; case .badge(let b): b.earned } }
    var name: String {
        switch self {
        case .ladder(let l): l.level > 0 ? (l.step?.name ?? l.name) : l.name
        case .badge(let b): b.name
        }
    }
    var blurb: String? { switch self { case .ladder(let l): l.blurb; case .badge(let b): b.blurb } }
    var art: String { switch self { case .ladder(let l): l.step?.art ?? ""; case .badge(let b): b.art } }
    var tier: String { switch self { case .ladder(let l): l.step?.tier ?? "common"; case .badge(let b): b.tier } }
    /// How far towards the next level or the badge, 0…100; -1 when there's nothing left to earn.
    var percent: Double {
        switch self {
        case .ladder(let l): l.next == nil ? -1 : l.progress
        case .badge(let b): b.earned ? -1 : b.progress.map { min(100, $0.value / max(1, $0.need) * 100) } ?? -1
        }
    }
    var progressText: String? {
        switch self {
        case .ladder(let l): l.next.map { "\(Int(l.value).formatted()) of \(Int($0).formatted()) \(l.unit ?? "")" }
        case .badge(let b): b.earned ? nil : b.progress.map { "\(Int($0.value).formatted()) of \(Int($0.need).formatted())" }
        }
    }
}

/// One achievement: its art (from the website's public files), name and progress.
struct AchievementRow: View {
    let item: AnyAchievement
    @Environment(AppModel.self) private var model
    @State private var image: UIImage?

    var body: some View {
        HStack(spacing: 12) {
            Group {
                if let image { Image(uiImage: image).resizable().scaledToFit() }
                else { Image(systemName: "rosette").font(.title).foregroundStyle(.secondary) }
            }
            .frame(width: 52, height: 52)
            .saturation(item.earned ? 1 : 0)
            .opacity(item.earned ? 1 : 0.6)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.name).font(.body.weight(.semibold))
                if let b = item.blurb { Text(b).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                if item.percent >= 0, let t = item.progressText {
                    ProgressView(value: item.percent, total: 100).tint(.brand)
                    Text(t).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .task(id: item.art) { await load() }
    }

    private func load() async {
        guard let api = model.api else { return }
        for path in ["/ach-\(item.art).webp", "/ach-tier_\(item.tier).webp"] {
            if let hit = ImageCache.shared.object(forKey: path as NSString) { image = hit; return }
            if let data = try? await api.raw(path), let img = UIImage(data: data) {
                ImageCache.shared.setObject(img, forKey: path as NSString)
                image = img
                return
            }
        }
    }
}

/// Every achievement: ladders, then badges, earned first.
struct AchievementsView: View {
    let set: AchievementSet

    var body: some View {
        List {
            Section("Ladders") {
                ForEach(set.ladders) { AchievementRow(item: .ladder($0)) }
            }
            Section("Badges · \(set.badges.filter(\.earned).count) of \(set.badges.count)") {
                ForEach(set.badges.sorted { ($0.earned ? 0 : 1) < ($1.earned ? 0 : 1) }) { AchievementRow(item: .badge($0)) }
            }
        }
        .navigationTitle("Achievements")
        .contentMargins(.bottom, 90, for: .scrollContent)
    }
}
