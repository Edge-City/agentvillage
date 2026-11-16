import AppKit

private final class CellView: NSView {
    private let thumb = NSImageView()
    private let icon = NSImageView()
    private let label = NSTextField(labelWithString: "")
    private var hasThumbnail = false

    var selected = false { didSet { updateHighlight() } }
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 10
        thumb.imageScaling = .scaleProportionallyUpOrDown
        icon.imageScaling = .scaleProportionallyUpOrDown
        label.alignment = .center
        label.lineBreakMode = .byTruncatingTail
        label.textColor = .white
        label.font = .systemFont(ofSize: 12, weight: .medium)
        addSubview(thumb)
        addSubview(icon)
        addSubview(label)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func configure(_ entry: WindowEntry, thumbnail: NSImage?) {
        icon.image = entry.app.icon
        label.stringValue = entry.displayTitle
        toolTip = entry.title.isEmpty ? entry.appName : "\(entry.appName): \(entry.title)"
        alphaValue = entry.isMinimized || entry.app.isHidden ? 0.7 : 1
        setThumbnail(thumbnail, fallback: entry.app.icon)
    }

    func setThumbnail(_ image: NSImage?, fallback: NSImage? = nil) {
        hasThumbnail = image != nil
        if let image { thumb.image = image } else if let fallback { thumb.image = fallback }
        icon.isHidden = !hasThumbnail
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let pad: CGFloat = 10, labelHeight: CGFloat = 18
        let area = NSRect(x: pad, y: pad, width: bounds.width - 2 * pad,
                          height: bounds.height - 2 * pad - labelHeight - 6)
        thumb.frame = hasThumbnail ? area : area.insetBy(dx: area.width * 0.2, dy: area.height * 0.1)
        let iconSize = min(40, area.height * 0.4)
        icon.frame = NSRect(x: area.maxX - iconSize, y: area.maxY - iconSize, width: iconSize, height: iconSize)
        label.frame = NSRect(x: pad, y: bounds.height - pad - labelHeight, width: bounds.width - 2 * pad, height: labelHeight)
    }

    private func updateHighlight() {
        layer?.backgroundColor = selected ? NSColor.white.withAlphaComponent(0.18).cgColor : NSColor.clear.cgColor
        layer?.borderWidth = selected ? 2 : 0
        layer?.borderColor = NSColor.controlAccentColor.cgColor
    }
}

private final class GridView: NSView {
    var onMove: ((NSPoint) -> Void)?
    var onClick: ((NSPoint) -> Void)?
    private var tracking: NSTrackingArea?

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        // mouseMoved only: a panel that appears under a resting cursor must not steal the selection.
        let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseMoved(with event: NSEvent) { onMove?(convert(event.locationInWindow, from: nil)) }
    override func mouseDown(with event: NSEvent) { onClick?(convert(event.locationInWindow, from: nil)) }
}

final class SwitcherPanel: NSPanel {
    var onHover: ((Int) -> Void)?
    var onClick: ((Int) -> Void)?
    private(set) var columns = 1

    private let effect = NSVisualEffectView()
    private let grid = GridView()
    private var cells: [CellView] = []
    private var ids: [CGWindowID] = []

    init() {
        super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        level = .popUpMenu
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]

        effect.material = .hudWindow
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.appearance = NSAppearance(named: .vibrantDark)
        effect.wantsLayer = true
        effect.layer?.cornerRadius = 18
        effect.layer?.masksToBounds = true
        contentView = effect
        effect.addSubview(grid)

        grid.onMove = { [weak self] point in
            guard let self, let i = self.index(at: point) else { return }
            self.onHover?(i)
        }
        grid.onClick = { [weak self] point in
            guard let self, let i = self.index(at: point) else { return }
            self.onClick?(i)
        }
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    private func index(at point: NSPoint) -> Int? {
        cells.firstIndex { $0.frame.contains(point) }
    }

    func present(_ entries: [WindowEntry], selected: Int, thumbnail: (CGWindowID) -> NSImage?) {
        cells.forEach { $0.removeFromSuperview() }
        cells = []
        ids = entries.map { $0.id }
        guard !entries.isEmpty else { orderOut(nil); return }

        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main ?? NSScreen.screens[0]
        let area = screen.visibleFrame
        let margin: CGFloat = 14
        let maxWidth = area.width * 0.92 - 2 * margin
        let maxHeight = area.height * 0.88 - 2 * margin

        // Shrink the cells until everything fits on one screen.
        var scale: CGFloat = 1
        var cell = NSSize(width: 230, height: 180)
        var rows = 1
        while true {
            cell = NSSize(width: (230 * scale).rounded(), height: (180 * scale).rounded())
            columns = max(1, min(entries.count, Int(maxWidth / cell.width)))
            rows = Int(ceil(Double(entries.count) / Double(columns)))
            if CGFloat(rows) * cell.height <= maxHeight || scale < 0.35 { break }
            scale *= 0.9
        }

        let size = NSSize(width: CGFloat(columns) * cell.width + 2 * margin,
                          height: CGFloat(rows) * cell.height + 2 * margin)
        setFrame(NSRect(x: area.midX - size.width / 2, y: area.midY - size.height / 2,
                        width: size.width, height: size.height), display: false)
        grid.frame = NSRect(origin: .zero, size: size)

        for (i, entry) in entries.enumerated() {
            let lastRow = i / columns == rows - 1
            let inRow = lastRow ? entries.count - (rows - 1) * columns : columns
            // Centre a short final row.
            let offset = CGFloat(columns - inRow) * cell.width / 2
            let view = CellView(frame: NSRect(
                x: margin + offset + CGFloat(i % columns) * cell.width,
                y: margin + CGFloat(i / columns) * cell.height,
                width: cell.width, height: cell.height).insetBy(dx: 3, dy: 3))
            view.configure(entry, thumbnail: entry.id == 0 ? nil : thumbnail(entry.id))
            view.selected = i == selected
            grid.addSubview(view)
            cells.append(view)
        }
        orderFrontRegardless()
    }

    func select(_ index: Int) {
        for (i, cell) in cells.enumerated() { cell.selected = i == index }
    }

    func setThumbnail(_ image: NSImage, for id: CGWindowID) {
        guard isVisible, let i = ids.firstIndex(of: id), i < cells.count else { return }
        cells[i].setThumbnail(image)
    }
}
