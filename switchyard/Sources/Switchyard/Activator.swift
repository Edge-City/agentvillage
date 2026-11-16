import AppKit

enum Activator {
    static func activate(_ entry: WindowEntry) {
        let app = entry.app
        if app.isHidden { app.unhide() }

        if entry.isAppOnly {
            // Same effect as clicking the Dock icon: the app comes forward and
            // gets a chance to reopen a window.
            app.activate(options: [.activateAllWindows])
            if let url = app.bundleURL {
                NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
            }
            return
        }

        if let ax = entry.ax, entry.isMinimized {
            AXUIElementSetAttributeValue(ax, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
        }

        var focused = false
        if entry.id != 0 {
            var psn = ProcessSerialNumber()
            if GetProcessForPID(entry.pid, &psn) == noErr {
                // Brings exactly this window forward (following it to its Space)
                // instead of whichever window the app considers its main one.
                _ = _SLPSSetFrontProcessWithOptions(&psn, entry.id, 0x200)
                makeKeyWindow(&psn, entry.id)
                focused = true
            }
        }
        if let ax = entry.ax {
            AXUIElementPerformAction(ax, kAXRaiseAction as CFString)
            AXUIElementSetAttributeValue(ax, kAXMainAttribute as CFString, kCFBooleanTrue)
        }
        if !focused {
            app.activate(options: [.activateIgnoringOtherApps])
        }
    }

    static func close(_ entry: WindowEntry) -> Bool {
        guard let ax = entry.ax, let button = AX.element(ax, kAXCloseButtonAttribute) else { return false }
        return AXUIElementPerformAction(button, kAXPressAction as CFString) == .success
    }

    static func quit(_ entry: WindowEntry) {
        entry.app.terminate()
    }

    /// Posts the pair of synthetic window-server events that make a window key.
    private static func makeKeyWindow(_ psn: inout ProcessSerialNumber, _ wid: CGWindowID) {
        var bytes = [UInt8](repeating: 0, count: 0xf8)
        bytes[0x04] = 0xf8
        bytes[0x3a] = 0x10
        withUnsafeBytes(of: wid) { raw in
            for i in 0..<4 { bytes[0x3c + i] = raw[i] }
        }
        for i in 0x20..<0x30 { bytes[i] = 0xff }
        bytes[0x08] = 0x01
        _ = SLPSPostEventRecordTo(&psn, &bytes)
        bytes[0x08] = 0x02
        _ = SLPSPostEventRecordTo(&psn, &bytes)
    }
}
