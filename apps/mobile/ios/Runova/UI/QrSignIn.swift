import AVFoundation
import SwiftUI

/// Reads QR codes with the back camera. The session stops as soon as the view goes.
private final class QrCameraPreview: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

private struct QrCamera: UIViewRepresentable {
    let onCode: (String) -> Void

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        let session = AVCaptureSession()
        let queue = DispatchQueue(label: "com.runovahq.app.qr")
        var onCode: (String) -> Void
        private var found = false

        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func metadataOutput(
            _ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection
        ) {
            guard !found, let code = objects.first as? AVMetadataMachineReadableCodeObject,
                let text = code.stringValue
            else { return }
            found = true
            onCode(text)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    func makeUIView(context: Context) -> UIView {
        let view = QrCameraPreview()
        let coordinator = context.coordinator
        let session = coordinator.session
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        coordinator.queue.async {
            guard let camera = AVCaptureDevice.default(for: .video),
                let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input)
            else { return }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(coordinator, queue: .main)
            output.metadataObjectTypes = [.qr]
            session.startRunning()
        }
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        context.coordinator.onCode = onCode
    }

    static func dismantleUIView(_ view: UIView, coordinator: Coordinator) {
        let session = coordinator.session
        coordinator.queue.async { session.stopRunning() }
    }
}

/// The camera, with the square to hold the code in.
struct QrScanScreen: View {
    let onCode: (String) -> Void
    let onCancel: () -> Void

    @State private var access = AVCaptureDevice.authorizationStatus(for: .video)
    @Environment(\.palette) private var palette

    private var refused: Bool { access == .denied || access == .restricted }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if access == .authorized {
                QrCamera(onCode: onCode).ignoresSafeArea()
            }
            VStack(spacing: 0) {
                RunovaText("Scan to sign in", style: RunovaType.heading, color: .white)
                Spacer().frame(height: 6)
                RunovaText(
                    refused
                        ? "Runova needs the camera to read the code. Allow it in the phone's settings, or sign in with the browser."
                        : "Show the code in Runova on your computer (Account, Devices) or on runovahq.com (Devices and sessions).",
                    color: .white.opacity(0.78), alignment: .center)
                Spacer(minLength: 0)
                RoundedRectangle(cornerRadius: 20).stroke(palette.primary, lineWidth: 2).frame(width: 248, height: 248)
                Spacer(minLength: 0)
                RunovaButton(text: "Cancel", kind: .soft, action: onCancel).frame(maxWidth: .infinity)
            }
            .padding(24)
        }
        .task {
            guard access == .notDetermined else { return }
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            access = granted ? .authorized : .denied
        }
    }
}

/// After the scan: the digits both screens show, until the other side answers.
struct QrWaitingScreen: View {
    let view: QrSignInView
    let onCancel: () -> Void

    @Environment(\.palette) private var palette

    private static let digits = RunovaTextStyle(
        size: 40, lineHeight: 48, weight: 600, tracking: 0.18, fontName: "JetBrainsMono-Regular")

    var body: some View {
        VStack(spacing: 0) {
            RunovaLogo(size: 72)
            Spacer().frame(height: 16)
            if let digits = view.matchCode {
                RunovaText("Approve on your other screen", style: RunovaType.heading, alignment: .center)
                Spacer().frame(height: 6)
                RunovaText(
                    "Check that it shows these digits, then approve. Only approve if they match.",
                    color: palette.mutedForeground, alignment: .center)
                Spacer().frame(height: 20)
                RunovaCard {
                    RunovaText(digits, style: Self.digits, alignment: .center).frame(maxWidth: .infinity)
                }
            } else {
                RunovaText("Checking the code…", style: RunovaType.heading, alignment: .center)
            }
            Spacer().frame(height: 24)
            RunovaButton(text: "Cancel", kind: .soft, action: onCancel).frame(maxWidth: .infinity)
        }
        .padding(32)
    }
}
