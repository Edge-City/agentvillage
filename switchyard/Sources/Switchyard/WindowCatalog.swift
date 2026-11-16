import AppKit

final class WindowEntry {
    let id: CGWindowID          // 0 when the entry stands for an app with no windows
    let app: NSRunningApplication
    var ax: AXUIElement?
    let title: String
    let isMinimized: Bool
    let isOnScreen: Bool
    let isAppOnly: Bool

    var pid: pid_t { app.processIdentifier }
    var appName: String { app.localizedName ?? "Unknown" }
    var displayTitle: String { title.isEmpty ? appName : title }

    init(id: CGWindowID, app: NSRunningApplication, ax: AXUIElement?, title: String,
         isMinimized: Bool = false, isOnScreen: Bool = false, isAppOnly: Bool = false) {
        self.id = id
        self.app = app
        self.ax = ax
        self.title = title
        self.isMinimized = isMinimized
        self.isOnScreen = isOnScreen
        self.isAppOnly = isAppOnly
    }
}

/// Builds the list of things you can switch to. Three sources are merged so that
/// no running app is ever missing:
///   1. Accessibility windows of every regular app (current Space, minimized, hidden).
///   2. Window-server windows that live on other Spaces or in full screen.
///   3. A fallback entry for any regular app that produced no window at all.
final class WindowCatalog {
    private let cid = CGSMainConnectionID()
    private var mru: [CGWindowID] = []
    private var axCache: [CGWindowID: AXUIElement] = [:]
    private var resolving = Set<pid_t>()

    func noteActivated(_ entry: WindowEntry) {
        guard entry.id != 0 else { return }
        touch(entry.id)
    }

    private func touch(_ id: CGWindowID) {
        mru.removeAll { $0 == id }
        mru.insert(id, at: 0)
        if mru.count > 200 { mru.removeLast(mru.count - 200) }
    }

    func snapshot(onlyPID: pid_t? = nil) -> [WindowEntry] {
        let me = ProcessInfo.processInfo.processIdentifier
        let apps = NSWorkspace.shared.runningApplications.filter {
            $0.activationPolicy == .regular && !$0.isTerminated && $0.processIdentifier != me
                && (onlyPID == nil || $0.processIdentifier == onlyPID)
        }
        let appByPID = Dictionary(apps.map { ($0.processIdentifier, $0) }, uniquingKeysWith: { a, _ in a })

        // Front-to-back order of what is visible right now.
        var zRank: [CGWindowID: Int] = [:]
        for (i, info) in windowInfo([.optionOnScreenOnly, .excludeDesktopElements]).enumerated() {
            guard (info[kCGWindowLayer as String] as? Int) == 0,
                  let wid = info[kCGWindowNumber as String] as? CGWindowID else { continue }
            zRank[wid] = i
        }

        var entries: [WindowEntry] = []
        var seen = Set<CGWindowID>()
        var appsWithWindows = Set<pid_t>()

        // 1. Accessibility windows.
        for app in apps {
            let axApp = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(axApp, 0.25) // a hung app must not stall the switcher
            for window in AX.windows(axApp) where AX.isSwitchable(window) {
                let wid = AX.windowID(window)
                if wid != 0 {
                    guard !seen.contains(wid) else { continue }
                    seen.insert(wid)
                    axCache[wid] = window
                }
                entries.append(WindowEntry(
                    id: wid, app: app, ax: window,
                    title: AX.string(window, kAXTitleAttribute) ?? "",
                    isMinimized: AX.bool(window, kAXMinimizedAttribute),
                    isOnScreen: zRank[wid] != nil))
                appsWithWindows.insert(app.processIdentifier)
            }
        }

        // 2. Windows on other Spaces (including other apps' full screen Spaces).
        let visibleSpaces = currentSpaces()
        for info in windowInfo([.excludeDesktopElements]) {
            guard (info[kCGWindowLayer as String] as? Int) == 0,
                  let wid = info[kCGWindowNumber as String] as? CGWindowID, !seen.contains(wid),
                  let pid = info[kCGWindowOwnerPID as String] as? pid_t, let app = appByPID[pid],
                  ((info[kCGWindowAlpha as String] as? Double) ?? 1) > 0,
                  let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
                  bounds.width >= 200, bounds.height >= 150 else { continue }
            let spaces = spacesFor(wid)
            guard !spaces.isEmpty, spaces.isDisjoint(with: visibleSpaces) else { continue }
            seen.insert(wid)
            let ax = axCache[wid]
            if ax == nil { resolveInBackground(pid: pid) }
            entries.append(WindowEntry(
                id: wid, app: app, ax: ax,
                title: (info[kCGWindowName as String] as? String) ?? ""))
            appsWithWindows.insert(pid)
        }

        // 3. Apps that produced nothing still get an entry.
        for app in apps where !appsWithWindows.contains(app.processIdentifier) {
            entries.append(WindowEntry(id: 0, app: app, ax: nil, title: "", isAppOnly: true))
        }

        return ordered(entries, zRank: zRank)
    }

    /// Visible windows keep the window server's front-to-back order. Everything
    /// else follows by how recently this switcher focused it. The last window you
    /// came from is pulled to slot 2 even when it sits on another Space, so a
    /// quick tap always toggles between your two most recent windows.
    private func ordered(_ entries: [WindowEntry], zRank: [CGWindowID: Int]) -> [WindowEntry] {
        var onScreen = entries.filter { $0.isOnScreen }
        onScreen.sort { (zRank[$0.id] ?? .max) < (zRank[$1.id] ?? .max) }

        let front = onScreen.first?.id
        let previous = mru.first { $0 != front }
        if let front { touch(front) }

        let rank = Dictionary(mru.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
        var rest = entries.filter { !$0.isOnScreen && !$0.isAppOnly }
        // Stable: sort by (rank, original position).
        let positioned = rest.enumerated().sorted { a, b in
            let ra = rank[a.element.id] ?? .max, rb = rank[b.element.id] ?? .max
            return ra != rb ? ra < rb : a.offset < b.offset
        }
        rest = positioned.map { $0.element }

        var result = onScreen
        if let previous, let i = rest.firstIndex(where: { $0.id == previous }) {
            result.insert(rest.remove(at: i), at: min(1, result.count))
        }
        result += rest
        result += entries.filter { $0.isAppOnly }
        return result
    }

    private func windowInfo(_ options: CGWindowListOption) -> [[String: Any]] {
        (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]) ?? []
    }

    private func currentSpaces() -> Set<UInt64> {
        var result = Set<UInt64>()
        guard let displays = CGSCopyManagedDisplaySpaces(cid) as? [[String: Any]] else { return result }
        for display in displays {
            guard let current = display["Current Space"] as? [String: Any] else { continue }
            if let id = (current["id64"] ?? current["ManagedSpaceID"]) as? NSNumber {
                result.insert(id.uint64Value)
            }
        }
        return result
    }

    private func spacesFor(_ wid: CGWindowID) -> Set<UInt64> {
        let ids = CGSCopySpacesForWindows(cid, 7, [NSNumber(value: wid)] as CFArray) as? [NSNumber] ?? []
        return Set(ids.map { $0.uint64Value })
    }

    /// The accessibility API only lists windows on the current Space. Elements
    /// for the others can still be obtained by constructing their remote tokens
    /// directly. This takes a while, so it runs off the main thread and the
    /// result is cached for the next time the switcher opens.
    private func resolveInBackground(pid: pid_t) {
        guard !resolving.contains(pid) else { return }
        resolving.insert(pid)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var found: [CGWindowID: AXUIElement] = [:]
            var token = Data(count: 20)
            token.replaceSubrange(0..<4, with: withUnsafeBytes(of: pid) { Data($0) })
            token.replaceSubrange(4..<8, with: withUnsafeBytes(of: Int32(0)) { Data($0) })
            token.replaceSubrange(8..<12, with: withUnsafeBytes(of: Int32(0x636f_636f)) { Data($0) })
            let deadline = Date().addingTimeInterval(2)
            for elementID in UInt64(0)..<1000 {
                if Date() > deadline { break }
                token.replaceSubrange(12..<20, with: withUnsafeBytes(of: elementID) { Data($0) })
                guard let element = _AXUIElementCreateWithRemoteToken(token as CFData)?.takeRetainedValue()
                else { continue }
                let subrole = AX.string(element, kAXSubroleAttribute)
                guard subrole == kAXStandardWindowSubrole || subrole == kAXDialogSubrole else { continue }
                let wid = AX.windowID(element)
                if wid != 0 { found[wid] = element }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.axCache.merge(found) { _, new in new }
                self.resolving.remove(pid)
            }
        }
    }

    func cachedElement(for id: CGWindowID) -> AXUIElement? { axCache[id] }
}
