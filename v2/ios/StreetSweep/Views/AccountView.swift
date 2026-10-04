import SwiftUI

/// Who you're signed in as, where, and signing out.
struct AccountView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmSignOut = false

    var body: some View {
        NavigationStack {
            Form {
                if let user = model.user {
                    Section("Signed in as") {
                        LabeledContent("Name", value: user.displayName)
                        LabeledContent("Email", value: user.email)
                    }
                }
                Section("Server") {
                    LabeledContent("Address", value: model.server?.absoluteString ?? "—")
                }
                Section("Teams") {
                    ForEach(model.teams) { team in
                        LabeledContent(team.label, value: team.role.capitalized)
                    }
                }
                Section {
                    Button("Sign out", role: .destructive) { confirmSignOut = true }
                } footer: {
                    Text("Signing out also removes this iPad from Fleet → Phones on the website.")
                }
            }
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .confirmationDialog("Sign out of StreetSweep on this iPad?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) {
                    Task {
                        await model.signOut()
                        dismiss()
                    }
                }
            }
        }
    }
}
