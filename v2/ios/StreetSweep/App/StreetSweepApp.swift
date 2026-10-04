import SwiftUI

@main
struct StreetSweepApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            Group {
                if model.signedIn {
                    MainView()
                } else {
                    SignInView()
                }
            }
            .environment(model)
            .tint(.brand)
            .task {
                #if DEBUG
                await model.devSignIn()
                #endif
                await model.refresh()
            }
            .onChange(of: phase) { _, now in
                if now == .active { Task { await model.refresh() } }
            }
        }
    }
}

extension Color {
    static let brand = Color("AccentColor")
}
