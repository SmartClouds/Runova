import CoreGraphics
import Foundation
import ImageIO
import UIKit

/// Bigger than any screen a computer should report.
private let largestSide: UInt32 = 8192

/// What the core draws into: one bitmap context the size of the computer's screen, with each JPEG
/// tile decoded and painted onto it. Tiles come one at a time on the core's frame thread. The view
/// reads `image` on the main thread.
final class RemoteFrames: RemoteFrameSink, ObservableObject, @unchecked Sendable {
    /// Replaced at most once per main-loop turn, however fast tiles land.
    @Published private(set) var image: CGImage?

    private let lock = NSLock()
    private var context: CGContext?
    private var publishQueued = false

    func onScreenSize(width: UInt32, height: UInt32) {
        let w = Int(min(max(width, 1), largestSide))
        let h = Int(min(max(height, 1), largestSide))
        let next = CGContext(
            data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        lock.lock()
        context = next
        lock.unlock()
        publishSoon()
    }

    func onTile(x: UInt16, y: UInt16, w: UInt16, h: UInt16, jpeg: Data) {
        guard let source = CGImageSourceCreateWithData(jpeg as CFData, nil),
            let tile = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { return }
        lock.lock()
        if let context {
            // Core Graphics counts from the bottom.
            let rect = CGRect(
                x: CGFloat(x), y: CGFloat(context.height) - CGFloat(y) - CGFloat(h),
                width: CGFloat(w), height: CGFloat(h))
            context.draw(tile, in: rect)
        }
        lock.unlock()
        publishSoon()
    }

    func onStopped() {
        lock.lock()
        context = nil
        lock.unlock()
        DispatchQueue.main.async { [weak self] in self?.image = nil }
    }

    private func publishSoon() {
        lock.lock()
        let shouldQueue = !publishQueued
        publishQueued = true
        lock.unlock()
        guard shouldQueue else { return }
        DispatchQueue.main.async { [weak self] in self?.publish() }
    }

    private func publish() {
        lock.lock()
        publishQueued = false
        let snapshot = context?.makeImage()
        lock.unlock()
        image = snapshot
    }
}
