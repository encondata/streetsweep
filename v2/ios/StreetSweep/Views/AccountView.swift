import SwiftUI

/// Who you're signed in as, where, and signing out.
struct AccountView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmSignOut = false
    @State private var saving = false
    @State private var stripeError: String?

    var body: some View {
        NavigationStack {
            Form {
                if let user = model.user {
                    Section("Signed in as") {
                        LabeledContent("Name", value: user.displayName)
                        LabeledContent("Email", value: user.email)
                    }
                }
                Section {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(StripeColors.presets, id: \.hex) { p in
                                Button {
                                    Task {
                                        saving = true
                                        do { try await model.setExcludedColor(p.hex) } catch { stripeError = error.localizedDescription }
                                        saving = false
                                    }
                                } label: {
                                    StripeSwatch(hex: p.hex, selected: (model.user?.preferences?.excludedColor ?? StripeColors.standard).lowercased() == p.hex)
                                }
                                .buttonStyle(.plain)
                                .disabled(saving)
                                .accessibilityLabel(p.name)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                } header: {
                    Text("Left-out streets")
                } footer: {
                    Text(stripeError ?? "Gated and left-out streets are drawn candy-striped in this colour, here, on the website and on the phone.")
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

/// A colour for left-out streets, drawn as the candy stripe it will be on the map.
private struct StripeSwatch: View {
    let hex: String
    let selected: Bool

    var body: some View {
        Canvas { ctx, size in
            ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.white))
            let band = size.height
            var x: CGFloat = 0
            while x < size.width {
                ctx.fill(Path(CGRect(x: x, y: 0, width: min(band, size.width - x), height: size.height)), with: .color(Color(hex: hex)))
                x += band * 2
            }
        }
        .frame(width: 44, height: 12)
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(.secondarySystemBackground)))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(selected ? Color.accentColor : Color.black.opacity(0.15), lineWidth: selected ? 3 : 1))
    }
}
