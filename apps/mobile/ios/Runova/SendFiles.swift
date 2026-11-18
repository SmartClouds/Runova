import CoreTransferable
import Foundation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// More than the core takes at once, so a huge folder stops being walked early.
private let mostFiles = 10_001

/// The phone's picks, read for the core a piece at a time (E113). A file is opened on its first
/// read, inside its security scope, and closed when the core says it is done with it, so a pick of
/// thousands never holds thousands open.
final class PickedURLs: PickedFiles, @unchecked Sendable {
    private let lock = NSLock()
    private var picked: [String: (url: URL, scope: URL)] = [:]
    private var open: [String: (file: FileHandle, scope: URL, scoped: Bool)] = [:]

    private func remember(_ url: URL, scope: URL, path: String, size: Int64) -> StagedFile {
        let handle = UUID().uuidString
        lock.lock()
        picked[handle] = (url, scope)
        lock.unlock()
        return StagedFile(handle: handle, path: path, size: size)
    }

    /// Files from the file picker or the photo picker, by their own names.
    func stageFiles(_ urls: [URL]) -> [StagedFile] {
        urls.compactMap { url in
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize else { return nil }
            return remember(url, scope: url, path: url.lastPathComponent, size: Int64(size))
        }
    }

    /// Everything under a picked folder, with the folder's own name first in every path.
    func stageFolder(_ folder: URL) -> [StagedFile] {
        let scoped = folder.startAccessingSecurityScopedResource()
        defer { if scoped { folder.stopAccessingSecurityScopedResource() } }
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey]
        guard
            let walker = FileManager.default.enumerator(
                at: folder, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles])
        else { return [] }
        let base = folder.standardizedFileURL.path
        var staged: [StagedFile] = []
        for case let url as URL in walker {
            if staged.count >= mostFiles { break }
            guard let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true,
                let size = values.fileSize
            else { continue }
            let relative = String(url.standardizedFileURL.path.dropFirst(base.count))
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            staged.append(remember(url, scope: folder, path: folder.lastPathComponent + "/" + relative, size: Int64(size)))
        }
        return staged
    }

    func read(handle: String, offset: UInt64, length: UInt32) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        guard let file = fileFor(handle) else { return nil }
        do {
            try file.seek(toOffset: offset)
            return try file.read(upToCount: Int(length)) ?? Data()
        } catch {
            return nil
        }
    }

    /// Called with the lock held.
    private func fileFor(_ handle: String) -> FileHandle? {
        if let held = open[handle] { return held.file }
        guard let pick = picked[handle] else { return nil }
        let scoped = pick.scope.startAccessingSecurityScopedResource()
        guard let file = try? FileHandle(forReadingFrom: pick.url) else {
            if scoped { pick.scope.stopAccessingSecurityScopedResource() }
            return nil
        }
        open[handle] = (file, pick.scope, scoped)
        return file
    }

    func close(handle: String) {
        lock.lock()
        let held = open.removeValue(forKey: handle)
        lock.unlock()
        guard let held else { return }
        try? held.file.close()
        if held.scoped { held.scope.stopAccessingSecurityScopedResource() }
    }
}

/// A photo or video from the photo picker, copied into the app's own temporary folder so it can be
/// read a piece at a time like any other file.
struct PickedMedia: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .item) { received in
            let folder = FileManager.default.temporaryDirectory
                .appendingPathComponent("Send", isDirectory: true)
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let copy = folder.appendingPathComponent(received.file.lastPathComponent)
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedMedia(url: copy)
        }
    }
}

/// Copies picked photos in, off the main thread, and hands back their URLs.
func loadPickedMedia(_ items: [PhotosPickerItem]) async -> [URL] {
    var urls: [URL] = []
    for item in items {
        if let media = try? await item.loadTransferable(type: PickedMedia.self) {
            urls.append(media.url)
        }
    }
    return urls
}
