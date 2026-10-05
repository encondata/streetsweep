import MapLibre
import SwiftUI

/// A small map for one thing: a drive's track and streets, or a place's pin. Same
/// basemaps as the big map, fitted to what it shows.
struct MiniMap: UIViewRepresentable {
    /// Lines to draw ([lng, lat] pairs): the matched streets, then the raw track.
    var streets: [[[Double]]] = []
    var track: [[[Double]]] = []
    var pin: CLLocationCoordinate2D?
    var interactive = true
    @Environment(AppModel.self) private var model

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> MLNMapView {
        if let token = model.token { MapController.authorize(token) }
        let url = model.server.map { MapController.writeStyle(server: $0) }
        let v = MLNMapView(frame: .zero, styleURL: url)
        v.delegate = context.coordinator
        v.logoView.isHidden = true
        v.attributionButtonPosition = .bottomLeft
        v.isRotateEnabled = false
        v.isPitchEnabled = false
        v.isUserInteractionEnabled = interactive
        context.coordinator.parent = self
        return v
    }

    func updateUIView(_ v: MLNMapView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.render(v)
    }

    final class Coordinator: NSObject, MLNMapViewDelegate {
        var parent: MiniMap?
        private var ready = false
        private var fitted = false

        func mapView(_ mapView: MLNMapView, didFinishLoading style: MLNStyle) {
            func add(_ id: String, color: UIColor, width: Double, opacity: Double) {
                let s = MLNShapeSource(identifier: id, shape: nil, options: nil)
                style.addSource(s)
                let l = MLNLineStyleLayer(identifier: id, source: s)
                l.lineColor = NSExpression(forConstantValue: color)
                l.lineWidth = NSExpression(forConstantValue: width)
                l.lineOpacity = NSExpression(forConstantValue: opacity)
                l.lineCap = NSExpression(forConstantValue: "round")
                l.lineJoin = NSExpression(forConstantValue: "round")
                style.addLayer(l)
            }
            add("mini-streets", color: UIColor(red: 0.086, green: 0.639, blue: 0.29, alpha: 1), width: 5, opacity: 0.55)
            add("mini-track", color: UIColor(red: 0.886, green: 0.447, blue: 0.122, alpha: 1), width: 2.5, opacity: 0.95)
            let pin = MLNShapeSource(identifier: "mini-pin", shape: nil, options: nil)
            style.addSource(pin)
            let c = MLNCircleStyleLayer(identifier: "mini-pin", source: pin)
            c.circleRadius = NSExpression(forConstantValue: 9)
            c.circleColor = NSExpression(forConstantValue: UIColor(red: 0.761, green: 0.094, blue: 0.357, alpha: 1))
            c.circleStrokeColor = NSExpression(forConstantValue: UIColor.white)
            c.circleStrokeWidth = NSExpression(forConstantValue: 3)
            style.addLayer(c)
            ready = true
            render(mapView)
        }

        func render(_ v: MLNMapView) {
            guard ready, let p = parent, let style = v.style else { return }
            func lines(_ ls: [[[Double]]]) -> MLNShape? {
                let fc: [String: Any] = ["type": "FeatureCollection", "features": ls.isEmpty ? [] : [
                    ["type": "Feature", "properties": [:], "geometry": ["type": "MultiLineString", "coordinates": ls]],
                ]]
                guard let d = try? JSONSerialization.data(withJSONObject: fc) else { return nil }
                return try? MLNShape(data: d, encoding: String.Encoding.utf8.rawValue)
            }
            (style.source(withIdentifier: "mini-streets") as? MLNShapeSource)?.shape = lines(p.streets)
            (style.source(withIdentifier: "mini-track") as? MLNShapeSource)?.shape = lines(p.track)
            (style.source(withIdentifier: "mini-pin") as? MLNShapeSource)?.shape = p.pin.map { c in
                let f = MLNPointFeature()
                f.coordinate = c
                return f
            }
            guard !fitted else { return }
            let all = (p.streets + p.track).flatMap { $0 }
            if let first = all.first {
                var s = first[1], n = first[1], w = first[0], e = first[0]
                for c in all { s = min(s, c[1]); n = max(n, c[1]); w = min(w, c[0]); e = max(e, c[0]) }
                v.setVisibleCoordinateBounds(MLNCoordinateBounds(sw: CLLocationCoordinate2D(latitude: s, longitude: w), ne: CLLocationCoordinate2D(latitude: n, longitude: e)),
                                             edgePadding: UIEdgeInsets(top: 30, left: 30, bottom: 30, right: 30), animated: false, completionHandler: nil)
                fitted = true
            } else if let pin = p.pin {
                v.setCenter(pin, zoomLevel: 16, animated: false)
                fitted = true
            }
        }
    }
}
