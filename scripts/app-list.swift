import AppKit
import Foundation

// 用法：
//   app-list              -> 列出当前正在运行（regular）的应用
//   app-list --front      -> 输出当前前台应用（单对象）
//   app-list --all        -> 列出系统级 + 非系统级全部已安装应用（按名称排序）

if CommandLine.arguments.contains("--front") {
    if let app = NSWorkspace.shared.frontmostApplication {
        let dict: [String: String] = [
            "name": app.localizedName ?? (app.bundleIdentifier ?? ""),
            "bundleId": app.bundleIdentifier ?? "",
        ]
        if let data = try? JSONSerialization.data(withJSONObject: dict),
           let text = String(data: data, encoding: .utf8) {
            print(text)
        }
    }
    exit(0)
}

struct AppItem: Encodable {
    let name: String
    let bundleId: String
    let icon: String
}

func iconPNG(forPath path: String, size: Int = 64) -> String? {
    let image = NSWorkspace.shared.icon(forFile: path)
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size,
        pixelsHigh: size,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .calibratedRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
    return png.base64EncodedString()
}

// ---------- --all：列出全部已安装应用（Launchpad 风格） ----------
if CommandLine.arguments.contains("--all") {
    let fm = FileManager.default
    var roots: [URL] = []
    for dir in ["/System/Applications", "/System/Applications/Utilities", "/Applications"] {
        roots.append(URL(fileURLWithPath: dir, isDirectory: true))
    }
    let home = fm.homeDirectoryForCurrentUser
    let userApps = home.appendingPathComponent("Applications", isDirectory: true)
    if fm.fileExists(atPath: userApps.path) { roots.append(userApps) }

    var seen = Set<String>()
    var items: [AppItem] = []

    for root in roots {
        guard let enumerator = fm.enumerator(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { continue }
        for case let url as URL in enumerator {
            if url.pathExtension != "app" { continue }
            guard let bundle = Bundle(url: url),
                  let bundleId = bundle.bundleIdentifier else { continue }
            // 过滤后台代理 / 仅菜单栏应用，只保留可通过 Launchpad 启动的用户应用
            let lsui = bundle.object(forInfoDictionaryKey: "LSUIElement") as? Bool ?? false
            let bgOnly = bundle.object(forInfoDictionaryKey: "LSBackgroundOnly") as? Bool ?? false
            if lsui || bgOnly { continue }
            // 跳过应用包内部的 Helper / 插件 / 渲染进程（路径含 /Contents/，或 bundleId 含 .helper），
            // 它们不是可以独立启动的用户 App
            if url.path.contains("/Contents/") { continue }
            if bundleId.lowercased().contains(".helper") { continue }
            if seen.contains(bundleId) { continue }
            seen.insert(bundleId)
            let name = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
                       ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String
                       ?? url.deletingPathExtension().lastPathComponent
            let icon = iconPNG(forPath: url.path) ?? ""
            items.append(AppItem(name: name, bundleId: bundleId, icon: icon))
        }
    }

    items.sort { $0.name.lowercased() < $1.name.lowercased() }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    let data = (try? encoder.encode(items)) ?? Data()
    print(String(data: data, encoding: .utf8) ?? "[]")
    exit(0)
}

// ---------- 默认：列出正在运行的应用 ----------
let apps = NSWorkspace.shared.runningApplications
var seen = Set<String>()
var items: [AppItem] = []

for app in apps where app.activationPolicy == .regular {
    guard let bundleId = app.bundleIdentifier, !seen.contains(bundleId) else { continue }
    seen.insert(bundleId)
    let name = app.localizedName ?? bundleId
    let icon: String
    if let url = app.bundleURL {
        icon = iconPNG(forPath: url.path) ?? ""
    } else {
        icon = ""
    }
    items.append(AppItem(name: name, bundleId: bundleId, icon: icon))
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.withoutEscapingSlashes]
let data = try encoder.encode(items)
print(String(data: data, encoding: .utf8) ?? "[]")
