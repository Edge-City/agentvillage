import AppKit

enum Trigger: String, CaseIterable {
    case option, control

    var flag: CGEventFlags { self == .option ? .maskAlternate : .maskControl }
    var label: String { self == .option ? "⌥ Option" : "⌃ Control" }

    static var current: Trigger {
        get { Trigger(rawValue: UserDefaults.standard.string(forKey: "trigger") ?? "") ?? .option }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: "trigger") }
    }

    /// Trigger+` cycles the current app's windows. It can be switched off because
    /// Option+` is also how accented letters are typed on many layouts.
    static var currentAppShortcut: Bool {
        get { UserDefaults.standard.object(forKey: "currentAppShortcut") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "currentAppShortcut") }
    }
}

private enum Key {
    static let tab: Int64 = 48, backtick: Int64 = 50, escape: Int64 = 53, returnKey: Int64 = 36
    static let left: Int64 = 123, right: Int64 = 124, down: Int64 = 125, up: Int64 = 126
    static let q: Int64 = 12, w: Int64 = 13
}

final class SwitcherController {
    private let catalog = WindowCatalog()
    private let thumbnails = Thumbnailer()
    private let tap = HotkeyTap()
    private lazy var panel: SwitcherPanel = {
        let panel = SwitcherPanel()
        panel.onHover = { [weak self] i in self?.select(i) }
        panel.onClick = { [weak self] i in self?.select(i); self?.commit() }
        return panel
    }()

    private var active = false
    private var entries: [WindowEntry] = []
    private var index = 0
    private var pendingShow: DispatchWorkItem?
    private var watchdog: Timer?

    /// Quick taps switch without ever drawing the panel, like Alt+Tab on Windows.
    private let showDelay: TimeInterval = 0.12

    var isRunning: Bool { tap.isRunning }

    @discardableResult
    func start() -> Bool {
        tap.handler = { [weak self] type, event in self?.handle(type, event) ?? false }
        // If events were missed, the release of the trigger key may be among
        // them. Never stay open on a guess.
        tap.onInterrupted = { [weak self] in self?.cancel() }
        if observers.isEmpty {
            let center = NSWorkspace.shared.notificationCenter
            for name in [NSWorkspace.sessionDidResignActiveNotification,
                         NSWorkspace.screensDidSleepNotification, NSWorkspace.willSleepNotification] {
                observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    self?.cancel()
                })
            }
        }
        return tap.start()
    }

    func stop() {
        cancel()
        tap.stop()
    }

    private var observers: [NSObjectProtocol] = []

    // MARK: - Keyboard

    private func handle(_ type: CGEventType, _ event: CGEvent) -> Bool {
        let trigger = Trigger.current
        let held = event.flags.intersection([.maskAlternate, .maskControl, .maskCommand])
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        let shift = event.flags.contains(.maskShift)

        switch type {
        case .flagsChanged:
            if active && !event.flags.contains(trigger.flag) { commit() }
            return false

        case .keyUp:
            return active

        case .keyDown:
            if !active {
                guard held == trigger.flag else { return false }
                guard code == Key.tab || (code == Key.backtick && Trigger.currentAppShortcut) else { return false }
                begin(currentAppOnly: code == Key.backtick, backwards: shift)
                return true
            }
            // A held key must never repeat an action that closes or quits something.
            let repeating = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
            if repeating && (code == Key.q || code == Key.w || code == Key.returnKey) { return true }
            switch code {
            case Key.tab, Key.backtick: move(shift ? -1 : 1)
            case Key.right: move(1)
            case Key.left: move(-1)
            case Key.down: moveRow(1)
            case Key.up: moveRow(-1)
            case Key.returnKey: commit()
            case Key.escape: cancel()
            case Key.q: quitSelected()
            case Key.w: closeSelected()
            default: break
            }
            return true // nothing leaks into the app underneath while the switcher is up

        default:
            return false
        }
    }

    // MARK: - Session

    private func begin(currentAppOnly: Bool, backwards: Bool) {
        let frontPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        entries = catalog.snapshot(onlyPID: currentAppOnly ? frontPID : nil)
        guard !entries.isEmpty else { return }
        active = true

        // Slot 0 is the window you are already in, so start on the next one.
        // If the frontmost app has no window, slot 0 is already somewhere new.
        let frontIsFirst = entries[0].pid == frontPID && !entries[0].isAppOnly
        if backwards {
            index = entries.count - 1
        } else {
            index = frontIsFirst && entries.count > 1 ? 1 : 0
        }

        thumbnails.capture(entries.map { $0.id }) { [weak self] id, image in
            guard let self, self.active else { return }
            self.panel.setThumbnail(image, for: id)
        }

        // Safety net: if the release of the trigger key never reaches us (secure
        // input, screen lock), notice that it is up and close without acting.
        watchdog = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            if !CGEventSource.flagsState(.combinedSessionState).contains(Trigger.current.flag) {
                self?.cancel()
            }
        }

        let work = DispatchWorkItem { [weak self] in self?.showPanel() }
        pendingShow = work
        DispatchQueue.main.asyncAfter(deadline: .now() + showDelay, execute: work)
    }

    private func showPanel() {
        guard active else { return }
        panel.present(entries, selected: index) { [thumbnails] id in thumbnails.cached(id) }
    }

    private func end() {
        active = false
        watchdog?.invalidate()
        watchdog = nil
        pendingShow?.cancel()
        pendingShow = nil
        panel.orderOut(nil)
        thumbnails.prune(keeping: Set(entries.map { $0.id }))
    }

    private func commit() {
        guard active else { return }
        let target = entries.indices.contains(index) ? entries[index] : nil
        end()
        guard let target else { return }
        if target.ax == nil { target.ax = catalog.cachedElement(for: target.id) }
        catalog.noteActivated(target)
        Activator.activate(target)
    }

    private func cancel() {
        guard active else { return }
        end()
    }

    private func select(_ i: Int) {
        guard active, entries.indices.contains(i), i != index else { return }
        index = i
        panel.select(index)
    }

    private func move(_ delta: Int) {
        guard !entries.isEmpty else { return }
        index = (index + delta + entries.count) % entries.count
        panel.select(index)
    }

    private func moveRow(_ delta: Int) {
        guard panel.isVisible else { return }
        let next = index + delta * panel.columns
        guard entries.indices.contains(next) else { return }
        index = next
        panel.select(index)
    }

    private func closeSelected() {
        guard entries.indices.contains(index) else { return }
        let target = entries[index]
        guard Activator.close(target) else { return }
        remove { $0 === target }
    }

    private func quitSelected() {
        guard entries.indices.contains(index) else { return }
        let pid = entries[index].pid
        Activator.quit(entries[index])
        remove { $0.pid == pid }
    }

    private func remove(where predicate: (WindowEntry) -> Bool) {
        entries = entries.filter { !predicate($0) }
        guard !entries.isEmpty else { cancel(); return }
        index = min(index, entries.count - 1)
        if panel.isVisible { showPanel() }
    }
}
