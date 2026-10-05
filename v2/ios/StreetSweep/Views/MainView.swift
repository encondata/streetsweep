import SwiftUI

/// The app's sections, as on the website. Areas is built; the rest arrive in later stages.
enum AppSection: String, CaseIterable, Identifiable {
    case home, map, areas, drives, places, fleet, teams, admin
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
    var symbol: String {
        switch self {
        case .home: "house"
        case .map: "map"
        case .areas: "square.on.square.dashed"
        case .drives: "car"
        case .places: "mappin.and.ellipse"
        case .fleet: "car.2"
        case .teams: "person.3"
        case .admin: "shield.lefthalf.filled"
        }
    }
    /// Where the same page is on the website, for sections the app doesn't have yet.
    var webPath: String { self == .home ? "/" : "/\(rawValue)" }
}

/// The whole app once signed in: the section showing, and the icons-only bar along the
/// bottom to switch between them (like the website when it's narrow).
struct MainView: View {
    @Environment(AppModel.self) private var model
    @State private var ws = Workspace()
    @State private var cw = CoverageWorkspace()
    @AppStorage("section") private var section: AppSection = .areas
    @State private var showAccount = false

    private var sections: [AppSection] {
        AppSection.allCases.filter { $0 != .admin || model.user?.isSiteAdmin == true }
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            // Areas stays alive underneath, so its map doesn't reload on every switch.
            // The two maps stay alive underneath, so they don't reload on every switch.
            AreasScreen()
                .opacity(section == .areas ? 1 : 0)
                .allowsHitTesting(section == .areas)
            MapScreen()
                .opacity(section == .map ? 1 : 0)
                .allowsHitTesting(section == .map)
            if section != .areas && section != .map {
                SoonView(section: section)
                    .transition(.opacity)
            }
            // Drawing or marking: the tools take the bottom of the screen instead.
            if ws.session == nil && cw.mark == nil {
                NavBar(sections: sections, selection: $section) { showAccount = true }
                    .padding(.bottom, 14)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.spring(duration: 0.3), value: ws.session == nil && cw.mark == nil)
        .animation(.easeInOut(duration: 0.15), value: section)
        .environment(ws)
        .environment(cw)
        .sheet(isPresented: $showAccount) { AccountView() }
        .alert("Something went wrong", isPresented: Binding(get: { ws.error != nil || cw.error != nil },
                                                             set: { if !$0 { ws.error = nil; cw.error = nil } })) {
            Button("OK") { ws.error = nil; cw.error = nil }
        } message: {
            Text(ws.error ?? cw.error ?? "")
        }
        .onAppear {
            ws.attach(model)
            cw.attach(model)
        }
        // The team is known once the server has said who you are (straight away after
        // signing in, a moment after launch otherwise), and changes with the picker.
        .task(id: model.team?.id) {
            guard model.team != nil else { return }
            ws.close()
            if cw.mark != nil { cw.cancelMarking() }
            async let a: Void = ws.reload()
            async let b: Void = cw.reload()
            _ = await (a, b)
        }
    }
}

/// Icons only, floating at the bottom: the sections, then your account.
struct NavBar: View {
    let sections: [AppSection]
    @Binding var selection: AppSection
    let onAccount: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 4) {
            ForEach(sections) { s in
                Button { selection = s } label: {
                    Image(systemName: s.symbol)
                        .font(.system(size: 21, weight: selection == s ? .semibold : .regular))
                        .frame(width: 58, height: 48)
                        .foregroundStyle(selection == s ? Color.brand : Color.secondary)
                        .background(selection == s ? Color.brand.opacity(0.14) : .clear, in: RoundedRectangle(cornerRadius: 14))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(s.label)
                .accessibilityAddTraits(selection == s ? .isSelected : [])
            }
            Divider().frame(height: 30).padding(.horizontal, 4)
            Button(action: onAccount) {
                Avatar(name: model.user?.displayName ?? "?")
                    .frame(width: 58, height: 48)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Your account")
        }
        .padding(6)
        .background(.regularMaterial, in: Capsule())
        .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
    }
}

/// Initials in a circle, until the app shows photos.
struct Avatar: View {
    let name: String
    var body: some View {
        let initials = name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined()
        Text(initials.isEmpty ? "?" : initials.uppercased())
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: 32, height: 32)
            .background(Color.brand, in: Circle())
    }
}

/// A section the app doesn't have yet: say so, and offer the website's page.
struct SoonView: View {
    let section: AppSection
    @Environment(AppModel.self) private var model

    var body: some View {
        ContentUnavailableView {
            Label(section.label, systemImage: section.symbol)
        } description: {
            Text("\(section.label) comes to the iPad app in a later stage. It's on the website now.")
        } actions: {
            if let server = model.server, let url = URL(string: section.webPath, relativeTo: server) {
                Link("Open \(section.label) on the website", destination: url)
                    .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }
}

/// Areas: the map filling the screen, the areas panel floating on the left (or the drawing
/// panel while drawing), and the tools along the bottom while drawing.
struct AreasScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(Workspace.self) private var ws
    @AppStorage("map.base") private var base: Basemap = .map
    @AppStorage("draw.finger") private var fingerDraws = false
    @AppStorage("areas.panel") private var panelShown = true
    @AppStorage("draw.snap") private var snap = false
    @AppStorage("draw.others") private var showOthers = true
    private let panelWidth: CGFloat = 390

    var body: some View {
        ZStack(alignment: .topLeading) {
            if let server = model.server, let token = model.token {
                MapView(controller: ws.map, server: server, token: token)
                    .ignoresSafeArea()
            }

            if panelShown || ws.session != nil {
                panel
                    .frame(width: panelWidth)
                    .background(Color(.systemGroupedBackground), in: RoundedRectangle(cornerRadius: 22))
                    .clipShape(RoundedRectangle(cornerRadius: 22))
                    .shadow(color: .black.opacity(0.15), radius: 14, y: 4)
                    .padding(.leading, 16)
                    .padding(.top, 16)
                    // Clear of the bottom bar (or the drawing tools).
                    .padding(.bottom, 92)
                    .transition(.move(edge: .leading).combined(with: .opacity))
            } else {
                Button { panelShown = true } label: {
                    Label("Areas", systemImage: "sidebar.left").font(.headline)
                        .padding(.horizontal, 16).frame(height: 44)
                        .background(.regularMaterial, in: Capsule())
                }
                .buttonStyle(.plain)
                .padding(16)
            }
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
        .overlay(alignment: .bottom) {
            if let s = ws.session {
                ToolPalette(session: s, snap: $snap, showOthers: $showOthers)
                    .padding(.bottom, 16)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.spring(duration: 0.3), value: panelShown)
        .animation(.spring(duration: 0.3), value: ws.session == nil)
        .onAppear {
            ws.map.base = base
            ws.map.fingerDraws = fingerDraws
            ws.map.leftInset = panelShown ? panelWidth + 16 : 0
            ws.setSnapping(snap)
            ws.setShowOthers(showOthers)
        }
        .onChange(of: snap) { _, on in ws.setSnapping(on) }
        .onChange(of: showOthers) { _, on in ws.setShowOthers(on) }
        .onChange(of: base) { _, b in ws.map.base = b }
        .onChange(of: fingerDraws) { _, on in ws.map.fingerDraws = on }
        .onChange(of: panelShown) { _, on in ws.map.leftInset = on ? panelWidth + 16 : 0 }
    }

    @ViewBuilder private var panel: some View {
        if let s = ws.session {
            NavigationStack { DrawPanel(session: s, fingerDraws: $fingerDraws) }
        } else {
            // The open area is the stack: system back (and swipe back) closes it.
            NavigationStack(path: Binding(get: { ws.openArea.map { [$0.id] } ?? [] },
                                          set: { if $0.isEmpty { ws.close() } })) {
                AreaListView()
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button { panelShown = false } label: { Image(systemName: "sidebar.left") }
                                .accessibilityLabel("Hide areas")
                        }
                    }
                    .navigationDestination(for: String.self) { _ in
                        if let area = ws.openArea { AreaDetailView(area: area) }
                    }
            }
        }
    }
}
