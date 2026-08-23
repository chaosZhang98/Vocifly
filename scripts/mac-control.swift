import Foundation
import AppKit
import ApplicationServices

// 辅助功能权限自检：CGEvent.post 合成键盘/鼠标事件必须依赖「辅助功能」权限，
// 否则事件会被系统静默丢弃（不报错）。这里用 AXIsProcessTrusted() 在注入前探测，
// 无权限时回 NOPERM 让上层如实上报，而不是像以前那样无条件回 OK 造成「假成功」。
func hasAccessibilityPermission() -> Bool {
    return AXIsProcessTrusted()
}

func postKey(_ keyCode: CGKeyCode, flags: CGEventFlags = []) {
    let source = CGEventSource(stateID: .hidSystemState)
    let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true)
    down?.flags = flags
    down?.post(tap: .cghidEventTap)
    let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)
    up?.flags = flags
    up?.post(tap: .cghidEventTap)
}

func paste(base64: String) {
    guard let data = Data(base64Encoded: base64), let text = String(data: data, encoding: .utf8) else { return }
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString(text, forType: .string)
    postKey(9, flags: .maskCommand) // V
}

// 图片：解码后经 NSImage 写剪贴板（兼容多数 App 如微信/QQ），并保留原始像素类型
func pasteImage(base64: String) {
    guard let data = Data(base64Encoded: base64) else { return }
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    if let image = NSImage(data: data) {
        pasteboard.writeObjects([image])
    }
    let type: NSPasteboard.PasteboardType
    if data.starts(with: [0x89, 0x50, 0x4E, 0x47]) {
        type = NSPasteboard.PasteboardType("public.png")
    } else if data.starts(with: [0xFF, 0xD8, 0xFF]) {
        type = NSPasteboard.PasteboardType("public.jpeg")
    } else if data.starts(with: [0x47, 0x49, 0x46]) {
        type = NSPasteboard.PasteboardType("public.gif")
    } else {
        type = NSPasteboard.PasteboardType("public.tiff")
    }
    pasteboard.setData(data, forType: type)
    postKey(9, flags: .maskCommand) // V
}

// 文件：字节原样写临时文件，再把 fileURL 放到剪贴板，模拟粘贴文件
func pasteFile(nameBase64: String, fileBase64: String) {
    guard let fileData = Data(base64Encoded: fileBase64) else { return }
    let safeName = (nameBase64.isEmpty ? "file" : (String(data: Data(base64Encoded: nameBase64) ?? Data(), encoding: .utf8) ?? "file")) as NSString
    let finalName = safeName.lastPathComponent.isEmpty ? "file" : safeName.lastPathComponent
    let tmpDir = NSTemporaryDirectory()
    let url = URL(fileURLWithPath: tmpDir).appendingPathComponent(UUID().uuidString + "-" + finalName)
    do {
        try fileData.write(to: url)
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.writeObjects([url as NSURL])
        postKey(9, flags: .maskCommand) // V
    } catch {
        // 写临时文件失败：忽略，避免崩溃
    }
}

func activate(bundleId: String) {
    NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first?.activate(options: [.activateAllWindows])
}

while let line = readLine() {
    let parts = line.split(separator: " ").map(String.init)
    guard let cmd = parts.first else { continue }
    // ACTIVATE（激活应用）不注入按键，无需辅助功能权限；其余命令都要合成键盘事件，
    // 无权限时直接回 NOPERM，避免静默丢弃事件后仍回 OK 造成「假成功」。
    if cmd != "ACTIVATE" && !hasAccessibilityPermission() {
        print("NOPERM " + cmd)
        fflush(stdout)
        continue
    }
    switch cmd {
    case "PASTE":
        if parts.count >= 2 { paste(base64: parts[1]) }
    case "PASTE_IMAGE":
        if parts.count >= 2 { pasteImage(base64: parts[1]) }
    case "PASTE_FILE":
        if parts.count >= 3 { pasteFile(nameBase64: parts[1], fileBase64: parts[2]) }
    case "ENTER":
        postKey(36)
    case "ENTER_CMD":
        postKey(36, flags: .maskCommand)
    case "ENTER_CTRL":
        postKey(36, flags: .maskControl)
    case "UNDO":
        postKey(6, flags: .maskCommand)
    case "BACKSPACE":
        if parts.count >= 2, let n = Int(parts[1]) {
            for _ in 0..<min(n, 500) { postKey(51) }
        }
    case "TAB_CMD":
        postKey(48, flags: .maskCommand)
    case "TAB_CMD_SHIFT":
        postKey(48, flags: [.maskCommand, .maskShift])
    case "MISSION":
        postKey(126, flags: .maskControl)
    case "EXPOSE":
        postKey(125, flags: .maskControl)
    case "ACTIVATE":
        if parts.count >= 2 { activate(bundleId: parts[1]) }
    case "CLOSE_WINDOW":
        postKey(13, flags: .maskCommand) // W
    case "QUIT_APP":
        postKey(12, flags: .maskCommand) // Q
    default:
        break
    }
    print("OK " + cmd)
    fflush(stdout)
}
