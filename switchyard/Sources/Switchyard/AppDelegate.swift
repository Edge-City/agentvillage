import AppKit
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let switcher = SwitcherController()
    private var statusItem: NSStatusItem!
    private var permissionTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(
            systemSymbolName: "rectangle.on.rectangle", accessibilityDescription: "Switchyard")
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu

        // Thumbnails are optional; ask once and carry on either way.
        if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }

        // The keyboard tap cannot exist without Accessibility. Prompt, then
        // start by ourselves the moment the permission is granted.
        let prompt = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        if AXIsProcessTrustedWithOptions(prompt) {
            switcher.start()
        } else {
            permissionTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] timer in
                guard AXIsProcessTrusted(), let self else { return }
                if self.switcher.start() {
                    timer.invalidate()
                    self.permissionTimer = nil
                }
            }
        }
    }

    // MARK: - Menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        let trigger = Trigger.current
        let key = trigger == .option ? "⌥" : "⌃"
        menu.addItem(disabled("\(key)Tab: all windows     \(key)`: current app"))
        menu.addItem(disabled("While open: ←→↑↓ move, W close, Q quit, Esc cancel"))
        menu.addItem(.separator())

        if !AXIsProcessTrusted() {
            menu.addItem(item("⚠︎ Grant Accessibility access…", #selector(openAccessibility)))
        } else if !switcher.isRunning {
            menu.addItem(disabled("⚠︎ Keyboard tap failed to start"))
        }
        if !CGPreflightScreenCaptureAccess() {
            menu.addItem(item("Enable window previews (Screen Recording)…", #selector(openScreenRecording)))
        }

        let triggerMenu = NSMenu()
        for option in Trigger.allCases {
            let entry = item(option.label, #selector(setTrigger(_:)))
            entry.representedObject = option.rawValue
            entry.state = option == trigger ? .on : .off
            triggerMenu.addItem(entry)
        }
        let triggerItem = NSMenuItem(title: "Trigger key", action: nil, keyEquivalent: "")
        triggerItem.submenu = triggerMenu
        menu.addItem(triggerItem)

        let login = item("Launch at login", #selector(toggleLogin))
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(login)

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Switchyard", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }

    private func item(_ title: String, _ action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        return item
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    @objc private func setTrigger(_ sender: NSMenuItem) {
        if let raw = sender.representedObject as? String, let trigger = Trigger(rawValue: raw) {
            Trigger.current = trigger
        }
    }

    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            let alert = NSAlert(error: error)
            alert.messageText = "Could not change the login item"
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
        }
    }

    @objc private func openAccessibility() {
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
    }

    @objc private func openScreenRecording() {
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
    }

    private func open(_ string: String) {
        if let url = URL(string: string) { NSWorkspace.shared.open(url) }
    }
}
