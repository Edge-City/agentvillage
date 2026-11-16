import AppKit

// Undocumented window-server and accessibility calls. Public API cannot
// (a) map an accessibility window to its CGWindowID, (b) see windows on other
// Spaces, (c) focus one specific window of another app, or (d) capture a
// window that is not on screen. Every serious macOS window switcher relies on
// these same symbols; they have been stable since macOS 10.12.

typealias CGSConnectionID = UInt32

@_silgen_name("CGSMainConnectionID")
func CGSMainConnectionID() -> CGSConnectionID

@_silgen_name("CGSCopySpacesForWindows")
func CGSCopySpacesForWindows(_ cid: CGSConnectionID, _ mask: Int, _ wids: CFArray) -> CFArray

@_silgen_name("CGSCopyManagedDisplaySpaces")
func CGSCopyManagedDisplaySpaces(_ cid: CGSConnectionID) -> CFArray

@_silgen_name("CGSHWCaptureWindowList")
func CGSHWCaptureWindowList(
    _ cid: CGSConnectionID, _ windowList: UnsafePointer<CGWindowID>, _ count: UInt32, _ options: UInt32
) -> Unmanaged<CFArray>

@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ wid: UnsafeMutablePointer<CGWindowID>) -> AXError

@_silgen_name("_AXUIElementCreateWithRemoteToken")
func _AXUIElementCreateWithRemoteToken(_ data: CFData) -> Unmanaged<AXUIElement>?

@_silgen_name("GetProcessForPID")
func GetProcessForPID(_ pid: pid_t, _ psn: UnsafeMutablePointer<ProcessSerialNumber>) -> OSStatus

@_silgen_name("_SLPSSetFrontProcessWithOptions")
func _SLPSSetFrontProcessWithOptions(
    _ psn: UnsafeMutablePointer<ProcessSerialNumber>, _ wid: CGWindowID, _ mode: UInt32
) -> CGError

@_silgen_name("SLPSPostEventRecordTo")
func SLPSPostEventRecordTo(
    _ psn: UnsafeMutablePointer<ProcessSerialNumber>, _ bytes: UnsafeMutablePointer<UInt8>
) -> CGError

enum CaptureOption {
    static let nominalResolution: UInt32 = 1 << 9
    static let ignoreGlobalClipShape: UInt32 = 1 << 11
}

// MARK: - Accessibility helpers

enum AX {
    static func value(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value
    }

    static func string(_ element: AXUIElement, _ attribute: String) -> String? {
        value(element, attribute) as? String
    }

    static func bool(_ element: AXUIElement, _ attribute: String) -> Bool {
        (value(element, attribute) as? Bool) ?? false
    }

    static func element(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let v = value(element, attribute), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    static func windows(_ app: AXUIElement) -> [AXUIElement] {
        guard let list = value(app, kAXWindowsAttribute) as? [AnyObject] else { return [] }
        return list.compactMap { item in
            CFGetTypeID(item) == AXUIElementGetTypeID() ? (item as! AXUIElement) : nil
        }
    }

    static func size(_ element: AXUIElement) -> CGSize? {
        guard let v = value(element, kAXSizeAttribute), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var size = CGSize.zero
        return AXValueGetValue(v as! AXValue, .cgSize, &size) ? size : nil
    }

    static func windowID(_ element: AXUIElement) -> CGWindowID {
        var wid: CGWindowID = 0
        return _AXUIElementGetWindow(element, &wid) == .success ? wid : 0
    }

    /// True for things a person would call a window (not tooltips, popovers, sheets-in-flight).
    static func isSwitchable(_ window: AXUIElement) -> Bool {
        let subrole = string(window, kAXSubroleAttribute)
        if subrole == kAXStandardWindowSubrole || subrole == kAXDialogSubrole { return true }
        // Some toolkits (Java, games, older Electron) report no subrole at all.
        // Accept those when they look like a real window, so the app is never invisible.
        if subrole == nil || subrole == kAXUnknownSubrole {
            guard let size = size(window) else { return false }
            return size.width >= 200 && size.height >= 150
        }
        return false
    }
}
