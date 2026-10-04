import SwiftUI

/// Sign in with the same account as the website. The look follows the web's login page.
struct SignInView: View {
    @Environment(AppModel.self) private var model
    @State private var server = ""
    @State private var email = ""
    @State private var password = ""
    @State private var otherServer = false
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?

    private enum Field { case server, email, password }

    var body: some View {
        GeometryReader { geo in
            let wide = geo.size.width > geo.size.height
            let layout = wide ? AnyLayout(HStackLayout(spacing: 0)) : AnyLayout(VStackLayout(spacing: 0))
            layout {
                Image("LoginArt")
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: wide ? geo.size.width * 0.5 : geo.size.width,
                           height: wide ? geo.size.height : geo.size.height * 0.36)
                    .clipped()
                form
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(.systemBackground))
            }
        }
        .ignoresSafeArea(edges: .all)
        .onAppear {
            if server.isEmpty {
                server = model.lastServer
                otherServer = AppModel.serverURL(from: server) != AppModel.serverURL(from: AppModel.defaultServer)
            }
            error = model.signedOutReason
        }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 18) {
            Image("LoginLockup")
                .resizable()
                .scaledToFit()
                .frame(height: 52)
                .padding(.bottom, 8)
            Text("Sign in")
                .font(.largeTitle.bold())
            Text("Use your StreetSweep account, the same one as on the website.")
                .foregroundStyle(.secondary)

            if let error {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            }

            field("Email") {
                TextField("you@example.com", text: $email)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .email)
                    .submitLabel(.next)
                    .onSubmit { focus = .password }
            }
            field("Password") {
                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .focused($focus, equals: .password)
                    .submitLabel(.go)
                    .onSubmit(submit)
            }
            // streetsweep.net unless told otherwise (a test server, say).
            if otherServer {
                field("Server") {
                    TextField(AppModel.defaultServer, text: $server)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .server)
                }
            }

            Button(action: submit) {
                HStack {
                    if busy { ProgressView().tint(.white) }
                    Text(busy ? "Signing in…" : "Sign in").bold()
                }
                .frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.borderedProminent)
            .disabled(busy || email.isEmpty || password.isEmpty)
            .padding(.top, 4)

            Text("No account yet? Sign up at streetsweep.net, then sign in here.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Button(otherServer ? "Use streetsweep.net" : "Use a different server") {
                otherServer.toggle()
                server = otherServer ? "" : AppModel.defaultServer
            }
            .font(.footnote)
        }
        .frame(maxWidth: 420)
        .padding(32)
    }

    private func field<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.subheadline.weight(.semibold))
            content()
                .padding(.horizontal, 12)
                .frame(minHeight: 46)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private func submit() {
        guard !busy, !email.isEmpty, !password.isEmpty else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await model.signIn(server: server, email: email, password: password)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
