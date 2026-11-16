import AppKit

/// Captures window previews off the main thread. Needs the Screen Recording
/// permission; without it the switcher simply shows app icons.
final class Thumbnailer {
    private var cache: [CGWindowID: NSImage] = [:]
    private let queue = DispatchQueue(label: "switchyard.thumbnails", qos: .userInteractive, attributes: .concurrent)
    private let cid = CGSMainConnectionID()

    var hasPermission: Bool { CGPreflightScreenCaptureAccess() }

    func cached(_ id: CGWindowID) -> NSImage? { cache[id] }

    func prune(keeping ids: Set<CGWindowID>) {
        cache = cache.filter { ids.contains($0.key) }
    }

    /// `done` is called on the main thread once per captured window.
    func capture(_ ids: [CGWindowID], done: @escaping (CGWindowID, NSImage) -> Void) {
        guard hasPermission else { return }
        let cid = self.cid
        for id in ids where id != 0 {
            queue.async { [weak self] in
                var wid = id
                let options = CaptureOption.ignoreGlobalClipShape | CaptureOption.nominalResolution
                let list = CGSHWCaptureWindowList(cid, &wid, 1, options).takeRetainedValue() as NSArray
                guard let first = list.firstObject else { return }
                let ref = first as CFTypeRef
                guard CFGetTypeID(ref) == CGImage.typeID else { return }
                let cgImage = ref as! CGImage
                guard cgImage.width > 1, cgImage.height > 1 else { return }
                let image = NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
                DispatchQueue.main.async {
                    self?.cache[id] = image
                    done(id, image)
                }
            }
        }
    }
}
