import MapLibre
import SwiftUI
import UIKit

enum Basemap: String, CaseIterable, Identifiable {
    case map, satellite, hybrid
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

/// The map, and everything drawn on it: the server's basemaps and streets, the team's
/// areas, and whatever the Pencil is drawing. Fingers always move the map; while drawing,
/// the Apple Pencil draws (and a finger too, if "Draw with finger" is on).
///
/// Two kinds: the Areas map shows plain streets (planning, no drive history), the
/// coverage map colours them for a team: driven, still to do, left out.
@MainActor
final class MapController: NSObject, @preconcurrency MLNMapViewDelegate, UIGestureRecognizerDelegate, UIPencilInteractionDelegate {
    enum Mode { case areas, coverage }
    let mode: Mode
    private(set) weak var view: MLNMapView?
    private var styleReady = false
    private let overlay = DrawingOverlay()
    private var root = ""

    init(mode: Mode) {
        self.mode = mode
        super.init()
    }

    /// The coverage map's team: its streets come coloured for it.
    private(set) var teamId: String?
    private var streetsVersion = 0
    private var colorsPref: MapColors = .standard
    private var completeFill = StreetColor(color: "#39ff14", opacity: 0.1)
    private var shadeComplete = true

    var base: Basemap = .map { didSet { applyBase() } }
    /// Tapped an area on the map (not while drawing).
    var onAreaTap: ((String) -> Void)?
    /// Tapped a place's pin (the coverage map shows them).
    var onPlaceTap: ((String) -> Void)?

    /// The middle of the map, where a place being added goes.
    var centerCoordinate: CLLocationCoordinate2D? { view?.centerCoordinate }
    /// The map stopped moving: what's in view now.
    var onSettle: ((MapFrame) -> Void)?
    /// Room the sidebar takes on the left, so fitting an area doesn't hide it underneath.
    var leftInset: CGFloat = 0

    private var areas: [Area] = []
    private var colors: [String: String] = [:]
    private var selectedArea: String?
    private var searchPin: CLLocationCoordinate2D?

    /// An area's outline being drawn (its pieces are drawn as map layers).
    private(set) var session: DrawingSession?
    /// Whatever the Pencil draws into right now: the drawing session, or a mark outline.
    private(set) var ink: PencilTarget?
    var fingerDraws = false { didSet { configureGestures() } }

    // MARK: - Making the view

    func makeView(server: URL) -> MLNMapView {
        root = server.absoluteString
        while root.hasSuffix("/") { root.removeLast() }
        let view = MLNMapView(frame: .zero, styleURL: Self.writeStyle(server: server))
        view.delegate = self
        view.logoView.isHidden = true
        view.compassViewPosition = .bottomRight
        view.attributionButtonPosition = .bottomLeft
        let saved = Camera.load()
        view.setCenter(saved.center, zoomLevel: saved.zoom, animated: false)

        overlay.frame = view.bounds
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        overlay.isUserInteractionEnabled = false
        view.addSubview(overlay)

        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.delegate = self
        for r in view.gestureRecognizers ?? [] where (r as? UITapGestureRecognizer)?.numberOfTapsRequired == 2 {
            tap.require(toFail: r)
        }
        view.addGestureRecognizer(tap)

        pencil.addTarget(self, action: #selector(pencilMoved(_:)))
        pencil.delegate = self
        view.addGestureRecognizer(pencil)

        twoFingerTap.numberOfTouchesRequired = 2
        twoFingerTap.addTarget(self, action: #selector(undoTap))
        threeFingerTap.numberOfTouchesRequired = 3
        threeFingerTap.addTarget(self, action: #selector(redoTap))
        for r in [twoFingerTap, threeFingerTap] {
            r.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
            r.delegate = self
            view.addGestureRecognizer(r)
        }

        let hover = UIHoverGestureRecognizer(target: self, action: #selector(hovered(_:)))
        view.addGestureRecognizer(hover)
        view.addInteraction(UIPencilInteraction(delegate: self))

        self.view = view
        configureGestures()
        return view
    }

    /// Every tile request carries the device token: the server's tiles are for signed-in people.
    static func authorize(_ token: String) {
        let c = URLSessionConfiguration.default
        c.httpAdditionalHeaders = ["Authorization": "Bearer \(token)"]
        MLNNetworkConfiguration.sharedManager.sessionConfiguration = c
    }

    static func writeStyle(server: URL) -> URL {
        var root = server.absoluteString
        while root.hasSuffix("/") { root.removeLast() }
        func raster(_ layer: String, _ attribution: String?) -> [String: Any] {
            var s: [String: Any] = ["type": "raster", "tiles": ["\(root)/api/tiles/\(layer)/{z}/{x}/{y}"], "tileSize": 256, "maxzoom": 19]
            if let attribution { s["attribution"] = attribution }
            return s
        }
        let style: [String: Any] = [
            "version": 8,
            "sources": [
                "osm": raster("osm", "© OpenStreetMap contributors"),
                "sat": raster("sat", "Imagery © Esri"),
                "ref": raster("ref", nil),
            ],
            "layers": [
                ["id": "background", "type": "background", "paint": ["background-color": "#eef1f4"]],
                ["id": "base-osm", "type": "raster", "source": "osm", "paint": ["raster-saturation": -0.35]],
                ["id": "base-sat", "type": "raster", "source": "sat", "layout": ["visibility": "none"]],
                ["id": "base-ref", "type": "raster", "source": "ref", "layout": ["visibility": "none"]],
            ],
        ]
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("streetsweep-style.json")
        try? JSONSerialization.data(withJSONObject: style).write(to: url)
        return url
    }

    // MARK: - Style

    func mapView(_ mapView: MLNMapView, didFinishLoading style: MLNStyle) {
        addLayers(style)
        styleReady = true
        applyBase()
        renderAreas()
        renderDrawing()
        renderPlaces()
    }

    private func addLayers(_ style: MLNStyle) {
        func source(_ id: String) -> MLNShapeSource {
            let s = MLNShapeSource(identifier: id, shape: nil, options: nil)
            style.addSource(s)
            return s
        }
        let color = NSExpression(mglJSONObject: ["to-color", ["coalesce", ["get", "color"], "#1e8a28"]])

        let areas = source("areas")
        let fill = MLNFillStyleLayer(identifier: "areas-fill", source: areas)
        style.addLayer(fill)
        applyAreaFill()
        let line = MLNLineStyleLayer(identifier: "areas-line", source: areas)
        line.lineColor = color
        line.lineWidth = NSExpression(mglJSONObject: ["case", ["get", "selected"], 4.5, 2.2])
        line.lineOpacity = NSExpression(mglJSONObject: ["case", ["get", "faded"], 0.45, 1])
        line.lineJoin = NSExpression(forConstantValue: "round")
        style.addLayer(line)

        // Places: yours magenta, others' purple, as on the website.
        let places = MLNCircleStyleLayer(identifier: "places", source: source("places"))
        places.circleRadius = NSExpression(forConstantValue: 8)
        places.circleColor = NSExpression(mglJSONObject: ["case", ["get", "mine"], "#c2185b", "#7c3aed"])
        places.circleStrokeColor = NSExpression(forConstantValue: UIColor.white)
        places.circleStrokeWidth = NSExpression(forConstantValue: 2.5)
        style.addLayer(places)

        let pin = MLNCircleStyleLayer(identifier: "search-pin", source: source("search-pin"))
        pin.circleRadius = NSExpression(forConstantValue: 8)
        pin.circleColor = NSExpression(forConstantValue: UIColor(red: 0.886, green: 0.447, blue: 0.122, alpha: 1))
        pin.circleStrokeColor = NSExpression(forConstantValue: UIColor.white)
        pin.circleStrokeWidth = NSExpression(forConstantValue: 3)
        style.addLayer(pin)

        // The outline being drawn: orange, the selected piece purple.
        let orange = "#e2721f", purple = "#7c3aed"
        let pieces = source("draw-pieces")
        let pf = MLNFillStyleLayer(identifier: "draw-fill", source: pieces)
        pf.fillColor = NSExpression(mglJSONObject: ["case", ["get", "selected"], purple, orange])
        pf.fillOpacity = NSExpression(forConstantValue: 0.14)
        style.addLayer(pf)
        let pl = MLNLineStyleLayer(identifier: "draw-line", source: pieces)
        pl.lineColor = NSExpression(mglJSONObject: ["case", ["get", "selected"], purple, orange])
        pl.lineWidth = NSExpression(forConstantValue: 3)
        pl.lineJoin = NSExpression(forConstantValue: "round")
        style.addLayer(pl)

        let progress = source("draw-progress")
        let gl = MLNLineStyleLayer(identifier: "draw-progress-line", source: progress)
        gl.lineColor = NSExpression(forConstantValue: UIColor(red: 0.886, green: 0.447, blue: 0.122, alpha: 1))
        gl.lineWidth = NSExpression(forConstantValue: 3)
        gl.lineDashPattern = NSExpression(forConstantValue: [2, 1.5])
        style.addLayer(gl)

        let handles = source("draw-handles")
        let hc = MLNCircleStyleLayer(identifier: "draw-handles", source: handles)
        hc.circleRadius = NSExpression(mglJSONObject: ["match", ["get", "kind"], "mid", 5, "first", 9, 7])
        hc.circleColor = NSExpression(mglJSONObject: ["match", ["get", "kind"], "mid", "#ffffff", ["case", ["get", "selected"], purple, orange]])
        hc.circleStrokeColor = NSExpression(mglJSONObject: ["match", ["get", "kind"], "mid", ["case", ["get", "selected"], purple, orange], "#ffffff"])
        hc.circleStrokeWidth = NSExpression(forConstantValue: 2.5)
        style.addLayer(hc)

        // An outline of streets to mark: its shape, and the streets it would mark, flashing.
        let markOutline = source("mark-outline")
        let mof = MLNFillStyleLayer(identifier: "mark-outline-fill", source: markOutline)
        mof.fillColor = NSExpression(forConstantValue: UIColor(red: 1, green: 0.478, blue: 0, alpha: 1))
        mof.fillOpacity = NSExpression(forConstantValue: 0.08)
        style.addLayer(mof)
        let mol = MLNLineStyleLayer(identifier: "mark-outline-line", source: markOutline)
        mol.lineColor = NSExpression(forConstantValue: UIColor(red: 1, green: 0.478, blue: 0, alpha: 1))
        mol.lineWidth = NSExpression(forConstantValue: 2.5)
        mol.lineDashPattern = NSExpression(forConstantValue: [2, 1.5])
        style.addLayer(mol)
        // Scribbles so far: wide and faint, so the flashing streets read through them.
        let ms = MLNLineStyleLayer(identifier: "mark-scribble", source: source("mark-scribble"))
        ms.lineColor = NSExpression(forConstantValue: UIColor(red: 1, green: 0.478, blue: 0, alpha: 1))
        ms.lineOpacity = NSExpression(forConstantValue: 0.22)
        ms.lineWidth = NSExpression(forConstantValue: 20)
        ms.lineCap = NSExpression(forConstantValue: "round")
        ms.lineJoin = NSExpression(forConstantValue: "round")
        style.addLayer(ms)
        let mp = MLNLineStyleLayer(identifier: "mark-preview", source: source("mark-preview"))
        mp.lineColor = NSExpression(forConstantValue: UIColor(red: 1, green: 0.478, blue: 0, alpha: 1))
        mp.lineCap = NSExpression(forConstantValue: "round")
        mp.lineJoin = NSExpression(forConstantValue: "round")
        mp.lineWidth = Self.previewWidth(1)
        mp.lineOpacity = NSExpression(forConstantValue: 0)
        style.addLayer(mp)

        // While drawing with Snap on: the lines it snaps to (state, county, city), faintly.
        let sl = MLNLineStyleLayer(identifier: "snap-lines", source: source("snap-lines"))
        sl.lineColor = NSExpression(forConstantValue: UIColor(red: 0.486, green: 0.227, blue: 0.929, alpha: 1))
        sl.lineWidth = NSExpression(forConstantValue: 2)
        sl.lineOpacity = NSExpression(forConstantValue: 0.55)
        sl.lineDashPattern = NSExpression(forConstantValue: [3, 2])
        style.addLayer(sl)

        addStreets(style)
    }

    /// The boundary lines a drawing will snap to, or none.
    func setSnapLines(_ lines: [Ring]) {
        guard styleReady, let src = view?.style?.source(withIdentifier: "snap-lines") as? MLNShapeSource else { return }
        src.shape = Self.shape(lines.isEmpty ? [] : [["type": "Feature", "properties": [:],
            "geometry": ["type": "MultiLineString", "coordinates": lines.map { $0.map { [$0.longitude, $0.latitude] } }]]])
    }

    // MARK: - Streets

    /// Streets from the server's tiles, under the area outlines: plain on the Areas map,
    /// coloured for the team on the coverage map.
    private func addStreets(_ style: MLNStyle) {
        var url = "\(root)/api/tiles/streets/{z}/{x}/{y}"
        if mode == .coverage, let teamId { url += "?team=\(teamId)&v=\(streetsVersion)" }
        let src = MLNVectorTileSource(identifier: "streets", tileURLTemplates: [url],
                                      options: [.minimumZoomLevel: 12, .maximumZoomLevel: 16])
        style.addSource(src)
        let below = style.layer(withIdentifier: "areas-line")
        let width: [Any] = ["interpolate", ["linear"], ["zoom"], 12, 1.2, 16, 4, 19, 9]
        if mode == .coverage {
            let casing = MLNLineStyleLayer(identifier: "streets-casing", source: src)
            casing.sourceLayerIdentifier = "streets"
            casing.lineColor = NSExpression(forConstantValue: UIColor.white)
            casing.lineOpacity = NSExpression(forConstantValue: 0.9)
            casing.lineWidth = NSExpression(mglJSONObject: ["interpolate", ["linear"], ["zoom"], 12, 2.5, 16, 7, 19, 14])
            casing.lineCap = NSExpression(forConstantValue: "round")
            casing.lineJoin = NSExpression(forConstantValue: "round")
            if let below { style.insertLayer(casing, below: below) } else { style.addLayer(casing) }
        }
        let line = MLNLineStyleLayer(identifier: "streets", source: src)
        line.sourceLayerIdentifier = "streets"
        line.lineWidth = NSExpression(mglJSONObject: width)
        line.lineCap = NSExpression(forConstantValue: "round")
        line.lineJoin = NSExpression(forConstantValue: "round")
        if let below { style.insertLayer(line, below: below) } else { style.addLayer(line) }
        applyStreetColors()
    }

    private func applyStreetColors() {
        guard let line = view?.style?.layer(withIdentifier: "streets") as? MLNLineStyleLayer else { return }
        if mode == .areas {
            // Plain streets, as on the web's Areas page: no coverage while planning areas.
            line.lineColor = NSExpression(forConstantValue: UIColor(red: 0.545, green: 0.596, blue: 0.651, alpha: 1))
            line.lineOpacity = NSExpression(forConstantValue: 0.75)
            return
        }
        // As the web colours them: done or marked done in the driven colour, left out grey,
        // highways the team doesn't count faint, the rest in the to-do colour.
        let c = colorsPref
        line.lineColor = NSExpression(mglJSONObject: ["match", ["get", "state"], ["done", "complete"], c.driven.color, "excluded", "#9aa7b4", c.undriven.color])
        line.lineOpacity = NSExpression(mglJSONObject: ["match", ["get", "state"], ["done", "complete"], c.driven.opacity, "excluded", 0.7, "nc", 0.3, c.undriven.opacity])
    }

    private func applyAreaFill() {
        guard let fill = view?.style?.layer(withIdentifier: "areas-fill") as? MLNFillStyleLayer else { return }
        let own: [Any] = ["to-color", ["get", "color"]]
        fill.fillColor = NSExpression(mglJSONObject: shadeComplete ? ["case", ["get", "complete"], completeFill.color, own] : own)
        fill.fillOpacity = NSExpression(mglJSONObject: shadeComplete
            ? ["case", ["get", "complete"], completeFill.opacity, ["get", "selected"], 0.16, 0.06]
            : ["case", ["get", "selected"], 0.16, 0.06])
    }

    /// The person's colours, from their preferences on the website.
    func setPreferences(_ p: Preferences?) {
        colorsPref = p?.mapColors ?? .standard
        completeFill = p?.completeFill ?? StreetColor(color: "#39ff14", opacity: 0.1)
        shadeComplete = p?.shadeComplete ?? true
        applyStreetColors()
        applyAreaFill()
    }

    /// The coverage map's team: its streets come coloured for it.
    func setTeam(_ id: String?) {
        guard id != teamId else { return }
        teamId = id
        reloadStreets()
    }

    /// Fetch the streets again (after marking some done, say): coverage has changed.
    func reloadStreets() {
        streetsVersion += 1
        guard styleReady, let style = view?.style else { return }
        for id in ["streets", "streets-casing"] { if let l = style.layer(withIdentifier: id) { style.removeLayer(l) } }
        if let s = style.source(withIdentifier: "streets") { style.removeSource(s) }
        addStreets(style)
    }

    // MARK: - Marking by outline: the preview

    private var pulse: CADisplayLink?
    private var pulseStart: CFTimeInterval = 0

    /// The outline drawn to mark streets, and the streets it would mark (flashing), or nothing.
    func setMarkPreview(outline: Ring?, lines: [[CLLocationCoordinate2D]], scribbles: [[CLLocationCoordinate2D]] = []) {
        guard styleReady, let style = view?.style else { return }
        (style.source(withIdentifier: "mark-scribble") as? MLNShapeSource)?.shape = Self.shape(scribbles.isEmpty ? [] : [
            ["type": "Feature", "properties": [:], "geometry": ["type": "MultiLineString", "coordinates": scribbles.map { $0.map { [$0.longitude, $0.latitude] } }]],
        ])
        (style.source(withIdentifier: "mark-outline") as? MLNShapeSource)?.shape = Self.shape(outline.map { r in
            [["type": "Feature", "properties": [:], "geometry": ["type": "Polygon", "coordinates": [(r + r.prefix(1)).map { [$0.longitude, $0.latitude] }]]]]
        } ?? [])
        (style.source(withIdentifier: "mark-preview") as? MLNShapeSource)?.shape = Self.shape(lines.isEmpty ? [] : [
            ["type": "Feature", "properties": [:], "geometry": ["type": "MultiLineString", "coordinates": lines.map { $0.map { [$0.longitude, $0.latitude] } }]],
        ])
        if lines.isEmpty {
            pulse?.invalidate()
            pulse = nil
            (style.layer(withIdentifier: "mark-preview") as? MLNLineStyleLayer)?.lineOpacity = NSExpression(forConstantValue: 0)
        } else if pulse == nil {
            pulseStart = CACurrentMediaTime()
            let link = CADisplayLink(target: self, selector: #selector(pulseTick))
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 30)
            link.add(to: .main, forMode: .common)
            pulse = link
        }
    }

    /// A beat about once a second, brighter and a touch wider, like the web's multi-select.
    @objc private func pulseTick() {
        guard let layer = view?.style?.layer(withIdentifier: "mark-preview") as? MLNLineStyleLayer else { return }
        let t = CACurrentMediaTime() - pulseStart
        let beat = 0.5 - 0.5 * cos(t * 2 * .pi / 1.1)
        layer.lineOpacity = NSExpression(forConstantValue: 0.55 + 0.45 * beat)
        layer.lineWidth = Self.previewWidth(1 + 0.35 * beat)
    }

    private static func previewWidth(_ w: Double) -> NSExpression {
        NSExpression(mglJSONObject: ["interpolate", ["linear"], ["zoom"], 10, 2.5 * w, 12, 4 * w, 16, 9 * w, 19, 16 * w])
    }

    private func applyBase() {
        guard styleReady, let style = view?.style else { return }
        style.layer(withIdentifier: "base-osm")?.isVisible = base == .map
        style.layer(withIdentifier: "base-sat")?.isVisible = base != .map
        style.layer(withIdentifier: "base-ref")?.isVisible = base == .hybrid
    }

    // MARK: - Areas

    func setAreas(_ areas: [Area], colors: [String: String], selected: String?) {
        self.areas = areas
        self.colors = colors
        selectedArea = selected
        renderAreas()
    }

    private func renderAreas() {
        guard styleReady, let src = view?.style?.source(withIdentifier: "areas") as? MLNShapeSource else { return }
        // While drawing: only the areas of the kind being drawn (with "Areas" on), to snap to.
        let drawingShows = session?.visibleOtherIds
        let features: [[String: Any]] = areas.compactMap { a in
            guard let g = a.geometry, drawingShows?.contains(a.id) ?? true else { return nil }
            return ["type": "Feature",
                    "properties": ["id": a.id, "color": colors[a.id] ?? "#1e8a28", "complete": a.isComplete && session == nil,
                                   "selected": a.id == selectedArea && session == nil, "faded": false],
                    "geometry": ["type": "MultiPolygon", "coordinates": g.geoJSONCoordinates]]
        }
        src.shape = Self.shape(features)
    }

    func fit(_ outline: Outline?, bbox: [Double]? = nil, animated: Bool = true) {
        guard let view else { return }
        var sw: CLLocationCoordinate2D, ne: CLLocationCoordinate2D
        if let b = outline?.bounds { (sw, ne) = (b.sw, b.ne) }
        else if let bbox, bbox.count == 4 {
            sw = CLLocationCoordinate2D(latitude: bbox[1], longitude: bbox[0])
            ne = CLLocationCoordinate2D(latitude: bbox[3], longitude: bbox[2])
        } else { return }
        let pad = UIEdgeInsets(top: 90, left: leftInset + 60, bottom: 120, right: 60)
        view.setVisibleCoordinateBounds(MLNCoordinateBounds(sw: sw, ne: ne), edgePadding: pad, animated: animated, completionHandler: nil)
    }

    func setSearchPin(_ c: CLLocationCoordinate2D?) {
        searchPin = c
        guard styleReady, let src = view?.style?.source(withIdentifier: "search-pin") as? MLNShapeSource else { return }
        src.shape = Self.shape(c.map { [["type": "Feature", "properties": [:], "geometry": ["type": "Point", "coordinates": [$0.longitude, $0.latitude]]]] } ?? [])
    }

    private var placeList: [Place] = []

    func setPlaces(_ list: [Place]) {
        placeList = list
        renderPlaces()
    }

    private func renderPlaces() {
        guard styleReady, let src = view?.style?.source(withIdentifier: "places") as? MLNShapeSource else { return }
        src.shape = Self.shape(placeList.map { p in
            ["type": "Feature", "properties": ["id": p.id, "mine": p.mine], "geometry": ["type": "Point", "coordinates": [p.lon, p.lat]]]
        })
    }

    @objc private func tapped(_ r: UITapGestureRecognizer) {
        guard ink == nil, let view else { return }
        let p = r.location(in: view)
        let near = CGRect(x: p.x - 14, y: p.y - 14, width: 28, height: 28)
        if let id = view.visibleFeatures(in: near, styleLayerIdentifiers: ["places"]).first?.attribute(forKey: "id") as? String {
            onPlaceTap?(id)
            return
        }
        let hits = view.visibleFeatures(at: p, styleLayerIdentifiers: ["areas-fill"])
        // Smallest first: tapping inside a neighbourhood that sits inside a city means the neighbourhood.
        let ids = hits.compactMap { $0.attribute(forKey: "id") as? String }
        let pick = ids.compactMap { id in areas.first { $0.id == id } }.min { ($0.km2 ?? .infinity) < ($1.km2 ?? .infinity) }
        if let pick { onAreaTap?(pick.id) }
    }

    // MARK: - Drawing

    func startDrawing(_ s: DrawingSession) {
        session = s
        startInk(s)
        renderAreas()
        renderDrawing()
    }

    func stopDrawing() {
        session = nil
        stopInk()
        renderAreas()
        renderDrawing()
    }

    /// The Pencil draws into `target` (fingers keep moving the map) until `stopInk`.
    func startInk(_ target: PencilTarget) {
        ink?.onChange = nil
        ink = target
        target.onChange = { [weak self] in
            self?.renderDrawing()
            if self?.session != nil { self?.renderAreas() }
        }
        configureGestures()
    }

    func stopInk() {
        ink?.onChange = nil
        ink = nil
        configureGestures()
        overlay.render(nil, view: view)
    }

    /// The map right now, for the drawing to turn screen points into ground and back.
    func frame() -> MapFrame? {
        guard let view else { return nil }
        let b = view.visibleCoordinateBounds
        return MapFrame(
            projection: Projection(toPoint: { [weak view] c in view?.convert(c, toPointTo: view) ?? .zero },
                                   toCoord: { [weak view] p in view?.convert(p, toCoordinateFrom: view) ?? kCLLocationCoordinate2DInvalid }),
            view: (b.sw.latitude, b.sw.longitude, b.ne.latitude, b.ne.longitude))
    }

    private func renderDrawing() {
        overlay.render(ink, view: view)
        guard styleReady, let style = view?.style else { return }
        let s = session
        let pieces: [[String: Any]] = (s?.pieces ?? []).map { p in
            ["type": "Feature", "properties": ["selected": p.id == s?.selected],
             "geometry": ["type": "Polygon", "coordinates": [(p.ring + p.ring.prefix(1)).map { [$0.longitude, $0.latitude] }]]]
        }
        (style.source(withIdentifier: "draw-pieces") as? MLNShapeSource)?.shape = Self.shape(pieces)

        var handles: [[String: Any]] = []
        func point(_ c: CLLocationCoordinate2D, _ kind: String, _ selected: Bool) {
            handles.append(["type": "Feature", "properties": ["kind": kind, "selected": selected],
                            "geometry": ["type": "Point", "coordinates": [c.longitude, c.latitude]]])
        }
        if let s, s.tool == .edit || s.tool == .eraser {
            for p in s.pieces {
                let sel = p.id == s.selected
                for c in p.ring { point(c, "corner", sel) }
                if s.tool == .edit {
                    for i in p.ring.indices {
                        let a = p.ring[i], b = p.ring[(i + 1) % p.ring.count]
                        point(CLLocationCoordinate2D(latitude: (a.latitude + b.latitude) / 2, longitude: (a.longitude + b.longitude) / 2), "mid", sel)
                    }
                }
            }
        }
        if let s, !s.inProgress.isEmpty {
            for (i, c) in s.inProgress.enumerated() { point(c, i == 0 && s.inProgress.count >= 3 ? "first" : "corner", false) }
        }
        (style.source(withIdentifier: "draw-handles") as? MLNShapeSource)?.shape = Self.shape(handles)

        var progress: [[String: Any]] = []
        if let s, s.inProgress.count >= 2 {
            progress.append(["type": "Feature", "properties": [:],
                             "geometry": ["type": "LineString", "coordinates": s.inProgress.map { [$0.longitude, $0.latitude] }]])
        }
        (style.source(withIdentifier: "draw-progress") as? MLNShapeSource)?.shape = Self.shape(progress)
    }

    // MARK: - Pencil, fingers, and gestures

    private let pencil = PencilRecognizer()
    private let twoFingerTap = UITapGestureRecognizer()
    private let threeFingerTap = UITapGestureRecognizer()
    private var mapPinchAndPan: [UIGestureRecognizer] = []

    /// While drawing, the map's own gestures take only fingers (and a trackpad), so the Pencil
    /// never pans it; ours take only the Pencil. With "Draw with finger", one finger draws
    /// and the map needs two fingers to move.
    private func configureGestures() {
        guard let view else { return }
        let drawing = ink != nil
        let ours: Set<UIGestureRecognizer> = [pencil, twoFingerTap, threeFingerTap]
        let fingers = [UITouch.TouchType.direct, .indirectPointer].map { NSNumber(value: $0.rawValue) }
        let all = [UITouch.TouchType.direct, .indirect, .pencil, .indirectPointer].map { NSNumber(value: $0.rawValue) }
        for r in view.gestureRecognizers ?? [] where !ours.contains(r) && !(r is UIHoverGestureRecognizer) {
            r.allowedTouchTypes = drawing ? fingers : all
            if let pan = r as? UIPanGestureRecognizer, !(r is UIScreenEdgePanGestureRecognizer) {
                pan.minimumNumberOfTouches = drawing && fingerDraws ? 2 : 1
            }
            // MapLibre's two-finger tap zooms out; while drawing, it's undo.
            if let tap = r as? UITapGestureRecognizer, tap.numberOfTouchesRequired == 2, tap !== twoFingerTap {
                tap.isEnabled = !drawing
            }
        }
        pencil.isEnabled = drawing
        pencil.allowedTouchTypes = ([.pencil] + (fingerDraws ? [.direct] : [UITouch.TouchType]())).map { NSNumber(value: $0.rawValue) }
        twoFingerTap.isEnabled = drawing
        threeFingerTap.isEnabled = drawing
    }

    @objc private func pencilMoved(_ r: PencilRecognizer) {
        guard let s = ink, let f = frame() else { return }
        switch r.state {
        case .began: s.began(r.points.first ?? r.location(in: view), f); s.moved(Array(r.points.dropFirst()), f)
        case .changed: s.moved(r.points, f)
        case .ended: s.moved(r.points, f); s.ended(r.location(in: view), f)
        case .cancelled, .failed: s.cancelled()
        default: break
        }
        r.points.removeAll()
    }

    @objc private func undoTap() { ink?.undo() }
    @objc private func redoTap() { ink?.redo() }

    @objc private func hovered(_ r: UIHoverGestureRecognizer) {
        guard let s = ink, let f = frame() else { return }
        // A Pencil hovering above the screen (it reports a height); a trackpad pointer doesn't.
        let isPencil = r.zOffset > 0
        switch r.state {
        case .began, .changed: s.hovering(isPencil ? r.location(in: view) : nil, f)
        default: s.hovering(nil, f)
        }
    }

    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        guard UIPencilInteraction.preferredTapAction != .ignore else { return }
        ink?.swapTool()
    }

    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        guard squeeze.phase == .ended, UIPencilInteraction.preferredSqueezeAction != .ignore else { return }
        ink?.swapTool()
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
    }

    // MARK: - Camera

    func mapView(_ mapView: MLNMapView, regionIsChangingWith reason: MLNCameraChangeReason) {
        overlay.render(ink, view: view)
    }

    func mapView(_ mapView: MLNMapView, regionDidChangeAnimated animated: Bool) {
        Camera.save(center: mapView.centerCoordinate, zoom: mapView.zoomLevel)
        overlay.render(ink, view: view)
        if let f = frame() { onSettle?(f) }
    }

    private static func shape(_ features: [[String: Any]]) -> MLNShape? {
        let fc: [String: Any] = ["type": "FeatureCollection", "features": features]
        guard let data = try? JSONSerialization.data(withJSONObject: fc) else { return nil }
        return try? MLNShape(data: data, encoding: String.Encoding.utf8.rawValue)
    }
}

/// Follows one Pencil (or finger, if allowed) from touch-down to lift, collecting every
/// point it passed through, coalesced ones included, so fast strokes stay smooth.
final class PencilRecognizer: UIGestureRecognizer {
    var points: [CGPoint] = []
    private var tracked: UITouch?

    override init(target: Any?, action: Selector?) {
        super.init(target: target, action: action)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }
    convenience init() { self.init(target: nil, action: nil) }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        if tracked != nil {
            // A second finger while drawing with a finger: that's the map being moved, not drawing.
            if touches.contains(where: { $0.type == .direct }) && tracked?.type == .direct { state = .cancelled }
            return
        }
        guard let t = touches.first else { return }
        tracked = t
        points = [t.location(in: view)]
        state = .began
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let t = tracked, touches.contains(t) else { return }
        points += (event.coalescedTouches(for: t) ?? [t]).map { $0.location(in: view) }
        state = .changed
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let t = tracked, touches.contains(t) else { return }
        points += (event.coalescedTouches(for: t) ?? []).map { $0.location(in: view) }
        state = .ended
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let t = tracked, touches.contains(t) else { return }
        state = .cancelled
    }

    override func reset() {
        super.reset()
        tracked = nil
        points = []
    }
}

/// The live stroke (lasso or eraser) and the hover dot: drawn in screen space for speed,
/// re-placed from their coordinates whenever the map moves.
final class DrawingOverlay: UIView {
    private let strokeLayer = CAShapeLayer()
    private let hoverLayer = CAShapeLayer()
    private let bandLayer = CAShapeLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        strokeLayer.fillColor = UIColor.clear.cgColor
        strokeLayer.lineWidth = 3
        strokeLayer.lineCap = .round
        strokeLayer.lineJoin = .round
        hoverLayer.lineWidth = 2
        bandLayer.fillColor = UIColor.clear.cgColor
        bandLayer.lineWidth = 2.5
        bandLayer.lineDashPattern = [7, 5]
        bandLayer.lineCap = .round
        layer.addSublayer(bandLayer)
        layer.addSublayer(strokeLayer)
        layer.addSublayer(hoverLayer)
    }
    required init?(coder: NSCoder) { fatalError() }

    @MainActor func render(_ s: PencilTarget?, view: MLNMapView?) {
        guard let view else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let orange = UIColor(red: 0.886, green: 0.447, blue: 0.122, alpha: 1)
        let path = UIBezierPath()
        if let s, s.stroke.count >= 2 {
            path.move(to: view.convert(s.stroke[0], toPointTo: self))
            for c in s.stroke.dropFirst() { path.addLine(to: view.convert(c, toPointTo: self)) }
            if s.strokeStyle == .lasso { path.close() }
        }
        strokeLayer.path = path.cgPath
        switch s?.strokeStyle {
        case .eraser?:
            strokeLayer.strokeColor = UIColor.systemRed.withAlphaComponent(0.5).cgColor
            strokeLayer.lineWidth = 2 * DrawingSession.snapRadius
        case .scribble?:
            strokeLayer.strokeColor = orange.withAlphaComponent(0.35).cgColor
            strokeLayer.lineWidth = 20
        default:
            strokeLayer.strokeColor = orange.withAlphaComponent(0.9).cgColor
            strokeLayer.lineWidth = 3
        }

        if let band = s?.rubberBand {
            let p = UIBezierPath()
            p.move(to: view.convert(band.from, toPointTo: self))
            p.addLine(to: view.convert(band.to, toPointTo: self))
            bandLayer.path = p.cgPath
            bandLayer.strokeColor = orange.withAlphaComponent(0.85).cgColor
        } else {
            bandLayer.path = nil
        }

        if let h = s?.hover {
            let p = view.convert(h.coord, toPointTo: self)
            let color = h.snapped ? UIColor(red: 0.486, green: 0.227, blue: 0.929, alpha: 1) : orange
            hoverLayer.path = UIBezierPath(ovalIn: CGRect(x: p.x - 7, y: p.y - 7, width: 14, height: 14)).cgPath
            hoverLayer.fillColor = color.withAlphaComponent(0.3).cgColor
            hoverLayer.strokeColor = color.cgColor
        } else {
            hoverLayer.path = nil
        }
        CATransaction.commit()
    }
}

/// Where the map was left, so it opens there next time.
enum Camera {
    static func load() -> (center: CLLocationCoordinate2D, zoom: Double) {
        let d = UserDefaults.standard
        guard d.object(forKey: "map.lat") != nil else {
            return (CLLocationCoordinate2D(latitude: 30.2672, longitude: -97.7431), 11) // Austin
        }
        return (CLLocationCoordinate2D(latitude: d.double(forKey: "map.lat"), longitude: d.double(forKey: "map.lon")), d.double(forKey: "map.zoom"))
    }

    static func save(center: CLLocationCoordinate2D, zoom: Double) {
        let d = UserDefaults.standard
        d.set(center.latitude, forKey: "map.lat")
        d.set(center.longitude, forKey: "map.lon")
        d.set(zoom, forKey: "map.zoom")
    }
}

/// SwiftUI's handle on the map: the controller does the work.
struct MapView: UIViewRepresentable {
    let controller: MapController
    let server: URL
    let token: String

    func makeUIView(context: Context) -> MLNMapView {
        MapController.authorize(token)
        return controller.makeView(server: server)
    }

    func updateUIView(_ view: MLNMapView, context: Context) {}
}
