import Foundation
import CoreGraphics

func currentPoint() -> CGPoint {
    CGEvent(source: nil)?.location ?? .zero
}

/// 把目标坐标钳制到当前光标所在显示器的可见范围内。
/// 光标在屏幕边缘被系统钳制后，CGEvent.location 仍可能记录出屏坐标；
/// 若不加钳制，连续朝边缘推入的增量会让出屏偏移不断累积，导致反向移动时
/// 必须先“消耗”这段偏移，光标才会真正动起来。这里在写入事件前直接钳制，
/// 从源头消除该累积。
func clampToDisplay(_ point: CGPoint, near ref: CGPoint) -> CGPoint {
    var displayID = CGMainDisplayID()
    var count: UInt32 = 0
    var displays: [CGDirectDisplayID] = [0, 0, 0, 0]
    let found = CGGetDisplaysWithPoint(ref, UInt32(displays.count), &displays, &count)
    if found == .success, count > 0 {
        displayID = displays[0]
    }
    let b = CGDisplayBounds(displayID)
    return CGPoint(
        x: min(max(point.x, b.minX), b.maxX),
        y: min(max(point.y, b.minY), b.maxY)
    )
}

func postMouse(_ type: CGEventType, at point: CGPoint) {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?.post(tap: CGEventTapLocation.cghidEventTap)
}

func scrollEvent(dx: Int32, dy: Int32) {
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0) else { return }
    event.setIntegerValueField(CGEventField.scrollWheelEventDeltaAxis2, value: Int64(dx))
    event.post(tap: CGEventTapLocation.cghidEventTap)
}

while let line = readLine() {
    let parts = line.split(separator: " ").map(String.init)
    guard let cmd = parts.first else { continue }
    switch cmd {
    case "M":
        guard parts.count >= 3, let dx = Double(parts[1]), let dy = Double(parts[2]) else { continue }
        let p = currentPoint()
        let target = CGPoint(x: p.x + dx, y: p.y + dy)
        postMouse(.mouseMoved, at: clampToDisplay(target, near: p))
    case "C":
        let p = currentPoint()
        postMouse(.leftMouseDown, at: p)
        postMouse(.leftMouseUp, at: p)
    case "D":
        postMouse(.leftMouseDown, at: currentPoint())
    case "U":
        postMouse(.leftMouseUp, at: currentPoint())
    case "R":
        let p = currentPoint()
        postMouse(.rightMouseDown, at: p)
        postMouse(.rightMouseUp, at: p)
    case "S":
        guard parts.count >= 3, let dx = Int32(parts[1]), let dy = Int32(parts[2]) else { continue }
        scrollEvent(dx: dx, dy: -dy)
    default:
        break
    }
}
