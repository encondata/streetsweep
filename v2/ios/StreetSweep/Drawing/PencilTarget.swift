import CoreGraphics
import CoreLocation

/// Something the Apple Pencil draws into on the map: an area's outline being drawn, or an
/// outline of streets to mark done. The map feeds it the Pencil's points (and hover, undo
/// taps, Pencil double-tap/squeeze) and draws its live stroke.
@MainActor
protocol PencilTarget: AnyObject {
    /// The Pencil's path right now, for the map to draw.
    var stroke: [CLLocationCoordinate2D] { get }
    var strokeStyle: StrokeStyle { get }
    /// Where a hovering Pencil would land, and whether it would snap.
    var hover: (coord: CLLocationCoordinate2D, snapped: Bool)? { get }
    /// Called after anything visible changes, so the map redraws.
    var onChange: (() -> Void)? { get set }

    func began(_ p: CGPoint, _ map: MapFrame)
    func moved(_ points: [CGPoint], _ map: MapFrame)
    func ended(_ p: CGPoint, _ map: MapFrame)
    func cancelled()
    func hovering(_ p: CGPoint?, _ map: MapFrame)
    func undo()
    func redo()
    /// Pencil double-tap or squeeze.
    func swapTool()
}

enum StrokeStyle {
    /// A closed loop, drawn as a thin line.
    case lasso
    /// A wide, faint red band.
    case eraser
}

extension DrawingSession: PencilTarget {
    var strokeStyle: StrokeStyle { tool == .eraser ? .eraser : .lasso }
}
