import SwiftUI
import UIKit

/// A picture from the server, fetched with the device token (place photos, avatars and
/// vehicle photos are for signed-in people), kept in memory while the app runs.
struct RemoteImage<Placeholder: View>: View {
    let path: String?
    var contentMode: ContentMode = .fill
    @ViewBuilder var placeholder: () -> Placeholder
    @Environment(AppModel.self) private var model
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else {
                placeholder()
            }
        }
        .task(id: path) { await load() }
    }

    private func load() async {
        guard let path, let api = model.api else { image = nil; return }
        if let hit = ImageCache.shared.object(forKey: path as NSString) { image = hit; return }
        guard let data = try? await api.raw(path), let img = UIImage(data: data) else { return }
        ImageCache.shared.setObject(img, forKey: path as NSString)
        image = img
    }
}

enum ImageCache {
    static let shared: NSCache<NSString, UIImage> = {
        let c = NSCache<NSString, UIImage>()
        c.countLimit = 300
        return c
    }()
}

/// A person: their photo if they have one, else initials on a colour from their id.
struct PersonAvatar: View {
    let id: String
    let name: String
    let url: String?
    var size: CGFloat = 32

    var body: some View {
        RemoteImage(path: url) {
            Text(initials)
                .font(.system(size: size * 0.4, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: size, height: size)
                .background(color, in: Circle())
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }

    private var initials: String {
        let s = name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
        return s.isEmpty ? "?" : s
    }

    /// The website's avatar colours and hash, so a person is the same colour on both.
    private static let colors = ["#1e8a28", "#1a6fd4", "#8e44ad", "#d35400", "#16a085", "#c0392b", "#2c3e50", "#b7950b"]
    private var color: Color {
        let h = id.utf16.reduce(UInt32(7)) { $0 &* 31 &+ UInt32($1) }
        return Color(hex: Self.colors[Int(h % UInt32(Self.colors.count))])
    }
}

extension View {
    /// Lists and forms at a comfortable width on a 13" screen, centred on the grouped background.
    func readableWidth(_ max: CGFloat = 960) -> some View {
        frame(maxWidth: max)
            .frame(maxWidth: .infinity)
            .background(Color(.systemGroupedBackground))
    }
}
